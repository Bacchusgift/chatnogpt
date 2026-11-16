package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// A minimal RFC 6455 server built on net/http connection hijacking. It only
// implements what browsers actually use: text frames, fragmentation,
// ping/pong keepalive and close handling — no third-party dependency.

const (
	wsGUID          = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	wsMaxMessage    = 1 << 16 // 64 KiB per message
	opContinuation  = 0x0
	opText          = 0x1
	opBinary        = 0x2
	opClose         = 0x8
	opPing          = 0x9
	opPong          = 0xA
	wsReadTimeout   = 90 * time.Second
	wsWriteTimeout  = 10 * time.Second
	wsPingInterval  = 30 * time.Second
	wsOutBufferSize = 128
)

func acceptKeyOf(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

type wsConn struct {
	conn net.Conn
	br   *bufio.Reader
	wmu  sync.Mutex // serializes writes from broadcast + writePump
}

func tryUpgrade(w http.ResponseWriter, r *http.Request) (*wsConn, bool) {
	if r.Method != http.MethodGet ||
		!headerHasToken(r.Header, "Connection", "upgrade") ||
		!strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key")) == "" {
		http.Error(w, "expected a websocket handshake", http.StatusBadRequest)
		return nil, false
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "webserver does not support hijacking", http.StatusInternalServerError)
		return nil, false
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		http.Error(w, "hijack failed", http.StatusInternalServerError)
		return nil, false
	}
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + acceptKeyOf(strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))) + "\r\n\r\n"
	if _, err := conn.Write([]byte(resp)); err != nil {
		conn.Close()
		return nil, false
	}
	return &wsConn{conn: conn, br: bufio.NewReaderSize(rw.Reader, 8192)}, true
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

func readFrameFrom(r io.Reader) (fin bool, op byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(r, hdr[:]); err != nil {
		return
	}
	fin = hdr[0]&0x80 != 0
	op = hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > wsMaxMessage {
		err = errors.New("websocket frame too large")
		return
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(r, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(r, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i&3]
		}
	}
	return
}

// writeFrameTo writes a single frame. Client->server frames must be masked;
// server->client frames never are.
func writeFrameTo(w io.Writer, op byte, payload []byte, mask bool) error {
	var hdr [14]byte
	hdr[0] = 0x80 | op
	n := len(payload)
	i := 2
	switch {
	case n < 126:
		hdr[1] = byte(n)
	case n <= 65535:
		hdr[1] = 126
		binary.BigEndian.PutUint16(hdr[2:4], uint16(n))
		i = 4
	default:
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:10], uint64(n))
		i = 10
	}
	var key []byte
	if mask {
		hdr[1] |= 0x80
		key = randomBytes(4)
		copy(hdr[i:i+4], key)
		i += 4
	}
	buf := make([]byte, i+n)
	copy(buf, hdr[:i])
	if mask {
		for j, b := range payload {
			buf[i+j] = b ^ key[j&3]
		}
	} else {
		copy(buf[i:], payload)
	}
	_, err := w.Write(buf)
	return err
}

func (c *wsConn) writeFrame(op byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return writeFrameTo(c.conn, op, payload, false)
}

func (c *wsConn) setReadDeadline(t time.Time)  { _ = c.conn.SetReadDeadline(t) }
func (c *wsConn) setWriteDeadline(t time.Time) { _ = c.conn.SetWriteDeadline(t) }
func (c *wsConn) closeConn()                   { _ = c.conn.Close() }

// readMessage reads a full (possibly fragmented) data message, answering
// pings and honoring close frames along the way.
func (c *wsConn) readMessage() (byte, []byte, error) {
	var assembled []byte
	var dataOp byte
	started := false
	for {
		fin, op, payload, err := readFrameFrom(c.br)
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case opText, opBinary:
			if started {
				return 0, nil, errors.New("new data frame inside a fragmented message")
			}
			started = true
			dataOp = op
			assembled = append(assembled, payload...)
		case opContinuation:
			if !started {
				return 0, nil, errors.New("continuation frame without a start")
			}
			assembled = append(assembled, payload...)
		case opPing:
			_ = c.writeFrame(opPong, payload)
		case opPong:
			// nothing to do; the deadline reset is enough
		case opClose:
			_ = c.writeFrame(opClose, nil)
			return 0, nil, io.EOF
		default:
			return 0, nil, errors.New("unsupported websocket opcode")
		}
		if started && fin {
			return dataOp, assembled, nil
		}
	}
}

// ---- hub: rooms of connected clients per conversation ----

type hub struct {
	mu    sync.Mutex
	rooms map[string]map[*wsClient]struct{}
}

func newHub() *hub {
	return &hub{rooms: map[string]map[*wsClient]struct{}{}}
}

func (h *hub) join(convID string, cl *wsClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room, ok := h.rooms[convID]
	if !ok {
		room = map[*wsClient]struct{}{}
		h.rooms[convID] = room
	}
	room[cl] = struct{}{}
}

func (h *hub) leave(convID string, cl *wsClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room, ok := h.rooms[convID]; ok {
		delete(room, cl)
		if len(room) == 0 {
			delete(h.rooms, convID)
		}
	}
}

// broadcast sends payload to everyone in the room (optionally except one).
// A slow consumer with a full outbound buffer gets kicked rather than
// stalling the whole room.
func (h *hub) broadcast(convID string, payload []byte, except *wsClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for cl := range h.rooms[convID] {
		if except != nil && cl == except {
			continue
		}
		select {
		case cl.out <- payload:
		default:
			go cl.close()
		}
	}
}

// ---- client ----

type wsClient struct {
	srv      *server
	conn     *wsConn
	userID   string
	nickname string
	convID   string
	out      chan []byte
	done     chan struct{}
	once     sync.Once
}

func (cl *wsClient) close() {
	cl.once.Do(func() {
		cl.srv.hub.leave(cl.convID, cl)
		close(cl.done)
		cl.conn.closeConn()
	})
}

func (cl *wsClient) readPump() {
	defer cl.close()
	cl.conn.setReadDeadline(time.Now().Add(wsReadTimeout))
	for {
		_, data, err := cl.conn.readMessage()
		if err != nil {
			return
		}
		cl.conn.setReadDeadline(time.Now().Add(wsReadTimeout))
		cl.handleMessage(data)
	}
}

type clientEvent struct {
	Type        string `json:"type"`
	Content     string `json:"content"`
	ClientMsgID string `json:"client_msg_id"`
}

func (cl *wsClient) handleMessage(raw []byte) {
	var ev clientEvent
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}
	switch ev.Type {
	case "msg":
		content := strings.TrimSpace(ev.Content)
		if content == "" || len(content) > 6000 {
			return
		}
		m, err := cl.srv.store.AddMessage(cl.convID, cl.userID, cl.nickname, content, ev.ClientMsgID)
		if err != nil {
			return
		}
		payload, _ := json.Marshal(map[string]any{
			"type":          "msg",
			"id":            m.ID,
			"conv_id":       cl.convID,
			"sender_id":     cl.userID,
			"nickname":      cl.nickname,
			"content":       m.Content,
			"ts":            m.TS,
			"client_msg_id": ev.ClientMsgID,
		})
		cl.srv.hub.broadcast(cl.convID, payload, nil)
	case "typing":
		payload, _ := json.Marshal(map[string]any{
			"type":      "typing",
			"sender_id": cl.userID,
			"nickname":  cl.nickname,
		})
		cl.srv.hub.broadcast(cl.convID, payload, cl)
	}
}

func (cl *wsClient) writePump() {
	ticker := time.NewTicker(wsPingInterval)
	defer ticker.Stop()
	for {
		select {
		case b, ok := <-cl.out:
			if !ok {
				return
			}
			cl.conn.setWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := cl.conn.writeFrame(opText, b); err != nil {
				return
			}
		case <-ticker.C:
			cl.conn.setWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := cl.conn.writeFrame(opPing, nil); err != nil {
				return
			}
		case <-cl.done:
			return
		}
	}
}

func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	u := s.store.UserByToken(strings.TrimSpace(q.Get("token")))
	if u == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	convID := strings.TrimSpace(q.Get("conv"))
	if _, err := s.store.GetConv(convID, u.ID); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	c, ok := tryUpgrade(w, r)
	if !ok {
		return
	}
	cl := &wsClient{
		srv:      s,
		conn:     c,
		userID:   u.ID,
		nickname: u.Nickname,
		convID:   convID,
		out:      make(chan []byte, wsOutBufferSize),
		done:     make(chan struct{}),
	}
	s.hub.join(convID, cl)
	go cl.writePump()
	go cl.readPump()
}
