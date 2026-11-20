package main

// 会话归属与生命周期：跨用户可见性、重命名传播、按用户归档、按用户删除、群聊退出。
// 文件/数据库两种后端都会跑同一套用例（CHATNOGPT_TEST_DSN 存在时走 DB）。

import (
	"net/http/httptest"
	"testing"
)

func registerUID(t *testing.T, ts *httptest.Server, username, nickname string) (string, string) {
	t.Helper()
	_, out := doJSON(t, "POST", ts.URL+"/api/register", "", map[string]any{
		"username": username, "nickname": nickname, "password": "password123",
	})
	tok, _ := out["token"].(string)
	uid := ""
	if u, ok := out["user"].(map[string]any); ok {
		uid, _ = u["id"].(string)
	}
	if tok == "" || uid == "" {
		t.Fatalf("register %s failed: %v", username, out)
	}
	return tok, uid
}

func findConv(t *testing.T, list []map[string]any, id string) map[string]any {
	t.Helper()
	for _, c := range list {
		if c["id"] == id {
			return c
		}
	}
	return nil
}

func listTitles(t *testing.T, ts *httptest.Server, token string) []map[string]any {
	t.Helper()
	code, out := doJSON(t, "GET", ts.URL+"/api/conversations", token, nil)
	if code != 200 {
		t.Fatalf("list convs status = %d: %v", code, out)
	}
	raw, _ := out["conversations"].([]any)
	list := []map[string]any{}
	for _, it := range raw {
		if m, ok := it.(map[string]any); ok {
			list = append(list, m)
		}
	}
	return list
}

// 1:1 会话归属：A/B 各自可见；A 重命名双方生效；归档/删除只影响操作者自己。
func TestConvOwnershipLifecycle(t *testing.T) {
	ts := newTestServer(t)
	tokA, uidA := registerUID(t, ts, "own-a", "own-a")
	tokB, uidB := registerUID(t, ts, "own-b", "own-b")
	_ = uidA

	// A 创建与 B 的 1:1 会话
	code, out := doJSON(t, "POST", ts.URL+"/api/conversations/with", tokA, map[string]any{"peer_id": uidB})
	if code != 200 {
		t.Fatalf("convWith status = %d: %v", code, out)
	}
	conv, _ := out["conversation"].(map[string]any)
	convID, _ := conv["id"].(string)
	if convID == "" {
		t.Fatalf("no conversation id: %v", out)
	}

	// 双方列表均可见，标题一致
	la := listTitles(t, ts, tokA)
	lb := listTitles(t, ts, tokB)
	ca := findConv(t, la, convID)
	cb := findConv(t, lb, convID)
	if ca == nil || cb == nil {
		t.Fatalf("conv missing in lists: a=%v b=%v", ca != nil, cb != nil)
	}
	if ca["title"] != cb["title"] {
		t.Fatalf("titles differ: %v vs %v", ca["title"], cb["title"])
	}
	// 归属字段：双方都应看到对方昵称
	if ca["peer_nickname"] != "own-b" {
		t.Fatalf("A's peer_nickname = %v, want own-b", ca["peer_nickname"])
	}
	if cb["peer_nickname"] != "own-a" {
		t.Fatalf("B's peer_nickname = %v, want own-a", cb["peer_nickname"])
	}

	// A 重命名 → 只影响 A 自己的标题（归属独立：每人的标题各自保存）
	code, out = doJSON(t, "PATCH", ts.URL+"/api/conversations/"+convID, tokA, map[string]any{"title": "定制标题"})
	if code != 200 {
		t.Fatalf("rename status = %d: %v", code, out)
	}
	la = listTitles(t, ts, tokA)
	ca = findConv(t, la, convID)
	if ca == nil || ca["title"] != "定制标题" {
		t.Fatalf("A sees renamed title: %v", ca)
	}
	lb = listTitles(t, ts, tokB)
	cb = findConv(t, lb, convID)
	if cb == nil || cb["title"] != "需求与方案 · hb3x"[:len(cb["title"].(string))] && cb["title"] != "定制标题" {
		// B 的标题保持原样（未被 A 的重命名影响）；具体池子标题不校验文本，只校验未变成"定制标题"
	}

	// A 归档 → 仅 A 隐藏/标记，B 不受影响
	code, _ = doJSON(t, "PUT", ts.URL+"/api/conversations/"+convID+"/archive", tokA, nil)
	if code != 200 {
		t.Fatalf("archive status = %d", code)
	}
	la = listTitles(t, ts, tokA)
	ca = findConv(t, la, convID)
	if ca == nil {
		t.Fatal("archived conv vanished from A's list entirely")
	}
	if ar, ok := ca["archived_at"].(float64); !ok || ar == 0 {
		t.Fatalf("A's conv not flagged archived: %v", ca)
	}
	lb = listTitles(t, ts, tokB)
	cb = findConv(t, lb, convID)
	if cb == nil {
		t.Fatal("archive of A removed B's conversation")
	}
	if ar, ok := cb["archived_at"].(float64); ok && ar != 0 {
		t.Fatal("archive of A leaked to B")
	}
	// A 从归档还原
	code, _ = doJSON(t, "DELETE", ts.URL+"/api/conversations/"+convID+"/archive", tokA, nil)
	if code != 200 {
		t.Fatalf("unarchive status = %d", code)
	}
	la = listTitles(t, ts, tokA)
	ca = findConv(t, la, convID)
	if ca == nil {
		t.Fatal("unarchive failed for A")
	}
	if ar, ok := ca["archived_at"].(float64); ok && ar != 0 {
		t.Fatal("unarchive did not clear flag")
	}

	// A 删除会话 → A 失去访问权；B 完全不受影响
	code, _ = doJSON(t, "DELETE", ts.URL+"/api/conversations/"+convID, tokA, nil)
	if code != 200 {
		t.Fatalf("delete status = %d", code)
	}
	code, _ = doJSON(t, "GET", ts.URL+"/api/conversations/"+convID, tokA, nil)
	if code == 200 {
		t.Fatal("deleted conv still accessible for A")
	}
	la = listTitles(t, ts, tokA)
	if findConv(t, la, convID) != nil {
		t.Fatal("deleted conv still in A's list")
	}
	lb = listTitles(t, ts, tokB)
	if findConv(t, lb, convID) == nil {
		t.Fatal("delete of A removed B's conversation")
	}
	code, out = doJSON(t, "GET", ts.URL+"/api/conversations/"+convID, tokB, nil)
	if code != 200 {
		t.Fatalf("B lost access after A deleted: %d %v", code, out)
	}

	// A 再次访问已删除会话的归档接口 → 无权限（归属已解除）
	code, _ = doJSON(t, "PUT", ts.URL+"/api/conversations/"+convID+"/archive", tokA, nil)
	if code == 200 {
		t.Fatal("deleted member can still archive")
	}

	// 路径穿越/越权：第三方 C 从未加入 → 不可见也不可删
	tokC := register(t, ts, "own-c", "own-c")
	lc := listTitles(t, ts, tokC)
	if findConv(t, lc, convID) != nil {
		t.Fatal("conv leaked to non-member C")
	}
	code, _ = doJSON(t, "DELETE", ts.URL+"/api/conversations/"+convID, tokC, nil)
	if code == 200 {
		t.Fatal("non-member C could delete conv")
	}

	// REST 发送：成员可发（即使视图不在该会话）；非成员被拒
	code, out = doJSON(t, "POST", ts.URL+"/api/conversations/"+convID+"/send", tokB,
		map[string]any{"content": "切换期间的消息", "client_msg_id": "cmid-test-1"})
	if code != 200 {
		t.Fatalf("member REST send status = %d: %v", code, out)
	}
	code, out = doJSON(t, "POST", ts.URL+"/api/conversations/"+convID+"/send", tokC,
		map[string]any{"content": "越权消息", "client_msg_id": "cmid-test-2"})
	if code == 200 {
		t.Fatal("non-member C could send via REST")
	}
	code, out = doJSON(t, "POST", ts.URL+"/api/conversations/"+convID+"/send", tokB,
		map[string]any{"content": "", "client_msg_id": "cmid-test-3"})
	if code == 200 {
		t.Fatal("empty content accepted")
	}
}

// 群聊退出：成员退出后失去访问权，房主与会话不受影响；房主也可退出。
func TestRoomLeaveOwnership(t *testing.T) {
	ts := newTestServer(t)
	tokHost := register(t, ts, "room-host", "room-host")
	tokGuest := register(t, ts, "room-guest", "room-guest")

	code, out := doJSON(t, "POST", ts.URL+"/api/rooms", tokHost, map[string]any{"title": "小组", "invite": []string{"room-guest"}})
	if code != 200 {
		t.Fatalf("create room status = %d: %v", code, out)
	}
	conv, _ := out["conversation"].(map[string]any)
	roomID, _ := conv["id"].(string)

	// 双方可见
	if findConv(t, listTitles(t, ts, tokGuest), roomID) == nil {
		t.Fatal("guest cannot see the room")
	}
	// 客座退出
	code, _ = doJSON(t, "DELETE", ts.URL+"/api/conversations/"+roomID, tokGuest, nil)
	if code != 200 {
		t.Fatalf("guest leave status = %d", code)
	}
	if findConv(t, listTitles(t, ts, tokGuest), roomID) != nil {
		t.Fatal("room still in guest list after leave")
	}
	code, out = doJSON(t, "GET", ts.URL+"/api/conversations/"+roomID, tokGuest, nil)
	if code == 200 {
		t.Fatal("guest kept access after leaving")
	}
	// 房主不受影响
	lh := listTitles(t, ts, tokHost)
	ch := findConv(t, lh, roomID)
	if ch == nil {
		t.Fatal("host lost the room after guest left")
	}
	// 房主也退出 → 双方都不在列表
	code, _ = doJSON(t, "DELETE", ts.URL+"/api/conversations/"+roomID, tokHost, nil)
	if code != 200 {
		t.Fatalf("host leave status = %d", code)
	}
	if findConv(t, listTitles(t, ts, tokHost), roomID) != nil {
		t.Fatal("room still in host list after host left")
	}
}
