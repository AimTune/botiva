package botiva

import (
	"context"
	"strings"
	"sync"
	"testing"
)

type collector struct {
	mu     sync.Mutex
	frames []Frame
}

func (c *collector) deliver(f Frame) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frames = append(c.frames, f)
}

func (c *collector) find(pred func(Frame) bool) Frame {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, f := range c.frames {
		if pred(f) {
			return f
		}
	}
	return nil
}

func botText(f Frame, contains string) bool {
	if f["type"] != "text" || f["from"] != "bot" {
		return false
	}
	data, _ := f["data"].(map[string]any)
	text, _ := data["text"].(string)
	return strings.Contains(text, contains)
}

func userText(f Frame, contains string) bool {
	if f["type"] != "text" || f["from"] != "user" {
		return false
	}
	data, _ := f["data"].(map[string]any)
	text, _ := data["text"].(string)
	return strings.Contains(text, contains)
}

func TestEngineEndToEnd(t *testing.T) {
	ctx := context.Background()
	engine := NewConversationEngine(EngineOptions{
		Runtime:  DemoRuntime{},
		Greeting: "go-greeting",
	})

	// 1. fresh connect → welcome + greeting
	a := &collector{}
	connA, err := engine.Connect(ctx, ConnectParams{Deliver: a.deliver})
	if err != nil {
		t.Fatal(err)
	}
	welcome := a.find(func(f Frame) bool { return f["type"] == "welcome" })
	if welcome == nil {
		t.Fatal("no welcome frame")
	}
	data := welcome["data"].(map[string]any)
	if data["protocol"] != ProtocolVersion {
		t.Fatalf("bad protocol: %v", data["protocol"])
	}
	if a.find(func(f Frame) bool { return botText(f, "go-greeting") }) == nil {
		t.Fatal("no greeting")
	}

	// 2. echo turn (HandleMessage is synchronous in the Go port)
	if err := connA.Receive(ctx, `{"type":"text","data":{"text":"hello world"}}`); err != nil {
		t.Fatal(err)
	}
	if a.find(func(f Frame) bool { return botText(f, "Echo: hello world") }) == nil {
		t.Fatal("no echo reply")
	}

	// 3. user state
	_ = connA.Receive(ctx, `{"type":"text","data":{"text":"my name is Hamza"}}`)
	if a.find(func(f Frame) bool { return botText(f, "Nice to meet you, Hamza") }) == nil {
		t.Fatal("name not saved")
	}

	// 4. tool_call + HITL interrupt + resume
	_ = connA.Receive(ctx, `{"type":"text","data":{"text":"report please"}}`)
	if a.find(func(f Frame) bool { return f["type"] == "tool_call" }) == nil {
		t.Fatal("no tool_call frame")
	}
	chips := a.find(func(f Frame) bool { _, ok := f["actions"]; return f["type"] == "text" && ok })
	if chips == nil {
		t.Fatal("no interrupt chips")
	}
	_ = connA.Receive(ctx, `{"type":"text","data":{"text":"Approve"}}`)
	if a.find(func(f Frame) bool { return botText(f, "Approved") }) == nil {
		t.Fatal("HITL resume failed")
	}

	// 5. genui via ambient Emit + auto stream close
	_ = connA.Receive(ctx, `{"type":"text","data":{"text":"weather"}}`)
	genui := a.find(func(f Frame) bool { return f["type"] == "genui" })
	if genui == nil {
		t.Fatal("no genui frame")
	}
	if a.find(func(f Frame) bool { return f["type"] == "genui" && f["done"] == true }) == nil {
		t.Fatal("genui stream not auto-closed")
	}

	// 6. replay on reconnect (watermark 0) + multi-connection fan-out
	convID := data["conversationId"].(string)
	userID := data["userId"].(string)
	b := &collector{}
	connB, err := engine.Connect(ctx, ConnectParams{
		ConversationID: convID, UserID: userID, Watermark: 0, Deliver: b.deliver,
	})
	if err != nil {
		t.Fatal(err)
	}
	if b.find(func(f Frame) bool { return userText(f, "hello world") }) == nil {
		t.Fatal("replay missing user frame")
	}
	if b.find(func(f Frame) bool { return botText(f, "Echo: hello world") }) == nil {
		t.Fatal("replay missing bot frame")
	}
	wb := b.find(func(f Frame) bool { return f["type"] == "welcome" })
	if wm, ok := wb["data"].(map[string]any)["watermark"].(int); !ok || wm <= 0 {
		t.Fatalf("reconnect watermark should be > 0, got %v", wb["data"].(map[string]any)["watermark"])
	}

	_ = connB.Receive(ctx, `{"type":"text","data":{"text":"sync test"}}`)
	if a.find(func(f Frame) bool { return userText(f, "sync test") }) == nil {
		t.Fatal("user frame not fanned out to first connection")
	}
	if b.find(func(f Frame) bool { return userText(f, "sync test") }) != nil {
		t.Fatal("sender must not receive its own user frame")
	}

	// 7. user state across conversations
	c := &collector{}
	connC, err := engine.Connect(ctx, ConnectParams{UserID: userID, Deliver: c.deliver})
	if err != nil {
		t.Fatal(err)
	}
	_ = connC.Receive(ctx, `{"type":"text","data":{"text":"what's my name"}}`)
	if c.find(func(f Frame) bool { return botText(f, "Your name is Hamza") }) == nil {
		t.Fatal("user state did not survive across conversations")
	}

	_ = connA.Close(ctx)
	_ = connB.Close(ctx)
	_ = connC.Close(ctx)
}
