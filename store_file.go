package main

// fileStore keeps everything in data.json under the data directory: the
// zero-config fallback for personal use, tests and air-gapped machines.
// Rooms, images (files on disk) and custom reading models all work; only
// database-only capabilities (message search) are unavailable.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type fileStore struct {
	mu  sync.Mutex
	dir string
	d   *fileData
}

type fileData struct {
	Users        map[string]*User        `json:"users"`
	ByName       map[string]string       `json:"users_by_name"`
	ByNick       map[string]string       `json:"users_by_nick"`
	Tokens       map[string]string       `json:"tokens"`
	ConvByCode   map[string]string       `json:"conv_by_code"`
	Convs        map[string]*fileConv    `json:"convs"`
	Images       map[string]imageRecord  `json:"images"`
	CustomModels map[string]*CustomModel `json:"custom_models,omitempty"`
}

type fileConv struct {
	ID        string             `json:"id"`
	Code      string             `json:"code"`
	Title     string             `json:"title"`
	CreatorID string             `json:"creator_id"`
	CreatedAt int64              `json:"created_at"`
	CreatedNS int64              `json:"created_ns"`
	Kind      int                `json:"kind"`
	Members   map[string]*Member `json:"members"`
	Messages  []*Message         `json:"messages"`
}

func newFileStore(dir string) (*fileStore, error) {
	fs := &fileStore{dir: dir, d: &fileData{
		Users: map[string]*User{}, ByName: map[string]string{}, ByNick: map[string]string{},
		Tokens: map[string]string{}, ConvByCode: map[string]string{}, Convs: map[string]*fileConv{},
		Images: map[string]imageRecord{}, CustomModels: map[string]*CustomModel{},
	}}
	b, err := os.ReadFile(fs.jsonPath())
	if err == nil {
		if jerr := json.Unmarshal(b, fs.d); jerr != nil {
			return nil, jerr
		}
		for _, fix := range []struct{ mapPtr *map[string]*User }{} {
			_ = fix
		}
	}
	for k, v := range fs.d.Users {
		if v == nil {
			delete(fs.d.Users, k)
			continue
		}
		fs.d.ByName[strings.ToLower(v.Username)] = v.ID
		fs.d.ByNick[strings.ToLower(v.Nickname)] = v.ID
	}
	if fs.d.Users == nil {
		fs.d.Users = map[string]*User{}
	}
	if fs.d.Convs == nil {
		fs.d.Convs = map[string]*fileConv{}
	}
	if fs.d.CustomModels == nil {
		fs.d.CustomModels = map[string]*CustomModel{}
	}
	return fs, nil
}

func (s *fileStore) Dir() string  { return s.dir }
func (s *fileStore) Close() error { return nil }

func (s *fileStore) jsonPath() string { return filepath.Join(s.dir, "data.json") }

func (s *fileStore) Fresh() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d = &fileData{
		Users: map[string]*User{}, ByName: map[string]string{}, ByNick: map[string]string{},
		Tokens: map[string]string{}, ConvByCode: map[string]string{}, Convs: map[string]*fileConv{},
		Images: map[string]imageRecord{}, CustomModels: map[string]*CustomModel{},
	}
	s.saveLocked()
	return nil
}

func (s *fileStore) saveLocked() {
	b, err := json.Marshal(s.d)
	if err != nil {
		return
	}
	tmp := s.jsonPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, s.jsonPath())
}

func (s *fileStore) nextNS() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	ns := now()
	if s.d.Convs != nil {
		for _, c := range s.d.Convs {
			if c.CreatedNS >= ns {
				ns = c.CreatedNS + 1
			}
		}
	}
	return ns
}

func (s *fileStore) insertToken(userID string) (string, error) {
	token := newToken()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Tokens[token] = userID
	s.saveLocked()
	return token, nil
}

func (s *fileStore) usernameTaken(name string) bool {
	_, ok := s.d.ByName[name]
	return ok
}

func (s *fileStore) nicknameTaken(name string) bool {
	_, ok := s.d.ByNick[strings.ToLower(name)]
	return ok
}

// ---- users & auth ----

func (s *fileStore) CreateUser(username, nickname, password string) (*User, string, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	nickname = strings.TrimSpace(nickname)
	if err := validateRegister(username, nickname, password); err != nil {
		return nil, "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.usernameTaken(username) {
		return nil, "", ErrNameTaken
	}
	if s.nicknameTaken(nickname) {
		return nil, "", ErrNickTaken
	}
	u := &User{ID: newID(), Username: username, Nickname: nickname, CreatedAt: now()}
	u.Salt, u.Hash = hashPassword(password)
	s.d.Users[u.ID] = u
	s.d.ByName[username] = u.ID
	s.d.ByNick[strings.ToLower(nickname)] = u.ID
	token := newToken()
	s.d.Tokens[token] = u.ID
	s.saveLocked()
	return u, token, nil
}

func (s *fileStore) SuggestModelName() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.suggestLocked()
}

// suggestLocked picks an unused model-style name (call with lock held).
func (s *fileStore) suggestLocked() string {
	for i := 0; i < 32; i++ {
		name := modelNames[fastrand()%len(modelNames)]
		if !s.nicknameTaken(name) {
			return name
		}
	}
	return modelNames[fastrand()%len(modelNames)] + "-" + randSuffix(4)
}

// Register creates an account from a model-style display name; duplicate
// names are auto-reassigned instead of rejected.
func (s *fileStore) Register(name, password string) (*User, string, error) {
	if len(password) < 6 || len(password) > 64 {
		return nil, "", errors.New("密码长度需在 6-64 位之间")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	name = strings.TrimSpace(name)
	if name == "" {
		name = s.suggestLocked()
	} else if n := len([]rune(name)); n > 30 {
		return nil, "", errors.New("模型名称需为 1-30 个字符")
	} else if s.nicknameTaken(name) {
		name = s.suggestLocked()
	}
	slug := slugifyName(name)
	for i := 0; i < 8; i++ {
		if !s.usernameTaken(slug) {
			break
		}
		cut := len(slug)
		if cut > 20 {
			cut = 20
		}
		slug = slug[:cut] + "-" + randSuffix(4)
	}
	u := &User{ID: newID(), Username: slug, Nickname: name, CreatedAt: now()}
	u.Salt, u.Hash = hashPassword(password)
	s.d.Users[u.ID] = u
	s.d.ByName[slug] = u.ID
	s.d.ByNick[strings.ToLower(name)] = u.ID
	token := newToken()
	s.d.Tokens[token] = u.ID
	s.saveLocked()
	return u, token, nil
}

func (s *fileStore) Login(name, password string) (*User, string, error) {
	key := strings.ToLower(strings.TrimSpace(name))
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.d.ByNick[key]
	if !ok {
		id, ok = s.d.ByName[key]
	}
	if !ok {
		return nil, "", ErrBadAccount
	}
	u := s.d.Users[id]
	if u == nil || !verifyPassword(password, u.Salt, u.Hash) {
		return nil, "", ErrBadAccount
	}
	token := newToken()
	s.d.Tokens[token] = u.ID
	s.saveLocked()
	return u, token, nil
}

func (s *fileStore) UserByToken(token string) *User {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.d.Tokens[token]
	if !ok {
		return nil
	}
	return s.d.Users[id]
}

func (s *fileStore) DropToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.d.Tokens, token)
	s.saveLocked()
}

// ---- conversations ----

func (s *fileStore) CreateConv(u *User, title string) convBrief {
	title = clampTitle(title)
	s.mu.Lock()
	defer s.mu.Unlock()
	c := &fileConv{
		ID: newID(), Title: title, CreatorID: u.ID, CreatedAt: now(), CreatedNS: s.nextNSLocked(), Kind: 0,
		Members: map[string]*Member{}, Messages: []*Message{},
	}
	for {
		c.Code = newInviteCode(8)
		if _, clash := s.d.ConvByCode[c.Code]; !clash {
			break
		}
	}
	c.Members[u.ID] = &Member{UserID: u.ID, Title: title, JoinedAt: now()}
	s.d.Convs[c.ID] = c
	s.d.ConvByCode[c.Code] = c.ID
	s.saveLocked()
	return convBrief{ID: c.ID, Title: title, Code: c.Code}
}

// nextNSLocked derives a monotonic stamp from existing conversations.
func (s *fileStore) nextNSLocked() int64 {
	ns := now()
	for _, c := range s.d.Convs {
		if c.CreatedNS >= ns {
			ns = c.CreatedNS + 1
		}
	}
	return ns
}

func (s *fileStore) JoinConv(u *User, code, title string) (convBrief, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	title = clampTitle(title)
	s.mu.Lock()
	defer s.mu.Unlock()
	cid, ok := s.d.ConvByCode[code]
	if !ok {
		return convBrief{}, ErrBadCode
	}
	c := s.d.Convs[cid]
	local := title
	if m, exists := c.Members[u.ID]; exists {
		local = m.Title
	} else {
		c.Members[u.ID] = &Member{UserID: u.ID, Title: title, JoinedAt: now()}
		s.saveLocked()
	}
	return convBrief{ID: c.ID, Title: local, Code: c.Code, Kind: c.Kind}, nil
}

// peerOf returns the other member of a 1:1 conversation (empty for groups).
func (s *fileStore) peerOf(c *fileConv, userID string) (string, string) {
	if len(c.Members) != 2 {
		return "", ""
	}
	for mid := range c.Members {
		if mid != userID {
			return mid, ""
		}
	}
	return "", ""
}

func (s *fileStore) ListConvs(userID string) []convSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []convSummary{}
	for _, c := range s.d.Convs {
		m, ok := c.Members[userID]
		if !ok {
			continue
		}
		last := int64(0)
		if n := len(c.Messages); n > 0 {
			last = c.Messages[n-1].TS
		}
		peerID, _ := s.peerOf(c, userID)
		peerNick := ""
		if peerID != "" && s.d.Users[peerID] != nil {
			peerNick = s.d.Users[peerID].Nickname
		}
		out = append(out, convSummary{
			ID: c.ID, Title: m.Title, Code: c.Code, Kind: c.Kind,
			MemberCount: len(c.Members), CreatedAt: c.CreatedAt, LastTS: last,
			PeerID: peerID, PeerNickname: peerNick,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].LastTS != out[j].LastTS {
			return out[i].LastTS > out[j].LastTS
		}
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out
}

// GetConv only checks membership; details come from ConvDetail.
func (s *fileStore) GetConv(convID, userID string) (*Conv, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.d.Convs[convID]
	if !ok {
		return nil, ErrNotFound
	}
	if _, member := c.Members[userID]; !member {
		return nil, ErrForbidden
	}
	return &Conv{ID: c.ID, Code: c.Code, Title: c.Title, CreatorID: c.CreatorID,
		CreatedAt: c.CreatedAt, CreatedNS: c.CreatedNS, Kind: c.Kind}, nil
}

func (s *fileStore) ConvDetail(convID, userID string) (convOut, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.d.Convs[convID]
	if !ok {
		return convOut{}, ErrNotFound
	}
	m, member := c.Members[userID]
	if !member {
		return convOut{}, ErrForbidden
	}
	members := make([]publicMember, 0, len(c.Members))
	for _, mm := range c.Members {
		nick := ""
		if u := s.d.Users[mm.UserID]; u != nil {
			nick = u.Nickname
		}
		members = append(members, publicMember{ID: mm.UserID, Nickname: nick, JoinedAt: mm.JoinedAt})
	}
	sort.Slice(members, func(i, j int) bool { return members[i].JoinedAt < members[j].JoinedAt })
	peerID, _ := s.peerOf(c, userID)
	peerNick := ""
	if peerID != "" && s.d.Users[peerID] != nil {
		peerNick = s.d.Users[peerID].Nickname
	}
	return convOut{
		ID: c.ID, Title: m.Title, Code: c.Code, Kind: c.Kind, CreatorID: c.CreatorID,
		CreatedAt: c.CreatedAt, MemberCount: len(c.Members),
		PeerID: peerID, PeerNickname: peerNick, Members: members,
	}, nil
}

// NewConvWith always creates a separate 1:1 conversation.
func (s *fileStore) NewConvWith(aID, bID string) (convBrief, error) {
	return s.convWith(aID, bID, true)
}

// ConvWith reuses the most recently created matching 1:1 conversation.
func (s *fileStore) ConvWith(aID, bID string) (convBrief, error) {
	return s.convWith(aID, bID, false)
}

func (s *fileStore) convWith(aID, bID string, createNew bool) (convBrief, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.d.Users[aID] == nil || s.d.Users[bID] == nil {
		return convBrief{}, ErrUserNotFound
	}
	if aID == bID {
		return convBrief{}, ErrSelfPeer
	}
	var latest *fileConv
	if !createNew {
		for _, c := range s.d.Convs {
			if c.Kind == 0 && len(c.Members) == 2 && c.Members[aID] != nil && c.Members[bID] != nil &&
				(latest == nil || c.CreatedNS > latest.CreatedNS || c.CreatedNS == latest.CreatedNS && (c.CreatedAt > latest.CreatedAt || c.CreatedAt == latest.CreatedAt && c.ID > latest.ID)) {
				latest = c
			}
		}
	}
	if latest != nil {
		return convBrief{ID: latest.ID, Title: latest.Members[aID].Title, Code: latest.Code, Kind: latest.Kind}, nil
	}
	title := conversationTitles[fastrand()%len(conversationTitles)] + " · " + randSuffix(4)
	c := &fileConv{
		ID: newID(), Title: title, CreatorID: aID, CreatedAt: now(), CreatedNS: s.nextNSLocked(), Kind: 0,
		Members: map[string]*Member{}, Messages: []*Message{},
	}
	for {
		c.Code = newInviteCode(8)
		if _, clash := s.d.ConvByCode[c.Code]; !clash {
			break
		}
	}
	c.Members[aID] = &Member{UserID: aID, Title: title, JoinedAt: now()}
	c.Members[bID] = &Member{UserID: bID, Title: title, JoinedAt: now()}
	s.d.Convs[c.ID] = c
	s.d.ConvByCode[c.Code] = c.ID
	s.saveLocked()
	return convBrief{ID: c.ID, Title: title, Code: c.Code}, nil
}

func (s *fileStore) RenameConv(convID, userID, title string) (convOut, error) {
	title = strings.TrimSpace(title)
	if title == "" || len([]rune(title)) > 60 {
		return convOut{}, errors.New("标题需为 1-60 个字符")
	}
	s.mu.Lock()
	c, ok := s.d.Convs[convID]
	if !ok {
		s.mu.Unlock()
		return convOut{}, ErrNotFound
	}
	m := c.Members[userID]
	if m == nil {
		s.mu.Unlock()
		return convOut{}, ErrForbidden
	}
	m.Title = title
	s.saveLocked()
	s.mu.Unlock()
	return s.ConvDetail(convID, userID)
}

func (s *fileStore) RecordImage(id, owner string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Images[id] = imageRecord{OwnerID: owner}
	s.saveLocked()
}

func (s *fileStore) ImageOwner(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.d.Images[id].OwnerID
}

func (s *fileStore) CanReadImage(id, userID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.d.Images[id]
	if !ok {
		return "", false
	}
	if rec.OwnerID == userID {
		return rec.OwnerID, true
	}
	for _, c := range s.d.Convs {
		if c.Members[userID] == nil {
			continue
		}
		for _, m := range c.Messages {
			if m.ImageID == id {
				return rec.OwnerID, true
			}
		}
	}
	return "", false
}

// ---- models ----

func (s *fileStore) ListModels(exceptUserID string) []modelInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []modelInfo{}
	for _, u := range s.d.Users {
		if u.ID == exceptUserID {
			continue
		}
		out = append(out, modelInfo{ID: u.ID, Name: u.Nickname})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ---- messages ----

func (s *fileStore) AddMessage(convID, senderID, nickname, content, clientMsgID string) (*Message, error) {
	return s.AddMessageWithImage(convID, senderID, nickname, content, clientMsgID, "")
}

func (s *fileStore) AddMessageWithImage(convID, senderID, nickname, content, clientMsgID, imageID string) (*Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.d.Convs[convID]
	if !ok {
		return nil, ErrNotFound
	}
	if _, member := c.Members[senderID]; !member {
		return nil, ErrForbidden
	}
	if imageID != "" {
		if s.d.Images[imageID].OwnerID != senderID {
			return nil, ErrForbidden
		}
		if _, err := os.Stat(filepath.Join(s.dir, "images", senderID, imageID+".webp")); err != nil {
			return nil, ErrNotFound
		}
	}
	m := &Message{
		ID: newID(), SenderID: senderID, Nickname: nickname,
		Content: content, TS: now(), ClientMsgID: clientMsgID, ImageID: imageID,
	}
	if clientMsgID != "" {
		for _, prev := range c.Messages {
			if prev.ClientMsgID == clientMsgID {
				return prev, nil
			}
		}
	}
	c.Messages = append(c.Messages, m)
	const maxHistory = 5000
	if len(c.Messages) > maxHistory {
		c.Messages = c.Messages[len(c.Messages)-maxHistory:]
	}
	s.saveLocked()
	return m, nil
}

func (s *fileStore) HistoryMessages(convID, userID string, afterTS, beforeTS int64, beforeID string, limit int) ([]*Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.d.Convs[convID]
	if !ok {
		return nil, ErrNotFound
	}
	if _, member := c.Members[userID]; !member {
		return nil, ErrForbidden
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	msgs := c.Messages
	if afterTS > 0 {
		idx := sort.Search(len(msgs), func(i int) bool { return msgs[i].TS > afterTS })
		msgs = msgs[idx:]
	}
	if beforeTS > 0 {
		end := len(msgs)
		for i := len(msgs) - 1; i >= 0; i-- {
			if msgs[i].TS < beforeTS || (msgs[i].TS == beforeTS && (beforeID == "" || msgs[i].ID < beforeID)) {
				end = i + 1
				break
			}
			if i == 0 {
				end = 0
			}
		}
		msgs = msgs[:end]
	}
	if len(msgs) > limit {
		msgs = msgs[len(msgs)-limit:]
	}
	out := make([]*Message, len(msgs))
	copy(out, msgs)
	return out, nil
}

// ---- rooms ----

func (s *fileStore) CreateRoom(ownerID, title string, inviteNames []string) (convBrief, []string, error) {
	title = clampTitle(title)
	invited := map[string]bool{ownerID: true}
	missing := []string{}
	members := []string{}
	for _, raw := range inviteNames {
		name := strings.ToLower(strings.TrimSpace(raw))
		if name == "" {
			continue
		}
		id, ok := s.d.ByNick[name]
		if !ok {
			id, ok = s.d.ByName[name]
		}
		if !ok || invited[id] {
			missing = append(missing, strings.TrimSpace(raw))
			continue
		}
		invited[id] = true
		members = append(members, id)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c := &fileConv{
		ID: newID(), Title: title, CreatorID: ownerID, CreatedAt: now(), CreatedNS: s.nextNSLocked(), Kind: 1,
		Members: map[string]*Member{}, Messages: []*Message{},
	}
	for {
		c.Code = newInviteCode(8)
		if _, clash := s.d.ConvByCode[c.Code]; !clash {
			break
		}
	}
	for _, member := range append([]string{ownerID}, members...) {
		c.Members[member] = &Member{UserID: member, Title: title, JoinedAt: now()}
	}
	s.d.Convs[c.ID] = c
	s.d.ConvByCode[c.Code] = c.ID
	s.saveLocked()
	return convBrief{ID: c.ID, Title: title, Code: c.Code, Kind: 1}, missing, nil
}

func (s *fileStore) RoomMembers(convID, userID string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.d.Convs[convID]
	if !ok {
		return nil, ErrNotFound
	}
	if _, member := c.Members[userID]; !member {
		return nil, ErrForbidden
	}
	members := make([]publicMember, 0, len(c.Members))
	for _, mm := range c.Members {
		nick := ""
		if u := s.d.Users[mm.UserID]; u != nil {
			nick = u.Nickname
		}
		members = append(members, publicMember{ID: mm.UserID, Nickname: nick, JoinedAt: mm.JoinedAt})
	}
	sort.Slice(members, func(i, j int) bool { return members[i].JoinedAt < members[j].JoinedAt })
	out := []string{}
	for _, pm := range members {
		out = append(out, pm.Nickname)
	}
	return out, nil
}

// ---- custom reading models ----

func (s *fileStore) CreateCustomModel(ownerID, name, url string) (CustomModel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := CustomModel{ID: newID(), OwnerID: ownerID, Name: name, URL: url, CreatedAt: now()}
	s.d.CustomModels[m.ID] = &m
	s.saveLocked()
	return m, nil
}

func (s *fileStore) ListCustomModels(ownerID string) ([]CustomModel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []CustomModel{}
	for _, m := range s.d.CustomModels {
		if m.OwnerID != ownerID {
			continue
		}
		copyM := *m
		copyM.Text = ""
		out = append(out, copyM)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, nil
}

func (s *fileStore) GetCustomModel(modelID, ownerID string) (*CustomModel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.d.CustomModels[modelID]
	if m == nil || m.OwnerID != ownerID {
		return nil, ErrNotFound
	}
	copyM := *m
	return &copyM, nil
}

func (s *fileStore) SaveCustomModelText(modelID, ownerID, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.d.CustomModels[modelID]
	if m == nil || m.OwnerID != ownerID {
		return ErrNotFound
	}
	m.Text = text
	m.Position = 0
	s.saveLocked()
	return nil
}

func (s *fileStore) SaveCustomModelPosition(modelID, ownerID string, position int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.d.CustomModels[modelID]
	if m == nil || m.OwnerID != ownerID {
		return ErrNotFound
	}
	m.Position = position
	s.saveLocked()
	return nil
}

func (s *fileStore) SaveCustomModelProgress(modelID, ownerID, chapterID string, offset int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.d.CustomModels[modelID]
	if m == nil || m.OwnerID != ownerID {
		return ErrNotFound
	}
	m.ChapterID = chapterID
	m.ChapterOffset = offset
	s.saveLocked()
	return nil
}

// ---- search (database-only capability) ----

func (s *fileStore) SearchMessages(userID, query string, limit int) ([]SearchHit, error) {
	return nil, ErrNoDatabase
}
