package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"math/big"
	"regexp"
	"strings"
)

const pbkdf2Iterations = 60000

var usernameRe = regexp.MustCompile(`^[a-z0-9_-]{2,30}$`)

// pbkdf2SHA256 implements PBKDF2 (RFC 2898) with HMAC-SHA256 using only the
// standard library, so the whole project keeps zero external dependencies.
func pbkdf2SHA256(password, salt []byte, iterations, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	hashLen := prf.Size()
	blocks := (keyLen + hashLen - 1) / hashLen
	dk := make([]byte, 0, blocks*hashLen)
	blockBuf := make([]byte, 4)
	u := make([]byte, hashLen)
	for block := 1; block <= blocks; block++ {
		prf.Reset()
		binary.BigEndian.PutUint32(blockBuf, uint32(block))
		prf.Write(salt)
		prf.Write(blockBuf)
		dk = prf.Sum(dk)
		t := dk[len(dk)-hashLen:]
		copy(u, t)
		for n := 2; n <= iterations; n++ {
			prf.Reset()
			prf.Write(u)
			sum := prf.Sum(nil)
			copy(u, sum)
			for i := range t {
				t[i] ^= u[i]
			}
		}
	}
	return dk[:keyLen]
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func hashPassword(password string) (saltB64, hashB64 string) {
	salt := randomBytes(16)
	key := pbkdf2SHA256([]byte(password), salt, pbkdf2Iterations, 32)
	return base64.StdEncoding.EncodeToString(salt), base64.StdEncoding.EncodeToString(key)
}

func verifyPassword(password, saltB64, hashB64 string) bool {
	salt, err1 := base64.StdEncoding.DecodeString(saltB64)
	want, err2 := base64.StdEncoding.DecodeString(hashB64)
	if err1 != nil || err2 != nil || len(want) == 0 {
		return false
	}
	got := pbkdf2SHA256([]byte(password), salt, pbkdf2Iterations, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func newToken() string { return base64.RawURLEncoding.EncodeToString(randomBytes(32)) }

func newID() string { return base64.RawURLEncoding.EncodeToString(randomBytes(9)) }

// newInviteCode uses an alphabet without 0/O/1/I so codes are easy to read out.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

func newInviteCode(n int) string {
	out := make([]byte, n)
	max := big.NewInt(int64(len(codeAlphabet)))
	for i := range out {
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}
		out[i] = codeAlphabet[v.Int64()]
	}
	return string(out)
}

// randSuffix returns a short lowercase alphanumeric string, used to
// de-duplicate auto-generated login names.
func randSuffix(n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	out := make([]byte, n)
	max := big.NewInt(int64(len(alphabet)))
	for i := range out {
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}
		out[i] = alphabet[v.Int64()]
	}
	return string(out)
}

// slugify maps a display name to a login-safe username: lowercase, and every
// character outside [a-z0-9_-] becomes a dash.
func slugify(name string) string {
	var b strings.Builder
	lastDash := true // avoid leading dashes
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
				continue
			}
		}
		lastDash = false
	}
	slug := strings.Trim(b.String(), "-")
	if len(slug) > 30 {
		slug = slug[:30]
	}
	return slug
}

func validateRegister(username, nickname, password string) error {
	switch {
	case !usernameRe.MatchString(username):
		return fmt.Errorf("用户名需为 2-30 位小写字母、数字、下划线或中划线")
	case strings.TrimSpace(nickname) == "" || len([]rune(nickname)) > 30:
		return fmt.Errorf("昵称需为 1-30 个字符")
	case len(password) < 6 || len(password) > 64:
		return fmt.Errorf("密码长度需在 6-64 位之间")
	}
	return nil
}
