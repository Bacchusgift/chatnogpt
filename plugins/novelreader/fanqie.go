package novelreader

import (
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
)

var fanqieID = regexp.MustCompile(`^/(page|reader)/(\d+)$`)
var fanqieReaderLink = regexp.MustCompile(`(?:href=["'](?:https://fanqienovel\.com)?/reader/|/reader/)(\d+)`)
var fanqieParagraph = regexp.MustCompile(`(?s)<p(?:\s[^>]*)?>(.*?)</p>`)
var fanqieTag = regexp.MustCompile(`(?s)<[^>]+>`)
var fanqieSpace = regexp.MustCompile(`[ \t\r\n]+`)

func fanqieSource(raw string) (kind, id string, err error) {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.Hostname() != "fanqienovel.com" || u.Port() != "" || u.User != nil {
		return "", "", errors.New("目前仅支持番茄小说官网的 HTTPS 书籍页或章节页链接")
	}
	m := fanqieID.FindStringSubmatch(strings.TrimRight(u.Path, "/"))
	if m == nil {
		return "", "", errors.New("请使用 fanqienovel.com/page/… 或 /reader/… 链接")
	}
	return m[1], m[2], nil
}

func fetchFanqie(path string) (string, error) {
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 3 || r.URL.Scheme != "https" || r.URL.Hostname() != "fanqienovel.com" {
			return errors.New("番茄页面跳转到不受支持的地址")
		}
		return nil
	}}
	req, _ := http.NewRequest(http.MethodGet, "https://fanqienovel.com"+path, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ChatNoGPT/1.0)")
	req.Header.Set("Accept", "text/html")
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("读取番茄页面失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("番茄页面返回 HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func fanqieChapterIDs(page string) []string {
	matches := fanqieReaderLink.FindAllStringSubmatch(page, -1)
	ids, seen := []string{}, map[string]bool{}
	for _, m := range matches {
		if !seen[m[1]] {
			ids = append(ids, m[1])
			seen[m[1]] = true
		}
	}
	return ids
}

func fanqieReadableText(page string) (string, error) {
	if strings.Contains(page, "SVIP网页畅读") || strings.Contains(page, "会员登录后，可在网页畅读全文") {
		return "", errors.New("该章节在番茄网页端要求 SVIP 或登录后阅读，无法从公开页面读取完整正文")
	}
	at := strings.Index(page, "muye-reader-content")
	if at < 0 {
		return "", errors.New("该章节页面没有可读取的公开正文")
	}
	tail := page[at:]
	if len(tail) > 200000 {
		tail = tail[:200000]
	}
	if end := strings.Index(tail, "下一章"); end > 0 {
		tail = tail[:end]
	}
	paras := fanqieParagraph.FindAllStringSubmatch(tail, -1)
	lines := []string{}
	for _, p := range paras {
		line := fanqieSpace.ReplaceAllString(html.UnescapeString(fanqieTag.ReplaceAllString(p[1], "")), " ")
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	content := strings.Join(lines, "\n\n")
	if len([]rune(content)) < 30 {
		return "", errors.New("未找到足够的章节正文")
	}
	var private, total int
	for _, r := range content {
		if !unicode.IsSpace(r) {
			total++
		}
		if r >= 0xE000 && r <= 0xF8FF {
			private++
		}
	}
	if total > 0 && private*4 > total {
		return "", errors.New("该章节使用番茄字体编码，当前无法正确显示正文")
	}
	return content, nil
}
