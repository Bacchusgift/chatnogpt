// Command wsprobe is a minimal websocket client used to verify a deployed
// ChatNoGPT instance over ws:// or wss:// (including public HTTPS endpoints).
package main

import (
	"bufio"
	"context"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type conn struct {
	c  net.Conn
	br *bufio.Reader
}

func dial(rawURL string, timeout time.Duration) (*conn, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "ws" && u.Scheme != "wss" {
		return nil, fmt.Errorf("url must be ws:// or wss://")
	}
	hostPort := u.Host
	if !strings.Contains(hostPort, ":") {
		if u.Scheme == "wss" {
			hostPort += ":443"
		} else {
			hostPort += ":80"
		}
	}
	var c net.Conn
	d := net.Dialer{Timeout: timeout}
	if u.Scheme == "wss" {
		host, _, _ := net.SplitHostPort(hostPort)
		c, err = d.DialContext(context.Background(), "tcp", hostPort)
		if err != nil {
			return nil, err
		}
		tlsConn := tls.Client(c, &tls.Config{ServerName: host})
		if err := tlsConn.Handshake(); err != nil {
			c.Close()
			return nil, err
		}
		c = tlsConn
	} else {
		c, err = d.Dial("tcp", hostPort)
		if err != nil {
			return nil, err
		}
	}
	path := u.Path
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	key := base64.StdEncoding.EncodeToString([]byte("wsprobe-static-key01"))
	req := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	c.SetWriteDeadline(time.Now().Add(timeout))
	if _, err := c.Write([]byte(req)); err != nil {
		c.Close()
		return nil, err
	}
	br := bufio.NewReader(c)
	c.SetReadDeadline(time.Now().Add(timeout))
	var head strings.Builder
	b := make([]byte, 1)
	for {
		n, rerr := br.Read(b)
		if rerr != nil {
			c.Close()
			return nil, fmt.Errorf("handshake read: %v", rerr)
		}
		head.Write(b[:n])
		if strings.HasSuffix(head.String(), "\r\n\r\n") {
			break
		}
		if head.Len() > 8192 {
			c.Close()
			return nil, fmt.Errorf("handshake too large")
		}
	}
	h := head.String()
	if !strings.HasPrefix(h, "HTTP/1.1 101") {
		c.Close()
		return nil, fmt.Errorf("handshake rejected: %s", strings.TrimSpace(strings.SplitN(h, "\r\n", 2)[0]))
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	if !strings.Contains(h, base64.StdEncoding.EncodeToString(sum[:])) {
		c.Close()
		return nil, fmt.Errorf("Sec-WebSocket-Accept mismatch")
	}
	c.SetReadDeadline(time.Time{})
	return &conn{c: c, br: br}, nil
}

func writeFrame(c net.Conn, op byte, payload []byte) error {
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
	hdr[1] |= 0x80
	key := []byte{1, 2, 3, 4}
	copy(hdr[i:i+4], key)
	i += 4
	buf := make([]byte, i+n)
	copy(buf, hdr[:i])
	for j, b := range payload {
		buf[i+j] = b ^ key[j&3]
	}
	_, err := c.Write(buf)
	return err
}

func readFrame(br *bufio.Reader) (op byte, payload []byte, err error) {
	var h [2]byte
	if _, err = readFull(br, h[:]); err != nil {
		return
	}
	op = h[0] & 0x0f
	masked := h[1]&0x80 != 0
	length := uint64(h[1] & 0x7f)
	switch length {
	case 126:
		var e [2]byte
		if _, err = readFull(br, e[:]); err != nil {
			return
		}
		length = uint64(binary.BigEndian.Uint16(e[:]))
	case 127:
		var e [8]byte
		if _, err = readFull(br, e[:]); err != nil {
			return
		}
		length = binary.BigEndian.Uint64(e[:])
	}
	var mask [4]byte
	if masked {
		if _, err = readFull(br, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = readFull(br, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i&3]
		}
	}
	return
}

func readFull(br *bufio.Reader, p []byte) (int, error) {
	total := 0
	for total < len(p) {
		n, err := br.Read(p[total:])
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

func main() {
	wsURL := flag.String("url", "", "websocket url, e.g. wss://host/ws?conv=ID&token=TOKEN")
	send := flag.String("send", "", "optional message content to send after connecting")
	sendType := flag.String("type", "msg", "event type to send (msg|typing)")
	wait := flag.Duration("wait", 12*time.Second, "how long to listen for events")
	flag.Parse()
	if *wsURL == "" {
		fmt.Fprintln(os.Stderr, "-url is required")
		os.Exit(2)
	}
	c, err := dial(*wsURL, 15*time.Second)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FAIL dial: %v\n", err)
		os.Exit(1)
	}
	defer c.c.Close()
	fmt.Println("CONNECTED")

	if *send != "" || *sendType != "msg" {
		payload, _ := json.Marshal(map[string]string{"type": *sendType, "content": *send, "client_msg_id": "probe-" + fmt.Sprint(time.Now().UnixNano())})
		if err := writeFrame(c.c, 1, payload); err != nil {
			fmt.Fprintf(os.Stderr, "FAIL send: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("SENT %s %q\n", *sendType, *send)
	}

	deadline := time.Now().Add(*wait)
	for time.Now().Before(deadline) {
		c.c.SetReadDeadline(deadline)
		op, payload, err := readFrame(c.br)
		if err != nil {
			fmt.Printf("READ-EOF (%v)\n", err)
			return
		}
		switch op {
		case 1:
			fmt.Printf("EVENT %s\n", payload)
		case 9: // ping -> pong
			_ = writeFrame(c.c, 10, payload)
		case 8: // close
			fmt.Println("CLOSED by server")
			return
		}
	}
	fmt.Println("LISTEN-DONE")
}
