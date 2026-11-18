package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

type publicUser struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Nickname string `json:"nickname"`
}

func publicUserOf(u *User) publicUser {
	return publicUser{ID: u.ID, Username: u.Username, Nickname: u.Nickname}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

func (s *server) authUser(r *http.Request) *User {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return s.store.UserByToken(strings.TrimSpace(strings.TrimPrefix(h, "Bearer ")))
	}
	return nil
}

func statusOf(err error) int {
	switch err {
	case ErrNotFound, ErrForbidden:
		// 404 instead of 403 so outsiders cannot probe which conversations exist
		return http.StatusNotFound
	}
	return http.StatusBadRequest
}

func (s *server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req struct {
		Name     string `json:"name"` // 模型名称（新流程）
		Password string `json:"password"`
		Username string `json:"username"` // 兼容旧字段
		Nickname string `json:"nickname"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	var u *User
	var token string
	var err error
	if req.Username != "" || req.Nickname != "" {
		u, token, err = s.store.CreateUser(req.Username, req.Nickname, req.Password)
	} else {
		u, token, err = s.store.Register(req.Name, req.Password)
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": publicUserOf(u)})
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req struct {
		Name     string `json:"name"` // 模型名称（新流程）
		Password string `json:"password"`
		Username string `json:"username"` // 兼容旧字段
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	name := req.Name
	if name == "" {
		name = req.Username
	}
	u, token, err := s.store.Login(name, req.Password)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": publicUserOf(u)})
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		s.store.DropToken(strings.TrimSpace(strings.TrimPrefix(h, "Bearer ")))
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": publicUserOf(u)})
}

func (s *server) handleConversations(w http.ResponseWriter, r *http.Request) {
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"conversations": s.store.ListConvs(u.ID)})
	case http.MethodPost:
		var req struct {
			Title string `json:"title"`
		}
		if err := readJSON(r, &req); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		brief := s.store.CreateConv(u, req.Title)
		writeJSON(w, http.StatusOK, map[string]any{"conversation": brief})
	default:
		writeErr(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
	}
}

func (s *server) handleJoinConv(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	var req struct {
		Code  string `json:"code"`
		Title string `json:"title"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	brief, err := s.store.JoinConv(u, req.Code, req.Title)
	if err != nil {
		writeErr(w, statusOf(err), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation": brief})
}

// handleModels lists the other users — they appear as "models" in the picker.
func (s *server) handleModels(w http.ResponseWriter, r *http.Request) {
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": s.store.ListModels(u.ID)})
}

func (s *server) handleModelSuggest(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"name": s.store.SuggestModelName()})
}

// handleCoverLines returns the thinking-disguise cover pool (auth required).
func (s *server) handleCoverLines(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	if s.authUser(r) == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	lines := s.cover.Lines()
	writeJSON(w, http.StatusOK, map[string]any{"lines": lines, "count": len(lines)})
}

// handleConvWith returns (creating if needed) the 1:1 conversation between
// the caller and the picked "model", so sending a message is enough to start
// a chat — no manual conversation creation anywhere in the UI.
func (s *server) handleConvWith(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	var req struct {
		PeerID string `json:"peer_id"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	brief, err := s.store.ConvWith(u.ID, req.PeerID)
	if err != nil {
		writeErr(w, statusOf(err), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation": brief})
}

func (s *server) handleConvNew(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	var req struct {
		PeerID string `json:"peer_id"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	brief, err := s.store.NewConvWith(u.ID, req.PeerID)
	if err != nil {
		writeErr(w, statusOf(err), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation": brief})
}

// handleRooms creates a multi-person group room (kind=1 conversation).
func (s *server) handleRooms(w http.ResponseWriter, r *http.Request) {
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req struct {
		Title  string   `json:"title"`
		Invite []string `json:"invite"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	brief, missing, err := s.store.CreateRoom(u.ID, req.Title, req.Invite)
	if err != nil {
		writeErr(w, statusOf(err), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation": brief, "missing": missing})
}

// handleSearch finds messages across the user's conversations (database mode).
func (s *server) handleSearch(w http.ResponseWriter, r *http.Request) {
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"hits": []SearchHit{}})
		return
	}
	hits, err := s.store.SearchMessages(u.ID, q, 50)
	if err != nil {
		writeErr(w, statusOf(err), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hits": hits})
}

func (s *server) handleConvSub(w http.ResponseWriter, r *http.Request) {
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/conversations/"), "/")
	parts := strings.Split(rest, "/")
	convID := parts[0]
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		detail, err := s.store.ConvDetail(convID, u.ID)
		if err != nil {
			writeErr(w, statusOf(err), err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"conversation": detail})
	case len(parts) == 1 && r.Method == http.MethodPatch:
		var req struct {
			Title string `json:"title"`
		}
		if err := readJSON(r, &req); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		detail, err := s.store.RenameConv(convID, u.ID, req.Title)
		if err != nil {
			writeErr(w, statusOf(err), err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"conversation": detail})
	case len(parts) == 2 && parts[1] == "messages" && r.Method == http.MethodGet:
		afterTS, _ := strconv.ParseInt(r.URL.Query().Get("after_ts"), 10, 64)
		beforeTS, _ := strconv.ParseInt(r.URL.Query().Get("before_ts"), 10, 64)
		beforeID := r.URL.Query().Get("before_id")
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		msgs, err := s.store.HistoryMessages(convID, u.ID, afterTS, beforeTS, beforeID, limit)
		if err != nil {
			writeErr(w, statusOf(err), err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "has_more": beforeTS > 0 && len(msgs) == limit})
		writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
	case len(parts) == 2 && parts[1] == "read" && r.Method == http.MethodPost:
		if err := s.store.MarkConvRead(convID, u.ID); err != nil {
			writeErr(w, statusOf(err), err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		http.NotFound(w, r)
	}
}
