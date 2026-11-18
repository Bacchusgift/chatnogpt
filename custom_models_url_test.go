package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCustomModelURLChangeResetsReadingProgress(t *testing.T) {
	st, err := OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner, token, err := st.CreateUser("url-owner", "URL Owner", "password123")
	if err != nil {
		t.Fatal(err)
	}
	_, otherToken, err := st.CreateUser("url-other", "URL Other", "password123")
	if err != nil {
		t.Fatal(err)
	}
	m, err := st.CreateCustomModel(owner.ID, "Reader", "https://fanqienovel.com/reader/123")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveCustomModelProgress(m.ID, owner.ID, "123", 52); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveCustomModelPosition(m.ID, owner.ID, 17); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(buildMux(newServer(st)))
	defer ts.Close()
	endpoint := ts.URL + "/api/custom-models/" + m.ID + "/url"
	if code, _ := doJSON(t, http.MethodPut, endpoint, otherToken, map[string]string{"url": "https://fanqienovel.com/reader/456"}); code != http.StatusNotFound {
		t.Fatalf("other user update status = %d", code)
	}
	if code, _ := doJSON(t, http.MethodPut, endpoint, token, map[string]string{"url": "file:///invalid"}); code != http.StatusBadRequest {
		t.Fatalf("invalid URL status = %d", code)
	}
	if code, _ := doJSON(t, http.MethodPut, endpoint, token, map[string]string{"url": "https://fanqienovel.com/reader/456"}); code != http.StatusOK {
		t.Fatalf("update status = %d", code)
	}
	updated, err := st.GetCustomModel(m.ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.URL != "https://fanqienovel.com/reader/456" || updated.Position != 0 || updated.ChapterID != "" || updated.ChapterOffset != 0 {
		t.Fatalf("model after URL update = %+v", updated)
	}
	reloaded, err := OpenFileStore(st.Dir())
	if err != nil {
		t.Fatal(err)
	}
	got, err := reloaded.GetCustomModel(m.ID, owner.ID)
	if err != nil || got.URL != updated.URL || got.ChapterID != "" {
		t.Fatalf("persisted model = %+v, err = %v", got, err)
	}
}
