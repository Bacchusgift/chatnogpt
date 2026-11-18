package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testDSN resolves the MySQL DSN used by tests: CHATNOGPT_TEST_DSN env or
// data/conf/chatnogpt_test.env (gitignored). Tests skip without either.
func testDSN(t *testing.T) string {
	t.Helper()
	if dsn := os.Getenv("CHATNOGPT_TEST_DSN"); dsn != "" {
		return dsn
	}
	if b, err := os.ReadFile(filepath.Join("data", "conf", "chatnogpt_test.env")); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if v, ok := strings.CutPrefix(line, "CHATNOGPT_TEST_DSN="); ok {
				return strings.TrimSpace(v)
			}
		}
	}
	return ""
}

func openTestStore(t *testing.T) Store {
	t.Helper()
	if dsn := testDSN(t); dsn != "" {
		st, err := OpenStore(dsn, t.TempDir())
		if err != nil {
			t.Fatalf("open database store: %v", err)
		}
		t.Cleanup(func() { st.Close() })
		return st
	}
	st, err := OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("open file store: %v", err)
	}
	return st
}

func testStore(t *testing.T) Store {
	t.Helper()
	st := openTestStore(t)
	if err := st.Fresh(); err != nil {
		t.Fatalf("fresh db: %v", err)
	}
	return st
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	st := testStore(t)
	ts := httptest.NewServer(buildMux(newServer(st)))
	t.Cleanup(ts.Close)
	return ts
}

func doJSON(t *testing.T, method, url, token string, body any) (int, map[string]any) {
	t.Helper()
	var rd *strings.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = strings.NewReader(string(raw))
	} else {
		rd = strings.NewReader("")
	}
	req, err := http.NewRequest(method, url, rd)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func register(t *testing.T, ts *httptest.Server, username, nickname string) string {
	t.Helper()
	_, out := doJSON(t, "POST", ts.URL+"/api/register", "", map[string]any{
		"username": username, "nickname": nickname, "password": "password123",
	})
	tok, _ := out["token"].(string)
	if tok == "" {
		t.Fatalf("register %s failed: %v", username, out)
	}
	return tok
}

// ---- unit: password hashing ----

func TestPBKDF2Vector(t *testing.T) {
	got := pbkdf2SHA256([]byte("password"), []byte("salt"), 1, 32)
	want, _ := hex.DecodeString("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b")
	if !bytes.Equal(got, want) {
		t.Fatalf("pbkdf2 mismatch: got %x want %x", got, want)
	}
}

func TestPasswordRoundtrip(t *testing.T) {
	salt, hash := hashPassword("hello-世界-123")
	if !verifyPassword("hello-世界-123", salt, hash) {
		t.Fatal("correct password rejected")
	}
	if verifyPassword("wrong", salt, hash) {
		t.Fatal("wrong password accepted")
	}
}

// ---- end-to-end: REST + WebSocket ----

func TestRegisterCreateJoinChat(t *testing.T) {
	ts := newTestServer(t)

	tokenA := register(t, ts, "alice", "爱丽丝")
	tokenB := register(t, ts, "bob", "鲍勃")

	// duplicate username must fail
	_, out := doJSON(t, "POST", ts.URL+"/api/register", "", map[string]any{
		"username": "alice", "nickname": "x", "password": "password123",
	})
	if out["error"] == nil {
		t.Fatal("duplicate username should be rejected")
	}

	// wrong password must fail
	_, out = doJSON(t, "POST", ts.URL+"/api/login", "", map[string]any{
		"username": "alice", "password": "nope-nope",
	})
	if out["error"] == nil {
		t.Fatal("bad login should be rejected")
	}

	// unauthorized list must 401
	sc, _ := doJSON(t, "GET", ts.URL+"/api/conversations", "", nil)
	if sc != http.StatusUnauthorized {
		t.Fatalf("unauth list status = %d", sc)
	}

	// A creates a conversation
	_, out = doJSON(t, "POST", ts.URL+"/api/conversations", tokenA, map[string]any{"title": "我的秘密会话"})
	conv := out["conversation"].(map[string]any)
	convID := conv["id"].(string)
	code := conv["code"].(string)
	if len(code) != 8 {
		t.Fatalf("invite code = %q", code)
	}

	// B cannot join with a bogus code
	_, out = doJSON(t, "POST", ts.URL+"/api/conversations/join", tokenB, map[string]any{
		"code": "WRONGCOD", "title": "x",
	})
	if out["error"] == nil {
		t.Fatal("bad code should be rejected")
	}

	// B joins with the real code and their own title
	_, out = doJSON(t, "POST", ts.URL+"/api/conversations/join", tokenB, map[string]any{
		"code": code, "title": "B自己的标题",
	})
	if out["conversation"].(map[string]any)["id"] != convID {
		t.Fatal("join returned a different conversation")
	}

	// B's sidebar shows their own title
	_, lst := doJSON(t, "GET", ts.URL+"/api/conversations", tokenB, nil)
	arr := lst["conversations"].([]any)
	if len(arr) != 1 {
		t.Fatalf("want 1 conversation, got %d", len(arr))
	}
	if item := arr[0].(map[string]any); item["title"] != "B自己的标题" {
		t.Fatalf("member title = %v", item["title"])
	}

	// A still sees their own title in the detail
	_, det := doJSON(t, "GET", ts.URL+"/api/conversations/"+convID, tokenA, nil)
	d := det["conversation"].(map[string]any)
	if d["title"] != "我的秘密会话" {
		t.Fatalf("creator title = %v", d["title"])
	}
	if int(d["member_count"].(float64)) != 2 {
		t.Fatalf("member count = %v", d["member_count"])
	}

	// a third user who is not a member cannot read it
	tokenC := register(t, ts, "carol", "卡萝尔")
	sc, _ = doJSON(t, "GET", ts.URL+"/api/conversations/"+convID+"/messages", tokenC, nil)
	if sc != http.StatusNotFound {
		t.Fatalf("outsider read status = %d", sc)
	}

	// ---- websocket chat ----
	wa := wsDial(t, ts, convID, tokenA)
	defer wa.conn.Close()
	wb := wsDial(t, ts, convID, tokenB)
	defer wb.conn.Close()

	// B types; A sees the typing event, B does not get their own echo back
	wb.sendText(t, `{"type":"typing"}`)
	ev := wa.readEvent(t)
	if ev["type"] != "typing" || ev["nickname"] != "鲍勃" {
		t.Fatalf("typing event = %v", ev)
	}

	// B sends a real message
	wb.sendText(t, `{"type":"msg","content":"你好呀","client_msg_id":"c1"}`)
	ev = wa.readEvent(t)
	if ev["type"] != "msg" || ev["content"] != "你好呀" || ev["nickname"] != "鲍勃" {
		t.Fatalf("A got %v", ev)
	}
	if ev["client_msg_id"] != "c1" {
		t.Fatalf("client_msg_id echo missing: %v", ev)
	}
	if ev["sender_id"].(string) == "" {
		t.Fatal("sender_id missing")
	}

	// sender also receives the broadcast back (their other tabs rely on it)
	ev = wb.readEvent(t)
	if ev["type"] != "msg" || ev["content"] != "你好呀" {
		t.Fatalf("sender echo = %v", ev)
	}

	// A replies
	wa.sendText(t, `{"type":"msg","content":"你好，鲍勃","client_msg_id":"c2"}`)
	ev = wb.readEvent(t)
	if ev["type"] != "msg" || ev["content"] != "你好，鲍勃" || ev["nickname"] != "爱丽丝" {
		t.Fatalf("B got %v", ev)
	}

	// empty content is dropped
	wb.sendText(t, `{"type":"msg","content":"   ","client_msg_id":"c3"}`)
	// history via REST holds exactly the two real messages
	_, h := doJSON(t, "GET", ts.URL+"/api/conversations/"+convID+"/messages", tokenA, nil)
	msgs := h["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("history len = %d", len(msgs))
	}

	// resync: after_ts filter only returns the newer message
	_, h2 := doJSON(t, "GET", ts.URL+"/api/conversations/"+convID+"/messages?after_ts=0", tokenB, nil)
	if len(h2["messages"].([]any)) != 2 {
		t.Fatal("after_ts=0 should return all")
	}

	// websocket with a bad token must be rejected
	resp, err := http.Get(ts.URL + "/ws?conv=" + convID + "&token=bad")
	if err != nil {
		t.Fatalf("GET /ws: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad-token /ws status = %d", resp.StatusCode)
	}

	// plain GET /ws with a valid token (no upgrade headers) must be 400
	req, _ := http.NewRequest("GET", ts.URL+"/ws?conv="+convID+"&token="+tokenA, nil)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /ws valid: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Fatalf("no-upgrade /ws status = %d", resp2.StatusCode)
	}
}

// ---- model-name registration, model picker, implicit conversations ----

func TestModelRegisterAndConvWith(t *testing.T) {
	ts := newTestServer(t)

	// suggest returns a usable model-style name
	_, sg := doJSON(t, "GET", ts.URL+"/api/model-suggest", "", nil)
	name, _ := sg["name"].(string)
	if name == "" {
		t.Fatalf("empty suggestion: %v", sg)
	}

	// register by model name; login again using the same name
	_, out := doJSON(t, "POST", ts.URL+"/api/register", "", map[string]any{
		"name": name, "password": "password123",
	})
	user := out["user"].(map[string]any)
	tokenA := out["token"].(string)
	if user["nickname"] != name {
		t.Fatalf("nickname = %v, want %v", user["nickname"], name)
	}
	_, lo := doJSON(t, "POST", ts.URL+"/api/login", "", map[string]any{
		"name": name, "password": "password123",
	})
	if lo["token"] == nil {
		t.Fatalf("login by model name failed: %v", lo)
	}

	// duplicate name is auto-reassigned, not rejected
	_, dup := doJSON(t, "POST", ts.URL+"/api/register", "", map[string]any{
		"name": name, "password": "password123",
	})
	if dup["token"] == nil {
		t.Fatalf("duplicate-name register failed: %v", dup)
	}
	if dup["user"].(map[string]any)["nickname"] == name {
		t.Fatal("duplicate name should be auto-reassigned")
	}

	// second user via legacy fields becomes a selectable "model" for A
	_, o2 := doJSON(t, "POST", ts.URL+"/api/register", "", map[string]any{
		"username": "peeruser", "nickname": "peer-model", "password": "password123",
	})
	tokenB := o2["token"].(string)
	peerID := o2["user"].(map[string]any)["id"].(string)

	_, ml := doJSON(t, "GET", ts.URL+"/api/models", tokenA, nil)
	found := false
	for _, m := range ml["models"].([]any) {
		mm := m.(map[string]any)
		if mm["id"] == user["id"].(string) {
			t.Fatal("models list must not contain self")
		}
		if mm["id"] == peerID {
			found = true
		}
	}
	if !found {
		t.Fatal("peer missing from models list")
	}

	// conv-with creates once, then reuses the same conversation
	_, c1 := doJSON(t, "POST", ts.URL+"/api/conversations/with", tokenA, map[string]any{"peer_id": peerID})
	id1 := c1["conversation"].(map[string]any)["id"].(string)
	_, c2 := doJSON(t, "POST", ts.URL+"/api/conversations/with", tokenA, map[string]any{"peer_id": peerID})
	if c2["conversation"].(map[string]any)["id"] != id1 {
		t.Fatal("conv-with should reuse the existing conversation")
	}

	// from B's side it is the same conversation, titled with A's nickname
	_, cb := doJSON(t, "POST", ts.URL+"/api/conversations/with", tokenB, map[string]any{"peer_id": user["id"].(string)})
	bconv := cb["conversation"].(map[string]any)
	if bconv["id"] != id1 {
		t.Fatal("B should land in the same conversation")
	}
	if bconv["title"] == user["nickname"].(string) || bconv["title"] == "peer-model" {
		t.Fatalf("title should not be a model name: %v", bconv["title"])
	}

	// detail exposes peer fields for the picker
	_, det := doJSON(t, "GET", ts.URL+"/api/conversations/"+id1, tokenA, nil)
	dd := det["conversation"].(map[string]any)
	if dd["peer_id"] != peerID || dd["peer_nickname"] != "peer-model" {
		t.Fatalf("peer fields = %v / %v", dd["peer_id"], dd["peer_nickname"])
	}

	// picking yourself is rejected
	sc, selfResp := doJSON(t, "POST", ts.URL+"/api/conversations/with", tokenA, map[string]any{"peer_id": user["id"].(string)})
	t.Logf("DEBUG self: sc=%d resp=%v userID=%v", sc, selfResp, user["id"])
	if sc == http.StatusOK {
		t.Fatal("self peer should be rejected")
	}
}

// share-link paths (/s/<code>) must serve the SPA regardless of auth state
func TestShareLinkServesSPA(t *testing.T) {
	ts := newTestServer(t)
	for _, path := range []string{"/s/ABCD2345", "/s/abcd2345", "/s/ABCD2345/"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d", path, resp.StatusCode)
		}
		if !bytes.Contains(body, []byte("ChatNoGPT")) || !bytes.Contains(body, []byte("app.js")) {
			t.Fatalf("GET %s did not serve the SPA", path)
		}
	}
	// non-share unknown paths still 404
	resp, err := http.Get(ts.URL + "/other/unknown")
	if err != nil {
		t.Fatalf("GET /other/unknown: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /other/unknown status = %d", resp.StatusCode)
	}
}

// ---- raw websocket test client (client side must mask frames) ----

type testWS struct {
	conn net.Conn
	br   *bufio.Reader
}

func wsDial(t *testing.T, ts *httptest.Server, convID, token string) *testWS {
	t.Helper()
	host := strings.TrimPrefix(ts.URL, "http://")
	conn, err := net.DialTimeout("tcp", host, 3*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	key := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef"))
	req := "GET /ws?conv=" + convID + "&token=" + token + " HTTP/1.1\r\n" +
		"Host: " + host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write handshake: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReader(conn)
	var head strings.Builder
	buf := make([]byte, 1)
	for {
		n, err := br.Read(buf)
		if err != nil {
			t.Fatalf("read handshake: %v", err)
		}
		head.Write(buf[:n])
		if strings.HasSuffix(head.String(), "\r\n\r\n") {
			break
		}
		if head.Len() > 8192 {
			t.Fatal("handshake response too large")
		}
	}
	h := head.String()
	if !strings.HasPrefix(h, "HTTP/1.1 101") {
		t.Fatalf("handshake status: %q", h)
	}
	if !strings.Contains(h, acceptKeyOf(key)) {
		t.Fatalf("bad Sec-WebSocket-Accept: %q", h)
	}
	conn.SetReadDeadline(time.Time{})
	return &testWS{conn: conn, br: br}
}

func (c *testWS) sendText(t *testing.T, s string) {
	t.Helper()
	c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := writeFrameTo(c.conn, opText, []byte(s), true); err != nil {
		t.Fatalf("send frame: %v", err)
	}
}

func (c *testWS) readEvent(t *testing.T) map[string]any {
	t.Helper()
	c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, op, payload, err := readFrameFrom(c.br)
		if err != nil {
			t.Fatalf("read frame: %v", err)
		}
		switch op {
		case opText:
			var ev map[string]any
			if err := json.Unmarshal(payload, &ev); err != nil {
				t.Fatalf("bad json frame: %v", err)
			}
			return ev
		case opPing:
			_ = writeFrameTo(c.conn, opPong, payload, true)
		case opPong:
			// keep waiting
		case opClose:
			t.Fatal("server closed the connection unexpectedly")
		}
	}
}

// ---- cover-lines: thinking-disguise pool endpoint ----

func TestCoverLinesEndpoint(t *testing.T) {
	ts := newTestServer(t)

	// 未登录 → 401
	code, _ := doJSON(t, "GET", ts.URL+"/api/cover-lines", "", nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("cover-lines without token: got %d, want 401", code)
	}

	// 登录后 → 200 + 非空语料池
	tok := register(t, ts, "cover-user-a", "cover-model-a")
	code, out := doJSON(t, "GET", ts.URL+"/api/cover-lines", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("cover-lines: got %d, want 200 (%v)", code, out)
	}
	raw, _ := out["lines"].([]any)
	if len(raw) < 10 {
		t.Fatalf("cover-lines: got %d lines, want >= 10", len(raw))
	}
	if _, ok := out["count"].(float64); !ok {
		t.Fatalf("cover-lines: missing count field: %v", out)
	}
}

func TestBuiltinCoverLines(t *testing.T) {
	st := testStore(t)
	lines := newServer(st).cover.Lines()
	if len(lines) < 10 {
		t.Fatalf("pool too small: %d", len(lines))
	}
	lines[0] = "modified"
	if newServer(st).cover.Lines()[0] != builtinCoverLines[0] {
		t.Fatal("cover lines must be isolated from callers")
	}
}

func TestSearchMessages(t *testing.T) {
	if testDSN(t) == "" {
		st, err := OpenFileStore(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.SearchMessages("x", "y", 5); !errors.Is(err, ErrNoDatabase) {
			t.Fatalf("file search err = %v", err)
		}
		return
	}
	st := testStore(t)
	a, _, err := st.Register("search-a", "password123")
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := st.Register("search-b", "password123")
	if err != nil {
		t.Fatal(err)
	}
	conv, err := st.NewConvWith(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddMessage(conv.ID, b.ID, "search-b", "数据库里藏着一个独特关键词斑马象", ""); err != nil {
		t.Fatal(err)
	}
	hits, err := st.SearchMessages(a.ID, "斑马象", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].ConvID != conv.ID || !strings.Contains(hits[0].Message.Content, "斑马象") {
		t.Fatalf("hits = %+v", hits)
	}
	outsider, _, err := st.Register("search-c", "password123")
	if err != nil {
		t.Fatal(err)
	}
	if hits, _ := st.SearchMessages(outsider.ID, "斑马象", 10); len(hits) != 0 {
		t.Fatal("outsider should not see other conversations")
	}

	// 文件后端不支持搜索：应明确返回 ErrNoDatabase
	fileStore, err := OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fileStore.SearchMessages("x", "y", 5); err == nil || !errors.Is(err, ErrNoDatabase) {
		t.Fatalf("file search err = %v", err)
	}
}
