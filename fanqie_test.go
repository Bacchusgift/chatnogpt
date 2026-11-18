package main

import (
	"strings"
	"testing"
)

func TestFanqieSource(t *testing.T) {
	kind, id, err := fanqieSource("https://fanqienovel.com/reader/7704310531267510808")
	if err != nil || kind != "reader" || id != "7704310531267510808" {
		t.Fatalf("source: %q %q %v", kind, id, err)
	}
	for _, bad := range []string{"http://fanqienovel.com/reader/123", "https://evil.test/reader/123", "https://fanqienovel.com.evil.test/reader/123", "https://fanqienovel.com@evil.test/reader/123"} {
		if _, _, err := fanqieSource(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestFanqieReadableText(t *testing.T) {
	page := `<div class="muye-reader-content"><div><p>第一段正文，窗外下着细雨，故事从这里开始。</p><p>第二段正文，主人公推开门，走进了那条熟悉的小巷。</p></div></div>下一章`
	got, err := fanqieReadableText(page)
	if err != nil || !strings.Contains(got, "第二段正文") {
		t.Fatalf("text: %q %v", got, err)
	}
	encoded := `<div class="muye-reader-content"><p>` + strings.Repeat("\ue001", 80) + `</p></div>下一章`
	if _, err := fanqieReadableText(encoded); err == nil {
		t.Fatal("encoded text should fail")
	}
	gated := `<div class="muye-reader-content"><p>开头片段</p></div>扫码下载APP免费读，SVIP网页畅读`
	if _, err := fanqieReadableText(gated); err == nil {
		t.Fatal("gated chapter should fail")
	}
}
