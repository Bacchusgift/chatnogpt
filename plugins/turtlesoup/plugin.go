package turtlesoup

// 海龟汤插件：群聊推理游戏。主持人（房间创建者）选故事本（谜面+谜底）开局，
// 谜面下发群聊，其他成员提问，主持人以「是 / 不是 / 是也不是 / 无关」引导，
// 主持人随时结束游戏并揭晓谜底。故事本支持系统内置 + 用户上传（谜底仅存储方可见）。

import (
	"chatnogpt/plugins/pluginbase"
	"context"
	crand "crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	Prefix     = "/api/plugins/turtle-soup"
	Name       = "turtle-soup"
	Title      = "海龟汤"
	Desc       = "群聊海龟汤推理：主持人出题，玩家提问，快捷回复「是 / 不是 / 是也不是 / 无关」"
	FrontendJS = "/plugins/turtle-soup/soup.js?v=2.3.10"
)

// WithUser / userIDFrom 为 pluginbase 统一身份契约的薄封装（保留以兼容既有调用）。
func WithUser(ctx context.Context, userID string) context.Context {
	return pluginbase.WithUser(ctx, userID)
}

func userIDFrom(ctx context.Context) string {
	return pluginbase.UserIDFrom(ctx)
}

// 故事本阶段：1=进行中 2=已揭晓
const (
	phasePlaying = 1
	phaseEnded   = 2
)

type Story struct {
	ID        string `json:"id"`
	OwnerID   string `json:"owner_id"`
	Riddle    string `json:"riddle"`
	Answer    string `json:"answer,omitempty"`
	CreatedAt int64  `json:"created_at"`
}

type Game struct {
	ConvID    string `json:"conv_id"`
	StoryID   string `json:"story_id"`
	HostID    string `json:"host_id"`
	Phase     int    `json:"phase"`
	Riddle    string `json:"riddle"`
	Answer    string `json:"answer,omitempty"` // 仅主持人或已揭晓时下发
	StartedAt int64  `json:"started_at"`
	EndedAt   int64  `json:"ended_at,omitempty"`
	IsHost    bool   `json:"is_host"`
}

type Config struct {
	// DB 数据库模式句柄；nil 时插件使用数据目录内的独立 JSON 文件。
	DB *sql.DB
	// Dir 基座数据目录（文件模式持久化位置）。
	Dir string
}

type Plugin struct {
	cfg    Config
	mu     sync.Mutex // 序列化文件模式的读写
	dbOnce sync.Once
	dbErr  error
}

func New(cfg Config) *Plugin {
	return &Plugin{cfg: cfg}
}

// Meta 插件自描述：目录页、脚本注入、对话模式与详情内容由基座从此派生。
func (p *Plugin) Meta() pluginbase.Meta {
	return pluginbase.Meta{
		Name:      Name,
		Title:     Title,
		Desc:      Desc,
		Icon:      "🍲",
		Script:    FrontendJS,
		RoomModes: []pluginbase.RoomMode{{ID: "turtle-soup", Label: "海龟汤"}},
		Detail: []pluginbase.DetailItem{
			{Type: "step", Text: "开启插件后，左侧「Agent Team」点 + 创建群聊室，对话模式选「海龟汤」；"},
			{Type: "step", Text: "建房人即主持人：开局前选一个故事本（内置经典或自己上传），系统把谜面发到群里；"},
			{Type: "step", Text: "谜底只有主持人能看到。其他成员像正常聊天一样提问，主持人自由回应；"},
			{Type: "step", Text: "主持人可在成员消息下点快捷按钮回复「是 / 不是 / 是也不是 / 无关」；"},
			{Type: "step", Text: "主持人随时结束游戏并揭晓谜底，全员可见；伪装与普通聊天完全一致。"},
			{Type: "note", Text: "在游戏面板也可以上传自己的故事本：谜底只有你能看到，别人可以拿它玩。"},
		},
	}
}

// Mount 自挂载：API 路由与前端脚本路由（均套基座门禁）。
func (p *Plugin) Mount(mux *http.ServeMux, gate pluginbase.Gate) {
	mux.HandleFunc(strings.SplitN(FrontendJS, "?", 2)[0], p.FrontendJSHandler)
	p.ensureSchema()
	mux.HandleFunc(Prefix, gate(p.handleStories))
	mux.HandleFunc(Prefix+"/", gate(p.handleSub))
}

// Register mounts the plugin's routes under prefix. gate 由基座提供：
// 已完成鉴权与按用户启用检查的处理器包装。
func (p *Plugin) Register(mux *http.ServeMux, prefix string, gate func(http.HandlerFunc) http.HandlerFunc) {
	p.ensureSchema()
	mux.HandleFunc(prefix, gate(p.handleStories))
	mux.HandleFunc(prefix+"/", gate(p.handleSub))
}

// FrontendJS 返回前端脚本内容（go:embed web/soup.js）。
//
//go:embed web/soup.js
var frontendJS string

func (p *Plugin) FrontendJSHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write([]byte(frontendJS))
}

// ensureSchema 建表与内置故事播种（仅 DB 模式，幂等）。
func (p *Plugin) ensureSchema() {
	if p.cfg.DB == nil {
		return
	}
	p.dbOnce.Do(func() {
		stmts := []string{
			`CREATE TABLE IF NOT EXISTS ts_stories (
				id VARCHAR(24) PRIMARY KEY,
				owner_id VARCHAR(24) NOT NULL DEFAULT '',
				riddle TEXT NOT NULL,
				answer TEXT NOT NULL,
				created_at BIGINT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS ts_games (
				conv_id VARCHAR(24) PRIMARY KEY,
				story_id VARCHAR(24) NOT NULL,
				host_id VARCHAR(24) NOT NULL,
				phase TINYINT NOT NULL DEFAULT 1,
				riddle TEXT NOT NULL,
				answer TEXT NOT NULL,
				started_at BIGINT NOT NULL,
				ended_at BIGINT NOT NULL DEFAULT 0
			)`,
			`CREATE TABLE IF NOT EXISTS ts_rooms (
				conv_id VARCHAR(24) PRIMARY KEY,
				created_at BIGINT NOT NULL
			)`,
		}
		for _, q := range stmts {
			if _, err := p.cfg.DB.Exec(q); err != nil {
				p.dbErr = err
				return
			}
		}
		// 内置故事播种：仅在空表时写入，避免重复
		var n int
		if err := p.cfg.DB.QueryRow("SELECT COUNT(*) FROM ts_stories WHERE owner_id=''").Scan(&n); err == nil && n == 0 {
			for _, s := range seedStories() {
				if _, err := p.cfg.DB.Exec(`INSERT INTO ts_stories (id, owner_id, riddle, answer, created_at) VALUES (?,?,?,?,?)`,
					s.ID, s.OwnerID, s.Riddle, s.Answer, s.CreatedAt); err != nil {
					p.dbErr = err
					return
				}
			}
		} else if err != nil {
			p.dbErr = err
		}
	})
}

// ---- 持久化：DB 模式走 ts_stories / ts_games 表；文件模式走插件自有 JSON ----

type fileData struct {
	Stories map[string]*Story `json:"stories"`
	Games   map[string]*Game  `json:"games"`
	Rooms   map[string]int64  `json:"rooms"`
}

func (p *Plugin) jsonPath() string {
	return jsonPathOf(p.cfg.Dir)
}

func jsonPathOf(dir string) string {
	return dir + "/plugins/turtle-soup.json"
}

func (p *Plugin) loadFile() (*fileData, error) {
	out := &fileData{Stories: map[string]*Story{}, Games: map[string]*Game{}}
	b, err := os.ReadFile(p.jsonPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			for _, s := range seedStories() {
				out.Stories[s.ID] = s
			}
			return out, nil
		}
		return nil, err
	}
	if jerr := json.Unmarshal(b, out); jerr != nil {
		return nil, jerr
	}
	if out.Stories == nil {
		out.Stories = map[string]*Story{}
	}
	if out.Games == nil {
		out.Games = map[string]*Game{}
	}
	if out.Rooms == nil {
		out.Rooms = map[string]int64{}
	}
	if len(out.Stories) == 0 {
		for _, s := range seedStories() {
			out.Stories[s.ID] = s
		}
	}
	return out, nil
}

func (p *Plugin) saveFile(fd *fileData) error {
	if err := os.MkdirAll(filepath.Dir(p.jsonPath()), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(fd, "", "  ")
	if err != nil {
		return err
	}
	tmp := p.jsonPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p.jsonPath())
}

var errStoryNotFound = errors.New("故事本不存在")
var errGameNotFound = errors.New("本房间还没有开始海龟汤")
var errNotHost = errors.New("只有主持人可以执行该操作")

// listStories 返回谜面列表（永不含谜底）。
func (p *Plugin) listStories(ownerID string) ([]Story, error) {
	if p.cfg.DB != nil {
		p.ensureSchema()
		if p.dbErr != nil {
			return nil, p.dbErr
		}
		rows, err := p.cfg.DB.Query(`SELECT id, owner_id, riddle, created_at FROM ts_stories ORDER BY created_at DESC, id`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []Story{}
		for rows.Next() {
			var s Story
			if err := rows.Scan(&s.ID, &s.OwnerID, &s.Riddle, &s.CreatedAt); err != nil {
				continue
			}
			out = append(out, s)
		}
		return out, rows.Err()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	fd, err := p.loadFile()
	if err != nil {
		return nil, err
	}
	out := []Story{}
	for _, s := range fd.Stories {
		c := *s
		c.Answer = ""
		out = append(out, c)
	}
	// 新的在前（上传时间倒序）
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].CreatedAt > out[j-1].CreatedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

func (p *Plugin) createStory(ownerID, riddle, answer string) (Story, error) {
	s := Story{ID: newID(), OwnerID: ownerID, Riddle: riddle, Answer: answer, CreatedAt: nowUnix()}
	if p.cfg.DB != nil {
		p.ensureSchema()
		if p.dbErr != nil {
			return Story{}, p.dbErr
		}
		_, err := p.cfg.DB.Exec(`INSERT INTO ts_stories (id, owner_id, riddle, answer, created_at) VALUES (?,?,?,?,?)`,
			s.ID, s.OwnerID, s.Riddle, s.Answer, s.CreatedAt)
		return s, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	fd, err := p.loadFile()
	if err != nil {
		return Story{}, err
	}
	fd.Stories[s.ID] = &s
	return s, p.saveFile(fd)
}

func (p *Plugin) deleteStory(storyID, ownerID string) error {
	if p.cfg.DB != nil {
		p.ensureSchema()
		if p.dbErr != nil {
			return p.dbErr
		}
		res, err := p.cfg.DB.Exec(`DELETE FROM ts_stories WHERE id=? AND owner_id=?`, storyID, ownerID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return errStoryNotFound
		}
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	fd, err := p.loadFile()
	if err != nil {
		return err
	}
	s := fd.Stories[storyID]
	if s == nil || s.OwnerID != ownerID {
		return errStoryNotFound
	}
	delete(fd.Stories, storyID)
	return p.saveFile(fd)
}

// createGame 以调用者为主持人开局；谜面谜底做快照，故事本后续删除不影响进行中的游戏。
func (p *Plugin) createGame(convID, storyID, userID string) (Game, error) {
	if p.cfg.DB != nil {
		p.ensureSchema()
		if p.dbErr != nil {
			return Game{}, p.dbErr
		}
	}
	var story Story
	if p.cfg.DB != nil {
		err := p.cfg.DB.QueryRow(`SELECT id, owner_id, riddle, answer, created_at FROM ts_stories WHERE id=?`, storyID).
			Scan(&story.ID, &story.OwnerID, &story.Riddle, &story.Answer, &story.CreatedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return Game{}, errStoryNotFound
		}
		if err != nil {
			return Game{}, err
		}
	} else {
		p.mu.Lock()
		fd, err := p.loadFile()
		if err != nil {
			p.mu.Unlock()
			return Game{}, err
		}
		if s := fd.Stories[storyID]; s != nil {
			story = *s
		}
		p.mu.Unlock()
		if story.ID == "" {
			return Game{}, errStoryNotFound
		}
	}
	g := Game{
		ConvID: convID, StoryID: story.ID, HostID: userID, Phase: phasePlaying,
		Riddle: story.Riddle, Answer: story.Answer, StartedAt: nowUnix(), IsHost: true,
	}
	if p.cfg.DB != nil {
		_, err := p.cfg.DB.Exec(`INSERT INTO ts_games (conv_id, story_id, host_id, phase, riddle, answer, started_at, ended_at)
			VALUES (?,?,?,?,?,?,?,0)
			ON DUPLICATE KEY UPDATE story_id=VALUES(story_id), host_id=VALUES(host_id), phase=1,
			riddle=VALUES(riddle), answer=VALUES(answer), started_at=VALUES(started_at), ended_at=0`,
			g.ConvID, g.StoryID, g.HostID, g.Phase, g.Riddle, g.Answer, g.StartedAt)
		if err != nil {
			return Game{}, err
		}
		return g, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	fd, err := p.loadFile()
	if err != nil {
		return Game{}, err
	}
	fd.Games[convID] = &g
	return g, p.saveFile(fd)
}

// RegisterSoupRoom 标记房间为海龟汤房间（抽屉面板可用性的依据）。
func (p *Plugin) RegisterSoupRoom(convID string) error {
	if p.cfg.DB != nil {
		p.ensureSchema()
		if p.dbErr != nil {
			return p.dbErr
		}
		if _, err := p.cfg.DB.Exec(`INSERT INTO ts_rooms (conv_id, created_at) VALUES (?,?)
			ON DUPLICATE KEY UPDATE created_at=VALUES(created_at)`, convID, nowUnix()); err != nil {
			return err
		}
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	fd, err := p.loadFile()
	if err != nil {
		return err
	}
	fd.Rooms[convID] = nowUnix()
	return p.saveFile(fd)
}

// IsSoupRoom 房间是否已注册为海龟汤房间。
func (p *Plugin) IsSoupRoom(convID string) bool {
	if p.cfg.DB != nil {
		p.ensureSchema()
		if p.dbErr != nil {
			return false
		}
		var one int
		if err := p.cfg.DB.QueryRow("SELECT 1 FROM ts_rooms WHERE conv_id=?", convID).Scan(&one); err != nil {
			return false
		}
		return true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	fd, err := p.loadFile()
	if err != nil {
		return false
	}
	_, ok := fd.Rooms[convID]
	return ok
}

func gameOrNil(g Game, err error) any {
	if err != nil {
		return nil
	}
	return g
}

// gameFor 组装给指定查看者的游戏视图（谜底只给主持人或已揭晓）。
func (p *Plugin) gameFor(convID, userID string) (Game, error) {
	if p.cfg.DB != nil {
		p.ensureSchema()
		if p.dbErr != nil {
			return Game{}, p.dbErr
		}
	}
	var raw Game
	if p.cfg.DB != nil {
		err := p.cfg.DB.QueryRow(`SELECT conv_id, story_id, host_id, phase, riddle, answer, started_at, ended_at
			FROM ts_games WHERE conv_id=?`, convID).
			Scan(&raw.ConvID, &raw.StoryID, &raw.HostID, &raw.Phase, &raw.Riddle, &raw.Answer, &raw.StartedAt, &raw.EndedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return Game{}, errGameNotFound
		}
		if err != nil {
			return Game{}, err
		}
	} else {
		p.mu.Lock()
		fd, err := p.loadFile()
		if err != nil {
			p.mu.Unlock()
			return Game{}, err
		}
		if g := fd.Games[convID]; g != nil {
			raw = *g
		}
		p.mu.Unlock()
		if raw.ConvID == "" {
			return Game{}, errGameNotFound
		}
	}
	raw.IsHost = raw.HostID == userID
	if !raw.IsHost && raw.Phase != phaseEnded {
		raw.Answer = ""
	}
	return raw, nil
}

func (p *Plugin) endGame(convID, userID string) (Game, error) {
	g, err := p.gameFor(convID, userID)
	if err != nil {
		return Game{}, err
	}
	if !g.IsHost {
		return Game{}, errNotHost
	}
	if g.Phase == phaseEnded {
		return g, nil
	}
	if p.cfg.DB != nil {
		if _, err := p.cfg.DB.Exec(`UPDATE ts_games SET phase=2, ended_at=? WHERE conv_id=?`, nowUnix(), convID); err != nil {
			return Game{}, err
		}
	} else {
		p.mu.Lock()
		fd, err := p.loadFile()
		if err != nil {
			p.mu.Unlock()
			return Game{}, err
		}
		if gm := fd.Games[convID]; gm != nil {
			gm.Phase = phaseEnded
			gm.EndedAt = nowUnix()
		}
		if err := p.saveFile(fd); err != nil {
			p.mu.Unlock()
			return Game{}, err
		}
		p.mu.Unlock()
	}
	return p.gameFor(convID, userID)
}

// ---- HTTP 处理器（门禁由基座注入；调用者身份来自 context） ----

func (p *Plugin) handleStories(w http.ResponseWriter, r *http.Request) {
	user := userIDFrom(r.Context())
	switch r.Method {
	case http.MethodGet:
		stories, err := p.listStories(user)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		type storyView struct {
			ID     string `json:"id"`
			Riddle string `json:"riddle"`
			System bool   `json:"system"`
			Mine   bool   `json:"mine"`
		}
		out := []storyView{}
		for _, s := range stories {
			out = append(out, storyView{ID: s.ID, Riddle: s.Riddle, System: s.OwnerID == "", Mine: s.OwnerID == user})
		}
		writeJSONOK(w, map[string]any{"stories": out})
	case http.MethodPost:
		var req struct {
			Riddle string `json:"riddle"`
			Answer string `json:"answer"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		req.Riddle = strings.TrimSpace(req.Riddle)
		req.Answer = strings.TrimSpace(req.Answer)
		if !utf8.ValidString(req.Riddle) || !utf8.ValidString(req.Answer) {
			http.Error(w, "内容需为 UTF-8 文本", http.StatusBadRequest)
			return
		}
		if runes(req.Riddle) < 5 || runes(req.Riddle) > 2000 {
			http.Error(w, "谜面需为 5–2000 字", http.StatusBadRequest)
			return
		}
		if runes(req.Answer) < 2 || runes(req.Answer) > 2000 {
			http.Error(w, "谜底需为 2–2000 字", http.StatusBadRequest)
			return
		}
		s, err := p.createStory(user, req.Riddle, req.Answer)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONOK(w, map[string]any{"story": map[string]any{"id": s.ID, "riddle": s.Riddle, "mine": true}})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (p *Plugin) handleSub(w http.ResponseWriter, r *http.Request) {
	user := userIDFrom(r.Context())
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, Prefix+"/"), "/")
	parts := strings.Split(rest, "/")
	if len(parts) == 1 && parts[0] == "stories" {
		p.handleStories(w, r)
		return
	}
	if len(parts) == 1 && parts[0] == "rooms" && (r.Method == http.MethodPost || r.Method == http.MethodPut) {
		var req struct {
			ConvID string `json:"conv_id"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		req.ConvID = strings.TrimSpace(req.ConvID)
		if req.ConvID == "" {
			http.Error(w, "conv_id 不能为空", http.StatusBadRequest)
			return
		}
		if err := p.RegisterSoupRoom(req.ConvID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONOK(w, map[string]any{"ok": true})
		return
	}
	if parts[0] == "games" {
		switch {
		case len(parts) == 1 && r.Method == http.MethodGet:
			convID := strings.TrimSpace(r.URL.Query().Get("conv_id"))
			if convID == "" {
				writeJSONOK(w, map[string]any{"game": nil})
				return
			}
			g, gerr := p.gameFor(convID, user)
			if gerr != nil && !errors.Is(gerr, errGameNotFound) {
				http.Error(w, gerr.Error(), http.StatusInternalServerError)
				return
			}
			soup := p.IsSoupRoom(convID) || gerr == nil
			writeJSONOK(w, map[string]any{"soup": soup, "game": gameOrNil(g, gerr)})
		case len(parts) == 1 && r.Method == http.MethodPost:
			var req struct {
				ConvID  string `json:"conv_id"`
				StoryID string `json:"story_id"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			req.ConvID = strings.TrimSpace(req.ConvID)
			req.StoryID = strings.TrimSpace(req.StoryID)
			if req.ConvID == "" || req.StoryID == "" {
				http.Error(w, "conv_id 与 story_id 不能为空", http.StatusBadRequest)
				return
			}
			g, err := p.createGame(req.ConvID, req.StoryID, user)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSONOK(w, map[string]any{"game": g})
		case len(parts) == 3 && parts[2] == "end" && r.Method == http.MethodPost:
			g, err := p.endGame(parts[1], user)
			if errors.Is(err, errNotHost) {
				http.Error(w, err.Error(), http.StatusForbidden)
				return
			}
			if errors.Is(err, errGameNotFound) {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSONOK(w, map[string]any{"game": g})
		default:
			http.NotFound(w, r)
		}
		return
	}
	if len(parts) == 2 && parts[0] == "stories" && r.Method == http.MethodDelete {
		if err := p.deleteStory(parts[1], user); err != nil {
			if errors.Is(err, errStoryNotFound) {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONOK(w, map[string]any{"ok": true})
		return
	}
	http.NotFound(w, r)
}

// ---- 工具 ----

func runes(s string) int { return utf8.RuneCountInString(s) }

func newID() string {
	return base64.RawURLEncoding.EncodeToString(randomBytes(9))
}

var rndMu sync.Mutex

func randomBytes(n int) []byte {
	rndMu.Lock()
	defer rndMu.Unlock()
	b := make([]byte, n)
	_, _ = crand.Read(b)
	return b
}

func nowUnix() int64 { return time.Now().Unix() }

func writeJSONOK(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(payload)
}

// 兼容测试注入的文件系统钩子（默认指向真实磁盘）。
// 测试通过 os.Setenv 修改 Dir 即可隔离，无需额外钩子。
