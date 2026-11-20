package novelreader

// NovelReader 插件：自定义阅读模型（番茄小说链接 / TXT 续读）。
// 以基座插件形式独立开发：路由挂载在 /api/plugins/novel-reader/ 下，
// 由基座按用户启用状态做门禁；持久化跟随基座（MySQL / data.json 双模式），
// 旧版散落在 data.json 的 custom_models 会在首次访问时自动迁入本插件文件。

import (
	"context"
	crand "crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	Prefix     = "/api/plugins/novel-reader"
	Name       = "novel-reader"
	Title      = "小说阅读"
	Desc       = "自定义阅读模型：番茄小说链接续读、TXT 上传阅读、章节透视"
	FrontendJS = "/plugins/novel-reader/novel.js"
)

type ctxKey struct{}

// WithUser 由基座门禁注入调用者身份。
func WithUser(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, ctxKey{}, userID)
}

func userIDFrom(ctx context.Context) string {
	v, _ := ctx.Value(ctxKey{}).(string)
	return v
}

type Model struct {
	ID            string `json:"id"`
	OwnerID       string `json:"owner_id"`
	Name          string `json:"name"`
	URL           string `json:"url,omitempty"`
	Text          string `json:"text,omitempty"`
	Position      int64  `json:"position"`
	ChapterID     string `json:"chapter_id,omitempty"`
	ChapterOffset int64  `json:"chapter_offset,omitempty"`
	CreatedAt     int64  `json:"created_at"`
}

type Config struct {
	// DB 数据库模式句柄；nil 时插件使用数据目录内的独立 JSON 文件。
	DB *sql.DB
	// Dir 基座数据目录（文件模式持久化 + 旧数据迁移来源）。
	Dir string
}

type Plugin struct {
	cfg Config
	mu  sync.Mutex // 序列化文件模式的读写
}

func New(cfg Config) *Plugin {
	return &Plugin{cfg: cfg}
}

// Register mounts the plugin's routes under prefix. gate 由基座提供：
// 已完成鉴权与按用户启用检查的处理器包装。
func (p *Plugin) Register(mux *http.ServeMux, prefix string, gate func(http.HandlerFunc) http.HandlerFunc) {
	log.Println("DEBUG Register:", prefix)
	mux.HandleFunc(prefix, gate(p.handleModels))
	mux.HandleFunc(prefix+"/", gate(p.handleModelSub))
}

// FrontendJS 返回前端脚本内容（go:embed web/novel.js）。
//
//go:embed web/novel.js
var frontendJS string

func (p *Plugin) FrontendJSHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write([]byte(frontendJS))
}

// ---- 持久化：DB 模式走 custom_models 表；文件模式走插件自有 JSON ----

type fileData struct {
	Models map[string]*Model `json:"models"`
}

func (p *Plugin) jsonPath() string {
	return filepath.Join(p.cfg.Dir, "plugins", Name+".json")
}

// loadFileModels 读取文件模式数据；首次访问时自动迁入旧版 data.json 里的
// custom_models 字段（v1.8 及之前散落在基座数据文件中）。
func (p *Plugin) loadFileModels() (map[string]*Model, error) {
	out := map[string]*Model{}
	if b, err := os.ReadFile(p.jsonPath()); err == nil {
		// 文件带 {"models": {...}} 包装层，必须按 wrapper 解析
		var fd fileData
		if jerr := json.Unmarshal(b, &fd); jerr != nil {
			return nil, jerr
		}
		for _, m := range fd.Models {
			if m != nil {
				out[m.ID] = m
			}
		}
		return out, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	// 旧数据迁移：data.json 的 custom_models 字段 -> 插件自有文件
	if lb, lerr := os.ReadFile(filepath.Join(p.cfg.Dir, "data.json")); lerr == nil {
		var legacy struct {
			CustomModels map[string]*Model `json:"custom_models"`
		}
		if json.Unmarshal(lb, &legacy) == nil {
			for _, m := range legacy.CustomModels {
				if m != nil {
					out[m.ID] = m
				}
			}
		}
	}
	return out, nil
}

func (p *Plugin) saveFileModels(models map[string]*Model) error {
	if err := os.MkdirAll(filepath.Dir(p.jsonPath()), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(&fileData{Models: models}, "", "  ")
	if err != nil {
		return err
	}
	tmp := p.jsonPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p.jsonPath())
}

var errModelNotFound = errors.New("阅读模型不存在")

func (p *Plugin) listModels(ownerID string) ([]Model, error) {
	if p.cfg.DB != nil {
		rows, err := p.cfg.DB.Query(`SELECT id, owner_id, name, url, position, chapter_id, chapter_offset, created_at
			FROM custom_models WHERE owner_id=? ORDER BY created_at`, ownerID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []Model{}
		for rows.Next() {
			var m Model
			if err := rows.Scan(&m.ID, &m.OwnerID, &m.Name, &m.URL, &m.Position, &m.ChapterID, &m.ChapterOffset, &m.CreatedAt); err != nil {
				continue
			}
			out = append(out, m)
		}
		return out, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	models, err := p.loadFileModels()
	if err != nil {
		return nil, err
	}
	out := []Model{}
	for _, m := range models {
		if m.OwnerID == ownerID {
			c := *m
			c.Text = ""
			out = append(out, c)
		}
	}
	sortModels(out)
	return out, nil
}

func sortModels(out []Model) {
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].CreatedAt < out[j-1].CreatedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
}

func (p *Plugin) createModel(ownerID, name, url string) (Model, error) {
	m := Model{ID: newModelID(), OwnerID: ownerID, Name: name, URL: url, CreatedAt: nowUnix()}
	if p.cfg.DB != nil {
		_, err := p.cfg.DB.Exec(`INSERT INTO custom_models (id, owner_id, name, url, created_at) VALUES (?,?,?,?,?)`,
			m.ID, m.OwnerID, m.Name, m.URL, m.CreatedAt)
		return m, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	models, err := p.loadFileModels()
	if err != nil {
		return Model{}, err
	}
	models[m.ID] = &m
	return m, p.saveFileModels(models)
}

func (p *Plugin) getModel(modelID, ownerID string) (*Model, error) {
	if p.cfg.DB != nil {
		var m Model
		err := p.cfg.DB.QueryRow(`SELECT id, owner_id, name, url, COALESCE(text,''), position, chapter_id, chapter_offset, created_at
			FROM custom_models WHERE id=? AND owner_id=?`,
			modelID, ownerID).Scan(&m.ID, &m.OwnerID, &m.Name, &m.URL, &m.Text, &m.Position, &m.ChapterID, &m.ChapterOffset, &m.CreatedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errModelNotFound
		}
		if err != nil {
			return nil, err
		}
		return &m, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	models, err := p.loadFileModels()
	if err != nil {
		return nil, err
	}
	m := models[modelID]
	if m == nil || m.OwnerID != ownerID {
		return nil, errModelNotFound
	}
	c := *m
	return &c, nil
}

func (p *Plugin) saveModelURL(modelID, ownerID, url string) error {
	if p.cfg.DB != nil {
		_, err := p.cfg.DB.Exec(`UPDATE custom_models SET url=?, position=0, chapter_id='', chapter_offset=0 WHERE id=? AND owner_id=?`,
			url, modelID, ownerID)
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	models, err := p.loadFileModels()
	if err != nil {
		return err
	}
	m := models[modelID]
	if m == nil || m.OwnerID != ownerID {
		return errModelNotFound
	}
	m.URL = url
	m.Position = 0
	m.ChapterID = ""
	m.ChapterOffset = 0
	return p.saveFileModels(models)
}

func (p *Plugin) saveModelText(modelID, ownerID, text string) error {
	if p.cfg.DB != nil {
		_, err := p.cfg.DB.Exec(`UPDATE custom_models SET text=?, position=0 WHERE id=? AND owner_id=?`,
			text, modelID, ownerID)
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	models, err := p.loadFileModels()
	if err != nil {
		return err
	}
	m := models[modelID]
	if m == nil || m.OwnerID != ownerID {
		return errModelNotFound
	}
	m.Text = text
	m.Position = 0
	return p.saveFileModels(models)
}

func (p *Plugin) saveModelPosition(modelID, ownerID string, position int64) error {
	if p.cfg.DB != nil {
		_, err := p.cfg.DB.Exec("UPDATE custom_models SET position=? WHERE id=? AND owner_id=?", position, modelID, ownerID)
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	models, err := p.loadFileModels()
	if err != nil {
		return err
	}
	m := models[modelID]
	if m == nil || m.OwnerID != ownerID {
		return errModelNotFound
	}
	m.Position = position
	return p.saveFileModels(models)
}

func (p *Plugin) saveModelProgress(modelID, ownerID, chapterID string, offset int64) error {
	if p.cfg.DB != nil {
		_, err := p.cfg.DB.Exec("UPDATE custom_models SET chapter_id=?, chapter_offset=? WHERE id=? AND owner_id=?",
			chapterID, offset, modelID, ownerID)
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	models, err := p.loadFileModels()
	if err != nil {
		return err
	}
	m := models[modelID]
	if m == nil || m.OwnerID != ownerID {
		return errModelNotFound
	}
	m.ChapterID = chapterID
	m.ChapterOffset = offset
	return p.saveFileModels(models)
}

// ---- HTTP 处理器（门禁由基座注入；调用者身份来自 context） ----

func (p *Plugin) handleModels(w http.ResponseWriter, r *http.Request) {
	log.Println("DEBUG handleModels:", r.Method, r.URL.Path)
	owner := userIDFrom(r.Context())
	switch r.Method {
	case http.MethodGet:
		models, err := p.listModels(owner)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONOK(w, map[string]any{"models": models})
	case http.MethodPost:
		var req struct {
			Name string `json:"name"`
			URL  string `json:"url"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		req.Name = strings.TrimSpace(req.Name)
		req.URL = strings.TrimSpace(req.URL)
		if req.Name == "" || utf8.RuneCountInString(req.Name) > 40 {
			http.Error(w, "模型名称需为 1–40 个字", http.StatusBadRequest)
			return
		}
		if !validModelURL(req.URL) {
			http.Error(w, "请输入有效的 http 或 https 模型链接", http.StatusBadRequest)
			return
		}
		m, err := p.createModel(owner, req.Name, req.URL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONOK(w, map[string]any{"model": m})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (p *Plugin) handleModelSub(w http.ResponseWriter, r *http.Request) {
	log.Println("DEBUG handleModelSub:", r.Method, r.URL.Path)
	owner := userIDFrom(r.Context())
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, Prefix+"/"), "/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	if len(parts) == 1 {
		// /models：集合级列表与创建（GET/POST）
		p.handleModels(w, r)
		return
	}
	modelID, action := parts[0], parts[1]
	switch {
	case action == "next" && r.Method == http.MethodPost:
		p.handleNext(w, owner, modelID)
	case action == "text" && r.Method == http.MethodPut:
		var req struct {
			Text string `json:"text"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 3<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if len(req.Text) == 0 || len(req.Text) > 2<<20 || !utf8.ValidString(req.Text) {
			http.Error(w, "TXT 文件需为 UTF-8 编码且不超过 2 MB", http.StatusBadRequest)
			return
		}
		if err := p.saveModelText(modelID, owner, req.Text); err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, errModelNotFound) {
				status = http.StatusNotFound
			}
			http.Error(w, err.Error(), status)
			return
		}
		writeJSONOK(w, map[string]any{"ok": true})
	case action == "url" && r.Method == http.MethodPut:
		var req struct {
			URL string `json:"url"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		req.URL = strings.TrimSpace(req.URL)
		if !validModelURL(req.URL) {
			http.Error(w, "请输入有效的 http 或 https 模型链接", http.StatusBadRequest)
			return
		}
		if err := p.saveModelURL(modelID, owner, req.URL); err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, errModelNotFound) {
				status = http.StatusNotFound
			}
			http.Error(w, err.Error(), status)
			return
		}
		writeJSONOK(w, map[string]any{"ok": true})
	default:
		http.NotFound(w, r)
	}
}

func (p *Plugin) handleNext(w http.ResponseWriter, owner, modelID string) {
	m, err := p.getModel(modelID, owner)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errModelNotFound) {
			status = http.StatusNotFound
		}
		http.Error(w, err.Error(), status)
		return
	}
	if m.URL == "" {
		if m.Text == "" {
			http.Error(w, "请先上传 TXT 文件", http.StatusBadRequest)
			return
		}
		runes := []rune(m.Text)
		if int(m.Position) >= len(runes) {
			writeJSONOK(w, map[string]any{"content": "已读完", "done": true})
			return
		}
		end := chunkBoundary(runes, int(m.Position), 800)
		content := strings.TrimSpace(string(runes[m.Position:end]))
		if err := p.saveModelPosition(modelID, owner, int64(end)); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONOK(w, map[string]any{"content": content, "done": end == len(runes)})
		return
	}
	kind, bookOrChapterID, err := fanqieSource(m.URL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	chapterID, offset := m.ChapterID, int(m.ChapterOffset)
	if chapterID == "" {
		if kind == "reader" {
			chapterID = bookOrChapterID
		} else {
			page, err := fetchFanqie("/page/" + bookOrChapterID)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
			ids := fanqieChapterIDs(page)
			if len(ids) == 0 {
				http.Error(w, "书籍目录中未找到公开章节", http.StatusBadGateway)
				return
			}
			chapterID = ids[0]
		}
	}
	page, err := fetchFanqie("/reader/" + chapterID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	content, err := fanqieReadableText(page)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	runes := []rune(content)
	if offset >= len(runes) {
		if kind != "page" {
			writeJSONOK(w, map[string]any{"content": "本章已读完；请添加书籍页链接以继续下一章", "done": true})
			return
		}
		bookPage, err := fetchFanqie("/page/" + bookOrChapterID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		ids := fanqieChapterIDs(bookPage)
		idx := -1
		for i, id := range ids {
			if id == chapterID {
				idx = i
				break
			}
		}
		if idx < 0 || idx+1 >= len(ids) {
			writeJSONOK(w, map[string]any{"content": "已读到最新章节", "done": true})
			return
		}
		chapterID, offset = ids[idx+1], 0
		page, err = fetchFanqie("/reader/" + chapterID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		content, err = fanqieReadableText(page)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		runes = []rune(content)
	}
	end := chunkBoundary(runes, offset, 800)
	chunk := strings.TrimSpace(string(runes[offset:end]))
	if err := p.saveModelProgress(modelID, owner, chapterID, int64(end)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSONOK(w, map[string]any{"content": chunk, "chapter_id": chapterID, "done": false})
}

func newModelID() string {
	// 与基座 newID 同规格：base64(RawURL) 9 字节随机
	return base64.RawURLEncoding.EncodeToString(randomModelBytes(9))
}

var rndMu sync.Mutex

func randomModelBytes(n int) []byte {
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

// chunkBoundary 为阅读分段挑一个结束偏移（约 target 个字，回退到最近的段落换行）。
func chunkBoundary(runes []rune, start, target int) int {
	end := start + target
	if end > len(runes) {
		end = len(runes)
	}
	if end < len(runes) {
		for i := end; i > start+target/2; i-- {
			if runes[i-1] == '\n' {
				end = i
				break
			}
		}
	}
	return end
}

func validModelURL(raw string) bool {
	if raw == "" {
		return true
	}
	parsed, err := url.Parse(raw)
	return err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") &&
		parsed.Host != "" && parsed.User == nil && len(raw) <= 2048
}
