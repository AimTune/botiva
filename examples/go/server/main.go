// botiva Go demo server — DemoRuntime behind the stdlib WebSocket transport.
// The Go counterpart of examples/langgraph-server.ts (deterministic, no API
// key needed): welcome/identity, echo, UserStore, tool_call + HITL resume,
// ambient-emit GenUI, watermark replay.
//
//	go run ./examples/go/server             # from the repo root, server on :8793
//	go run ./examples/go/server --selftest  # starts :8793 AND runs a scripted
//	                                        # WS client, exit 0/1
//
// Try it from the browser console:
//
//	s = new WebSocket("ws://localhost:8793/chat")
//	s.onmessage = e => console.log(JSON.parse(e.data))
//	s.onopen = () => s.send(JSON.stringify({type:"text",data:{text:"report please"}}))
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	botiva "github.com/aimtune/botiva/core"
	"github.com/aimtune/botiva/server/ws"
)

func main() {
	selftest := flag.Bool("selftest", false, "run a scripted WebSocket client against the server and exit 0/1")
	flag.Parse()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8793"
	}

	engine := botiva.NewConversationEngine(botiva.EngineOptions{
		Runtime:  botiva.DemoRuntime{},
		Greeting: "Hi! botiva Go demo. Try: 'my name is Ada', 'weather', or 'report please' 👋",
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"ok":true,"engine":"botiva-go-demo"}`)
	})
	mux.Handle("/chat", ws.NewHandler(engine, nil))

	errCh := make(chan error, 1)
	go func() { errCh <- http.ListenAndServe(":"+port, mux) }()
	if err := waitForServer(port, errCh); err != nil {
		fmt.Fprintln(os.Stderr, "server failed to start:", err)
		os.Exit(1)
	}
	fmt.Printf("\n✓ botiva Go demo ready → ws://localhost:%s/chat\n\n", port)

	if *selftest {
		if err := runSelfTest(port); err != nil {
			fmt.Fprintf(os.Stderr, "\nGo transport selftest failed ❌ %v\n", err)
			os.Exit(1)
		}
		fmt.Println("\nGo transport selftest passed ✅")
		os.Exit(0)
	}
	if err := <-errCh; err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func waitForServer(port string, errCh <-chan error) error {
	for i := 0; i < 50; i++ {
		select {
		case err := <-errCh: // e.g. the port is already taken by another process
			return err
		default:
		}
		resp, err := http.Get("http://localhost:" + port + "/healthz")
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			// Guard against answering a foreign server squatting on the port.
			if !strings.Contains(string(body), "botiva-go-demo") {
				return fmt.Errorf(":%s is serving something else — set PORT to a free port", port)
			}
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("no /healthz response on :%s", port)
}

// ── scripted self-test (same scenario as the TS --selftest) ─────────────────

type client struct {
	conn   *ws.Conn
	frames chan botiva.Frame
}

func dial(url string) (*client, error) {
	conn, err := ws.Dial(url)
	if err != nil {
		return nil, err
	}
	c := &client{conn: conn, frames: make(chan botiva.Frame, 64)}
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
	return c, nil
}

func (c *client) send(text string) error {
	raw, _ := json.Marshal(botiva.Frame{"type": "text", "data": map[string]any{"text": text}})
	return c.conn.WriteText(string(raw))
}

func (c *client) waitFor(label string, pred func(botiva.Frame) bool) (botiva.Frame, error) {
	deadline := time.After(5 * time.Second)
	for {
		select {
		case frame, ok := <-c.frames:
			if !ok {
				return nil, fmt.Errorf("%s: connection closed", label)
			}
			if pred(frame) {
				return frame, nil
			}
		case <-deadline:
			return nil, fmt.Errorf("%s: timed out", label)
		}
	}
}

func botText(f botiva.Frame, contains string) bool {
	data, _ := f["data"].(map[string]any)
	text, _ := data["text"].(string)
	return f["type"] == "text" && f["from"] == "bot" && strings.Contains(text, contains)
}

func userText(f botiva.Frame, contains string) bool {
	data, _ := f["data"].(map[string]any)
	text, _ := data["text"].(string)
	return f["type"] == "text" && f["from"] == "user" && strings.Contains(text, contains)
}

func runSelfTest(port string) error {
	url := fmt.Sprintf("ws://localhost:%s/chat", port)
	pass := func(name string) { fmt.Printf("  ✅ %s\n", name) }

	a, err := dial(url)
	if err != nil {
		return err
	}
	defer a.conn.Close()

	welcome, err := a.waitFor("welcome", func(f botiva.Frame) bool { return f["type"] == "welcome" })
	if err != nil {
		return err
	}
	data := welcome["data"].(map[string]any)
	if data["protocol"] != botiva.ProtocolVersion {
		return fmt.Errorf("unexpected protocol %v", data["protocol"])
	}
	conversationID, _ := data["conversationId"].(string)
	userID, _ := data["userId"].(string)
	pass("welcome frame (protocol botiva/1)")

	if _, err := a.waitFor("greeting", func(f botiva.Frame) bool { return botText(f, "Go demo") }); err != nil {
		return err
	}
	pass("greeting delivered")

	if err := a.send("hello world"); err != nil {
		return err
	}
	if _, err := a.waitFor("echo", func(f botiva.Frame) bool { return botText(f, "Echo: hello world") }); err != nil {
		return err
	}
	pass("echo turn over the wire")

	if err := a.send("my name is Botivan"); err != nil {
		return err
	}
	if _, err := a.waitFor("name saved", func(f botiva.Frame) bool { return botText(f, "Botivan") }); err != nil {
		return err
	}
	pass("UserStore write")

	if err := a.send("report please"); err != nil {
		return err
	}
	if _, err := a.waitFor("tool_call", func(f botiva.Frame) bool { return f["type"] == "tool_call" }); err != nil {
		return err
	}
	if _, err := a.waitFor("interrupt chips", func(f botiva.Frame) bool {
		actions, _ := f["actions"].([]any)
		return f["type"] == "text" && len(actions) > 0
	}); err != nil {
		return err
	}
	pass("tool_call + interrupt chips")

	if err := a.send("Approve"); err != nil {
		return err
	}
	if _, err := a.waitFor("HITL resume", func(f botiva.Frame) bool { return botText(f, "Approved") }); err != nil {
		return err
	}
	pass("HITL resume via next message")

	if err := a.send("weather"); err != nil {
		return err
	}
	if _, err := a.waitFor("genui", func(f botiva.Frame) bool { return f["type"] == "genui" }); err != nil {
		return err
	}
	if _, err := a.waitFor("genui auto close", func(f botiva.Frame) bool {
		return f["type"] == "genui" && f["done"] == true
	}); err != nil {
		return err
	}
	pass("ambient-emit GenUI + auto stream close")

	b, err := dial(fmt.Sprintf("%s?userId=%s&conversationId=%s&watermark=0", url, userID, conversationID))
	if err != nil {
		return err
	}
	defer b.conn.Close()
	if _, err := b.waitFor("replay", func(f botiva.Frame) bool { return botText(f, "Echo: hello world") }); err != nil {
		return err
	}
	pass("watermark replay on reconnect")

	if err := b.send("sync test"); err != nil {
		return err
	}
	if _, err := a.waitFor("fan-out", func(f botiva.Frame) bool { return userText(f, "sync test") }); err != nil {
		return err
	}
	pass("multi-connection fan-out")

	c, err := dial(fmt.Sprintf("%s?userId=%s", url, userID))
	if err != nil {
		return err
	}
	defer c.conn.Close()
	if _, err := c.waitFor("welcome (C)", func(f botiva.Frame) bool { return f["type"] == "welcome" }); err != nil {
		return err
	}
	if err := c.send("what's my name"); err != nil {
		return err
	}
	if _, err := c.waitFor("cross-conversation state", func(f botiva.Frame) bool {
		return botText(f, "Your name is Botivan")
	}); err != nil {
		return err
	}
	pass("UserStore across conversations")

	return nil
}
