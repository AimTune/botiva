package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	botiva "github.com/aimtune/botiva/core"
)

// testClient collects frames from one socket, mirroring the TS selftest client.
type testClient struct {
	t      *testing.T
	conn   *Conn
	frames chan botiva.Frame
}

func dialTest(t *testing.T, url string) *testClient {
	t.Helper()
	return dialTestHeaders(t, url, nil)
}

func dialTestHeaders(t *testing.T, url string, headers map[string]string) *testClient {
	t.Helper()
	conn, err := DialWithHeaders(url, headers)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	c := &testClient{t: t, conn: conn, frames: make(chan botiva.Frame, 64)}
	go func() {
		defer close(c.frames)
		for {
			text, err := conn.ReadText()
			if err != nil {
				return
			}
			var frame botiva.Frame
			if json.Unmarshal([]byte(text), &frame) == nil {
				c.frames <- frame
			}
		}
	}()
	t.Cleanup(func() { conn.Close() })
	return c
}

func (c *testClient) send(text string) {
	c.t.Helper()
	raw, _ := json.Marshal(botiva.Frame{"type": "text", "data": map[string]any{"text": text}})
	if err := c.conn.WriteText(string(raw)); err != nil {
		c.t.Fatalf("send: %v", err)
	}
}

func (c *testClient) sendRaw(frame botiva.Frame) {
	c.t.Helper()
	raw, _ := json.Marshal(frame)
	if err := c.conn.WriteText(string(raw)); err != nil {
		c.t.Fatalf("send raw: %v", err)
	}
}

// waitFor blocks until a frame matches pred (5s timeout).
func (c *testClient) waitFor(label string, pred func(botiva.Frame) bool) botiva.Frame {
	c.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case frame, ok := <-c.frames:
			if !ok {
				c.t.Fatalf("%s: connection closed before match", label)
			}
			if pred(frame) {
				return frame
			}
		case <-deadline:
			c.t.Fatalf("%s: timed out", label)
		}
	}
}

func botText(frame botiva.Frame, contains string) bool {
	if frame["type"] != "text" || frame["from"] != "bot" {
		return false
	}
	data, _ := frame["data"].(map[string]any)
	text, _ := data["text"].(string)
	return strings.Contains(text, contains)
}

func userText(frame botiva.Frame, contains string) bool {
	if frame["type"] != "text" || frame["from"] != "user" {
		return false
	}
	data, _ := frame["data"].(map[string]any)
	text, _ := data["text"].(string)
	return strings.Contains(text, contains)
}

func TestWebSocketTransportEndToEnd(t *testing.T) {
	engine := botiva.NewConversationEngine(botiva.EngineOptions{
		Runtime:  botiva.DemoRuntime{},
		Greeting: "ws-greeting",
	})
	server := httptest.NewServer(NewHandler(engine, nil))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/chat"

	// 1. fresh connect (no identity) → welcome + greeting
	a := dialTest(t, wsURL)
	welcome := a.waitFor("welcome", func(f botiva.Frame) bool { return f["type"] == "welcome" })
	data := welcome["data"].(map[string]any)
	if data["protocol"] != botiva.ProtocolVersion {
		t.Fatalf("welcome protocol = %v", data["protocol"])
	}
	conversationID := data["conversationId"].(string)
	userID := data["userId"].(string)
	a.waitFor("greeting", func(f botiva.Frame) bool { return botText(f, "ws-greeting") })

	// 2. echo turn over the wire
	a.send("hello world")
	a.waitFor("echo", func(f botiva.Frame) bool { return botText(f, "Echo: hello world") })

	// 3. HITL over the wire: report → interrupt chips → approve
	a.send("report please")
	a.waitFor("interrupt chips", func(f botiva.Frame) bool {
		actions, _ := f["actions"].([]any)
		return f["type"] == "text" && len(actions) > 0
	})
	a.send("Approve")
	a.waitFor("resume", func(f botiva.Frame) bool { return botText(f, "Approved") })

	// 4. genui via ambient emit
	a.send("weather")
	a.waitFor("genui", func(f botiva.Frame) bool { return f["type"] == "genui" })

	// 5. reconnect with query identity + watermark 0 → replay
	b := dialTest(t, fmt.Sprintf("%s?userId=%s&conversationId=%s&watermark=0", wsURL, userID, conversationID))
	b.waitFor("replay user frame", func(f botiva.Frame) bool { return userText(f, "hello world") })
	b.waitFor("replay bot frame", func(f botiva.Frame) bool { return botText(f, "Echo: hello world") })

	// 6. fan-out: b sends, a receives the user frame (b must not self-echo)
	b.send("sync test")
	a.waitFor("fan-out", func(f botiva.Frame) bool { return userText(f, "sync test") })

	// 7. hello-frame identity (no query): same conversation resumes
	c := dialTest(t, wsURL)
	c.sendRaw(botiva.Frame{
		"type": "hello", "userId": userID, "conversationId": conversationID, "watermark": 0,
	})
	welcomeC := c.waitFor("welcome via hello", func(f botiva.Frame) bool { return f["type"] == "welcome" })
	dataC := welcomeC["data"].(map[string]any)
	if dataC["conversationId"] != conversationID || dataC["userId"] != userID {
		t.Fatalf("hello identity not honored: %v", dataC)
	}
	c.waitFor("replay via hello", func(f botiva.Frame) bool { return botText(f, "Echo: hello world") })

	// 8. a ping before any identity/hello must NOT defeat the hello wait — the
	// server answers the pong and, after the timeout, still issues a fresh welcome.
	d := dialTest(t, wsURL)
	if err := d.conn.Ping(); err != nil {
		t.Fatalf("ping: %v", err)
	}
	welcomeD := d.waitFor("fresh welcome after early ping", func(f botiva.Frame) bool { return f["type"] == "welcome" })
	if (welcomeD["data"].(map[string]any))["conversationId"] == conversationID {
		t.Fatalf("early ping should yield a FRESH identity, got the existing conversation")
	}
	d.send("hello world")
	d.waitFor("turn works after early ping", func(f botiva.Frame) bool { return botText(f, "Echo: hello world") })
}

// testAuth is an inline Authenticator: token "good" (query, Bearer header, or
// the botiva_session cookie) → verified userId "user-verified"; anything else
// is rejected. Exercises the transport wiring without the authentication module.
type testAuth struct{}

func (testAuth) Authenticate(_ context.Context, ac botiva.AuthContext) (botiva.AuthResult, error) {
	token := ac.Token
	if token == "" {
		for _, pair := range strings.Split(ac.Headers["cookie"], ";") {
			kv := strings.SplitN(strings.TrimSpace(pair), "=", 2)
			if len(kv) == 2 && kv[0] == "botiva_session" {
				token = kv[1]
			}
		}
	}
	if token == "good" {
		return botiva.AuthResult{OK: true, UserID: "user-verified"}, nil
	}
	return botiva.AuthResult{OK: false, Reason: "invalid token"}, nil
}

func TestWebSocketAuthentication(t *testing.T) {
	engine := botiva.NewConversationEngine(botiva.EngineOptions{
		Runtime:       botiva.DemoRuntime{},
		Authenticator: testAuth{},
	})
	server := httptest.NewServer(NewHandler(engine, &HandlerOptions{HelloTimeout: 30 * time.Millisecond}))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/chat"

	// (a) rejected: no credential → error frame + close 4401, no welcome
	bad := dialTest(t, wsURL)
	errFrame := bad.waitFor("auth error frame", func(f botiva.Frame) bool { return f["type"] == "error" })
	if data, _ := errFrame["data"].(map[string]any); data["code"] != "unauthorized" {
		t.Fatalf("error frame = %v", errFrame["data"])
	}
	for f := range bad.frames { // drain until the socket closes
		if f["type"] == "welcome" {
			t.Fatal("rejected connection must not receive a welcome frame")
		}
	}
	if code := bad.conn.CloseCode(); code != botiva.AuthCloseCode {
		t.Fatalf("close code = %d, want %d", code, botiva.AuthCloseCode)
	}

	// (b) accepted via query token → verified userId overrides any claim
	good := dialTest(t, wsURL+"?token=good&userId=user-spoof")
	welcome := good.waitFor("welcome (auth)", func(f botiva.Frame) bool { return f["type"] == "welcome" })
	if uid := welcome["data"].(map[string]any)["userId"]; uid != "user-verified" {
		t.Fatalf("verified userId not applied: got %v", uid)
	}

	// (c) accepted via cookie header (browser-style, no client token plumbing)
	cookie := dialTestHeaders(t, wsURL, map[string]string{"Cookie": "botiva_session=good"})
	welcomeCookie := cookie.waitFor("welcome (cookie)", func(f botiva.Frame) bool { return f["type"] == "welcome" })
	if uid := welcomeCookie["data"].(map[string]any)["userId"]; uid != "user-verified" {
		t.Fatalf("cookie credential not honored: got %v", uid)
	}
}
