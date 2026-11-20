package novelreader

import (
	"errors"
	"testing"
)

func TestCustomModelURLChangeResetsReadingProgress(t *testing.T) {
	p := New(Config{Dir: t.TempDir()})
	owner := "reader-owner"
	m, err := p.createModel(owner, "阅读模型", "")
	if err != nil {
		t.Fatal(err)
	}
	const body = "第一段正文。\n\n第二段正文。\n\n第三段正文。"
	if err := p.saveModelText(m.ID, owner, body); err != nil {
		t.Fatal(err)
	}
	// 先推进阅读位置
	end := chunkBoundary([]rune(body), 0, 5)
	if err := p.saveModelPosition(m.ID, owner, int64(end)); err != nil {
		t.Fatal(err)
	}
	// 修改链接应重置阅读进度
	if err := p.saveModelURL(m.ID, owner, "https://fanqienovel.com/page/123"); err != nil {
		t.Fatal(err)
	}
	got, err := p.getModel(m.ID, owner)
	if err != nil {
		t.Fatal(err)
	}
	if got.Position != 0 {
		t.Fatalf("position not reset: %d", got.Position)
	}
	if got.URL != "https://fanqienovel.com/page/123" {
		t.Fatalf("url lost: %q", got.URL)
	}

	// 他人不可读写
	if _, err := p.getModel(m.ID, "someone-else"); !errors.Is(err, errModelNotFound) {
		t.Fatalf("owner check failed: %v", err)
	}
	if err := p.saveModelPosition(m.ID, "someone-else", 99); !errors.Is(err, errModelNotFound) {
		if err == nil {
			t.Fatal("other owner write should fail")
		}
	}
}
