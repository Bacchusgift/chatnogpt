package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"
)

func (s *server) handleCustomModels(w http.ResponseWriter, r *http.Request) {
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodGet:
		models, err := s.store.ListCustomModels(u.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"models": models})
	case http.MethodPost:
		var req struct {
			Name string `json:"name"`
			URL  string `json:"url"`
		}
		if err := readJSON(r, &req); err != nil {
			writeErr(w, 400, err)
			return
		}
		req.Name = strings.TrimSpace(req.Name)
		req.URL = strings.TrimSpace(req.URL)
		if req.Name == "" || utf8.RuneCountInString(req.Name) > 40 {
			writeErr(w, 400, errors.New("模型名称需为 1–40 个字"))
			return
		}
		if req.URL != "" {
			parsed, err := url.Parse(req.URL)
			if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil || len(req.URL) > 2048 {
				writeErr(w, 400, errors.New("请输入有效的 http 或 https 小说链接"))
				return
			}
		}
		m, err := s.store.CreateCustomModel(u.ID, req.Name, req.URL)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"model": m})
	default:
		writeErr(w, 405, errors.New("method not allowed"))
	}
}

func (s *server) handleCustomModelSub(w http.ResponseWriter, r *http.Request) {
	u := s.authUser(r)
	if u == nil {
		writeErr(w, 401, ErrUnauthorized)
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/custom-models/"), "/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	modelID := parts[0]
	if parts[1] == "next" && r.Method == http.MethodPost {
		s.handleCustomNext(w, u.ID, modelID)
		return
	}
	if parts[1] == "text" && r.Method == http.MethodPut {
		var req struct {
			Text string `json:"text"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 3<<20)).Decode(&req); err != nil {
			writeErr(w, 400, err)
			return
		}
		if len(req.Text) == 0 || len(req.Text) > 2<<20 || !utf8.ValidString(req.Text) {
			writeErr(w, 400, errors.New("TXT 文件需为 UTF-8 编码且不超过 2 MB"))
			return
		}
		if err := s.store.SaveCustomModelText(modelID, u.ID, req.Text); err != nil {
			writeErr(w, statusOf(err), err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	http.NotFound(w, r)
}

// chunkBoundary picks the end offset for a reading chunk of about target
// runes, rewinding to a paragraph break when one is nearby.
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

func (s *server) handleCustomNext(w http.ResponseWriter, ownerID, modelID string) {
	m, err := s.store.GetCustomModel(modelID, ownerID)
	if err != nil {
		writeErr(w, statusOf(err), err)
		return
	}
	if m.URL == "" {
		if m.Text == "" {
			writeErr(w, 400, errors.New("请先上传 TXT 文件"))
			return
		}
		runes := []rune(m.Text)
		if int(m.Position) >= len(runes) {
			writeJSON(w, 200, map[string]any{"content": "已读完", "done": true})
			return
		}
		end := chunkBoundary(runes, int(m.Position), 800)
		content := strings.TrimSpace(string(runes[m.Position:end]))
		if err := s.store.SaveCustomModelPosition(modelID, ownerID, int64(end)); err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, 200, map[string]any{"content": content, "done": end == len(runes)})
		return
	}
	kind, bookOrChapterID, err := fanqieSource(m.URL)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	chapterID, offset := m.ChapterID, int(m.ChapterOffset)
	if chapterID == "" {
		if kind == "reader" {
			chapterID = bookOrChapterID
		} else {
			page, err := fetchFanqie("/page/" + bookOrChapterID)
			if err != nil {
				writeErr(w, 502, err)
				return
			}
			ids := fanqieChapterIDs(page)
			if len(ids) == 0 {
				writeErr(w, 502, errors.New("书籍目录中未找到公开章节"))
				return
			}
			chapterID = ids[0]
		}
	}
	page, err := fetchFanqie("/reader/" + chapterID)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	content, err := fanqieReadableText(page)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	runes := []rune(content)
	if offset >= len(runes) {
		if kind != "page" {
			writeJSON(w, 200, map[string]any{"content": "本章已读完；请添加书籍页链接以继续下一章", "done": true})
			return
		}
		bookPage, err := fetchFanqie("/page/" + bookOrChapterID)
		if err != nil {
			writeErr(w, 502, err)
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
			writeJSON(w, 200, map[string]any{"content": "已读到最新章节", "done": true})
			return
		}
		chapterID, offset = ids[idx+1], 0
		page, err = fetchFanqie("/reader/" + chapterID)
		if err != nil {
			writeErr(w, 502, err)
			return
		}
		content, err = fanqieReadableText(page)
		if err != nil {
			writeErr(w, 502, err)
			return
		}
		runes = []rune(content)
	}
	end := chunkBoundary(runes, offset, 800)
	chunk := strings.TrimSpace(string(runes[offset:end]))
	if err := s.store.SaveCustomModelProgress(modelID, ownerID, chapterID, int64(end)); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, 200, map[string]any{"content": chunk, "chapter_id": chapterID, "done": false})
}
