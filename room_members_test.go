package main

import (
	"net/http"
	"testing"
)

func TestRoomMemberManagement(t *testing.T) {
	ts := newTestServer(t)
	owner := register(t, ts, "owner-member", "群主甲")
	member := register(t, ts, "member-one", "成员乙")
	outsider := register(t, ts, "member-two", "成员丙")
	code, room := doJSON(t, "POST", ts.URL+"/api/rooms", owner, map[string]any{"title": "群聊", "invite": []string{"成员乙"}})
	if code != 200 {
		t.Fatalf("create: %d %v", code, room)
	}
	id := room["conversation"].(map[string]any)["id"].(string)
	path := ts.URL + "/api/conversations/" + id
	code, profile := doJSON(t, "GET", ts.URL+"/api/me", outsider, nil)
	if code != 200 {
		t.Fatal(profile)
	}
	outsiderID := profile["user"].(map[string]any)["id"].(string)
	code, _ = doJSON(t, "POST", path+"/members", member, map[string]any{"name": "成员丙"})
	if code != http.StatusNotFound && code != http.StatusForbidden {
		t.Fatalf("non owner add: %d", code)
	}
	code, detail := doJSON(t, "POST", path+"/members", owner, map[string]any{"name": "成员丙"})
	if code != 200 || detail["conversation"].(map[string]any)["member_count"].(float64) != 3 {
		t.Fatalf("add: %d %v", code, detail)
	}
	code, _ = doJSON(t, "GET", path, outsider, nil)
	if code != 200 {
		t.Fatalf("added cannot access: %d", code)
	}
	code, _ = doJSON(t, "DELETE", path+"/members/"+outsiderID, owner, nil)
	if code != 200 {
		t.Fatalf("remove: %d", code)
	}
	code, _ = doJSON(t, "GET", path, outsider, nil)
	if code == 200 {
		t.Fatal("removed member still has access")
	}
	code, _ = doJSON(t, "POST", path+"/members", owner, map[string]any{"name": "成员丙"})
	if code != 200 {
		t.Fatalf("readd: %d", code)
	}
}
