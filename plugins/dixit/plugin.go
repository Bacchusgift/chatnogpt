package dixit

// 只言片语（Dixit）插件：抽屉面板型桌游插件。
// 每人 10 张手牌（程序化生成艺术的编号卡牌，前端动态渲染）；
// 讲者出一张暗牌并用一句话描述（走正常聊天消息），其他人从手牌里选一张回应；
// 全部出牌后亮牌投票，猜中讲者的是谁；按经典 Dixit 规则计分。
// 私密裁剪：手牌/暗牌/讲者卡只对持有者可见（与谜底同规则）。

import (
	"context"
	crand "crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"chatnogpt/plugins/pluginbase"
)

const (
	Prefix     = "/api/plugins/dixit"
	Name       = "dixit"
	Title      = "只言片语"
	Desc       = "Dixit 桌游：讲者出暗牌并描述，其他人出牌猜谜，经典计分"
	FrontendJS = "/plugins/dixit/dixit.js?v=2.5.0"
)

// 阶段：story=讲者出牌待描述 pick=成员选牌 vote=投票 reveal=结算展示
const (
	phaseStory  = "story"
	phasePick   = "pick"
	phaseVote   = "vote"
	phaseReveal = "reveal"
)

const (
	HandSize = 10
	DeckSize = 60
)

// WithUser / userIDFrom 为 pluginbase 统一身份契约的薄封装（与门禁注入一致）。
func WithUser(ctx context.Context, userID string) context.Context {
	return pluginbase.WithUser(ctx, userID)
}

func userIDFrom(ctx context.Context) string {
	return pluginbase.UserIDFrom(ctx)
}

type DPlayer struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
	Hand     []int  `json:"hand"`
	Score    int    `json:"score"`
}

type TableCard struct {
	PlayerIdx int `json:"player_idx"`
	Card      int `json:"card"`
}

type DixitState struct {
	ConvID     string         `json:"conv_id"`
	Players    []DPlayer      `json:"players"`
	Deck       []int          `json:"deck"`
	Phase      string         `json:"phase"`
	Round      int            `json:"round"`
	StoryIdx   int            `json:"story_idx"`
	StoryCard  int            `json:"story_card"`
	Clue       string         `json:"clue"`
	Table      []TableCard    `json:"table"`
	Votes      map[string]int `json:"votes"`
	LastResult string         `json:"last_result,omitempty"`
}

// MsgReaction 与基座 MsgReaction 结构对齐的本地投影（避免跨包耦合）
type MsgReaction = struct{}

type Config struct {
	DB  *sql.DB
	Dir string
}

type Plugin struct {
	cfg Config
	mu  sync.Mutex
}

func New(cfg Config) *Plugin { return &Plugin{cfg: cfg} }

// Meta 插件自描述：目录页、脚本注入与详情内容由基座从此派生。
func (p *Plugin) Meta() pluginbase.Meta {
	return pluginbase.Meta{
		Name:   Name,
		Title:  Title,
		Desc:   Desc,
		Icon:   "🎴",
		Script: FrontendJS,
		Detail: []pluginbase.DetailItem{
			{Type: "step", Text: "建房时对话模式选「只言片语」，每人发 10 张手牌；"},
			{Type: "step", Text: "讲者从手牌打出一张并附上一句描述（聊天消息发出）；"},
			{Type: "step", Text: "其他人从自己的手牌里选一张最贴合的牌打出；"},
			{Type: "step", Text: "全部出牌后亮牌投票：猜哪一张是讲者的牌；"},
			{Type: "step", Text: "经典 Dixit 计分：讲者骗过所有人 0 分，部分猜中讲者 +3；"},
			{Type: "note", Text: "卡牌插画为程序化生成的原创艺术 SVG，每张独一无二。"},
		},
	}
}

// Mount 自挂载：API 路由与前端脚本路由（均套基座门禁）。
func (p *Plugin) Mount(mux *http.ServeMux, gate pluginbase.Gate) {
	p.ensureSchema()
	mux.HandleFunc(strings.SplitN(FrontendJS, "?", 2)[0], p.FrontendJSHandler)
	mux.HandleFunc(Prefix, gate(p.handleRoot))
	mux.HandleFunc(Prefix+"/", gate(p.handleSub))
}

// FrontendJS 返回前端脚本内容（go:embed web/dixit.js）。
//
//go:embed web/dixit.js
var frontendJS string

func (p *Plugin) FrontendJSHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write([]byte(frontendJS))
}

// ensureSchema DB 模式建表（游戏状态整体存 JSON blob，便于复杂状态机）
func (p *Plugin) ensureSchema() {
	if p.cfg.DB == nil {
		return
	}
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS dx_games (
			conv_id VARCHAR(24) PRIMARY KEY,
			state MEDIUMTEXT NOT NULL,
			updated_at BIGINT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS dx_rooms (
			conv_id VARCHAR(24) PRIMARY KEY,
			created_at BIGINT NOT NULL
		)`,
	} {
		if _, err := p.cfg.DB.Exec(q); err != nil {
			return
		}
	}
}

// ---- 持久化：状态 blob ----

type fileData struct {
	Games map[string]string `json:"games"` // conv_id -> state JSON
	Rooms map[string]int64  `json:"rooms"`
}

func (p *Plugin) jsonPath() string { return p.cfg.Dir + "/plugins/dixit.json" }

func (p *Plugin) loadFile() (*fileData, error) {
	out := &fileData{Games: map[string]string{}, Rooms: map[string]int64{}}
	b, err := os.ReadFile(p.jsonPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return out, nil
		}
		return nil, err
	}
	if jerr := json.Unmarshal(b, out); jerr != nil {
		return nil, jerr
	}
	if out.Games == nil {
		out.Games = map[string]string{}
	}
	if out.Rooms == nil {
		out.Rooms = map[string]int64{}
	}
	return out, nil
}

func (p *Plugin) saveFile(fd *fileData) error {
	if err := os.MkdirAll(p.cfg.Dir+"/plugins", 0o755); err != nil {
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

func (p *Plugin) loadState(convID string) (*DixitState, error) {
	if p.cfg.DB != nil {
		var blob string
		err := p.cfg.DB.QueryRow("SELECT state FROM dx_games WHERE conv_id=?", convID).Scan(&blob)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errGameNotFound
		}
		if err != nil {
			return nil, err
		}
		var st DixitState
		if err := json.Unmarshal([]byte(blob), &st); err != nil {
			return nil, err
		}
		return &st, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	fd, err := p.loadFile()
	if err != nil {
		return nil, err
	}
	raw, ok := fd.Games[convID]
	if !ok {
		return nil, errGameNotFound
	}
	var st DixitState
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func (p *Plugin) saveState(st *DixitState) error {
	blob, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if p.cfg.DB != nil {
		_, err = p.cfg.DB.Exec(`INSERT INTO dx_games (conv_id, state, updated_at) VALUES (?,?,?)
			ON DUPLICATE KEY UPDATE state=VALUES(state), updated_at=VALUES(updated_at)`,
			st.ConvID, string(blob), nowUnix())
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	fd, err := p.loadFile()
	if err != nil {
		return err
	}
	fd.Games[st.ConvID] = string(blob)
	return p.saveFile(fd)
}

func (p *Plugin) RegisterRoom(convID string) error {
	if p.cfg.DB != nil {
		if _, err := p.cfg.DB.Exec(`INSERT INTO dx_rooms (conv_id, created_at) VALUES (?,?)
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

func (p *Plugin) IsDixitRoom(convID string) bool {
	if p.cfg.DB != nil {
		var one int
		if err := p.cfg.DB.QueryRow("SELECT 1 FROM dx_rooms WHERE conv_id=?", convID).Scan(&one); err != nil {
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

// ---- 游戏状态机 ----

var (
	errGameNotFound = errors.New("本房间还没有开始只言片语")
	errNotYourTurn  = errors.New("还没轮到你出牌")
	errPhase        = errors.New("当前阶段不能执行该操作")
	errBadCard      = errors.New("没有这张牌")
)

// StartGame 发牌开局：每位玩家 10 张（不重复），讲者为首位
func (p *Plugin) StartGame(convID string, players []DPlayer) (*DixitState, error) {
	deck := make([]int, DeckSize)
	for i := range deck {
		deck[i] = i + 1
	}
	for i := len(deck) - 1; i > 0; i-- {
		j := int(rndIntn(i + 1))
		deck[i], deck[j] = deck[j], deck[i]
	}
	st := &DixitState{
		ConvID: convID, Phase: phaseStory, Round: 1, StoryIdx: 0,
		Votes: map[string]int{},
	}
	for i := range players {
		hand := append([]int{}, deck[i*HandSize:(i+1)*HandSize]...)
		st.Players = append(st.Players, DPlayer{ID: players[i].ID, Nickname: players[i].Nickname, Hand: hand})
	}
	st.Deck = append([]int{}, deck[len(players)*HandSize:]...)
	return st, p.saveState(st)
}

// StoryPlay 讲者出暗牌（描述词由前端以聊天消息发出）
func (p *Plugin) StoryPlay(convID, userID string, card int) (*DixitState, error) {
	st, err := p.loadState(convID)
	if err != nil {
		return nil, err
	}
	if st.Phase != phaseStory {
		return nil, errPhase
	}
	if st.Players[st.StoryIdx].ID != userID {
		return nil, errNotYourTurn
	}
	hand := st.Players[st.StoryIdx].Hand
	ok := false
	for i, c := range hand {
		if c == card {
			hand = append(hand[:i], hand[i+1:]...)
			ok = true
			break
		}
	}
	if !ok {
		return nil, errBadCard
	}
	st.Players[st.StoryIdx].Hand = hand
	st.StoryCard = card
	st.Table = []TableCard{{PlayerIdx: st.StoryIdx, Card: card}}
	st.Phase = phasePick
	return st, p.saveState(st)
}

// SetClue 记录描述词（讲者的聊天消息发出后调用，仅存档）
func (p *Plugin) SetClue(convID, userID, clue string) (*DixitState, error) {
	st, err := p.loadState(convID)
	if err != nil {
		return nil, err
	}
	if st.Phase != phasePick && st.Phase != phaseStory {
		return nil, errPhase
	}
	if st.Players[st.StoryIdx].ID != userID {
		return nil, errNotYourTurn
	}
	if utf8.RuneCountInString(clue) < 1 || utf8.RuneCountInString(clue) > 60 {
		return nil, errors.New("描述词需为 1–60 字")
	}
	st.Clue = clue
	return st, p.saveState(st)
}

// Pick 成员选牌回应描述；全部出完 → 洗牌进入投票
func (p *Plugin) Pick(convID, userID string, card int) (*DixitState, error) {
	st, err := p.loadState(convID)
	if err != nil {
		return nil, err
	}
	if st.Phase != phasePick {
		return nil, errPhase
	}
	myIdx := -1
	for i := range st.Players {
		if st.Players[i].ID == userID {
			myIdx = i
			break
		}
	}
	if myIdx < 0 || myIdx == st.StoryIdx {
		return nil, errNotYourTurn
	}
	for _, tc := range st.Table {
		if tc.PlayerIdx == myIdx {
			return nil, errors.New("你已经出过牌了")
		}
	}
	hand := st.Players[myIdx].Hand
	for i, c := range hand {
		if c == card {
			st.Players[myIdx].Hand = append(hand[:i], hand[i+1:]...)
			st.Table = append(st.Table, TableCard{PlayerIdx: myIdx, Card: card})
			if len(st.Table) == len(st.Players) {
				for k := len(st.Table) - 1; k > 0; k-- {
					jj := int(rndIntn(k + 1))
					st.Table[k], st.Table[jj] = st.Table[jj], st.Table[k]
				}
				st.Phase = phaseVote
			}
			return st, p.saveState(st)
		}
	}
	return nil, errBadCard
}

// Vote 投票猜讲者的牌（桌面位置 1 基）；全员投完自动结算
func (p *Plugin) Vote(convID, userID string, pos int) (*DixitState, error) {
	st, err := p.loadState(convID)
	if err != nil {
		return nil, err
	}
	if st.Phase != phaseVote {
		return nil, errPhase
	}
	myIdx := -1
	for i := range st.Players {
		if st.Players[i].ID == userID {
			myIdx = i
			break
		}
	}
	if myIdx < 0 || myIdx == st.StoryIdx {
		return nil, errNotYourTurn
	}
	if pos < 1 || pos > len(st.Table) {
		return nil, errors.New("投票位置无效")
	}
	st.Votes[userID] = pos
	if len(st.Votes) == len(st.Players)-1 {
		dixitResolve(st)
	}
	return st, p.saveState(st)
}

// dixitResolve 经典 Dixit 计分 + 结算文案
func dixitResolve(st *DixitState) {
	storyPos := 0
	for i, tc := range st.Table {
		if tc.PlayerIdx == st.StoryIdx {
			storyPos = i + 1
			break
		}
	}
	found := 0
	guessers := len(st.Players) - 1
	for _, pos := range st.Votes {
		if pos == storyPos {
			found++
		}
	}
	deltas := map[int]int{}
	result := "讲者卡：第 " + itoa(storyPos) + " 张。"
	switch {
	case found == guessers:
		result += "全员猜中——讲者完美隐藏失败，众人各 +2。"
		for i := range st.Players {
			if i != st.StoryIdx {
				deltas[i] += 2
			}
		}
	case found == 0:
		result += "无人猜中——讲者成功骗过所有人（0 分），众人各 +2。"
		for i := range st.Players {
			if i != st.StoryIdx {
				deltas[i] += 2
			}
		}
	default:
		result += "讲者 +3，猜中者各 +1；被票到的牌主每票 +1。"
		deltas[st.StoryIdx] += 3
		for i := range st.Players {
			if i != st.StoryIdx {
				deltas[i]++
			}
		}
		voteCount := map[int]int{}
		for _, pos := range st.Votes {
			if pos != storyPos {
				tc := st.Table[pos-1]
				voteCount[tc.PlayerIdx]++
			}
		}
		for pi, n := range voteCount {
			if pi != st.StoryIdx {
				deltas[pi] += n
			}
		}
	}
	for i := range st.Players {
		st.Players[i].Score += deltas[i]
	}
	result += " 得分：" + scoreLine(st.Players, deltas)
	st.LastResult = result
	st.Phase = phaseReveal
	st.Votes = map[string]int{}
}

// Next 结束本回合：讲者轮转到下一位，补牌至 10 张，进入 story 阶段
func (p *Plugin) Next(convID, userID string) (*DixitState, error) {
	st, err := p.loadState(convID)
	if err != nil {
		return nil, err
	}
	if st.Phase != phaseReveal {
		return nil, errPhase
	}
	st.Round++
	st.StoryIdx = (st.StoryIdx + 1) % len(st.Players)
	st.Table = nil
	st.Clue = ""
	st.LastResult = ""
	st.Phase = phaseStory
	deck := st.Deck
	for i := range st.Players {
		hand := st.Players[i].Hand
		for len(hand) < HandSize && len(deck) > 0 {
			hand = append(hand, deck[0])
			deck = deck[1:]
		}
		st.Players[i].Hand = hand
	}
	st.Deck = deck
	return st, p.saveState(st)
}

// View 按查看者裁剪的视图：自己的手牌；暗牌/归属在揭示前隐藏
func (p *Plugin) View(convID, userID string) (map[string]any, error) {
	st, err := p.loadState(convID)
	if err != nil {
		return nil, err
	}
	myIdx := -1
	for i := range st.Players {
		if st.Players[i].ID == userID {
			myIdx = i
			break
		}
	}
	revealed := st.Phase == phaseReveal
	table := make([]map[string]any, 0, len(st.Table))
	for i, tc := range st.Table {
		entry := map[string]any{"pos": i + 1, "card": tc.Card}
		if revealed {
			entry["player_idx"] = tc.PlayerIdx
			entry["nickname"] = st.Players[tc.PlayerIdx].Nickname
		} else {
			entry["player_idx"] = -1
		}
		table = append(table, entry)
	}
	me := map[string]any{}
	if myIdx >= 0 {
		played := false
		for _, tc := range st.Table {
			if tc.PlayerIdx == myIdx {
				played = true
				break
			}
		}
		me = map[string]any{
			"idx": myIdx, "hand": st.Players[myIdx].Hand, "score": st.Players[myIdx].Score,
			"is_story": myIdx == st.StoryIdx, "played": played,
			"voted": st.Votes[userID] > 0,
		}
	}
	players := []map[string]any{}
	for i := range st.Players {
		players = append(players, map[string]any{
			"id": st.Players[i].ID, "nickname": st.Players[i].Nickname,
			"score": st.Players[i].Score, "is_story": i == st.StoryIdx,
		})
	}
	return map[string]any{
		"game": map[string]any{
			"conv_id": st.ConvID, "phase": st.Phase, "round": st.Round,
			"clue": st.Clue, "story_nickname": st.Players[st.StoryIdx].Nickname,
			"table": table, "players": players, "me": me,
			"last_result":   st.LastResult,
			"vote_progress": itoa(len(st.Votes)) + "/" + itoa(len(st.Players)-1),
			"pick_progress": itoa(len(st.Table)) + "/" + itoa(len(st.Players)),
		},
	}, nil
}

// ---- HTTP ----

func (p *Plugin) handleRoot(w http.ResponseWriter, r *http.Request) {
	user := userIDFrom(r.Context())
	switch r.Method {
	case http.MethodGet:
		if !p.IsDixitRoom(r.URL.Query().Get("conv")) {
			writeJSONOK(w, map[string]any{"dixit": false})
			return
		}
		v, err := p.View(r.URL.Query().Get("conv"), user)
		if err != nil {
			writeJSONOK(w, map[string]any{"dixit": true, "game": nil})
			return
		}
		v["dixit"] = true
		writeJSONOK(w, v)
	case http.MethodPost:
		var req struct {
			ConvID  string    `json:"conv_id"`
			Players []DPlayer `json:"players"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.ConvID == "" || len(req.Players) < 3 {
			http.Error(w, "需要 conv_id 与至少 3 名玩家", http.StatusBadRequest)
			return
		}
		if _, err := p.StartGame(req.ConvID, req.Players); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		v, _ := p.View(req.ConvID, user)
		writeJSONOK(w, v)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (p *Plugin) handleSub(w http.ResponseWriter, r *http.Request) {
	user := userIDFrom(r.Context())
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, Prefix+"/"), "/")
	parts := strings.Split(rest, "/")
	if len(parts) == 1 && parts[0] == "stories" {
		p.handleStoriesMeta(w, r)
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
		if err := p.RegisterRoom(req.ConvID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONOK(w, map[string]any{"ok": true})
		return
	}
	if len(parts) == 1 && parts[0] == "games" && r.Method == http.MethodGet {
		convQ := r.URL.Query().Get("conv_id")
		if convQ == "" {
			convQ = r.URL.Query().Get("conv")
		}
		v, err := p.View(convQ, user)
		if err != nil {
			writeJSONOK(w, map[string]any{"game": nil})
			return
		}
		writeJSONOK(w, v)
		return
	}
	if len(parts) == 1 && parts[0] == "games" && r.Method == http.MethodPost {
		var req struct {
			ConvID  string    `json:"conv_id"`
			Players []DPlayer `json:"players"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.ConvID == "" || len(req.Players) < 3 {
			http.Error(w, "需要 conv_id 与至少 3 名玩家", http.StatusBadRequest)
			return
		}
		if _, err := p.StartGame(req.ConvID, req.Players); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		v, _ := p.View(req.ConvID, user)
		writeJSONOK(w, v)
		return
	}
	if len(parts) < 2 || parts[0] != "games" {
		http.NotFound(w, r)
		return
	}
	convID := ""
	if len(parts) >= 2 {
		convID = parts[1]
	}
	if len(parts) == 2 && r.Method == http.MethodGet {
		v, err := p.View(convID, user)
		if err != nil {
			writeJSONOK(w, map[string]any{"game": nil})
			return
		}
		writeJSONOK(w, v)
		return
	}
	if len(parts) == 3 && (r.Method == http.MethodPost || r.Method == http.MethodPut) {
		action := parts[2]
		var respStatus int
		defer func() {
			log.Println("[dixit-dbg] resp action=" + action + " status=" + itoa(respStatus))
		}()
		w2 := &statusWriter{ResponseWriter: w, status: 200}
		defer func() {
			respStatus = w2.status
			log.Println("[dixit-dbg] resp action=" + action + " status=" + itoa(w2.status))
		}()
		var req struct {
			Card int    `json:"card"`
			Clue string `json:"clue"`
			Pos  int    `json:"pos"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var st *DixitState
		_ = st
		var err error
		switch action {
		case "story":
			st, err = p.StoryPlay(convID, user, req.Card)
		case "clue":
			st, err = p.SetClue(convID, user, req.Clue)
		case "pick":
			st, err = p.Pick(convID, user, req.Card)
		case "vote":
			st, err = p.Vote(convID, user, req.Pos)
		case "next":
			st, err = p.Next(convID, user)
		default:
			http.NotFound(w, r)
			return
		}
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, errGameNotFound) || errors.Is(err, errBadCard) {
				status = http.StatusNotFound
			}
			if errors.Is(err, errNotYourTurn) || errors.Is(err, errPhase) ||
				strings.Contains(err.Error(), "你已经出过牌了") ||
				strings.Contains(err.Error(), "不能投自己出的牌") ||
				strings.Contains(err.Error(), "投票位置无效") ||
				strings.Contains(err.Error(), "描述词需为") {
				status = http.StatusForbidden
			}
			http.Error(w, err.Error(), status)
			return
		}
		v, verr := p.View(convID, user)
		if verr != nil {
			http.Error(w, verr.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONOK(w, v)
		return
	}
	http.NotFound(w, r)
}

// handleStoriesMeta 目录页详情数据（步骤由 Meta.Detail 承载，此处仅返回占位）
func (p *Plugin) handleStoriesMeta(w http.ResponseWriter, r *http.Request) {
	writeJSONOK(w, map[string]any{"stories": []string{}})
}

// ---- 工具 ----

func scoreLine(players []DPlayer, deltas map[int]int) string {
	parts := []string{}
	for i := range players {
		d := deltas[i]
		mark := ""
		if d >= 0 {
			mark = "+"
		}
		parts = append(parts, players[i].Nickname+" "+mark+itoa(d)+"（"+itoa(players[i].Score)+"）")
	}
	return strings.Join(parts, "，")
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	digits := ""
	for i > 0 {
		digits = string(rune('0'+i%10)) + digits
		i /= 10
	}
	if neg {
		digits = "-" + digits
	}
	return digits
}

func rndIntn(n int) int {
	b := make([]byte, 4)
	if _, err := crand.Read(b); err != nil {
		return int(time.Now().UnixNano()) % n
	}
	v := int(b[0]) | int(b[1])<<8 | int(b[2])<<16 | int(b[3])<<24
	if v < 0 {
		v = -v
	}
	return v % n
}

func nowUnix() int64 { return time.Now().Unix() }

func writeJSONOK(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(payload)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	return w.ResponseWriter.Write(b)
}
