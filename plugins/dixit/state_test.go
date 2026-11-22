package dixit

import (
	"testing"
)

func TestStartAndView(t *testing.T) {
	p := New(Config{Dir: t.TempDir()})
	players := []DPlayer{
		{ID: "u1", Nickname: "A"},
		{ID: "u2", Nickname: "B"},
		{ID: "u3", Nickname: "C"},
	}
	st, err := p.StartGame("cv1", players)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if len(st.Players) != 3 {
		t.Fatalf("players = %d", len(st.Players))
	}
	if len(st.Players[0].Hand) != HandSize {
		t.Fatalf("hand = %d", len(st.Players[0].Hand))
	}
	v, err := p.View("cv1", "u1")
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	me := v["game"].(map[string]any)["me"].(map[string]any)
	if me["idx"] != 0 {
		t.Fatalf("me.idx = %v", me["idx"])
	}
	if me["idx"] != 0 {
		t.Fatalf("view me.idx = %v", me["idx"])
	}
}
