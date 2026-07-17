// Package ws is the botiva WebSocket transport for Go — the stdlib-only
// counterpart of @botiva/websocket (RFC 6455 server, no third-party deps).
//
// Identity handshake (either works, PROTOCOL.md §2):
//   - Query params:  ws://host/chat?userId=u-1&conversationId=c-1&watermark=12
//   - Hello frame:   first message {type:"hello", userId?, conversationId?, watermark?, meta?}
//
// If neither arrives within HelloTimeout, a fresh identity is generated and
// announced via the `welcome` frame (the client should persist it).
//
// The transport is intentionally thin: everything protocol-related (welcome,
// replay, broadcast, turn handling) lives in the engine — mount the handler
// and you are done:
//
//	engine := botiva.NewConversationEngine(botiva.EngineOptions{Runtime: rt})
//	mux := http.NewServeMux()
//	mux.Handle("/chat", ws.NewHandler(engine, nil))
//	http.ListenAndServe(":8793", mux)
package ws

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	botiva "github.com/aimtune/botiva/core"
)

// HandlerOptions tune the transport; the zero value is production-ready.
type HandlerOptions struct {
	// HelloTimeout is how long to wait for a hello frame when the URL carries
	// no identity. Default 300ms; negative disables the wait.
	HelloTimeout time.Duration
	Logger       *slog.Logger
}

// NewHandler returns an http.Handler that upgrades requests to WebSocket and
// attaches them to the engine (socket open → Connect, inbound → Receive,
// close → Close, Deliver → socket write).
func NewHandler(engine *botiva.ConversationEngine, opts *HandlerOptions) http.Handler {
	if opts == nil {
		opts = &HandlerOptions{}
	}
	helloTimeout := opts.HelloTimeout
	if helloTimeout == 0 {
		helloTimeout = 300 * time.Millisecond
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &handler{engine: engine, helloTimeout: helloTimeout, log: logger}
}

type handler struct {
	engine       *botiva.ConversationEngine
	helloTimeout time.Duration
	log          *slog.Logger
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := Upgrade(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer conn.Close()
	if err := h.serve(conn, r); err != nil {
		h.log.Warn("[botiva/ws] connection failed", "error", err)
	}
}

func (h *handler) serve(conn *Conn, r *http.Request) error {
	ctx := context.Background()

	q := r.URL.Query()
	headers := flattenHeaders(r.Header)
	userID := q.Get("userId")
	conversationID := q.Get("conversationId")
	// Auth credential (§2.1): ?token=, then Authorization: Bearer; a hello frame
	// may still add one below.
	token := q.Get("token")
	if token == "" {
		token = bearer(headers)
	}
	watermark := 0
	hasWatermark := false
	if v := q.Get("watermark"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			watermark = n
			hasWatermark = true
		}
	}
	var meta map[string]any
	buffered := ""

	// No identity in the URL → give the client a beat to send a hello frame.
	if userID == "" && conversationID == "" && !hasWatermark && h.helloTimeout > 0 {
		text, err := conn.readTextWithin(h.helloTimeout)
		switch {
		case err == errHelloTimeout:
			// fresh visitor — the engine generates ids
		case err != nil:
			return err
		default:
			if inbound := botiva.ParseIncoming(text); inbound != nil && inbound.Hello != nil {
				hello := inbound.Hello
				userID, conversationID, meta = hello.UserID, hello.ConversationID, hello.Meta
				if hello.HasWatermark {
					watermark = hello.Watermark
				}
				if hello.Token != "" {
					token = hello.Token
				}
			} else {
				buffered = text // first frame was a normal message → handle after connect
			}
		}
	}

	connection, err := h.engine.Connect(ctx, botiva.ConnectParams{
		UserID:         userID,
		ConversationID: conversationID,
		Watermark:      watermark,
		Meta:           meta,
		Auth: &botiva.AuthInput{
			Transport: "websocket",
			Token:     token,
			Query:     flattenQuery(q),
			Headers:   headers,
		},
		Deliver: func(frame botiva.Frame) {
			raw, err := json.Marshal(frame)
			if err != nil {
				h.log.Warn("[botiva/ws] frame marshal failed", "error", err)
				return
			}
			if err := conn.WriteText(string(raw)); err != nil {
				h.log.Debug("[botiva/ws] deliver failed", "error", err)
			}
		},
	})
	if err != nil {
		var authErr *botiva.AuthenticationError
		if errors.As(err, &authErr) {
			if raw, marshalErr := json.Marshal(botiva.ErrorFrame(authErr.Code, authErr.Reason)); marshalErr == nil {
				_ = conn.WriteText(string(raw))
			}
			_ = conn.CloseWithCode(botiva.AuthCloseCode, authErr.Reason)
			return nil
		}
		return err
	}
	defer connection.Close(ctx)

	if buffered != "" {
		if err := connection.Receive(ctx, buffered); err != nil {
			h.log.Warn("[botiva/ws] receive failed", "error", err)
		}
	}
	for {
		text, err := conn.ReadText()
		if err != nil {
			return nil // client went away — the conversation stays resumable
		}
		if err := connection.Receive(ctx, text); err != nil {
			h.log.Warn("[botiva/ws] receive failed", "error", err)
		}
	}
}

// Upgrade performs the RFC 6455 server handshake and hijacks the connection.
// Exposed for transports that need raw access (custom routing, subprotocols).
func Upgrade(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if r.Method != http.MethodGet {
		return nil, errBadHandshake("method must be GET")
	}
	if !headerContainsToken(r.Header, "Connection", "upgrade") ||
		!headerContainsToken(r.Header, "Upgrade", "websocket") {
		return nil, errBadHandshake("not a websocket upgrade")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errBadHandshake("missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errBadHandshake("server does not support hijacking")
	}
	netConn, brw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n"
	if _, err := brw.WriteString(response); err != nil {
		netConn.Close()
		return nil, err
	}
	if err := brw.Flush(); err != nil {
		netConn.Close()
		return nil, err
	}
	return newConn(netConn, brw.Reader, false), nil
}

// acceptKey computes the Sec-WebSocket-Accept value (RFC 6455 §4.2.2).
func acceptKey(key string) string {
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h[:])
}

// flattenHeaders turns http.Header into a flat lower-cased map (multi-values
// joined), the shape botiva.AuthContext.Headers expects.
func flattenHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for name, values := range h {
		out[strings.ToLower(name)] = strings.Join(values, ", ")
	}
	return out
}

func flattenQuery(q map[string][]string) map[string]string {
	out := make(map[string]string, len(q))
	for name, values := range q {
		if len(values) > 0 {
			out[name] = values[0]
		}
	}
	return out
}

// bearer pulls a token out of an `Authorization: Bearer …` header.
func bearer(headers map[string]string) string {
	auth := headers["authorization"]
	if auth == "" {
		return ""
	}
	const prefix = "bearer "
	if len(auth) > len(prefix) && strings.EqualFold(auth[:len(prefix)], prefix) {
		return strings.TrimSpace(auth[len(prefix):])
	}
	return ""
}

func headerContainsToken(h http.Header, name, token string) bool {
	for _, value := range h.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

type errBadHandshake string

func (e errBadHandshake) Error() string { return "websocket: " + string(e) }
