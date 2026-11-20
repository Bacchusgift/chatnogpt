package main

import (
	"testing"
)

func TestProjectsAndConvAssignment(t *testing.T) {
	st := testStore(t)
	a, _, err := st.Register("proj-a", "password123")
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := st.Register("proj-b", "password123")
	if err != nil {
		t.Fatal(err)
	}
	conv, err := st.NewConvWith(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 创建项目（A 名下）
	p, err := st.CreateProject(a.ID, "需求池")
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "需求池" {
		t.Fatalf("name = %q", p.Name)
	}
	// 归类会话
	if err := st.SetConvProject(conv.ID, a.ID, p.ID); err != nil {
		t.Fatal(err)
	}
	// A 视角能看到 project_id
	sums := st.ListConvs(a.ID)
	found := false
	for _, s := range sums {
		if s.ID == conv.ID && s.ProjectID == p.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("project assignment lost for owner")
	}
	// B 视角不受影响（B 自己没归组）
	for _, s := range st.ListConvs(b.ID) {
		if s.ID == conv.ID && s.ProjectID != "" {
			t.Fatal("project assignment leaked to peer")
		}
	}
	// 重命名
	if _, err := st.RenameProject(a.ID, p.ID, "迭代一"); err != nil {
		t.Fatal(err)
	}
	// 删除项目 → 会话移出分组
	if err := st.DeleteProject(a.ID, p.ID); err != nil {
		t.Fatal(err)
	}
	for _, s := range st.ListConvs(a.ID) {
		if s.ID == conv.ID && s.ProjectID != "" {
			t.Fatal("project assignment should be cleared after delete")
		}
	}
	// 越权：B 不能把会话归到 A 的项目（项目已删，任何 set 都应拒绝或按空处理）
	if err := st.SetConvProject(conv.ID, b.ID, p.ID); err == nil {
		t.Fatal("non-owner project assignment should fail")
	}
}
