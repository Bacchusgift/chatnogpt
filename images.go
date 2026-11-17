package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const maxImageUpload = 1 << 20

// webpDimensions checks the RIFF container and the dimensions in the first image chunk.
func webpDimensions(b []byte) bool {
	if len(b) < 20 || !bytes.Equal(b[:4], []byte("RIFF")) || !bytes.Equal(b[8:12], []byte("WEBP")) || uint64(binary.LittleEndian.Uint32(b[4:8]))+8 != uint64(len(b)) {
		return false
	}
	var width, height int
	first := true
	for pos := 12; pos < len(b); {
		if len(b)-pos < 8 {
			return false
		}
		n := uint64(binary.LittleEndian.Uint32(b[pos+4 : pos+8]))
		if n > uint64(len(b)-pos-8) || n+uint64(n&1) > uint64(len(b)-pos-8) {
			return false
		}
		chunk := b[pos+8 : pos+8+int(n)]
		if first {
			switch string(b[pos : pos+4]) {
			case "VP8 ":
				if len(chunk) < 10 || chunk[0]&1 != 0 || !bytes.Equal(chunk[3:6], []byte{0x9d, 0x01, 0x2a}) {
					return false
				}
				width, height = int(binary.LittleEndian.Uint16(chunk[6:8])&0x3fff), int(binary.LittleEndian.Uint16(chunk[8:10])&0x3fff)
			case "VP8L":
				if len(chunk) < 5 || chunk[0] != 0x2f {
					return false
				}
				width = 1 + int(chunk[1]) + int(chunk[2]&0x3f)<<8
				height = 1 + int(chunk[2]>>6) + int(chunk[3])<<2 + int(chunk[4]&0x0f)<<10
			case "VP8X":
				if len(chunk) < 10 || chunk[0]&0xc0 != 0 {
					return false
				}
				width = 1 + int(chunk[4]) + int(chunk[5])<<8 + int(chunk[6])<<16
				height = 1 + int(chunk[7]) + int(chunk[8])<<8 + int(chunk[9])<<16
			default:
				return false
			}
			first = false
		}
		pos += 8 + int(n) + int(n&1)
	}
	return width > 0 && height > 0 && width <= 4096 && height <= 4096
}

func (s *server) handleImages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxImageUpload)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, err)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	if err := r.ParseMultipartForm(maxImageUpload); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	files := r.MultipartForm.File["file"]
	if len(files) != 1 {
		writeErr(w, http.StatusBadRequest, errors.New("expected one file"))
		return
	}
	f, err := files[0].Open()
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxImageUpload+1))
	if err != nil || len(data) > maxImageUpload || !webpDimensions(data) {
		writeErr(w, http.StatusBadRequest, errors.New("invalid WebP image"))
		return
	}
	dir := filepath.Join(filepath.Dir(s.store.path), "images", u.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	var id string
	for {
		id = newID()
		f, err := os.OpenFile(filepath.Join(dir, id+".webp"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		_, err = f.Write(data)
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			os.Remove(filepath.Join(dir, id+".webp"))
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		break
	}
	s.store.RecordImage(id, u.ID)
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (s *server) handleImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	u := s.authUser(r)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, ErrUnauthorized)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/images/")
	if id == "" || strings.ContainsAny(id, "/\\.") {
		http.NotFound(w, r)
		return
	}
	owner, ok := s.store.CanReadImage(id, u.ID)
	if !ok {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(filepath.Dir(s.store.path), "images", owner, id+".webp"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	io.Copy(w, f)
}
