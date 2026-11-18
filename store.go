package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrUnauthorized = errors.New("未登录或登录状态已失效")
	ErrNameTaken    = errors.New("用户名已被注册")
	ErrNickTaken    = errors.New("该模型名称已被使用")
	ErrBadAccount   = errors.New("名称或密码不正确")
	ErrNotFound     = errors.New("聊天不存在")
	ErrBadCode      = errors.New("链接无效或已失效")
	ErrForbidden    = errors.New("无权访问该聊天")
	ErrUserNotFound = errors.New("模型不存在")
	ErrSelfPeer     = errors.New("不能选择自己作为模型")
)

type User struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	Nickname  string `json:"nickname"` // 以 AI 身份发言时显示的名字
	Salt      string `json:"salt"`
	Hash      string `json:"hash"`
	CreatedAt int64  `json:"created_at"`
}

type Member struct {
	UserID      string `json:"user_id"`
	Title       string `json:"title"` // 每个成员给会话自己取的名字
	JoinedAt    int64  `json:"joined_at"`
	UnreadCount int    `json:"unread_count,omitempty"`
}

type Message struct {
	ID          string `json:"id"`
	SenderID    string `json:"sender_id"`
	Nickname    string `json:"nickname"` // 发送时的昵称快照
	Content     string `json:"content"`
	TS          int64  `json:"ts"`
	ClientMsgID string `json:"client_msg_id,omitempty"`
	ImageID     string `json:"image_id,omitempty"`
}

type Conv struct {
	ID        string             `json:"id"`
	Code      string             `json:"code"`
	Title     string             `json:"title"` // 创建者取的原始标题
	CreatorID string             `json:"creator_id"`
	CreatedAt int64              `json:"created_at"`
	CreatedNS int64              `json:"created_ns,omitempty"`
	Members   map[string]*Member `json:"members"`
	Messages  []*Message         `json:"messages"`
}

type convBrief struct {
	ID    string `json:"id"`
	Title string `json:"title"` // 当前用户视角的标题
	Code  string `json:"code"`
}

type convSummary struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Code         string `json:"code"`
	MemberCount  int    `json:"member_count"`
	CreatedAt    int64  `json:"created_at"`
	LastTS       int64  `json:"last_ts"`
	UnreadCount  int    `json:"unread_count"`
	PeerID       string `json:"peer_id,omitempty"`
	PeerNickname string `json:"peer_nickname,omitempty"`
}

type publicMember struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
	JoinedAt int64  `json:"joined_at"`
}

type convOut struct {
	ID           string         `json:"id"`
	Title        string         `json:"title"`
	Code         string         `json:"code"`
	CreatorID    string         `json:"creator_id"`
	CreatedAt    int64          `json:"created_at"`
	MemberCount  int            `json:"member_count"`
	PeerID       string         `json:"peer_id,omitempty"`
	PeerNickname string         `json:"peer_nickname,omitempty"`
	Members      []publicMember `json:"members"`
}

type imageRecord struct {
	OwnerID string `json:"owner_id"`
}

type persistData struct {
	CustomModels map[string]*CustomModel `json:"custom_models,omitempty"`
	Images       map[string]imageRecord  `json:"images"`
	Users        map[string]*User        `json:"users"`
	ByName       map[string]string       `json:"users_by_name"` // username(小写) -> user id
	ByNick       map[string]string       `json:"users_by_nick"` // 模型名称(小写) -> user id
	Tokens       map[string]string       `json:"tokens"`
	ConvByCode   map[string]string       `json:"conv_by_code"`
	Convs        map[string]*Conv        `json:"convs"`
}

type CustomModel struct {
	ID            string `json:"id"`
	OwnerID       string `json:"owner_id"`
	Name          string `json:"name"`
	URL           string `json:"url,omitempty"`
	Text          string `json:"text,omitempty"`
	Position      int    `json:"position"`
	ChapterID     string `json:"chapter_id,omitempty"`
	ChapterOffset int    `json:"chapter_offset,omitempty"`
	CreatedAt     int64  `json:"created_at"`
}

// Store is a tiny JSON-file backed store, fine for a friends-sized
// deployment; swap in a real database if it ever outgrows that.
type Store struct {
	mu        sync.Mutex
	path      string
	d         *persistData
	createdNS int64 // 最近一次分配的会话创建时间（纳秒），保证单调递增，不受墙钟回拨影响
}

func LoadStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "data.json")}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			s.d = freshData()
			return s, nil
		}
		return nil, err
	}
	d := &persistData{}
	if err := json.Unmarshal(raw, d); err != nil {
		return nil, err
	}
	if d.Users == nil {
		d.Users = map[string]*User{}
	}
	if d.ByName == nil {
		d.ByName = map[string]string{}
	}
	if d.ByNick == nil {
		d.ByNick = map[string]string{}
	}
	// ByNick is a derived index: rebuild it on load so data written by older
	// versions (before nickname login existed) can still log in by name.
	d.ByNick = map[string]string{}
	for id, u := range d.Users {
		d.ByNick[strings.ToLower(u.Nickname)] = id
	}
	if d.Tokens == nil {
		d.Tokens = map[string]string{}
	}
	if d.ConvByCode == nil {
		d.ConvByCode = map[string]string{}
	}
	if d.Convs == nil {
		d.Convs = map[string]*Conv{}
	}
	if d.CustomModels == nil {
		d.CustomModels = map[string]*CustomModel{}
	}
	if d.Images == nil {
		d.Images = map[string]imageRecord{}
	}
	s.d = d
	return s, nil
}

func freshData() *persistData {
	return &persistData{
		Images:       map[string]imageRecord{},
		Users:        map[string]*User{},
		ByName:       map[string]string{},
		ByNick:       map[string]string{},
		Tokens:       map[string]string{},
		ConvByCode:   map[string]string{},
		Convs:        map[string]*Conv{},
		CustomModels: map[string]*CustomModel{},
	}
}

// saveLocked persists atomically: write a temp file, then rename over the old one.
func (s *Store) saveLocked() {
	raw, err := json.Marshal(s.d)
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, s.path)
}

func now() int64 { return time.Now().Unix() }

// nextNS 返回严格递增的纳秒时间戳；同一进程内创建顺序即可决定“最新会话”。
func (s *Store) nextNS() int64 {
	ns := time.Now().UnixNano()
	if ns <= s.createdNS {
		ns = s.createdNS + 1
	}
	s.createdNS = ns
	return ns
}

func clampTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "新的会话"
	}
	r := []rune(title)
	if len(r) > 60 {
		title = string(r[:60])
	}
	return title
}

// ---- users & auth ----

func (s *Store) CreateUser(username, nickname, password string) (*User, string, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	nickname = strings.TrimSpace(nickname)
	if err := validateRegister(username, nickname, password); err != nil {
		return nil, "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, taken := s.d.ByName[username]; taken {
		return nil, "", ErrNameTaken
	}
	if _, taken := s.d.ByNick[strings.ToLower(nickname)]; taken {
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

// modelNames is the pool used to auto-generate model-style display names.
var modelNames = []string{
	"gpt-6.1-sol", "glm-5.3-flash", "claude-sonnet-4.6", "gemini-3-pro",
	"grok-4.2", "deepseek-r2", "qwen-4-max", "kimi-k3", "llama-5-405b",
	"mistral-large-3", "yi-lightning-2", "minimax-m3", "doubao-pro-1.6",
	"hunyuan-turbo-s", "spark-4.5-ultra", "ernie-5.0", "baichuan-5-turbo",
	"step-3-max", "nova-pro-2", "orion-7b-chat",
}

// suggestLocked picks an unused model-style name (call with lock held).
func (s *Store) suggestLocked() string {
	for i := 0; i < 32; i++ {
		name := modelNames[fastrand()%len(modelNames)]
		if _, taken := s.d.ByNick[strings.ToLower(name)]; !taken {
			return name
		}
	}
	return modelNames[fastrand()%len(modelNames)] + "-" + randSuffix(4)
}

func fastrand() int {
	b := randomBytes(4)
	return int(b[0]) | int(b[1])<<8 | int(b[2])<<16 | int(b[3])<<24
}

// SuggestModelName returns an unused model-style name for the register form.
func (s *Store) SuggestModelName() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.suggestLocked()
}

// slugifyName derives a login-safe username from a display name.
func slugifyName(name string) string {
	slug := slugify(name)
	if slug == "" {
		slug = "u-" + randSuffix(6)
	}
	return slug
}

// Register creates an account from a model-style display name: the nickname
// doubles as the login name (unique, case-insensitive); the username is
// derived internally. If the requested name is taken, a fresh suggestion is
// used automatically and returned via the resulting user.
func (s *Store) Register(name, password string) (*User, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(password) < 6 || len(password) > 64 {
		return nil, "", fmt.Errorf("密码长度需在 6-64 位之间")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = s.suggestLocked()
	} else if n := len([]rune(name)); n > 30 {
		return nil, "", fmt.Errorf("模型名称需为 1-30 个字符")
	} else if _, taken := s.d.ByNick[strings.ToLower(name)]; taken {
		// 名称被占用：自动分配另一个可用的模型名
		name = s.suggestLocked()
	}
	slug := slugifyName(name)
	for i := 0; i < 8; i++ {
		if _, taken := s.d.ByName[slug]; !taken {
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

func (s *Store) Login(name, password string) (*User, string, error) {
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

func (s *Store) UserByToken(token string) *User {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.d.Tokens[token]
	if !ok {
		return nil
	}
	return s.d.Users[id]
}

func (s *Store) DropToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.d.Tokens, token)
	s.saveLocked()
}

// ---- conversations ----

func (s *Store) CreateConv(u *User, title string) convBrief {
	title = clampTitle(title)
	s.mu.Lock()
	defer s.mu.Unlock()
	c := &Conv{
		ID:        newID(),
		Title:     title,
		CreatorID: u.ID,
		CreatedAt: now(),
		CreatedNS: s.nextNS(), // 同秒创建的会话也按创建顺序取“最新”
		Members:   map[string]*Member{},
		Messages:  []*Message{},
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

// JoinConv adds the user to the conversation behind code, using their own
// local title. Joining twice keeps the original title.
func (s *Store) JoinConv(u *User, code, title string) (convBrief, error) {
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
	return convBrief{ID: c.ID, Title: local, Code: c.Code}, nil
}

// peerFields returns the other member of a 1:1 conversation (empty for groups).
func (s *Store) peerFields(c *Conv, userID string) (string, string) {
	if len(c.Members) != 2 {
		return "", ""
	}
	for mid := range c.Members {
		if mid != userID {
			nick := ""
			if u := s.d.Users[mid]; u != nil {
				nick = u.Nickname
			}
			return mid, nick
		}
	}
	return "", ""
}

func (s *Store) ListConvs(userID string) []convSummary {
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
		peerID, peerNick := s.peerFields(c, userID)
		out = append(out, convSummary{
			ID: c.ID, Title: m.Title, Code: c.Code,
			MemberCount: len(c.Members), CreatedAt: c.CreatedAt, LastTS: last,
			UnreadCount: m.UnreadCount,
			PeerID:      peerID, PeerNickname: peerNick,
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

func (s *Store) GetConv(convID, userID string) (*Conv, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.d.Convs[convID]
	if !ok {
		return nil, ErrNotFound
	}
	if _, member := c.Members[userID]; !member {
		return nil, ErrForbidden
	}
	return c, nil
}

// ConvDetail returns everything the UI needs about a conversation, from the
// calling user's point of view (their own title).
func (s *Store) ConvDetail(convID, userID string) (convOut, error) {
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
	peerID, peerNick := s.peerFields(c, userID)
	return convOut{
		ID: c.ID, Title: m.Title, Code: c.Code, CreatorID: c.CreatorID,
		CreatedAt: c.CreatedAt, MemberCount: len(c.Members),
		PeerID: peerID, PeerNickname: peerNick, Members: members,
	}, nil
}

// NewConvWith always creates a separate 1:1 conversation.
func (s *Store) NewConvWith(aID, bID string) (convBrief, error) {
	return s.convWith(aID, bID, true)
}

// ConvWith reuses the most recently created matching 1:1 conversation.
func (s *Store) ConvWith(aID, bID string) (convBrief, error) {
	return s.convWith(aID, bID, false)
}

var conversationTitles = []string{"需求与方案", "技术讨论", "问题排查", "实现思路", "功能规划", "测试与验证"}

func (s *Store) convWith(aID, bID string, createNew bool) (convBrief, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.d.Users[aID]
	b := s.d.Users[bID]
	if a == nil || b == nil {
		return convBrief{}, ErrUserNotFound
	}
	if aID == bID {
		return convBrief{}, ErrSelfPeer
	}
	var latest *Conv
	if !createNew {
		for _, c := range s.d.Convs {
			if len(c.Members) == 2 && c.Members[aID] != nil && c.Members[bID] != nil &&
				(latest == nil || c.CreatedNS > latest.CreatedNS || c.CreatedNS == latest.CreatedNS && (c.CreatedAt > latest.CreatedAt || c.CreatedAt == latest.CreatedAt && c.ID > latest.ID)) {
				latest = c
			}
		}
	}
	if latest != nil {
		return convBrief{ID: latest.ID, Title: latest.Members[aID].Title, Code: latest.Code}, nil
	}
	title := conversationTitles[fastrand()%len(conversationTitles)] + " · " + randSuffix(4)
	c := &Conv{
		ID: newID(), Title: title, CreatorID: aID, CreatedAt: now(), CreatedNS: s.nextNS(),
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

func (s *Store) RenameConv(convID, userID, title string) (convOut, error) {
	if strings.TrimSpace(title) == "" || len([]rune(strings.TrimSpace(title))) > 60 {
		return convOut{}, errors.New("标题需为 1-60 个字符")
	}
	s.mu.Lock()
	c := s.d.Convs[convID]
	if c == nil {
		s.mu.Unlock()
		return convOut{}, ErrNotFound
	}
	m := c.Members[userID]
	if m == nil {
		s.mu.Unlock()
		return convOut{}, ErrForbidden
	}
	m.Title = strings.TrimSpace(title)
	s.saveLocked()
	s.mu.Unlock()
	return s.ConvDetail(convID, userID)
}

func (s *Store) RecordImage(id, owner string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Images[id] = imageRecord{OwnerID: owner}
	s.saveLocked()
}

func (s *Store) ImageOwner(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.d.Images[id].OwnerID
}

func (s *Store) CanReadImage(id, userID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	owner := s.d.Images[id].OwnerID
	if owner == "" {
		return "", false
	}
	if owner == userID {
		return owner, true
	}
	for _, c := range s.d.Convs {
		if c.Members[userID] == nil {
			continue
		}
		for _, m := range c.Messages {
			if m.ImageID == id {
				return owner, true
			}
		}
	}
	return "", false
}

// ---- models (other users, shown in the composer's model picker) ----

type modelInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (s *Store) ListModels(exceptUserID string) []modelInfo {
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

func (s *Store) AddMessage(convID, senderID, nickname, content, clientMsgID string) (*Message, error) {
	return s.AddMessageWithImage(convID, senderID, nickname, content, clientMsgID, "")
}

func (s *Store) AddMessageWithImage(convID, senderID, nickname, content, clientMsgID, imageID string) (*Message, error) {
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
		if _, err := os.Stat(filepath.Join(filepath.Dir(s.path), "images", senderID, imageID+".webp")); err != nil {
			return nil, ErrNotFound
		}
	}
	m := &Message{
		ID: newID(), SenderID: senderID, Nickname: nickname,
		Content: content, TS: now(), ClientMsgID: clientMsgID, ImageID: imageID,
	}
	c.Messages = append(c.Messages, m)
	for id, member := range c.Members {
		if id != senderID {
			member.UnreadCount++
		}
	}
	const maxHistory = 5000
	if len(c.Messages) > maxHistory {
		c.Messages = c.Messages[len(c.Messages)-maxHistory:]
	}
	s.saveLocked()
	return m, nil
}

// MarkConvRead clears the recipient's unread count when they view the conversation.
func (s *Store) MarkConvRead(convID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.d.Convs[convID]
	if !ok {
		return ErrNotFound
	}
	member, ok := c.Members[userID]
	if !ok {
		return ErrForbidden
	}
	if member.UnreadCount != 0 {
		member.UnreadCount = 0
		s.saveLocked()
	}
	return nil
}

// RecentMessages returns the latest messages in ascending order, optionally
// only those newer than afterTS (used by clients to resync after a reconnect).
func (s *Store) RecentMessages(convID, userID string, afterTS int64) ([]*Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.d.Convs[convID]
	if !ok {
		return nil, ErrNotFound
	}
	if _, member := c.Members[userID]; !member {
		return nil, ErrForbidden
	}
	const limit = 200
	msgs := c.Messages
	if afterTS > 0 {
		idx := sort.Search(len(msgs), func(i int) bool { return msgs[i].TS > afterTS })
		msgs = msgs[idx:]
	}
	if len(msgs) > limit {
		msgs = msgs[len(msgs)-limit:]
	}
	out := make([]*Message, len(msgs))
	copy(out, msgs)
	return out, nil
}
