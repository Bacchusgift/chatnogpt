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
	st, err := p.StartGame("cv1", "u1", players)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if st.Phase != phaseStory {
		t.Fatalf("phase = %s", st.Phase)
	}
	if len(st.Players[0].Hand) != HandSize {
		t.Fatalf("hand = %d", len(st.Players[0].Hand))
	}
	if st.StoryIdx != 0 {
		t.Fatalf("storyidx = %d", st.StoryIdx)
	}
	v, err := p.View("cv1", "u1")
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	me := v["game"].(map[string]any)["me"].(map[string]any)
	if me["idx"] != 0 {
		t.Fatalf("view me.idx = %v", me["idx"])
	}
	// 讲者出牌 → 状态应持久化为 pick
	card := me["hand"].([]int)[0]
	if _, err := p.StoryPlay("cv1", "u1", card); err != nil {
		t.Fatalf("story play: %v", err)
	}
	st2, err2 := p.loadState("cv1")
	if err2 != nil {
		t.Fatalf("reload: %v", err2)
	}
	if st2.Phase != phasePick {
		t.Fatalf("phase after story = %s, want pick", st2.Phase)
	}
	if len(st2.Table) != 1 {
		t.Fatalf("table = %d", len(st2.Table))
	}
}
