package undercover

// 谁是卧底插件：抽屉面板型派对游戏。
// 每人获得一个词语：多数人拿「平民词」，1 人拿「卧底词」（相近但不同）。
// 按轮描述（聊天里说），投票放逐，找出卧底则平民胜；卧底存活到 2 人则卧底胜。

import (
	"chatnogpt/plugins/pluginbase"
	"context"
	crand "crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	Prefix     = "/api/plugins/undercover"
	Name       = "undercover"
	Title      = "谁是卧底"
	Desc       = "经典派对游戏：暗词描述与投票放逐，找出卧底"
	FrontendJS = "/plugins/undercover/undercover.js?v=2.5.0.1"
)

// WithUser / userIDFrom 为 pluginbase 统一身份契约的薄封装（与门禁注入一致）。
func WithUser(ctx context.Context, userID string) context.Context {
	return pluginbase.WithUser(ctx, userID)
}

func userIDFrom(ctx context.Context) string {
	return pluginbase.UserIDFrom(ctx)
}

// 阶段：describe=轮流描述 vote=投票 result=已结束（胜负已分）
const (
	phaseDescribe = "describe"
	phaseVote     = "vote"
	phaseResult   = "result"
)

type UPlayer struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
	Word     string `json:"word"` // 私密：仅本人可见（View 按身份裁剪）
	IsUnder  bool   `json:"is_under"`
	Alive    bool   `json:"alive"`
}

type UState struct {
	ConvID    string            `json:"conv_id"`
	Players   []UPlayer         `json:"players"`
	Round     int               `json:"round"`
	Phase     string            `json:"phase"`
	Described map[string]bool   `json:"described"` // 本轮已描述的玩家
	Votes     map[string]string `json:"votes"`     // voterID -> 被投票玩家 id
	LastEvent string            `json:"last_event,omitempty"`
	Winner    string            `json:"winner,omitempty"` // "civ" | "under" | ""
}

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
		Icon:   "🕵",
		Script: FrontendJS,
		Detail: []pluginbase.DetailItem{
			{Type: "step", Text: "建房时对话模式选「谁是卧底」：多数人拿平民词，1 人拿相近的卧底词；"},
			{Type: "step", Text: "按轮在聊天里用一句话描述自己的词——既能让队友明白，也别暴露给卧底；"},
			{Type: "step", Text: "全员描述完进入投票，得票最高者出局（平票无人出局）；"},
			{Type: "step", Text: "找出卧底则平民胜；卧底存活到最后则卧底胜利；"},
			{Type: "note", Text: "你的词语只有你自己可见，发言时注意不要直接说出词本身。"},
		},
	}
}

// Mount 自挂载：API 路由与前端脚本路由（均套基座门禁）。
func (p *Plugin) Mount(mux *http.ServeMux, gate pluginbase.Gate) {
	p.ensureSchema()
	mux.HandleFunc(strings.SplitN(FrontendJS, "?", 2)[0], p.FrontendJSHandler)
	p.Register(mux, Prefix, gate)
}

// Register mounts the plugin's routes under prefix. gate 由基座提供。
func (p *Plugin) Register(mux *http.ServeMux, prefix string, gate func(http.HandlerFunc) http.HandlerFunc) {
	p.ensureSchema()
	mux.HandleFunc(prefix, gate(p.handleRoot))
	mux.HandleFunc(prefix+"/", gate(p.handleSub))
}

//go:embed web/undercover.js
var frontendJS string

func (p *Plugin) FrontendJSHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write([]byte(frontendJS))
}

// ensureSchema 状态整体存 JSON blob
func (p *Plugin) ensureSchema() {
	if p.cfg.DB == nil {
		return
	}
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS uc_games (
			conv_id VARCHAR(24) PRIMARY KEY,
			state MEDIUMTEXT NOT NULL,
			updated_at BIGINT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS uc_rooms (
			conv_id VARCHAR(24) PRIMARY KEY,
			created_at BIGINT NOT NULL
		)`,
	} {
		if _, err := p.cfg.DB.Exec(q); err != nil {
			return
		}
	}
}

// ---- 持久化 ----

type fileData struct {
	Games map[string]string `json:"games"`
	Rooms map[string]int64  `json:"rooms"`
}

func (p *Plugin) jsonPath() string { return p.cfg.Dir + "/plugins/undercover.json" }

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

func (p *Plugin) loadState(convID string) (*UState, error) {
	if p.cfg.DB != nil {
		var blob string
		err := p.cfg.DB.QueryRow("SELECT state FROM uc_games WHERE conv_id=?", convID).Scan(&blob)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errGameNotFound
		}
		if err != nil {
			return nil, err
		}
		var st UState
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
	var st UState
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func (p *Plugin) saveState(st *UState) error {
	blob, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if p.cfg.DB != nil {
		_, err = p.cfg.DB.Exec(`INSERT INTO uc_games (conv_id, state, updated_at) VALUES (?,?,?)
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
		if _, err := p.cfg.DB.Exec(`INSERT INTO uc_rooms (conv_id, created_at) VALUES (?,?)
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

func (p *Plugin) IsUCRoom(convID string) bool {
	if p.cfg.DB != nil {
		var one int
		if err := p.cfg.DB.QueryRow("SELECT 1 FROM uc_rooms WHERE conv_id=?", convID).Scan(&one); err != nil {
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
	errGameNotFound = errors.New("本房间还没有开始谁是卧底")
	errPhase        = errors.New("当前阶段不能执行该操作")
	errNotPlayer    = errors.New("你不是本局玩家")
	errAlready      = errors.New("你已经操作过了")
	errNotAlive     = errors.New("玩家已出局")
)

// StartGame 开局：随机分配词语（1 名卧底）
func (p *Plugin) StartGame(convID string, players []UPlayer) (*UState, error) {
	if len(players) < 3 {
		return nil, errors.New("至少需要 3 名玩家")
	}
	civ, under := randomPair()
	underIdx := rndIntn(len(players))
	st := &UState{
		ConvID: convID, Round: 1, Phase: phaseDescribe,
		Described: map[string]bool{}, Votes: map[string]string{},
	}
	for i := range players {
		p := players[i]
		p.Word = civ
		p.IsUnder = false
		p.Alive = true
		if i == underIdx {
			p.Word = under
			p.IsUnder = true
		}
		st.Players = append(st.Players, p)
	}
	st.LastEvent = "第 1 轮描述开始，每人轮流用一句话描述自己的词。"
	return st, p.saveState(st)
}

// MarkDescribed 标记自己本轮已描述
func (p *Plugin) MarkDescribed(convID, userID string) (*UState, error) {
	st, err := p.loadState(convID)
	if err != nil {
		return nil, err
	}
	if st.Phase != phaseDescribe {
		return nil, errPhase
	}
	for i := range st.Players {
		if st.Players[i].ID == userID {
			if !st.Players[i].Alive {
				return nil, errNotAlive
			}
			if st.Described[userID] {
				return nil, errAlready
			}
			st.Described[userID] = true
			break
		}
	}
	// 全部描述完 → 进入投票
	alive := 0
	done := 0
	for _, pl := range st.Players {
		if pl.Alive {
			alive++
			if st.Described[pl.ID] {
				done++
			}
		}
	}
	if done == alive {
		st.Phase = phaseVote
		st.Votes = map[string]string{}
	}
	return st, p.saveState(st)
}

// Vote 投票放逐；全员投完自动结算
func (p *Plugin) Vote(convID, userID, target string) (*UState, error) {
	st, err := p.loadState(convID)
	if err != nil {
		return nil, err
	}
	if st.Phase != phaseVote {
		return nil, errPhase
	}
	meAlive := false
	alive := 0
	targetAlive := false
	for i := range st.Players {
		if st.Players[i].Alive {
			alive++
			if st.Players[i].ID == userID {
				meAlive = true
			}
			if st.Players[i].ID == target {
				targetAlive = true
			}
		}
	}
	if !meAlive {
		return nil, errNotPlayer
	}
	if !targetAlive {
		return nil, errNotAlive
	}
	if userID == target {
		return nil, errors.New("不能投自己")
	}
	st.Votes[userID] = target
	if len(st.Votes) == alive {
		p.resolve(st)
	}
	return st, p.saveState(st)
}

// resolve 得票最高者出局（平票无人出局），并判定胜负
func (p *Plugin) resolve(st *UState) {
	tally := map[string]int{}
	aliveIDs := []string{}
	for i := range st.Players {
		if st.Players[i].Alive {
			aliveIDs = append(aliveIDs, st.Players[i].ID)
		}
	}
	for _, v := range st.Votes {
		tally[v]++
	}
	top, topN, tie := "", 0, false
	for _, id := range aliveIDs {
		n := tally[id]
		if n > topN {
			top, topN, tie = id, n, false
		} else if n == topN && n > 0 {
			tie = true
		}
	}
	evicted := ""
	if !tie && topN > 0 {
		for i := range st.Players {
			if st.Players[i].ID == top {
				st.Players[i].Alive = false
				evicted = st.Players[i].Nickname
				if st.Players[i].IsUnder {
					st.Winner = "civ"
				}
				break
			}
		}
	}
	// 胜负判定
	underAlive, civAlive := 0, 0
	for i := range st.Players {
		if st.Players[i].Alive {
			if st.Players[i].IsUnder {
				underAlive++
			} else {
				civAlive++
			}
		}
	}
	if underAlive == 0 {
		st.Winner = "civ"
	} else if underAlive >= civAlive {
		st.Winner = "under"
	}
	// 事件文案
	switch {
	case st.Winner == "civ":
		st.LastEvent = "卧底「" + evictedLabel(st, evicted) + "」被找出——平民胜利！"
	case st.Winner == "under":
		st.LastEvent = "卧底存活到最后——卧底胜利！"
	case tie:
		st.LastEvent = "平票，本轮无人出局，进入下一轮描述。"
	default:
		st.LastEvent = "「" + evicted + "」被放逐，进入下一轮描述。"
	}
	if st.Winner == "" {
		st.Round++
		st.Phase = phaseDescribe
		st.Described = map[string]bool{}
		st.Votes = map[string]string{}
	} else {
		st.Phase = phaseResult
		st.Votes = map[string]string{}
	}
}

func evictedLabel(st *UState, nickname string) string {
	for i := range st.Players {
		if st.Players[i].Nickname == nickname {
			if st.Players[i].IsUnder {
				return nickname + "（卧底）"
			}
			return nickname + "（平民）"
		}
	}
	return nickname
}

// View 按查看者裁剪：只显示自己的词；他人词永不下发
func (p *Plugin) View(convID, userID string) (map[string]any, error) {
	st, err := p.loadState(convID)
	if err != nil {
		return nil, err
	}
	players := []map[string]any{}
	myWord := ""
	for i := range st.Players {
		pl := st.Players[i]
		entry := map[string]any{
			"id": pl.ID, "nickname": pl.Nickname, "alive": pl.Alive,
			"described": st.Described[pl.ID], "is_under": false,
		}
		if pl.ID == userID {
			entry["is_under"] = pl.IsUnder
			entry["my_word"] = pl.Word
			myWord = pl.Word
		}
		players = append(players, entry)
	}
	aliveCount := 0
	described := 0
	voted := 0
	for _, pl := range st.Players {
		if pl.Alive {
			aliveCount++
			if st.Described[pl.ID] {
				described++
			}
		}
	}
	if _, ok := st.Votes[userID]; ok {
		voted = 1
	}
	return map[string]any{
		"game": map[string]any{
			"conv_id": st.ConvID, "phase": st.Phase, "round": st.Round,
			"players": players, "me": myWord, "alive": aliveCount,
			"described": described, "voted": voted,
			"last_event": st.LastEvent, "winner": st.Winner,
		},
	}, nil
}

// ---- HTTP ----

func (p *Plugin) handleRoot(w http.ResponseWriter, r *http.Request) {
	user := userIDFrom(r.Context())
	switch r.Method {
	case http.MethodGet:
		if !p.IsUCRoom(r.URL.Query().Get("conv")) {
			writeJSONOK(w, map[string]any{"uc": false})
			return
		}
		v, err := p.View(r.URL.Query().Get("conv"), user)
		if err != nil {
			writeJSONOK(w, map[string]any{"uc": true, "game": nil})
			return
		}
		v["uc"] = true
		writeJSONOK(w, v)
	case http.MethodPost:
		var req struct {
			ConvID  string    `json:"conv_id"`
			Players []UPlayer `json:"players"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.ConvID == "" || len(req.Players) < 3 {
			http.Error(w, "需要 conv_id 与至少 3 名玩家", http.StatusBadRequest)
			return
		}
		for i := range req.Players {
			req.Players[i].Word = ""
			req.Players[i].IsUnder = false
			req.Players[i].Alive = true
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
	if len(parts) == 1 && parts[0] == "games" && r.Method == http.MethodPost {
		var req struct {
			ConvID  string    `json:"conv_id"`
			Players []UPlayer `json:"players"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.ConvID == "" || len(req.Players) < 3 {
			http.Error(w, "需要 conv_id 与至少 3 名玩家", http.StatusBadRequest)
			return
		}
		for i := range req.Players {
			req.Players[i].Word = ""
			req.Players[i].IsUnder = false
			req.Players[i].Alive = true
		}
		if _, err := p.StartGame(req.ConvID, req.Players); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		v, _ := p.View(req.ConvID, user)
		writeJSONOK(w, v)
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
	if len(parts) < 2 || parts[0] != "games" {
		http.NotFound(w, r)
		return
	}
	convID := parts[1]
	if len(parts) == 2 && r.Method == http.MethodGet {
		v, err := p.View(convID, user)
		if err != nil {
			writeJSONOK(w, map[string]any{"game": nil})
			return
		}
		writeJSONOK(w, v)
		return
	}
	if len(parts) == 3 && r.Method == http.MethodPost {
		action := parts[2]
		var req struct {
			Target string `json:"target"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var st *UState
		var err error
		switch action {
		case "described":
			st, err = p.MarkDescribed(convID, user)
		case "vote":
			st, err = p.Vote(convID, user, req.Target)
		default:
			http.NotFound(w, r)
			return
		}
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, errGameNotFound) {
				status = http.StatusNotFound
			}
			if errors.Is(err, errNotPlayer) || errors.Is(err, errNotAlive) ||
				errors.Is(err, errAlready) || errors.Is(err, errPhase) {
				status = http.StatusForbidden
			}
			http.Error(w, err.Error(), status)
			return
		}
		_ = st
		v, _ := p.View(convID, user)
		writeJSONOK(w, v)
		return
	}
	http.NotFound(w, r)
}

// ---- 工具 ----

func nowUnix() int64 { return time.Now().Unix() }

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

func writeJSONOK(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(payload)
}
