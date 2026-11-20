package main

import (
	"net/http/httptest"
	"testing"
)

func TestPluginHTTPFlow(t *testing.T) {
	st := testStore(t)
	ts := httptest.NewServer(buildMux(newServer(st)))
	defer ts.Close()

	sfx := "hp1"
	s, body := doJSON(t, "POST", ts.URL+"/api/register", "", map[string]any{"name": "plug-" + sfx, "password": "test-password-123"})
	if s != 200 {
		t.Fatalf("register: %d %v", s, body)
	}
	tok := body["token"].(string)

	// 目录：novel-reader 默认启用
	s, body = doJSON(t, "GET", ts.URL+"/api/plugins", tok, nil)
	if s != 200 {
		t.Fatalf("plugins list: %d %v", s, body)
	}
	plugs := body["plugins"].([]any)
	found := false
	for _, p := range plugs {
		pm := p.(map[string]any)
		if pm["name"] == "novel-reader" && pm["enabled"] == true {
			found = true
		}
	}
	if !found {
		t.Fatal("novel-reader missing or not enabled")
	}

	// 阅读模型创建（插件 API）
	s, body = doJSON(t, "POST", ts.URL+"/api/plugins/novel-reader/models", tok, map[string]any{"name": "HTTP 阅读模型"})
	if s != 200 {
		t.Fatalf("create model: %d %v", s, body)
	}

	// 停用插件 → 插件 API 403
	s, _ = doJSON(t, "POST", ts.URL+"/api/plugins", tok, map[string]any{"action": "disable", "name": "novel-reader"})
	if s != 200 {
		t.Fatalf("disable: %d", s)
	}
	s, body = doJSON(t, "GET", ts.URL+"/api/plugins/novel-reader/models", tok, nil)
	if s != 403 {
		t.Fatalf("disabled plugin API should 403, got %d", s)
	}

	// 重新启用 → 恢复
	s, _ = doJSON(t, "POST", ts.URL+"/api/plugins", tok, map[string]any{"action": "enable", "name": "novel-reader"})
	if s != 200 {
		t.Fatalf("enable: %d", s)
	}
	s, body = doJSON(t, "GET", ts.URL+"/api/plugins/novel-reader/models", tok, nil)
	if s != 200 {
		t.Fatalf("re-enabled plugin API: %d %v", s, body)
	}
}

func TestProjectHTTPFlow(t *testing.T) {
	st := testStore(t)
	ts := httptest.NewServer(buildMux(newServer(st)))
	defer ts.Close()

	sfx := "pj1"
	s, body := doJSON(t, "POST", ts.URL+"/api/register", "", map[string]any{"name": "pj-" + sfx, "password": "test-password-123"})
	if s != 200 {
		t.Fatalf("register: %d", s)
	}
	tok := body["token"].(string)
	breg := "pj-b-" + sfx
	s, body = doJSON(t, "POST", ts.URL+"/api/register", "", map[string]any{"name": breg, "password": "test-password-123"})
	bid := body["user"].(map[string]any)["id"].(string)

	s, body = doJSON(t, "POST", ts.URL+"/api/conversations/new", tok, map[string]any{"peer_id": bid})
	conv := body["conversation"].(map[string]any)["id"].(string)

	s, body = doJSON(t, "POST", ts.URL+"/api/projects", tok, map[string]any{"name": "项目 HTTP"})
	if s != 200 {
		t.Fatalf("create project: %d %v", s, body)
	}
	pid := body["project"].(map[string]any)["id"].(string)

	s, body = doJSON(t, "PUT", ts.URL+"/api/conversations/"+conv+"/project", tok, map[string]any{"project_id": pid})
	if s != 200 {
		t.Fatalf("assign: %d %v", s, body)
	}

	s, body = doJSON(t, "GET", ts.URL+"/api/conversations", tok, nil)
	sums := body["conversations"].([]any)
	assigned := false
	for _, c := range sums {
		cm := c.(map[string]any)
		if cm["id"] == conv && cm["project_id"] == pid {
			assigned = true
		}
	}
	if !assigned {
		t.Fatal("assignment missing in conversations list")
	}

	s, body = doJSON(t, "PATCH", ts.URL+"/api/projects/"+pid, tok, map[string]any{"name": "改名项目"})
	if s != 200 {
		t.Fatalf("rename: %d %v", s, body)
	}

	s, o2 := doJSON(t, "POST", ts.URL+"/api/register", "", map[string]any{"name": "pj-other-" + sfx, "password": "test-password-123"})
	otok := o2["token"].(string)
	if s, _ = doJSON(t, "PATCH", ts.URL+"/api/projects/"+pid, otok, map[string]any{"name": "hack"}); s == 200 {
		t.Fatal("cross-user rename should fail")
	}

	s, _ = doJSON(t, "DELETE", ts.URL+"/api/projects/"+pid, tok, nil)
	if s != 200 {
		t.Fatalf("delete: %d", s)
	}
	s, body = doJSON(t, "GET", ts.URL+"/api/conversations", tok, nil)
	for _, c := range body["conversations"].([]any) {
		cm := c.(map[string]any)
		if cm["id"] == conv {
			if pid, present := cm["project_id"]; present && pid != "" {
				t.Fatalf("project assignment should be cleared: %+v", cm)
			}
			break
		}
	}
}
