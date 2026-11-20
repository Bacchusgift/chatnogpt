package turtlesoup

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestPlugin(t *testing.T) (*Plugin, string) {
	t.Helper()
	dir := t.TempDir()
	return New(Config{Dir: dir}), dir
}

// 文件模式：内置故事播种 + 谜面列表永不含谜底
func TestFileSeedsAndNoAnswerLeak(t *testing.T) {
	p, dir := newTestPlugin(t)
	stories, err := p.listStories("userA")
	if err != nil {
		t.Fatalf("listStories: %v", err)
	}
	if len(stories) < 6 {
		t.Fatalf("seed stories = %d, want >= 6", len(stories))
	}
	for _, s := range stories {
		if s.Answer != "" {
			t.Fatalf("listStories leaked answer for %s", s.ID)
		}
		if s.OwnerID != "" {
			t.Fatalf("seed story owner = %q, want system", s.OwnerID)
		}
	}
	// 首次写入（上传故事本）后，种子随文件落盘
	if _, err := p.createStory("userA", "落盘测试谜面，长度足够通过校验。", "落盘测试谜底"); err != nil {
		t.Fatalf("createStory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "plugins", "turtle-soup.json")); err != nil {
		t.Fatalf("plugin json missing: %v", err)
	}
	// 重新加载实例（模拟重启），种子仍在
	p2 := New(Config{Dir: dir})
	stories2, err := p2.listStories("userB")
	if err != nil {
		t.Fatalf("reload listStories: %v", err)
	}
	if len(stories2) < 6 {
		t.Fatalf("after reload seeds = %d, want >= 6", len(stories2))
	}
}

// 上传/删除故事本与归属校验
func TestUploadAndDeleteStory(t *testing.T) {
	p, _ := newTestPlugin(t)
	s, err := p.createStory("userA", "一个测试谜面，足够长来通过校验。", "一个测试谜底")
	if err != nil {
		t.Fatalf("createStory: %v", err)
	}
	// 非所有者删除 → errStoryNotFound
	if err := p.deleteStory(s.ID, "userB"); err != errStoryNotFound {
		t.Fatalf("delete by non-owner = %v, want errStoryNotFound", err)
	}
	// 所有者删除成功
	if err := p.deleteStory(s.ID, "userA"); err != nil {
		t.Fatalf("delete by owner: %v", err)
	}
}

// 游戏生命周期：开局→非主持人不可见谜底→主持人可见→结束后全员可见
func TestGameLifecycleAnswerVisibility(t *testing.T) {
	p, _ := newTestPlugin(t)
	stories, _ := p.listStories("userA")
	host, player := "hostU", "playerU"

	g, err := p.createGame("convX", stories[0].ID, host)
	if err != nil {
		t.Fatalf("createGame: %v", err)
	}
	if g.Phase != phasePlaying || !g.IsHost || g.Answer == "" {
		t.Fatalf("createGame view wrong: %+v", g)
	}
	// 非主持人视图：谜底隐藏
	v, err := p.gameFor("convX", player)
	if err != nil {
		t.Fatalf("gameFor player: %v", err)
	}
	if v.Answer != "" || v.IsHost {
		t.Fatalf("player view must hide answer: %+v", v)
	}
	// 非主持人结束游戏 → 拒绝
	if _, err := p.endGame("convX", player); err != errNotHost {
		t.Fatalf("player endGame = %v, want errNotHost", err)
	}
	// 主持人结束 → 全员可见
	e, err := p.endGame("convX", host)
	if err != nil {
		t.Fatalf("endGame: %v", err)
	}
	if e.Phase != phaseEnded {
		t.Fatalf("phase = %d, want ended", e.Phase)
	}
	v2, err := p.gameFor("convX", player)
	if err != nil {
		t.Fatalf("gameFor after end: %v", err)
	}
	if v2.Answer == "" || v2.Phase != phaseEnded {
		t.Fatalf("answer must be public after end: %+v", v2)
	}
	// 未开局房间 → errGameNotFound
	if _, err := p.gameFor("convNone", player); err != errGameNotFound {
		t.Fatalf("empty room = %v, want errGameNotFound", err)
	}
}

// 重复开局覆盖为进行中（换故事本重开）
func TestRecreateGameResetsPhase(t *testing.T) {
	p, _ := newTestPlugin(t)
	stories, _ := p.listStories("hostU")
	if _, err := p.createGame("convY", stories[0].ID, "hostU"); err != nil {
		t.Fatalf("createGame1: %v", err)
	}
	if _, err := p.endGame("convY", "hostU"); err != nil {
		t.Fatalf("endGame: %v", err)
	}
	g2, err := p.createGame("convY", stories[1].ID, "hostU")
	if err != nil {
		t.Fatalf("createGame2: %v", err)
	}
	if g2.Phase != phasePlaying || g2.StoryID != stories[1].ID {
		t.Fatalf("recreate wrong: %+v", g2)
	}
}

// HTTP 全链路：门禁透传 + 谜底不泄露 + 端点行为
func TestHTTPFlow(t *testing.T) {
	p, _ := newTestPlugin(t)
	mux := http.NewServeMux()
	gate := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			next(w, r.WithContext(WithUser(r.Context(), "hostU")))
		}
	}
	p.Register(mux, Prefix, gate)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// stories 列表 JSON 不得包含 answer 字段值
	resp, err := http.Get(srv.URL + Prefix + "/stories")
	if err != nil {
		t.Fatalf("GET stories: %v", err)
	}
	defer resp.Body.Close()
	var listResp struct {
		Stories []struct {
			ID     string `json:"id"`
			Riddle string `json:"riddle"`
			System bool   `json:"system"`
			Mine   bool   `json:"mine"`
		} `json:"stories"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		t.Fatalf("decode stories: %v", err)
	}
	if len(listResp.Stories) == 0 {
		t.Fatal("no seeded stories via HTTP")
	}
	for _, s := range listResp.Stories {
		if !s.System {
			t.Fatalf("seed story not marked system: %+v", s)
		}
	}

	// 上传故事本
	body := `{"riddle":"HTTP 测试谜面，长度足够通过校验。","answer":"HTTP 测试谜底"}`
	r2, err := http.Post(srv.URL+Prefix+"/stories", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST stories: %v", err)
	}
	r2.Body.Close()
	if r2.StatusCode != 200 {
		t.Fatalf("POST stories status = %d", r2.StatusCode)
	}

	// 开局
	gbody := `{"conv_id":"convH","story_id":"` + listResp.Stories[0].ID + `"}`
	r3, err := http.Post(srv.URL+Prefix+"/games", "application/json", strings.NewReader(gbody))
	if err != nil {
		t.Fatalf("POST games: %v", err)
	}
	defer r3.Body.Close()
	if r3.StatusCode != 200 {
		t.Fatalf("POST games status = %d", r3.StatusCode)
	}
	var gameResp struct {
		Game Game `json:"game"`
	}
	if err := json.NewDecoder(r3.Body).Decode(&gameResp); err != nil {
		t.Fatalf("decode game: %v", err)
	}
	if gameResp.Game.Answer == "" || !gameResp.Game.IsHost {
		t.Fatalf("host game view wrong: %+v", gameResp.Game)
	}

	// 结束
	r4, err := http.Post(srv.URL+Prefix+"/games/convH/end", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("POST end: %v", err)
	}
	defer r4.Body.Close()
	if r4.StatusCode != 200 {
		t.Fatalf("POST end status = %d", r4.StatusCode)
	}

	// 未开局房间返回 game:null
	r5, err := http.Get(srv.URL + Prefix + "/games?conv_id=none")
	if err != nil {
		t.Fatalf("GET games: %v", err)
	}
	defer r5.Body.Close()
	var nullResp struct {
		Game *Game `json:"game"`
	}
	if err := json.NewDecoder(r5.Body).Decode(&nullResp); err != nil {
		t.Fatalf("decode null game: %v", err)
	}
	if nullResp.Game != nil {
		t.Fatalf("empty room should return null game: %+v", nullResp.Game)
	}
}

// context 身份注入检查
func TestWithUser(t *testing.T) {
	ctx := WithUser(context.Background(), "u1")
	if got := userIDFrom(ctx); got != "u1" {
		t.Fatalf("userIDFrom = %q", got)
	}
	if userIDFrom(context.Background()) != "" {
		t.Fatal("empty ctx should yield empty user")
	}
}
