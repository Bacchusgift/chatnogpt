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
		s.store.mu.Lock()
		models := []CustomModel{}
		for _, m := range s.store.d.CustomModels {
			if m.OwnerID == u.ID {
				copy := *m
				copy.Text = ""
				models = append(models, copy)
			}
		}
		s.store.mu.Unlock()
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
		m := &CustomModel{ID: newID(), OwnerID: u.ID, Name: req.Name, URL: req.URL, CreatedAt: now()}
		s.store.mu.Lock()
		s.store.d.CustomModels[m.ID] = m
		s.store.saveLocked()
		s.store.mu.Unlock()
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
	if len(parts) == 2 && parts[1] == "next" && r.Method == http.MethodPost {
		s.handleCustomNext(w, u.ID, parts[0])
		return
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	m := s.store.d.CustomModels[parts[0]]
	if m == nil || m.OwnerID != u.ID {
		writeErr(w, 404, ErrNotFound)
		return
	}
	if len(parts) == 2 && parts[1] == "text" && r.Method == http.MethodPut {
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
		m.Text = req.Text
		m.Position = 0
		s.store.saveLocked()
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	http.NotFound(w, r)
}

func (s *server) handleCustomNext(w http.ResponseWriter, ownerID, modelID string) {
	s.store.mu.Lock()
	m := s.store.d.CustomModels[modelID]
	if m == nil || m.OwnerID != ownerID {
		s.store.mu.Unlock()
		writeErr(w, 404, ErrNotFound)
		return
	}
	if m.URL == "" {
		if m.Text == "" {
			s.store.mu.Unlock()
			writeErr(w, 400, errors.New("请先上传 TXT 文件"))
			return
		}
		runes := []rune(m.Text)
		if m.Position >= len(runes) {
			s.store.mu.Unlock()
			writeJSON(w, 200, map[string]any{"content": "已读完", "done": true})
			return
		}
		end := m.Position + 800
		if end > len(runes) {
			end = len(runes)
		}
		if end < len(runes) {
			for i := end; i > m.Position+400; i-- {
				if runes[i-1] == '\n' {
					end = i
					break
				}
			}
		}
		content := strings.TrimSpace(string(runes[m.Position:end]))
		m.Position = end
		s.store.saveLocked()
		s.store.mu.Unlock()
		writeJSON(w, 200, map[string]any{"content": content, "done": end == len(runes)})
		return
	}
	source, chapterID, offset := m.URL, m.ChapterID, m.ChapterOffset
	s.store.mu.Unlock()
	kind, bookOrChapterID, err := fanqieSource(source)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
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
	end := offset + 800
	if end > len(runes) {
		end = len(runes)
	}
	if end < len(runes) {
		for i := end; i > offset+400; i-- {
			if runes[i-1] == '\n' {
				end = i
				break
			}
		}
	}
	chunk := strings.TrimSpace(string(runes[offset:end]))
	s.store.mu.Lock()
	m = s.store.d.CustomModels[modelID]
	if m != nil && m.OwnerID == ownerID {
		m.ChapterID = chapterID
		m.ChapterOffset = end
		s.store.saveLocked()
	}
	s.store.mu.Unlock()
	writeJSON(w, 200, map[string]any{"content": chunk, "chapter_id": chapterID, "done": false})
}
