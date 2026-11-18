package main

import (
	"encoding/json"
	"os"
	"strings"
)

// migrateFromJSON imports a legacy data.json store (pre-database format)
// into the MySQL schema, preserving every id, timestamp and token so users
// stay logged in and history keeps its order.
func migrateFromJSON(path string, st *Store) error {
	type legacyMember struct {
		UserID   string `json:"user_id"`
		Title    string `json:"title"`
		JoinedAt int64  `json:"joined_at"`
	}
	type legacyMessage struct {
		ID          string `json:"id"`
		SenderID    string `json:"sender_id"`
		Nickname    string `json:"nickname"`
		Content     string `json:"content"`
		TS          int64  `json:"ts"`
		ClientMsgID string `json:"client_msg_id"`
		ImageID     string `json:"image_id"`
	}
	type legacyConv struct {
		ID        string                   `json:"id"`
		Code      string                   `json:"code"`
		Title     string                   `json:"title"`
		CreatorID string                   `json:"creator_id"`
		CreatedAt int64                    `json:"created_at"`
		CreatedNS int64                    `json:"created_ns"`
		Members   map[string]*legacyMember `json:"members"`
		Messages  []*legacyMessage         `json:"messages"`
	}
	var d struct {
		Users        map[string]*User         `json:"users"`
		Tokens       map[string]string        `json:"tokens"`
		Convs        map[string]*legacyConv   `json:"convs"`
		Images       map[string]imageRecord   `json:"images"`
		CustomModels map[string]*CustomModel  `json:"custom_models"`
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return err
	}
	tx, err := st.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, u := range d.Users {
		if u == nil {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO users (id, username, username_lc, nickname, nickname_lc, salt, hash, created_at)
			VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE nickname=VALUES(nickname)`,
			u.ID, u.Username, strings.ToLower(u.Username), u.Nickname, strings.ToLower(u.Nickname), u.Salt, u.Hash, u.CreatedAt); err != nil {
			return err
		}
	}
	for token, uid := range d.Tokens {
		if uid == "" {
			continue
		}
		if _, err := tx.Exec("INSERT IGNORE INTO tokens (token, user_id) VALUES (?,?)", token, uid); err != nil {
			return err
		}
	}
	for _, c := range d.Convs {
		if c == nil {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO convs (id, code, title, creator_id, created_at, created_ns, kind)
			VALUES (?,?,?,?,?,?,0) ON DUPLICATE KEY UPDATE title=VALUES(title)`,
			c.ID, c.Code, c.Title, c.CreatorID, c.CreatedAt, c.CreatedNS); err != nil {
			return err
		}
		for _, m := range c.Members {
			if m == nil {
				continue
			}
			if _, err := tx.Exec(`INSERT IGNORE INTO conv_members (conv_id, user_id, title, joined_at)
				VALUES (?,?,?,?)`, c.ID, m.UserID, m.Title, m.JoinedAt); err != nil {
				return err
			}
		}
		for _, msg := range c.Messages {
			if msg == nil {
				continue
			}
			if _, err := tx.Exec(`INSERT IGNORE INTO messages (id, conv_id, sender_id, nickname, content, ts, client_msg_id, image_id)
				VALUES (?,?,?,?,?,?,?,?)`,
				msg.ID, c.ID, msg.SenderID, msg.Nickname, msg.Content, msg.TS, nullStr(msg.ClientMsgID), nullStr(msg.ImageID)); err != nil {
				return err
			}
		}
	}
	for id, rec := range d.Images {
		if _, err := tx.Exec("INSERT IGNORE INTO images (id, owner_id) VALUES (?,?)", id, rec.OwnerID); err != nil {
			return err
		}
	}
	for _, m := range d.CustomModels {
		if m == nil {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO custom_models (id, owner_id, name, url, text, position, chapter_id, chapter_offset, created_at)
			VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)`,
			m.ID, m.OwnerID, m.Name, m.URL, nullStr(m.Text), m.Position, m.ChapterID, m.ChapterOffset, m.CreatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}
