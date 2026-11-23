// Package guessnumber implements a multiplayer number guessing game.
package guessnumber

import (
	"chatnogpt/plugins/pluginbase"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const Name = "guess-number"
const script = "/plugins/guess-number/guess-number.js?v=1.0.0"
const api = "/api/plugins/guess-number"

type Player struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
}
type Config struct {
	DB      *sql.DB
	Dir     string
	Members func(string, string) ([]Player, error)
}
type Game struct {
	ConvID   string   `json:"conv_id"`
	Setter   string   `json:"setter"`
	Players  []Player `json:"players"`
	Secret   int      `json:"secret"`
	Phase    string   `json:"phase"`
	Turn     int      `json:"turn"`
	Low      int      `json:"low"`
	High     int      `json:"high"`
	Last     string   `json:"last"`
	Exploded string   `json:"exploded,omitempty"`
}
type Plugin struct {
	cfg Config
	mu  sync.Mutex
}

func New(c Config) *Plugin { return &Plugin{cfg: c} }
func (p *Plugin) Meta() pluginbase.Meta {
	return pluginbase.Meta{Name: Name, Title: "猜数字", Icon: "💣", Desc: "轮流猜数字，猜中数字的人爆炸", Script: script, RoomModes: []pluginbase.RoomMode{{ID: Name, Label: "猜数字"}}, Detail: []pluginbase.DetailItem{{Type: "step", Text: "创建群聊时选择猜数字，至少邀请两位成员。"}, {Type: "step", Text: "发起人在右侧游戏面板秘密设定 1～100 的整数。"}, {Type: "step", Text: "其他成员按顺序猜，系统提示偏大或偏小；猜中数字的人爆炸，本局结束。"}}}
}

//go:embed web/guess-number.js
var frontend string

func (p *Plugin) Mount(m *http.ServeMux, gate pluginbase.Gate) {
	if p.cfg.DB != nil {
		_, _ = p.cfg.DB.Exec(`CREATE TABLE IF NOT EXISTS guess_number_games (conv_id VARCHAR(24) PRIMARY KEY, state MEDIUMTEXT NOT NULL, updated_at BIGINT NOT NULL)`)
	}
	m.HandleFunc(strings.Split(script, "?")[0], func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=300")
		fmt.Fprint(w, frontend)
	})
	m.HandleFunc(api, gate(p.handle))
}
func (p *Plugin) load(id string) (*Game, error) {
	var b []byte
	if p.cfg.DB != nil {
		var s string
		if e := p.cfg.DB.QueryRow("SELECT state FROM guess_number_games WHERE conv_id=?", id).Scan(&s); e != nil {
			return nil, e
		}
		b = []byte(s)
	} else {
		var e error
		b, e = os.ReadFile(filepath.Join(p.cfg.Dir, "plugins", "guess-number", id+".json"))
		if e != nil {
			return nil, e
		}
	}
	var g Game
	if e := json.Unmarshal(b, &g); e != nil {
		return nil, e
	}
	return &g, nil
}
func (p *Plugin) save(g *Game) error {
	b, e := json.Marshal(g)
	if e != nil {
		return e
	}
	if p.cfg.DB != nil {
		_, e = p.cfg.DB.Exec(`INSERT INTO guess_number_games (conv_id,state,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE state=VALUES(state),updated_at=VALUES(updated_at)`, g.ConvID, string(b), time.Now().Unix())
		return e
	}
	dir := filepath.Join(p.cfg.Dir, "plugins", "guess-number")
	if e = os.MkdirAll(dir, 0755); e != nil {
		return e
	}
	tmp := filepath.Join(dir, g.ConvID+".tmp")
	if e = os.WriteFile(tmp, b, 0600); e != nil {
		return e
	}
	return os.Rename(tmp, filepath.Join(dir, g.ConvID+".json"))
}
func (p *Plugin) handle(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ConvID string `json:"conv_id"`
		Action string `json:"action"`
		Number *int   `json:"number"`
	}
	if r.Method == http.MethodGet {
		req.ConvID = r.URL.Query().Get("conv_id")
	} else if r.Method == http.MethodPost {
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req) != nil {
			writeError(w, "请求无效", 400)
			return
		}
	} else {
		writeError(w, "method not allowed", 405)
		return
	}
	id := req.ConvID
	user := pluginbase.UserIDFrom(r.Context())
	if id == "" || strings.ContainsAny(id, "/\\.") {
		writeError(w, "会话无效", 400)
		return
	}
	members, err := p.cfg.Members(id, user)
	if err != nil {
		writeError(w, "无权访问该群聊", 403)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	g, err := p.load(id)
	if err != nil && !errors.Is(err, os.ErrNotExist) && !errors.Is(err, sql.ErrNoRows) {
		writeError(w, "读取游戏失败", 500)
		return
	}
	if r.Method == http.MethodPost {
		switch req.Action {
		case "create":
			if g != nil {
				writeError(w, "游戏已创建", 409)
				return
			}
			if len(members) < 3 {
				writeError(w, "至少需要 3 名群成员", 400)
				return
			}
			g = &Game{ConvID: id, Setter: user, Players: members, Phase: "setup", Low: 1, High: 100, Last: "等待出题人设置秘密数字。"}
		case "reset":
			if g == nil || g.Phase != "result" {
				writeError(w, "本局尚未结束", 400)
				return
			}
			if len(members) < 3 {
				writeError(w, "至少需要 3 名群成员", 400)
				return
			}
			g = &Game{ConvID: id, Setter: user, Players: members, Phase: "setup", Low: 1, High: 100, Last: "等待出题人设置秘密数字。"}
		case "set":
			if g == nil || g.Phase != "setup" || g.Setter != user {
				writeError(w, "只有本局出题人可以设置数字", 403)
				return
			}
			if req.Number == nil || *req.Number < 1 || *req.Number > 100 {
				writeError(w, "请输入 1 到 100 的整数", 400)
				return
			}
			g.Secret = *req.Number
			g.Phase = "guess"
			g.Turn = firstGuesser(g)
			g.Last = "数字已设定，开始猜数字。"
		case "guess":
			if g == nil || g.Phase != "guess" || g.Turn < 0 || g.Turn >= len(g.Players) || g.Players[g.Turn].ID != user {
				writeError(w, "还没有轮到你猜", 403)
				return
			}
			if req.Number == nil || *req.Number < g.Low || *req.Number > g.High {
				writeError(w, "请输入当前范围内的整数", 400)
				return
			}
			n := *req.Number
			name := g.Players[g.Turn].Nickname
			if n == g.Secret {
				g.Phase = "result"
				g.Exploded = name
				g.Last = fmt.Sprintf("💥 %s 猜中 %d，爆炸了！", name, n)
			} else {
				if n < g.Secret {
					g.Low = n + 1
					g.Last = fmt.Sprintf("%s 猜了 %d：偏小。", name, n)
				} else {
					g.High = n - 1
					g.Last = fmt.Sprintf("%s 猜了 %d：偏大。", name, n)
				}
				g.Turn = nextGuesser(g)
			}
		default:
			writeError(w, "未知操作", 400)
			return
		}
		if err = p.save(g); err != nil {
			writeError(w, "保存游戏失败", 500)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if g == nil {
		json.NewEncoder(w).Encode(map[string]any{"game": nil})
		return
	}
	view := *g
	view.Secret = 0
	if g.Phase == "result" || user == g.Setter {
		view.Secret = g.Secret
	}
	json.NewEncoder(w).Encode(map[string]any{"game": view})
}
func firstGuesser(g *Game) int {
	for i, p := range g.Players {
		if p.ID != g.Setter {
			return i
		}
	}
	return -1
}
func nextGuesser(g *Game) int {
	for n := 1; n <= len(g.Players); n++ {
		i := (g.Turn + n) % len(g.Players)
		if g.Players[i].ID != g.Setter {
			return i
		}
	}
	return -1
}

func writeError(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
