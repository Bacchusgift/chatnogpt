package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
)

func imageRequest(t *testing.T, url, token string, data []byte) (int, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	f, _ := mw.CreateFormFile("file", "x.webp")
	f.Write(data)
	mw.Close()
	req, _ := http.NewRequest("POST", url+"/api/images", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	raw, _ := io.ReadAll(resp.Body)
	// Only the status matters for failed uploads.
	if resp.StatusCode == 200 {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode, out
}

func imageGet(t *testing.T, url, token, id string) (int, []byte, http.Header) {
	t.Helper()
	req, _ := http.NewRequest("GET", url+"/api/images/"+id, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, resp.Header
}

func tinyWebP() []byte {
	b := make([]byte, 26)
	copy(b, "RIFF")
	binary.LittleEndian.PutUint32(b[4:], 18)
	copy(b[8:], "WEBPVP8L")
	binary.LittleEndian.PutUint32(b[16:], 5)
	b[20] = 0x2f
	return b
}

func TestMultipleConversationsAndRename(t *testing.T) {
	ts := newTestServer(t)
	a := register(t, ts, "new-a", "name-a")
	b := register(t, ts, "new-b", "name-b")
	outsider := register(t, ts, "new-c", "name-c")
	_, me := doJSON(t, "GET", ts.URL+"/api/me", b, nil)
	peer := me["user"].(map[string]any)["id"].(string)
	_, me = doJSON(t, "GET", ts.URL+"/api/me", a, nil)
	aid := me["user"].(map[string]any)["id"].(string)
	var ids []string
	for i := 0; i < 3; i++ {
		code, out := doJSON(t, "POST", ts.URL+"/api/conversations/new", a, map[string]any{"peer_id": peer})
		if code != 200 {
			t.Fatal(out)
		}
		c := out["conversation"].(map[string]any)
		if c["title"] == "name-a" || c["title"] == "name-b" {
			t.Fatal(c)
		}
		ids = append(ids, c["id"].(string))
	}
	if ids[0] == ids[1] || ids[1] == ids[2] {
		t.Fatal(ids)
	}
	_, out := doJSON(t, "POST", ts.URL+"/api/conversations/with", b, map[string]any{"peer_id": aid})
	if out["conversation"].(map[string]any)["id"] != ids[2] {
		t.Fatalf("not latest: %v", out)
	}
	for _, token := range []string{"", outsider} {
		code, _ := doJSON(t, "PATCH", ts.URL+"/api/conversations/"+ids[2], token, map[string]any{"title": "hijack"})
		if code == 200 {
			t.Fatal("unauthorized rename")
		}
	}
	code, out := doJSON(t, "PATCH", ts.URL+"/api/conversations/"+ids[2], a, map[string]any{"title": "  my title "})
	if code != 200 || out["conversation"].(map[string]any)["title"] != "my title" {
		t.Fatal(code, out)
	}
	_, out = doJSON(t, "GET", ts.URL+"/api/conversations/"+ids[2], b, nil)
	if out["conversation"].(map[string]any)["title"] == "my title" {
		t.Fatal("peer title changed")
	}
	_, out = doJSON(t, "GET", ts.URL+"/api/conversations/"+ids[1], a, nil)
	if out["conversation"].(map[string]any)["title"] == "my title" {
		t.Fatal("other conversation changed")
	}
}

func TestConversationTitleAndImageIndexPersist(t *testing.T) {
	dir := t.TempDir()
	st, err := LoadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a, _, err := st.Register("persistence-a", "password123")
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := st.Register("persistence-b", "password123")
	if err != nil {
		t.Fatal(err)
	}
	conv, err := st.NewConvWith(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.RenameConv(conv.ID, a.ID, "本地修改后的标题"); err != nil {
		t.Fatal(err)
	}
	st.RecordImage("stored-image", a.ID)
	reloaded, err := LoadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := reloaded.ConvDetail(conv.ID, a.ID)
	if err != nil || detail.Title != "本地修改后的标题" {
		t.Fatalf("title lost: %v, %v", detail.Title, err)
	}
	if reloaded.ImageOwner("stored-image") != a.ID {
		t.Fatal("image index lost")
	}
}

func TestImageAuthorizationAndWS(t *testing.T) {
	ts := newTestServer(t)
	a := register(t, ts, "img-a", "img-name-a")
	b := register(t, ts, "img-b", "img-name-b")
	c := register(t, ts, "img-c", "img-name-c")
	_, me := doJSON(t, "GET", ts.URL+"/api/me", b, nil)
	peer := me["user"].(map[string]any)["id"].(string)
	_, conv := doJSON(t, "POST", ts.URL+"/api/conversations/new", a, map[string]any{"peer_id": peer})
	cid := conv["conversation"].(map[string]any)["id"].(string)
	img := tinyWebP()
	if code, _ := imageRequest(t, ts.URL, "", img); code != 401 {
		t.Fatal(code)
	}
	for _, bad := range [][]byte{[]byte("not webp"), append(append([]byte{}, img...), 0), bytes.Repeat([]byte("a"), 1<<20)} {
		if code, _ := imageRequest(t, ts.URL, a, bad); code == 200 {
			t.Fatal("accepted bad upload")
		}
	}
	huge := tinyWebP()
	huge[21] = 0xff
	huge[22] = 0x3f // width > 4096
	if code, _ := imageRequest(t, ts.URL, a, huge); code == 200 {
		t.Fatal("oversized dimensions")
	}
	code, out := imageRequest(t, ts.URL, a, img)
	if code != 200 {
		t.Fatal(code, out)
	}
	id := out["id"].(string)
	for _, token := range []string{b, c, ""} {
		if status, _, _ := imageGet(t, ts.URL, token, id); status == 200 {
			t.Fatal("private image leaked")
		}
	}
	if status, got, h := imageGet(t, ts.URL, a, id); status != 200 || !bytes.Equal(got, img) || h.Get("Content-Type") != "image/webp" || h.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal(status, h)
	}
	wa := wsDial(t, ts, cid, a)
	defer wa.conn.Close()
	wb := wsDial(t, ts, cid, b)
	defer wb.conn.Close()
	wb.sendText(t, fmt.Sprintf(`{"type":"msg","image_id":%q}`, id)) // cannot attach another user's image
	wa.sendText(t, `{"type":"msg","image_id":"missing"}`)
	wa.sendText(t, fmt.Sprintf(`{"type":"msg","image_id":%q,"content":" "}`, id))
	ev := wb.readEvent(t)
	if ev["image_id"] != id || ev["content"] != "" {
		t.Fatal(ev)
	}
	_, hist := doJSON(t, "GET", ts.URL+"/api/conversations/"+cid+"/messages", b, nil)
	msgs := hist["messages"].([]any)
	if len(msgs) != 1 || msgs[0].(map[string]any)["image_id"] != id {
		t.Fatal(hist)
	}
	if status, got, _ := imageGet(t, ts.URL, b, id); status != 200 || !bytes.Equal(got, img) {
		t.Fatal("member cannot read shared image", status)
	}
	if status, _, _ := imageGet(t, ts.URL, c, id); status != 404 {
		t.Fatal(status)
	}
}
