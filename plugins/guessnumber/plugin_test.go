package guessnumber

import (
	"bytes"
	"chatnogpt/plugins/pluginbase"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGameFlow(t *testing.T) {
	players := []Player{{ID: "a", Nickname: "甲"}, {ID: "b", Nickname: "乙"}, {ID: "c", Nickname: "丙"}}
	p := New(Config{Dir: t.TempDir(), Members: func(_ string, u string) ([]Player, error) {
		if u == "outsider" {
			return nil, osErr{}
		}
		return players, nil
	}})
	call := func(user, method, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/api/plugins/guess-number?conv_id=room", bytes.NewBufferString(body))
		r = r.WithContext(pluginbase.WithUser(r.Context(), user))
		w := httptest.NewRecorder()
		p.handle(w, r)
		return w
	}
	check := func(w *httptest.ResponseRecorder, status int) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("got %d: %s", w.Code, w.Body.String())
		}
	}
	create := `{"conv_id":"room","action":"create"}`
	check(call("a", http.MethodPost, create), 200)
	check(call("a", http.MethodPost, `{"conv_id":"room","action":"set","number":50}`), 200)
	v := call("b", http.MethodGet, "")
	check(v, 200)
	var out struct {
		Game Game `json:"game"`
	}
	if json.Unmarshal(v.Body.Bytes(), &out) != nil || out.Game.Secret != 0 {
		t.Fatal("secret exposed")
	}
	check(call("c", http.MethodPost, `{"conv_id":"room","action":"guess","number":50}`), 403)
	check(call("b", http.MethodPost, `{"conv_id":"room","action":"guess","number":20}`), 200)
	v = call("c", http.MethodPost, `{"conv_id":"room","action":"guess","number":50}`)
	check(v, 200)
	if json.Unmarshal(v.Body.Bytes(), &out) != nil || out.Game.Phase != "result" || out.Game.Exploded != "丙" || out.Game.Secret != 50 {
		t.Fatalf("unexpected result %s", v.Body.String())
	}
	check(call("outsider", http.MethodGet, ""), 403)
}

type osErr struct{}

func (osErr) Error() string { return "not a member" }
