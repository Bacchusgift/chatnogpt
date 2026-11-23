package main

import (
	"fmt"
	"net/http"
	"testing"
)

func TestSearchCurrentConversation(t *testing.T) {
	ts := newTestServer(t)
	a := register(t, ts, "search-owner", "搜索甲")
	b := register(t, ts, "search-peer", "搜索乙")
	c := register(t, ts, "search-outsider", "搜索丙")
	_, room := doJSON(t, "POST", ts.URL+"/api/rooms", a, map[string]any{"title": "搜索测试", "invite": []string{"搜索乙"}})
	id := room["conversation"].(map[string]any)["id"].(string)
	base := ts.URL + "/api/conversations/" + id
	for i, content := range []string{"第一条 苹果", "无关消息", "第二条 苹果"} {
		status, out := doJSON(t, "POST", base+"/send", a, map[string]any{"content": content, "client_msg_id": fmt.Sprintf("search-%d", i)})
		if status != 200 {
			t.Fatalf("send: %d %v", status, out)
		}
	}
	status, result := doJSON(t, "GET", base+"/search?q=苹果", b, nil)
	if status != 200 {
		t.Fatalf("search: %d %v", status, result)
	}
	hits := result["hits"].([]any)
	if len(hits) != 2 {
		t.Fatalf("hits: %v", hits)
	}
	status, _ = doJSON(t, "GET", base+"/search?q=苹果", c, nil)
	if status == http.StatusOK {
		t.Fatal("outsider can search messages")
	}
	status, result = doJSON(t, "GET", base+"/search?q=无匹配", a, nil)
	if status != 200 || len(result["hits"].([]any)) != 0 {
		t.Fatalf("empty: %d %v", status, result)
	}
}
