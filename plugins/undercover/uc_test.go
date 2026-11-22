package undercover

import (
	"testing"
)

func TestStartDescribeVote(t *testing.T) {
	p := New(Config{Dir: t.TempDir()})
	players := []UPlayer{
		{ID: "u1", Nickname: "A"},
		{ID: "u2", Nickname: "B"},
		{ID: "u3", Nickname: "C"},
	}
	st, err := p.StartGame("cv1", players)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if st.Phase != phaseDescribe {
		t.Fatalf("phase = %s", st.Phase)
	}
	underCount := 0
	for i := range st.Players {
		if st.Players[i].IsUnder {
			underCount++
		}
	}
	if underCount != 1 {
		t.Fatalf("undercount = %d", underCount)
	}
	// 三人全部描述
	for _, pid := range []string{"u1", "u2", "u3"} {
		if _, err := p.MarkDescribed("cv1", pid); err != nil {
			t.Fatalf("describe %s: %v", pid, err)
		}
	}
	st2, _ := p.loadState("cv1")
	if st2.Phase != phaseVote {
		t.Fatalf("phase = %s, want vote", st2.Phase)
	}
	// 投票：u1->u2, u2->u1, u3->u1 → u1 出局（2 票）
	for _, vt := range [][2]string{{"u1", "u2"}, {"u2", "u1"}, {"u3", "u1"}} {
		if _, err := p.Vote("cv1", vt[0], vt[1]); err != nil {
			t.Fatalf("vote %s: %v", vt[0], err)
		}
	}
	st3, _ := p.loadState("cv1")
	if st3.Phase != phaseResult && st3.Winner == "" {
		t.Fatalf("no result: phase=%s winner=%q", st3.Phase, st3.Winner)
	}
	t.Logf("winner=%s last=%s", st3.Winner, st3.LastEvent)
}
