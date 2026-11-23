package main

import (
	"errors"
	"strings"
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
	ErrNoDatabase   = errors.New("该功能需要数据库模式：用 -db-dsn 或 CHATNOGPT_DB_DSN 配置后重启")
)

type User struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	Nickname  string `json:"nickname"` // 以 AI 身份发言时显示的名字
	Salt      string `json:"salt"`
	Hash      string `json:"hash"`
	CreatedAt int64  `json:"created_at"`
	// DisabledPlugins 该用户停用的插件名（JSON 存于 users.disabled_plugins）
	DisabledPlugins []string `json:"disabled_plugins,omitempty"`
}

type Member struct {
	UserID      string `json:"user_id"`
	Title       string `json:"title"` // 每个成员给会话自己取的名字
	ProjectID   string `json:"project_id,omitempty"`
	JoinedAt    int64  `json:"joined_at"`
	UnreadCount int    `json:"unread_count,omitempty"`
	ArchivedAt  int64  `json:"archived_at,omitempty"`
	DeletedAt   int64  `json:"deleted_at,omitempty"`
}

type Project struct {
	ID        string `json:"id"`
	OwnerID   string `json:"owner_id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
}

const recalledMessageText = "消息已撤回"

type Message struct {
	ID          string        `json:"id"`
	SenderID    string        `json:"sender_id"`
	Nickname    string        `json:"nickname"` // 发送时的昵称快照
	Content     string        `json:"content"`
	TS          int64         `json:"ts"`
	ClientMsgID string        `json:"client_msg_id,omitempty"`
	ImageID     string        `json:"image_id,omitempty"`
	ReplyTo     string        `json:"reply_to,omitempty"`  // 引用回复的目标消息 id
	Reactions   []MsgReaction `json:"reactions,omitempty"` // 聚合的表情回应（读取时拼装）
}

// MsgReaction 单条表情回应（Nickname 为回应者昵称快照）。
type MsgReaction struct {
	MsgID    string `json:"msg_id"`
	Emoji    string `json:"emoji"`
	UserID   string `json:"user_id,omitempty"`
	Nickname string `json:"nickname"`
}

type Conv struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Title     string `json:"title"` // 创建者取的原始标题
	CreatorID string `json:"creator_id"`
	CreatedAt int64  `json:"created_at"`
	CreatedNS int64  `json:"created_ns,omitempty"`
	Kind      int    `json:"kind"` // 0=一对一，1=群聊室
}

type convBrief struct {
	ID    string `json:"id"`
	Title string `json:"title"` // 当前用户视角的标题
	Code  string `json:"code"`
	Kind  int    `json:"kind"`
}

type convSummary struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Code         string `json:"code"`
	Kind         int    `json:"kind"`
	MemberCount  int    `json:"member_count"`
	CreatedAt    int64  `json:"created_at"`
	LastTS       int64  `json:"last_ts"`
	UnreadCount  int    `json:"unread_count"`
	ArchivedAt   int64  `json:"archived_at,omitempty"`
	PeerID       string `json:"peer_id,omitempty"`
	PeerNickname string `json:"peer_nickname,omitempty"`
	ProjectID    string `json:"project_id,omitempty"`
}

// UserBrief 群成员搜索结果（仅公开字段）。
type UserBrief struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
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
	Kind         int            `json:"kind"`
	CreatorID    string         `json:"creator_id"`
	CreatedAt    int64          `json:"created_at"`
	MemberCount  int            `json:"member_count"`
	PeerID       string         `json:"peer_id,omitempty"`
	PeerNickname string         `json:"peer_nickname,omitempty"`
	Members      []publicMember `json:"members"`
}

type modelInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type imageRecord struct {
	OwnerID string `json:"owner_id"`
}

type CustomModel struct {
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

// SearchHit is one message matched by SearchMessages (database mode only).
type SearchHit struct {
	ConvID  string  `json:"conv_id"`
	Title   string  `json:"title"`
	Message Message `json:"message"`
}

// Store abstracts persistence: MariaDB/MySQL when configured, otherwise a
// JSON file in the data directory. Both backends implement the full surface;
// database-only capabilities (like message search) degrade gracefully.
type Store interface {
	CreateUser(username, nickname, password string) (*User, string, error)
	Register(name, password string) (*User, string, error)
	Login(name, password string) (*User, string, error)
	UserByToken(token string) *User
	DropToken(token string)
	SuggestModelName() string
	SearchUsers(q, excludeUserID string) []UserBrief
	CreateConv(u *User, title string) convBrief
	JoinConv(u *User, code, title string) (convBrief, error)
	ListConvs(userID string) []convSummary
	SetConvArchived(convID, userID string, archived bool) error
	SetConvDeleted(convID, userID string, deleted bool) error
	PurgeExpiredArchives() error
	MarkConvRead(convID, userID string) error
	GetConv(convID, userID string) (*Conv, error)
	ConvDetail(convID, userID string) (convOut, error)
	NewConvWith(aID, bID string) (convBrief, error)
	ConvWith(aID, bID string) (convBrief, error)
	RenameConv(convID, userID, title string) (convOut, error)
	RecordImage(id, owner string)
	ImageOwner(id string) string
	CanReadImage(id, userID string) (string, bool)
	ListModels(exceptUserID string) []modelInfo
	AddMessage(convID, senderID, nickname, content, clientMsgID string) (*Message, error)
	AddMessageWithImage(convID, senderID, nickname, content, clientMsgID, imageID, replyTo string) (*Message, error)
	ToggleReaction(convID, msgID, userID, emoji string) (bool, error)
	ListReactions(convID string) ([]MsgReaction, error)
	UpdateOwnMessage(convID, senderID, msgID, content string, recall bool) (*Message, error)
	HistoryMessages(convID, userID string, afterTS, beforeTS int64, beforeID string, limit int) ([]*Message, error)
	CreateRoom(ownerID, title string, inviteNames []string) (convBrief, []string, error)
	RoomMembers(convID, userID string) ([]string, error)
	AddRoomMember(convID, actorID, name string) error
	RemoveRoomMember(convID, actorID, memberID string) error
	SetPluginDisabled(userID, plugin string, disabled bool) error
	SearchMessages(userID, query string, limit int) ([]SearchHit, error)
	SearchConversation(convID, userID, query string, limit int) ([]SearchHit, error)
	CreateProject(ownerID, name string) (Project, error)
	ListProjects(ownerID string) []Project
	RenameProject(userID, projectID, name string) (Project, error)
	DeleteProject(userID, projectID string) error
	SetConvProject(convID, userID, projectID string) error
	Fresh() error
	Close() error
	Dir() string
}

func now() int64 { return time.Now().Unix() }

// OpenStore connects the database-backed store (advanced capabilities).
func OpenStore(dsn, dir string) (Store, error) { return newDBStore(dsn, dir) }

// OpenFileStore opens the zero-config JSON-file fallback.
func OpenFileStore(dir string) (Store, error) { return newFileStore(dir) }

func clampTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		return "新的会话"
	}
	if n := len([]rune(title)); n > 60 {
		title = string([]rune(title)[:60])
	}
	return title
}
