package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

//go:embed web
var webFiles embed.FS

//go:embed sites
var siteFiles embed.FS

// siteHosts maps public hostnames to embedded frontend directories. All
// fronts share the same API/WS backend; only the presentation differs.
// Defaults are placeholders; real deployments override them via the file
// given by -sites (sites.json, see sites.example.json).
var siteHosts = map[string]string{
	"play.example.com": "sites/play", // 3D 游戏：NPC 对话
	"mall.example.com": "sites/mall", // 电商：AI 客服
	"news.example.com": "sites/news", // 新闻：评论区
	"work.example.com": "sites/work", // OA：审批工作流
	"dev.example.com":  "sites/dev",  // 终端：命令输出
}

// siteDirs aliases for local debugging (?_site=play).
var siteDirs = map[string]string{
	"play": "sites/play",
	"mall": "sites/mall",
	"news": "sites/news",
	"work": "sites/work",
	"dev":  "sites/dev",
}

// loadSiteOverrides merges {"host": "sites/<name>"} pairs from path into
// siteHosts. Unknown dirs are rejected, so a typo cannot escape the embedded
// tree. Missing file is fine: defaults (or demo hosts) still work.
func loadSiteOverrides(path string) {
	if path == "" {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("sites config %s: %v (using defaults)", path, err)
		}
		return
	}
	var m map[string]string
	if err := json.Unmarshal(b, &m); err != nil {
		log.Fatalf("parse %s: %v", path, err)
	}
	n := 0
	for host, dir := range m {
		known := false
		for _, d := range siteDirs {
			if dir == d {
				known = true
				break
			}
		}
		if !known {
			log.Printf("%s: skip %q: unknown site dir %q", path, host, dir)
			continue
		}
		siteHosts[strings.ToLower(host)] = dir
		n++
	}
	log.Printf("loaded %d site host(s) from %s", n, path)
}

// frontendForRequest picks the embedded frontend for this request's host.
func frontendForRequest(r *http.Request) fs.FS {
	host := strings.ToLower(strings.Split(r.Host, ":")[0])
	if dir, ok := siteHosts[host]; ok {
		if sub, err := fs.Sub(siteFiles, dir); err == nil {
			return sub
		}
	}
	if s := r.URL.Query().Get("_site"); s != "" {
		if dir, ok := siteDirs[s]; ok {
			if sub, err := fs.Sub(siteFiles, dir); err == nil {
				return sub
			}
		}
	}
	sub, _ := fs.Sub(webFiles, "web")
	return sub
}

type server struct {
	store *Store
	hub   *hub
	cover *coverStore
}

func newServer(st *Store) *server {
	return &server{store: st, hub: newHub(), cover: &coverStore{lines: builtinCoverLines}}
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP listen address")
	dataDir := flag.String("data", "data", "data directory (data.json lives here)")
	sitesCfg := flag.String("sites", "sites.json", "optional JSON file mapping hostnames to site dirs (see sites.example.json); empty to disable")
	open := flag.Bool("open", true, "open the browser automatically on start")
	flag.Parse()
	loadSiteOverrides(*sitesCfg)

	// Windows may map .js/.css to wrong MIME types via the registry; force them.
	_ = mime.AddExtensionType(".html", "text/html; charset=utf-8")
	_ = mime.AddExtensionType(".js", "text/javascript; charset=utf-8")
	_ = mime.AddExtensionType(".css", "text/css; charset=utf-8")
	_ = mime.AddExtensionType(".svg", "image/svg+xml")

	store, err := LoadStore(*dataDir)
	if err != nil {
		log.Fatalf("load store: %v", err)
	}
	srv := newServer(store)

	if *open && isLoopbackAddr(*addr) {
		go func() {
			time.Sleep(400 * time.Millisecond)
			openBrowser("http://" + *addr)
		}()
	}

	log.Printf("ChatNoGPT listening on http://%s (data: %s)", *addr, *dataDir)
	if err := http.ListenAndServe(*addr, buildMux(srv)); err != nil {
		log.Fatal(err)
	}
}

func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func buildMux(s *server) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/register", s.handleRegister)
	mux.HandleFunc("/api/login", s.handleLogin)
	mux.HandleFunc("/api/logout", s.handleLogout)
	mux.HandleFunc("/api/me", s.handleMe)
	mux.HandleFunc("/api/models", s.handleModels)
	mux.HandleFunc("/api/model-suggest", s.handleModelSuggest)
	mux.HandleFunc("/api/cover-lines", s.handleCoverLines)
	mux.HandleFunc("/api/conversations/join", s.handleJoinConv)
	mux.HandleFunc("/api/conversations/with", s.handleConvWith)
	mux.HandleFunc("/api/conversations", s.handleConversations)
	mux.HandleFunc("/api/conversations/", s.handleConvSub)
	mux.HandleFunc("/ws", s.handleWS)

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fe := frontendForRequest(r)
		// /s/<code> is the share-link entry: serve the SPA and let app.js run
		// the join flow, so join URLs look exactly like ChatGPT share links.
		if strings.HasPrefix(r.URL.Path, "/s/") {
			serveIndex(w, r, fe)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.FileServer(http.FS(fe)).ServeHTTP(w, r)
	})
	return logRequests(mux)
}

// serveIndex writes the embedded index.html for SPA client-side routes.
func serveIndex(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	f, err := fsys.Open("index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", time.Time{}, rs)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(code int) {
	sw.status = code
	sw.ResponseWriter.WriteHeader(code)
}

// Hijack forwards to the underlying writer so websocket upgrades still work
// through the logging middleware.
func (sw *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := sw.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	return hj.Hijack()
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s -> %d", r.Method, r.URL.Path, sw.status)
	})
}
