package ws

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"
)

// RFC 6455 opcodes.
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// maxMessageSize guards against hostile frames (16 MiB, plenty for JSON frames).
const maxMessageSize = 16 << 20

var errHelloTimeout = errors.New("websocket: hello wait timed out")

// Conn is a minimal RFC 6455 connection (text messages, ping/pong, close).
// Server connections send unmasked frames; client connections mask.
type Conn struct {
	netConn net.Conn
	br      *bufio.Reader
	client  bool

	writeMu   sync.Mutex
	closeOnce sync.Once
	closeSent bool
	closeErr  error
	closeCode uint16 // status code received in the peer's close frame, if any
}

func newConn(netConn net.Conn, br *bufio.Reader, client bool) *Conn {
	if br == nil {
		br = bufio.NewReader(netConn)
	}
	return &Conn{netConn: netConn, br: br, client: client}
}

// WriteText sends one text message. Safe for concurrent use.
func (c *Conn) WriteText(text string) error {
	return c.writeFrame(opText, []byte(text))
}

// Ping sends a ping control frame (the peer answers with a pong). Safe for
// concurrent use.
func (c *Conn) Ping() error {
	return c.writeFrame(opPing, nil)
}

// ReadText blocks until the next complete text message, transparently
// answering pings and handling fragmentation. Returns an error once the peer
// closes or the connection dies.
func (c *Conn) ReadText() (string, error) {
	var message []byte
	inMessage := false
	for {
		fin, op, payload, err := c.readFrame()
		if err != nil {
			return "", err
		}
		switch op {
		case opPing:
			if err := c.writeFrame(opPong, payload); err != nil {
				return "", err
			}
		case opPong:
			// ignore
		case opClose:
			if len(payload) >= 2 {
				c.closeCode = binary.BigEndian.Uint16(payload[:2])
			}
			c.writeMu.Lock()
			if !c.closeSent {
				c.closeSent = true
				_ = writeRawFrame(c.netConn, opClose, payload, c.client)
			}
			c.writeMu.Unlock()
			return "", io.EOF
		case opText, opBinary:
			if inMessage {
				return "", errors.New("websocket: new message before previous finished")
			}
			message = payload
			inMessage = true
			if fin {
				return string(message), nil
			}
		case opContinuation:
			if !inMessage {
				return "", errors.New("websocket: continuation without a message")
			}
			if len(message)+len(payload) > maxMessageSize {
				return "", errors.New("websocket: message too large")
			}
			message = append(message, payload...)
			if fin {
				return string(message), nil
			}
		default:
			return "", fmt.Errorf("websocket: unsupported opcode %#x", op)
		}
	}
}

// readTextWithin waits up to d for a text message; errHelloTimeout if none
// arrives in time. The deadline covers the WHOLE read (not just the first
// byte), so a control frame — e.g. a ping the client sends before its hello —
// is answered and then the wait still expires instead of blocking forever.
func (c *Conn) readTextWithin(d time.Duration) (string, error) {
	_ = c.netConn.SetReadDeadline(time.Now().Add(d))
	defer func() { _ = c.netConn.SetReadDeadline(time.Time{}) }()
	text, err := c.ReadText()
	if err != nil {
		if os.IsTimeout(err) {
			return "", errHelloTimeout
		}
		return "", err
	}
	return text, nil
}

// Close sends a close frame (best effort) and closes the underlying socket.
// Idempotent: repeated calls return the first result instead of a spurious
// "use of closed connection".
func (c *Conn) Close() error {
	c.closeOnce.Do(func() {
		c.writeMu.Lock()
		if !c.closeSent {
			c.closeSent = true
			_ = c.netConn.SetWriteDeadline(time.Now().Add(time.Second))
			_ = writeRawFrame(c.netConn, opClose, nil, c.client)
		}
		c.writeMu.Unlock()
		c.closeErr = c.netConn.Close()
	})
	return c.closeErr
}

// CloseWithCode sends a close frame carrying an application status code +
// reason (RFC 6455 §5.5.1), then closes the socket. Used for auth rejections
// (AuthCloseCode = 4401). Idempotent, like Close.
func (c *Conn) CloseWithCode(code uint16, reason string) error {
	c.closeOnce.Do(func() {
		c.writeMu.Lock()
		if !c.closeSent {
			c.closeSent = true
			payload := make([]byte, 2, 2+len(reason))
			binary.BigEndian.PutUint16(payload, code)
			payload = append(payload, reason...)
			_ = c.netConn.SetWriteDeadline(time.Now().Add(time.Second))
			_ = writeRawFrame(c.netConn, opClose, payload, c.client)
		}
		c.writeMu.Unlock()
		c.closeErr = c.netConn.Close()
	})
	return c.closeErr
}

// CloseCode returns the status code from the peer's close frame (0 if none was
// received). Populated once ReadText observes a close.
func (c *Conn) CloseCode() uint16 { return c.closeCode }

func (c *Conn) writeFrame(op byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closeSent {
		return net.ErrClosed
	}
	return writeRawFrame(c.netConn, op, payload, c.client)
}

// writeRawFrame builds the whole frame in one buffer so a frame is always a
// single Write (no interleaving between concurrent deliveries).
func writeRawFrame(w io.Writer, op byte, payload []byte, mask bool) error {
	l := len(payload)
	frame := make([]byte, 0, 14+l)
	frame = append(frame, 0x80|op)
	switch {
	case l < 126:
		frame = append(frame, byte(l))
	case l <= 0xFFFF:
		frame = append(frame, 126, 0, 0)
		binary.BigEndian.PutUint16(frame[len(frame)-2:], uint16(l))
	default:
		frame = append(frame, 127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(frame[len(frame)-8:], uint64(l))
	}
	if mask {
		frame[1] |= 0x80
		var key [4]byte
		if _, err := rand.Read(key[:]); err != nil {
			return err
		}
		frame = append(frame, key[:]...)
		for i, b := range payload {
			frame = append(frame, b^key[i%4])
		}
	} else {
		frame = append(frame, payload...)
	}
	_, err := w.Write(frame)
	return err
}

func (c *Conn) readFrame() (fin bool, op byte, payload []byte, err error) {
	var header [2]byte
	if _, err = io.ReadFull(c.br, header[:]); err != nil {
		return
	}
	fin = header[0]&0x80 != 0
	op = header[0] & 0x0F
	masked := header[1]&0x80 != 0
	length := uint64(header[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > maxMessageSize {
		err = errors.New("websocket: frame too large")
		return
	}
	var key [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, key[:]); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= key[i%4]
		}
	}
	return
}

// Dial opens a client connection to a botiva WebSocket endpoint — handy for
// scripted self-tests and CLI clients:
//
//	conn, _ := ws.Dial("ws://localhost:8793/chat")
//	conn.WriteText(`{"type":"text","data":{"text":"hello"}}`)
//	frame, _ := conn.ReadText()
func Dial(rawURL string) (*Conn, error) {
	return DialWithHeaders(rawURL, nil)
}

// DialWithHeaders is Dial with extra request headers — used to exercise
// header-carried credentials (Authorization / Cookie, PROTOCOL.md §2.1).
func DialWithHeaders(rawURL string, headers map[string]string) (*Conn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	host := u.Host
	if u.Port() == "" {
		if u.Scheme == "wss" {
			host += ":443"
		} else {
			host += ":80"
		}
	}
	if u.Scheme == "wss" {
		return nil, errors.New("websocket: wss not supported by this minimal client")
	}
	netConn, err := net.DialTimeout("tcp", host, 10*time.Second)
	if err != nil {
		return nil, err
	}

	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		netConn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(nonce[:])
	path := u.RequestURI()
	if path == "" {
		path = "/"
	}
	request := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n"
	for name, value := range headers {
		request += name + ": " + value + "\r\n"
	}
	request += "\r\n"
	if _, err := netConn.Write([]byte(request)); err != nil {
		netConn.Close()
		return nil, err
	}

	br := bufio.NewReader(netConn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		netConn.Close()
		return nil, err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		netConn.Close()
		return nil, fmt.Errorf("websocket: handshake rejected (%s)", resp.Status)
	}
	if resp.Header.Get("Sec-WebSocket-Accept") != acceptKey(key) {
		netConn.Close()
		return nil, errors.New("websocket: bad Sec-WebSocket-Accept")
	}
	return newConn(netConn, br, true), nil
}
