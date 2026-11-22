package dixit

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// HTTP 全链路：注册（gate 注入身份）→ 开局 → 视图按身份裁剪
func TestHTTPStartAndView(t *testing.T) {
	p := New(Config{Dir: t.TempDir()})
	mux := http.NewServeMux()
	gate := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			next(w, r.WithContext(WithUser(r.Context(), "owner-u1")))
		}
	}
	p.Mount(mux, gate)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	// PUT /rooms 注册
	r1, _ := http.NewRequest("PUT", ts.URL+Prefix+"/rooms", strings.NewReader(`{"conv_id":"cv9"}`))
	r1.Header.Set("Content-Type", "application/json")
	resp1, err := http.DefaultClient.Do(r1)
	if err != nil {
		t.Fatal(err)
	}
	resp1.Body.Close()
	if resp1.StatusCode != 200 {
		t.Fatalf("PUT rooms = %d", resp1.StatusCode)
	}

	// POST /games 开局
	body := `{"conv_id":"cv9","players":[{"id":"owner-u1","nickname":"甲"},{"id":"u2x","nickname":"乙"},{"id":"u3x","nickname":"丙"}]}`
	r2, _ := http.NewRequest("POST", ts.URL+Prefix+"/games", strings.NewReader(body))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set("Authorization", "Bearer x")
	resp2, err := http.DefaultClient.Do(r2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		raw, _ := io.ReadAll(resp2.Body)
		t.Fatalf("POST games = %d body=%s", resp2.StatusCode, string(raw))
	}

	// GET 视图：me 应有 idx=0 与 10 张手牌
	r3, _ := http.NewRequest("GET", ts.URL+Prefix+"/games?conv=cv9", nil)
	resp3, err := http.DefaultClient.Do(r3)
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	raw, _ := io.ReadAll(resp3.Body)
	out := string(raw)
	if !strings.Contains(out, `"idx":0`) {
		t.Fatalf("view missing me.idx=0: %s", out[:min0(len(out), 400)])
	}
	if !strings.Contains(out, `"hand":[`) {
		t.Fatalf("view missing hand: %s", out[:min0(len(out), 400)])
	}
	t.Logf("view ok")
}

func min0(a, b int) int {
	if a < b {
		return a
	}
	return b
}
