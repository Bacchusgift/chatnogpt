package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	mysql "github.com/go-sql-driver/mysql"
)

// Store backs every API/WS handler with MariaDB. Image files stay on disk
// under dir/images/<userID>; the database only keeps their metadata.
type dbStore struct {
	db     *sql.DB
	dir    string
	mu     sync.Mutex
	lastNS int64 // 会话创建顺序的时间戳（纳秒），保证单调递增
}

const storeSchema = `
CREATE TABLE IF NOT EXISTS users (
  id CHAR(12) PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  username_lc VARCHAR(64) NOT NULL UNIQUE,
  nickname VARCHAR(64) NOT NULL,
  nickname_lc VARCHAR(64) NOT NULL UNIQUE,
  salt VARCHAR(64) NOT NULL,
  hash VARCHAR(128) NOT NULL,
  created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tokens (
  token CHAR(48) PRIMARY KEY,
  user_id CHAR(12) NOT NULL,
  KEY idx_tokens_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS convs (
  id CHAR(12) PRIMARY KEY,
  code VARCHAR(16) NOT NULL UNIQUE,
  title VARCHAR(120) NOT NULL,
  creator_id CHAR(12) NOT NULL,
  created_at BIGINT NOT NULL,
  created_ns BIGINT NOT NULL DEFAULT 0,
  kind TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS projects (
  id CHAR(12) PRIMARY KEY,
  owner_id CHAR(12) NOT NULL,
  name VARCHAR(120) NOT NULL,
  created_at BIGINT NOT NULL,
  KEY idx_projects_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS conv_members (
  conv_id CHAR(12) NOT NULL,
  user_id CHAR(12) NOT NULL,
  project_id CHAR(12) NOT NULL DEFAULT '',
  title VARCHAR(120) NOT NULL DEFAULT '',
  joined_at BIGINT NOT NULL,
  unread_count INT NOT NULL DEFAULT 0,
  archived_at BIGINT NOT NULL DEFAULT 0,
  deleted_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (conv_id, user_id),
  KEY idx_cm_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS messages (
  id CHAR(12) PRIMARY KEY,
  conv_id CHAR(12) NOT NULL,
  sender_id CHAR(12) NOT NULL,
  nickname VARCHAR(64) NOT NULL DEFAULT '',
  content MEDIUMTEXT,
  ts BIGINT NOT NULL,
  client_msg_id VARCHAR(64) DEFAULT NULL,
  image_id VARCHAR(12) DEFAULT NULL,
  UNIQUE KEY uq_client (conv_id, client_msg_id),
  KEY idx_msg_conv_ts (conv_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS images (
  id CHAR(12) PRIMARY KEY,
  owner_id CHAR(12) NOT NULL,
  KEY idx_img_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS custom_models (
  id CHAR(12) PRIMARY KEY,
  owner_id CHAR(12) NOT NULL,
  name VARCHAR(120) NOT NULL,
  url VARCHAR(2048) NOT NULL DEFAULT '',
  text MEDIUMTEXT NULL,
  position BIGINT NOT NULL DEFAULT 0,
  chapter_id VARCHAR(64) NOT NULL DEFAULT '',
  chapter_offset BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  KEY idx_cm_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`

// OpenStore connects to MariaDB and makes sure the schema exists.
func newDBStore(dsn, dir string) (*dbStore, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(time.Hour)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	for _, stmt := range strings.Split(storeSchema, ";") {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("初始化表结构: %w", err)
		}
	}
	// Existing databases predate unread_count; a duplicate-column error means
	// the migration has already been applied.
	if _, err := db.Exec("ALTER TABLE conv_members ADD COLUMN unread_count INT NOT NULL DEFAULT 0"); err != nil && sqlErrCode(err) != 1060 {
		db.Close()
		return nil, fmt.Errorf("初始化未读计数: %w", err)
	}
	if _, err := db.Exec("ALTER TABLE users ADD COLUMN disabled_plugins TEXT NULL"); err != nil && sqlErrCode(err) != 1060 {
		db.Close()
		return nil, fmt.Errorf("初始化插件开关: %w", err)
	}
	if _, err := db.Exec("ALTER TABLE conv_members ADD COLUMN project_id CHAR(12) NOT NULL DEFAULT ''"); err != nil && sqlErrCode(err) != 1060 {
		db.Close()
		return nil, fmt.Errorf("初始化项目分组: %w", err)
	}
	for _, column := range []string{"archived_at", "deleted_at"} {
		if _, err := db.Exec("ALTER TABLE conv_members ADD COLUMN " + column + " BIGINT NOT NULL DEFAULT 0"); err != nil && sqlErrCode(err) != 1060 {
			db.Close()
			return nil, fmt.Errorf("初始化归档字段 %s: %w", column, err)
		}
	}
	return &dbStore{db: db, dir: dir}, nil
}

func (s *dbStore) Close() error { return s.db.Close() }

// DB exposes the raw connection (used by the one-shot JSON migrator).
func (s *dbStore) DB() *sql.DB { return s.db }

// Dir is the data directory holding image files.
func (s *dbStore) Dir() string { return s.dir }

// Fresh empties every table; used by the test harness between servers.
func (s *dbStore) Fresh() error {
	for _, table := range []string{"messages", "conv_members", "convs", "custom_models", "images", "tokens", "users"} {
		if _, err := s.db.Exec("DELETE FROM " + table); err != nil {
			return err
		}
	}
	return nil
}

// nextNS returns a strictly increasing nanosecond stamp so conversation
// creation order survives identical wall-clock times and clock steps.
func (s *dbStore) nextNS() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	ns := time.Now().UnixNano()
	if ns <= s.lastNS {
		ns = s.lastNS + 1
	}
	s.lastNS = ns
	return ns
}

func nullStr(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func sqlErrCode(err error) uint16 {
	var myErr *mysql.MySQLError
	if errors.As(err, &myErr) {
		return myErr.Number
	}
	return 0
}

// ---- users & auth ----

func (s *dbStore) CreateUser(username, nickname, password string) (*User, string, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	nickname = strings.TrimSpace(nickname)
	if err := validateRegister(username, nickname, password); err != nil {
		return nil, "", err
	}
	if s.nicknameTaken(nickname) {
		return nil, "", ErrNickTaken
	}
	if s.usernameTaken(username) {
		return nil, "", ErrNameTaken
	}
	u := &User{ID: newID(), Username: username, Nickname: nickname, CreatedAt: now()}
	u.Salt, u.Hash = hashPassword(password)
	if _, err := s.db.Exec(`INSERT INTO users (id, username, username_lc, nickname, nickname_lc, salt, hash, created_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		u.ID, u.Username, u.Username, u.Nickname, strings.ToLower(u.Nickname), u.Salt, u.Hash, u.CreatedAt); err != nil {
		if sqlErrCode(err) == 1062 {
			return nil, "", ErrNameTaken
		}
		return nil, "", err
	}
	token, err := s.insertToken(u.ID)
	if err != nil {
		return nil, "", err
	}
	return u, token, nil
}

func (s *dbStore) insertToken(userID string) (string, error) {
	token := newToken()
	if _, err := s.db.Exec("INSERT INTO tokens (token, user_id) VALUES (?,?)", token, userID); err != nil {
		return "", err
	}
	return token, nil
}

func (s *dbStore) usernameTaken(name string) bool {
	var one int
	err := s.db.QueryRow("SELECT 1 FROM users WHERE username_lc=? LIMIT 1", name).Scan(&one)
	return err == nil
}

func (s *dbStore) nicknameTaken(name string) bool {
	var one int
	err := s.db.QueryRow("SELECT 1 FROM users WHERE nickname_lc=? LIMIT 1", strings.ToLower(name)).Scan(&one)
	return err == nil
}

// modelNames is the pool used to auto-generate model-style display names.
var modelNames = []string{
	"gpt-6.1-sol", "glm-5.3-flash", "claude-sonnet-4.6", "gemini-3-pro",
	"grok-4.2", "deepseek-r2", "qwen-4-max", "kimi-k3", "llama-5-405b",
	"mistral-large-3", "yi-lightning-2", "minimax-m3", "doubao-pro-1.6",
	"hunyuan-turbo-s", "spark-4.5-ultra", "ernie-5.0", "baichuan-5-turbo",
	"step-3-max", "nova-pro-2", "orion-7b-chat",
}

// SuggestModelName returns an unused model-style name for the register form.
func (s *dbStore) SuggestModelName() string {
	for i := 0; i < 32; i++ {
		name := modelNames[fastrand()%len(modelNames)]
		if !s.nicknameTaken(name) {
			return name
		}
	}
	return modelNames[fastrand()%len(modelNames)] + "-" + randSuffix(4)
}

func fastrand() int {
	b := randomBytes(4)
	return int(b[0]) | int(b[1])<<8 | int(b[2])<<16 | int(b[3])<<24
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
func (s *dbStore) Register(name, password string) (*User, string, error) {
	if len(password) < 6 || len(password) > 64 {
		return nil, "", fmt.Errorf("密码长度需在 6-64 位之间")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = s.SuggestModelName()
	} else if n := len([]rune(name)); n > 30 {
		return nil, "", fmt.Errorf("模型名称需为 1-30 个字符")
	} else if s.nicknameTaken(name) {
		// 名称被占用：自动分配另一个可用的模型名
		name = s.SuggestModelName()
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
	if _, err := s.db.Exec(`INSERT INTO users (id, username, username_lc, nickname, nickname_lc, salt, hash, created_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		u.ID, u.Username, u.Username, u.Nickname, strings.ToLower(u.Nickname), u.Salt, u.Hash, u.CreatedAt); err != nil {
		if sqlErrCode(err) == 1062 {
			return nil, "", ErrNameTaken
		}
		return nil, "", err
	}
	token, err := s.insertToken(u.ID)
	if err != nil {
		return nil, "", err
	}
	return u, token, nil
}

func (s *dbStore) Login(name, password string) (*User, string, error) {
	key := strings.ToLower(strings.TrimSpace(name))
	var u User
	var disabled sql.NullString
	row := s.db.QueryRow(`SELECT id, username, nickname, salt, hash, created_at, COALESCE(disabled_plugins,'') FROM users
		WHERE nickname_lc=? OR username_lc=? LIMIT 1`, key, key)
	if err := row.Scan(&u.ID, &u.Username, &u.Nickname, &u.Salt, &u.Hash, &u.CreatedAt, &disabled); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, "", ErrBadAccount
		}
		return nil, "", err
	}
	if !verifyPassword(password, u.Salt, u.Hash) {
		return nil, "", ErrBadAccount
	}
	u.DisabledPlugins = decodeDisabled(disabled)
	token, err := s.insertToken(u.ID)
	if err != nil {
		return nil, "", err
	}
	return &u, token, nil
}

func (s *dbStore) UserByToken(token string) *User {
	var u User
	var disabled sql.NullString
	err := s.db.QueryRow(`SELECT u.id, u.username, u.nickname, u.salt, u.hash, u.created_at, COALESCE(u.disabled_plugins,'')
		FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token=?`, token).
		Scan(&u.ID, &u.Username, &u.Nickname, &u.Salt, &u.Hash, &u.CreatedAt, &disabled)
	if err != nil {
		return nil
	}
	u.DisabledPlugins = decodeDisabled(disabled)
	return &u
}

func (s *dbStore) DropToken(token string) {
	s.db.Exec("DELETE FROM tokens WHERE token=?", token)
}

// ---- conversations ----

func (s *dbStore) CreateConv(u *User, title string) convBrief {
	title = clampTitle(title)
	id, code, err := s.insertConv(title, u.ID, 0)
	if err != nil {
		return convBrief{}
	}
	s.db.Exec("INSERT INTO conv_members (conv_id, user_id, title, joined_at) VALUES (?,?,?,?)", id, u.ID, title, now())
	return convBrief{ID: id, Title: title, Code: code}
}

// insertConv creates the conversation row with a unique invite code and
// returns (id, code). kind: 0=direct 1=room.
func (s *dbStore) insertConv(title, creatorID string, kind int) (string, string, error) {
	id, ns := newID(), s.nextNS()
	for attempt := 0; attempt < 8; attempt++ {
		code := newInviteCode(8)
		_, err := s.db.Exec(`INSERT INTO convs (id, code, title, creator_id, created_at, created_ns, kind)
			VALUES (?,?,?,?,?,?,?)`, id, code, title, creatorID, now(), ns, kind)
		if err == nil {
			return id, code, nil
		}
		if sqlErrCode(err) != 1062 {
			return "", "", err
		}
	}
	return "", "", errors.New("无法生成邀请码")
}

// JoinConv adds the user to the conversation behind code, using their own
// local title. Joining twice keeps the original title.
func (s *dbStore) JoinConv(u *User, code, title string) (convBrief, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	title = clampTitle(title)
	var id string
	var kind int
	var convTitle string
	err := s.db.QueryRow("SELECT id, kind, title FROM convs WHERE code=?", code).Scan(&id, &kind, &convTitle)
	if errors.Is(err, sql.ErrNoRows) {
		return convBrief{}, ErrBadCode
	}
	if err != nil {
		return convBrief{}, err
	}
	var local string
	var deletedAt, archivedAt int64
	err = s.db.QueryRow("SELECT title, deleted_at, archived_at FROM conv_members WHERE conv_id=? AND user_id=?", id, u.ID).Scan(&local, &deletedAt, &archivedAt)
	if errors.Is(err, sql.ErrNoRows) {
		local = title
		if _, err := s.db.Exec("INSERT INTO conv_members (conv_id, user_id, title, joined_at) VALUES (?,?,?,?)",
			id, u.ID, title, now()); err != nil {
			return convBrief{}, err
		}
	} else if err != nil {
		return convBrief{}, err
	}
	if deletedAt != 0 || (archivedAt > 0 && now()-archivedAt >= archiveRetentionSeconds) {
		return convBrief{}, ErrBadCode
	}
	return convBrief{ID: id, Title: local, Code: code, Kind: kind}, nil
}

// peerOf returns the other member of a 1:1 conversation (empty for groups).
func (s *dbStore) peerOf(convID, userID string, memberCount int) (string, string) {
	if memberCount != 2 {
		return "", ""
	}
	var pid, nick string
	err := s.db.QueryRow(`SELECT cm.user_id, COALESCE(u.nickname,'') FROM conv_members cm
		LEFT JOIN users u ON u.id=cm.user_id WHERE cm.conv_id=? AND cm.user_id<>? LIMIT 1`,
		convID, userID).Scan(&pid, &nick)
	if err != nil {
		return "", ""
	}
	return pid, nick
}

func (s *dbStore) ListConvs(userID string) []convSummary {
	_ = s.PurgeExpiredArchives()
	rows, err := s.db.Query(`SELECT c.id, cm.title, c.code, c.kind, c.created_at, cm.unread_count, cm.project_id,
		COALESCE((SELECT MAX(m.ts) FROM messages m WHERE m.conv_id=c.id), 0) AS last_ts,
		(SELECT COUNT(*) FROM conv_members x WHERE x.conv_id=c.id) AS member_count, cm.archived_at
		FROM convs c JOIN conv_members cm ON cm.conv_id=c.id AND cm.user_id=? AND cm.deleted_at=0`, userID)
	if err != nil {
		return []convSummary{}
	}
	defer rows.Close()
	out := []convSummary{}
	type row0 struct {
		id, title, code               string
		kind                          int
		createdAt, lastTS, archivedAt int64
		memberCount, unreadCount      int
		projectID                     string
	}
	for rows.Next() {
		var r row0
		if err := rows.Scan(&r.id, &r.title, &r.code, &r.kind, &r.createdAt, &r.unreadCount, &r.projectID, &r.lastTS, &r.memberCount, &r.archivedAt); err != nil {
			continue
		}
		out = append(out, convSummary{ID: r.id, Title: r.title, Code: r.code, Kind: r.kind,
			MemberCount: r.memberCount, CreatedAt: r.createdAt, LastTS: r.lastTS, UnreadCount: r.unreadCount, ArchivedAt: r.archivedAt, ProjectID: r.projectID})
	}
	for i := range out {
		out[i].PeerID, out[i].PeerNickname = s.peerOf(out[i].ID, userID, out[i].MemberCount)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].LastTS != out[j].LastTS {
			return out[i].LastTS > out[j].LastTS
		}
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out
}

func (s *dbStore) PurgeExpiredArchives() error {
	_, err := s.db.Exec("UPDATE conv_members SET deleted_at=?, archived_at=0, unread_count=0 WHERE deleted_at=0 AND archived_at>0 AND archived_at<=?", now(), now()-archiveRetentionSeconds)
	return err
}

func (s *dbStore) SetConvArchived(convID, userID string, archived bool) error {
	if err := s.PurgeExpiredArchives(); err != nil {
		return err
	}
	at := int64(0)
	if archived {
		at = now()
	}
	result, err := s.db.Exec("UPDATE conv_members SET archived_at=?, unread_count=0 WHERE conv_id=? AND user_id=? AND deleted_at=0", at, convID, userID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *dbStore) MarkConvRead(convID, userID string) error {
	result, err := s.db.Exec("UPDATE conv_members SET unread_count=0 WHERE conv_id=? AND user_id=? AND deleted_at=0", convID, userID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		var exists int
		if err := s.db.QueryRow("SELECT 1 FROM conv_members WHERE conv_id=? AND user_id=? AND deleted_at=0", convID, userID).Scan(&exists); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
	}
	return nil
}

// GetConv only checks membership; details come from ConvDetail.
func (s *dbStore) GetConv(convID, userID string) (*Conv, error) {
	if err := s.PurgeExpiredArchives(); err != nil {
		return nil, err
	}
	var c Conv
	err := s.db.QueryRow("SELECT id, code, title, creator_id, created_at, created_ns, kind FROM convs WHERE id=?",
		convID).Scan(&c.ID, &c.Code, &c.Title, &c.CreatorID, &c.CreatedAt, &c.CreatedNS, &c.Kind)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var one int
	if err := s.db.QueryRow("SELECT 1 FROM conv_members WHERE conv_id=? AND user_id=? AND deleted_at=0",
		convID, userID).Scan(&one); err != nil {
		return nil, ErrForbidden
	}
	return &c, nil
}

// ConvDetail returns everything the UI needs about a conversation, from the
// calling user's point of view (their own title).
func (s *dbStore) ConvDetail(convID, userID string) (convOut, error) {
	var out convOut
	var myTitle string
	err := s.db.QueryRow(`SELECT c.id, c.code, c.kind, c.creator_id, c.created_at, cm.title,
		(SELECT COUNT(*) FROM conv_members x WHERE x.conv_id=c.id)
		FROM convs c JOIN conv_members cm ON cm.conv_id=c.id AND cm.user_id=? AND cm.deleted_at=0 WHERE c.id=?`,
		userID, convID).Scan(&out.ID, &out.Code, &out.Kind, &out.CreatorID, &out.CreatedAt, &myTitle, &out.MemberCount)
	if errors.Is(err, sql.ErrNoRows) {
		return convOut{}, ErrNotFound
	}
	if err != nil {
		return convOut{}, err
	}
	out.Title = myTitle
	memRows, err := s.db.Query(`SELECT cm.user_id, COALESCE(u.nickname,''), cm.joined_at
		FROM conv_members cm LEFT JOIN users u ON u.id=cm.user_id WHERE cm.conv_id=?`, convID)
	if err != nil {
		return convOut{}, err
	}
	defer memRows.Close()
	out.Members = []publicMember{}
	for memRows.Next() {
		var pm publicMember
		if err := memRows.Scan(&pm.ID, &pm.Nickname, &pm.JoinedAt); err != nil {
			return convOut{}, err
		}
		out.Members = append(out.Members, pm)
	}
	sort.Slice(out.Members, func(i, j int) bool { return out.Members[i].JoinedAt < out.Members[j].JoinedAt })
	out.PeerID, out.PeerNickname = s.peerOf(convID, userID, out.MemberCount)
	return out, nil
}

// NewConvWith always creates a separate 1:1 conversation.
func (s *dbStore) NewConvWith(aID, bID string) (convBrief, error) {
	return s.convWith(aID, bID, true)
}

// ConvWith reuses the most recently created matching 1:1 conversation.
func (s *dbStore) ConvWith(aID, bID string) (convBrief, error) {
	return s.convWith(aID, bID, false)
}

var conversationTitles = []string{"需求与方案", "技术讨论", "问题排查", "实现思路", "功能规划", "测试与验证"}

func (s *dbStore) convWith(aID, bID string, createNew bool) (convBrief, error) {
	if !createNew {
		var id, myTitle, code string
		var kind int
		err := s.db.QueryRow(`SELECT c.id, me.title, c.code, c.kind FROM convs c
			JOIN conv_members me ON me.conv_id=c.id AND me.user_id=? AND me.deleted_at=0 AND me.archived_at=0
			JOIN conv_members pe ON pe.conv_id=c.id AND pe.user_id=? AND pe.user_id<>me.user_id
			WHERE c.kind=0 AND (SELECT COUNT(*) FROM conv_members x WHERE x.conv_id=c.id)=2
			ORDER BY c.created_ns DESC LIMIT 1`, aID, bID).Scan(&id, &myTitle, &code, &kind)
		if err == nil {
			return convBrief{ID: id, Title: myTitle, Code: code, Kind: kind}, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return convBrief{}, err
		}
	}
	var aName, bName string
	if err := s.db.QueryRow("SELECT nickname FROM users WHERE id=?", aID).Scan(&aName); err != nil {
		return convBrief{}, ErrUserNotFound
	}
	if err := s.db.QueryRow("SELECT nickname FROM users WHERE id=?", bID).Scan(&bName); err != nil {
		return convBrief{}, ErrUserNotFound
	}
	if aID == bID {
		return convBrief{}, ErrSelfPeer
	}
	title := conversationTitles[fastrand()%len(conversationTitles)] + " · " + randSuffix(4)
	id, code, err := s.insertConv(title, aID, 0)
	if err != nil {
		return convBrief{}, err
	}
	ts := now()
	for _, member := range []string{aID, bID} {
		if _, err := s.db.Exec("INSERT INTO conv_members (conv_id, user_id, title, joined_at) VALUES (?,?,?,?)",
			id, member, title, ts); err != nil {
			return convBrief{}, err
		}
	}
	return convBrief{ID: id, Title: title, Code: code}, nil
}

func (s *dbStore) RenameConv(convID, userID, title string) (convOut, error) {
	title = strings.TrimSpace(title)
	if title == "" || len([]rune(title)) > 60 {
		return convOut{}, errors.New("标题需为 1-60 个字符")
	}
	res, err := s.db.Exec("UPDATE conv_members SET title=? WHERE conv_id=? AND user_id=?", title, convID, userID)
	if err != nil {
		return convOut{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return convOut{}, ErrForbidden
	}
	return s.ConvDetail(convID, userID)
}

func (s *dbStore) RecordImage(id, owner string) {
	s.db.Exec("INSERT INTO images (id, owner_id) VALUES (?,?) ON DUPLICATE KEY UPDATE owner_id=owner_id", id, owner)
}

func (s *dbStore) ImageOwner(id string) string {
	var owner string
	s.db.QueryRow("SELECT owner_id FROM images WHERE id=?", id).Scan(&owner)
	return owner
}

func (s *dbStore) CanReadImage(id, userID string) (string, bool) {
	var owner string
	err := s.db.QueryRow(`SELECT i.owner_id FROM images i WHERE i.id=? AND
		(i.owner_id=? OR EXISTS (SELECT 1 FROM messages m
			JOIN conv_members cm ON cm.conv_id=m.conv_id AND cm.user_id=? AND cm.deleted_at=0
			WHERE m.image_id=i.id))`, id, userID, userID).Scan(&owner)
	if err != nil {
		return "", false
	}
	return owner, true
}

// ---- models (other users, shown in the composer's model picker) ----

func (s *dbStore) ListModels(exceptUserID string) []modelInfo {
	rows, err := s.db.Query("SELECT id, nickname FROM users WHERE id<>? ORDER BY nickname", exceptUserID)
	if err != nil {
		return []modelInfo{}
	}
	defer rows.Close()
	out := []modelInfo{}
	for rows.Next() {
		var m modelInfo
		if rows.Scan(&m.ID, &m.Name) == nil {
			out = append(out, m)
		}
	}
	return out
}

// ---- messages ----

func (s *dbStore) AddMessage(convID, senderID, nickname, content, clientMsgID string) (*Message, error) {
	return s.AddMessageWithImage(convID, senderID, nickname, content, clientMsgID, "")
}

func (s *dbStore) AddMessageWithImage(convID, senderID, nickname, content, clientMsgID, imageID string) (*Message, error) {
	if err := s.PurgeExpiredArchives(); err != nil {
		return nil, err
	}
	var one int
	if err := s.db.QueryRow("SELECT 1 FROM conv_members WHERE conv_id=? AND user_id=? AND deleted_at=0",
		convID, senderID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if imageID != "" {
		var owner string
		if err := s.db.QueryRow("SELECT owner_id FROM images WHERE id=?", imageID).Scan(&owner); err != nil || owner != senderID {
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
	if _, err := s.db.Exec(`INSERT INTO messages (id, conv_id, sender_id, nickname, content, ts, client_msg_id, image_id)
		VALUES (?,?,?,?,?,?,?,?)`,
		m.ID, convID, m.SenderID, m.Nickname, m.Content, m.TS, nullStr(m.ClientMsgID), nullStr(m.ImageID)); err != nil {
		if sqlErrCode(err) == 1062 {
			// 客户端重发同一条消息：视为成功，返回已存在的记录
			if prev := s.messageByClientID(convID, clientMsgID); prev != nil {
				return prev, nil
			}
		}
		return nil, err
	}
	if _, err := s.db.Exec("UPDATE conv_members SET unread_count=unread_count+1 WHERE conv_id=? AND user_id<>?", convID, senderID); err != nil {
		return nil, err
	}
	// 与旧版一致：每个会话最多保留 5000 条消息
	s.db.Exec(`DELETE m FROM messages m JOIN
		(SELECT ts FROM messages WHERE conv_id=? ORDER BY ts DESC, id DESC LIMIT 1 OFFSET 5000) old
		ON m.conv_id=? AND m.ts <= old.ts`, convID, convID)
	return m, nil
}

func (s *dbStore) UpdateOwnMessage(convID, senderID, msgID, content string, recall bool) (*Message, error) {
	if err := s.PurgeExpiredArchives(); err != nil {
		return nil, err
	}
	var member int
	if err := s.db.QueryRow("SELECT 1 FROM conv_members WHERE conv_id=? AND user_id=? AND deleted_at=0", convID, senderID).Scan(&member); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var m Message
	err := s.db.QueryRow(`SELECT id, sender_id, nickname, content, ts, COALESCE(client_msg_id,''), COALESCE(image_id,'') FROM messages WHERE conv_id=? AND id=?`, convID, msgID).
		Scan(&m.ID, &m.SenderID, &m.Nickname, &m.Content, &m.TS, &m.ClientMsgID, &m.ImageID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if m.SenderID != senderID || (m.Content == recalledMessageText && m.ImageID == "") {
		return nil, ErrForbidden
	}
	if recall {
		m.Content = recalledMessageText
		m.ImageID = ""
	} else {
		m.Content = content
	}
	if _, err = s.db.Exec("UPDATE messages SET content=?, image_id=? WHERE conv_id=? AND id=? AND sender_id=?", m.Content, nullStr(m.ImageID), convID, msgID, senderID); err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *dbStore) messageByClientID(convID, clientMsgID string) *Message {
	if clientMsgID == "" {
		return nil
	}
	var m Message
	err := s.db.QueryRow(`SELECT id, sender_id, nickname, content, ts, COALESCE(client_msg_id,''), COALESCE(image_id,'')
		FROM messages WHERE conv_id=? AND client_msg_id=?`, convID, clientMsgID).
		Scan(&m.ID, &m.SenderID, &m.Nickname, &m.Content, &m.TS, &m.ClientMsgID, &m.ImageID)
	if err != nil {
		return nil
	}
	return &m
}

// HistoryMessages returns messages in ascending order. afterTS>0 keeps only
// newer messages (reconnect resync); beforeTS>0 with beforeID pages older
// history (lazy loading). limit<=0 defaults to 200.
func (s *dbStore) HistoryMessages(convID, userID string, afterTS, beforeTS int64, beforeID string, limit int) ([]*Message, error) {
	if err := s.PurgeExpiredArchives(); err != nil {
		return nil, err
	}
	var one int
	if err := s.db.QueryRow("SELECT 1 FROM conv_members WHERE conv_id=? AND user_id=? AND deleted_at=0",
		convID, userID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	var rows *sql.Rows
	var err error
	if beforeTS > 0 {
		rows, err = s.db.Query(`SELECT id, sender_id, nickname, content, ts, COALESCE(client_msg_id,''), COALESCE(image_id,'')
			FROM messages WHERE conv_id=? AND (ts<? OR (ts=? AND id<?))
			ORDER BY ts DESC, id DESC LIMIT ?`, convID, beforeTS, beforeTS, beforeID, limit)
	} else {
		rows, err = s.db.Query(`SELECT id, sender_id, nickname, content, ts, COALESCE(client_msg_id,''), COALESCE(image_id,'')
			FROM messages WHERE conv_id=? AND ts>? ORDER BY ts DESC LIMIT ?`, convID, afterTS, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Message{}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.SenderID, &m.Nickname, &m.Content, &m.TS, &m.ClientMsgID, &m.ImageID); err != nil {
			continue
		}
		out = append(out, &m)
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

// ---- rooms (multi-person group chat) ----

// CreateRoom creates a kind=1 conversation and invites members by model name
// (nickname or username, case-insensitive). Unmatched names are returned so
// the caller can tell the user who was not invited.
func (s *dbStore) CreateRoom(ownerID, title string, inviteNames []string) (convBrief, []string, error) {
	title = clampTitle(title)
	invited := map[string]bool{ownerID: true}
	missing := []string{}
	members := []string{}
	for _, raw := range inviteNames {
		name := strings.ToLower(strings.TrimSpace(raw))
		if name == "" {
			continue
		}
		var id string
		err := s.db.QueryRow("SELECT id FROM users WHERE nickname_lc=? OR username_lc=? LIMIT 1", name, name).Scan(&id)
		if err != nil || invited[id] {
			missing = append(missing, strings.TrimSpace(raw))
			continue
		}
		invited[id] = true
		members = append(members, id)
	}
	id, code, err := s.insertConv(title, ownerID, 1)
	if err != nil {
		return convBrief{}, missing, err
	}
	ts := now()
	for _, member := range append([]string{ownerID}, members...) {
		if _, err := s.db.Exec("INSERT INTO conv_members (conv_id, user_id, title, joined_at) VALUES (?,?,?,?)",
			id, member, title, ts); err != nil {
			return convBrief{}, missing, err
		}
	}
	return convBrief{ID: id, Title: title, Code: code, Kind: 1}, missing, nil
}

// RoomMembers lists the display names inside a room.
func (s *dbStore) RoomMembers(convID, userID string) ([]string, error) {
	if _, err := s.GetConv(convID, userID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT COALESCE(u.nickname,'') FROM conv_members cm
		LEFT JOIN users u ON u.id=cm.user_id WHERE cm.conv_id=? ORDER BY cm.joined_at`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var nick string
		if rows.Scan(&nick) == nil {
			out = append(out, nick)
		}
	}
	return out, nil
}

// ---- custom reading models ----

// CreateCustomModel registers a private reading model for the owner.

// SearchMessages finds messages containing the query across every
// conversation the user belongs to (database-only capability).
func (s *dbStore) SearchMessages(userID, query string, limit int) ([]SearchHit, error) {
	pattern := "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(query) + "%"
	rows, err := s.db.Query(`SELECT m.id, m.conv_id, m.sender_id, m.nickname, m.content, m.ts,
		COALESCE(m.client_msg_id,''), COALESCE(m.image_id,''), COALESCE(NULLIF(mt.title,''), c.title)
		FROM messages m
		JOIN conv_members me ON me.conv_id=m.conv_id AND me.user_id=? AND me.deleted_at=0
		LEFT JOIN conv_members mt ON mt.conv_id=m.conv_id AND mt.user_id=?
		JOIN convs c ON c.id=m.conv_id
		WHERE m.content LIKE ? ORDER BY m.ts DESC LIMIT ?`, userID, userID, pattern, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SearchHit{}
	for rows.Next() {
		var h SearchHit
		if err := rows.Scan(&h.Message.ID, &h.ConvID, &h.Message.SenderID, &h.Message.Nickname,
			&h.Message.Content, &h.Message.TS, &h.Message.ClientMsgID, &h.Message.ImageID, &h.Title); err != nil {
			continue
		}
		out = append(out, h)
	}
	return out, nil
}

// decodeDisabled 解析 users.disabled_plugins（JSON 数组文本）。
func decodeDisabled(s sql.NullString) []string {
	if !s.Valid || strings.TrimSpace(s.String) == "" {
		return nil
	}
	var list []string
	if err := json.Unmarshal([]byte(s.String), &list); err != nil {
		return nil
	}
	return list
}

// SetPluginDisabled 按用户记录插件停用集合（JSON 文本存于 users 行）。
// ---- 项目分组（按用户独立的会话分组） ----

func (s *dbStore) CreateProject(ownerID, name string) (Project, error) {
	p := Project{ID: newID(), OwnerID: ownerID, Name: clampTitle(name), CreatedAt: now()}
	if p.Name == "" {
		p.Name = "新建项目"
	}
	_, err := s.db.Exec("INSERT INTO projects (id, owner_id, name, created_at) VALUES (?,?,?,?)",
		p.ID, p.OwnerID, p.Name, p.CreatedAt)
	return p, err
}

func (s *dbStore) ListProjects(ownerID string) []Project {
	rows, err := s.db.Query("SELECT id, owner_id, name, created_at FROM projects WHERE owner_id=? ORDER BY created_at", ownerID)
	if err != nil {
		return []Project{}
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		var p Project
		if rows.Scan(&p.ID, &p.OwnerID, &p.Name, &p.CreatedAt) == nil {
			out = append(out, p)
		}
	}
	return out
}

func (s *dbStore) RenameProject(userID, projectID, name string) (Project, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 60 {
		return Project{}, errors.New("项目名需为 1-60 个字符")
	}
	res, err := s.db.Exec("UPDATE projects SET name=? WHERE id=? AND owner_id=?", name, projectID, userID)
	if err != nil {
		return Project{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Project{}, ErrNotFound
	}
	var p Project
	err = s.db.QueryRow("SELECT id, owner_id, name, created_at FROM projects WHERE id=?", projectID).
		Scan(&p.ID, &p.OwnerID, &p.Name, &p.CreatedAt)
	return p, err
}

func (s *dbStore) DeleteProject(userID, projectID string) error {
	if _, err := s.db.Exec("UPDATE conv_members SET project_id='' WHERE user_id=? AND project_id=?", userID, projectID); err != nil {
		return err
	}
	_, err := s.db.Exec("DELETE FROM projects WHERE id=? AND owner_id=?", projectID, userID)
	return err
}

func (s *dbStore) SetConvProject(convID, userID, projectID string) error {
	if projectID != "" {
		var owner string
		if err := s.db.QueryRow("SELECT owner_id FROM projects WHERE id=?", projectID).Scan(&owner); err != nil {
			return ErrNotFound
		}
		if owner != userID {
			return ErrForbidden
		}
	}
	res, err := s.db.Exec("UPDATE conv_members SET project_id=? WHERE conv_id=? AND user_id=?", projectID, convID, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrForbidden
	}
	return nil
}

func (s *dbStore) SetPluginDisabled(userID, plugin string, disabled bool) error {
	var cur sql.NullString
	if err := s.db.QueryRow("SELECT COALESCE(disabled_plugins,'') FROM users WHERE id=?", userID).Scan(&cur); err != nil {
		return err
	}
	list := decodeDisabled(cur)
	contains := false
	out := make([]string, 0, len(list)+1)
	for _, name := range list {
		if name == plugin {
			contains = true
			if !disabled {
				continue
			}
		}
		out = append(out, name)
	}
	if disabled && !contains {
		out = append(out, plugin)
	}
	b, err := json.Marshal(out)
	if err != nil {
		return err
	}
	payload := string(b)
	if len(out) == 0 {
		payload = ""
	}
	_, err = s.db.Exec("UPDATE users SET disabled_plugins=? WHERE id=?", payload, userID)
	return err
}
