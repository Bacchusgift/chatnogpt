package murdermystery

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPluginOffersGroupModeAndServesScript(t *testing.T) {
	p := New()
	meta := p.Meta()
	if meta.Name != Name || len(meta.RoomModes) != 1 || meta.RoomModes[0].ID != Name {
		t.Fatalf("unexpected plugin metadata: %+v", meta)
	}
	mux := http.NewServeMux()
	p.Mount(mux, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, FrontendJS, nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "room-created") {
		t.Fatalf("plugin script not served: status %d", rec.Code)
	}
}
