package main

// 浏览器扩展分发：把仓库内 extension/fanqie-reader 打包为 zip 提供下载，
// 与服务同源，无需外网（GitHub raw 在部分网络环境不可达）。

import (
	"archive/zip"
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"strings"
	"sync"
)

//go:embed extension/fanqie-reader
var extFS embed.FS

var (
	extZipOnce sync.Once
	extZipData []byte
	extZipErr  error
)

// buildExtensionZip 将嵌入的扩展目录压成 zip，顶层目录为 fanqie-reader/，
// 便于用户解压后直接在 chrome://extensions 里"加载已解压的扩展程序"。
func buildExtensionZip() ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	err := fs.WalkDir(extFS, "extension/fanqie-reader", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if strings.HasSuffix(p, ".test.js") {
			return nil // 测试文件不进发布包
		}
		rel := strings.TrimPrefix(p, "extension/")
		data, err := extFS.ReadFile(p)
		if err != nil {
			return err
		}
		f, err := zw.Create(rel)
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		return err
	})
	if err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (s *server) handleExtensionZip(w http.ResponseWriter, r *http.Request) {
	extZipOnce.Do(func() {
		extZipData, extZipErr = buildExtensionZip()
	})
	if extZipErr != nil {
		writeErr(w, http.StatusInternalServerError, extZipErr)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="chatnogpt-extension.zip"`)
	w.Header().Set("Cache-Control", "public, max-age=600")
	w.Write(extZipData)
}
