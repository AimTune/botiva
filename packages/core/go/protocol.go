package botiva

import (
	"encoding/json"
	"strings"
	"time"
)

// ProtocolVersion of the Botiva Wire Protocol this port speaks.
const ProtocolVersion = "botiva/1"

// Frame is one wire frame. A map keeps the JSON mapping transparent and the
// port compact; typed accessors live where they matter (seq, type).
type Frame = map[string]any

// IncomingMessage is a parsed user message.
type IncomingMessage struct {
	Text string
	ID   string
	Meta map[string]any
}

// HelloFrame is the client handshake.
type HelloFrame struct {
	UserID         string
	ConversationID string
	Watermark      int
	HasWatermark   bool
	Token          string // auth credential (§2.1), when the server authenticates
	Meta           map[string]any
}

// Inbound is the result of ParseIncoming: exactly one field is non-nil.
type Inbound struct {
	Hello   *HelloFrame
	Message *IncomingMessage
}

// ParseIncoming accepts a JSON string, raw bytes, a parsed frame map or plain
// text — mirrors parseIncoming in @botiva/core.
func ParseIncoming(raw any) *Inbound {
	var value map[string]any
	switch v := raw.(type) {
	case string:
		if err := json.Unmarshal([]byte(v), &value); err != nil {
			text := strings.TrimSpace(v)
			if text == "" {
				return nil
			}
			return &Inbound{Message: &IncomingMessage{Text: text}}
		}
	case []byte:
		return ParseIncoming(string(v))
	case map[string]any:
		value = v
	default:
		return nil
	}
	if value == nil {
		return nil
	}
	if value["type"] == "hello" {
		hello := &HelloFrame{}
		hello.UserID, _ = value["userId"].(string)
		hello.ConversationID, _ = value["conversationId"].(string)
		if w, ok := value["watermark"].(float64); ok {
			hello.Watermark = int(w)
			hello.HasWatermark = true
		}
		hello.Token, _ = value["token"].(string)
		hello.Meta, _ = value["meta"].(map[string]any)
		return &Inbound{Hello: hello}
	}
	text := ""
	if data, ok := value["data"].(map[string]any); ok {
		text, _ = data["text"].(string)
	}
	if text == "" {
		text, _ = value["text"].(string)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	msg := &IncomingMessage{Text: text}
	msg.ID, _ = value["id"].(string)
	msg.Meta, _ = value["meta"].(map[string]any)
	return &Inbound{Message: msg}
}

// FrameMapping pairs a frame with its persistence class.
type FrameMapping struct {
	Frame      Frame
	Persistent bool
}

// EventToFrames is the canonical AgentEvent → wire frame mapping.
// Must stay byte-compatible with @botiva/core eventToFrames (PROTOCOL.md §4).
func EventToFrames(ev AgentEvent, newID func(prefix string) string) []FrameMapping {
	now := time.Now().UnixMilli()
	textFrame := func(text string, extra Frame) Frame {
		f := Frame{
			"type":      "text",
			"id":        newID("msg"),
			"from":      "bot",
			"data":      map[string]any{"text": text},
			"timestamp": now,
		}
		for k, v := range extra {
			f[k] = v
		}
		return f
	}

	switch ev.Type {
	case "message":
		extra := Frame{}
		if len(ev.Actions) > 0 {
			extra["actions"] = ev.Actions
		}
		return []FrameMapping{{textFrame(ev.Text, extra), true}}
	case "tool_call":
		return []FrameMapping{{Frame{"type": "tool_call", "data": ev.ToolCall}, true}}
	case "genui":
		streamID := ev.StreamID
		if streamID == "" {
			streamID = newID("stream")
		}
		return []FrameMapping{{Frame{
			"type": "genui", "streamId": streamID, "chunk": ev.Chunk, "done": ev.Done,
		}, true}}
	case "interrupt":
		question := "Your confirmation is needed to continue."
		options := []any{"Approve", "Cancel"}
		switch p := ev.Payload.(type) {
		case string:
			question = p
		case map[string]any:
			if q, ok := p["question"].(string); ok {
				question = q
			} else if m, ok := p["message"].(string); ok {
				question = m
			}
			// Accept both []any (JSON-decoded payloads) and []string (Go code
			// that follows the documented `"options": []string{...}` pattern).
			switch opts := p["options"].(type) {
			case []any:
				options = opts
			case []string:
				options = make([]any, len(opts))
				for i, s := range opts {
					options[i] = s
				}
			}
		}
		actions := make([]MessageAction, 0, len(options))
		for _, o := range options {
			switch a := o.(type) {
			case string:
				actions = append(actions, MessageAction{Label: a})
			case MessageAction:
				actions = append(actions, a)
			case map[string]any:
				label, _ := a["label"].(string)
				value, _ := a["value"].(string)
				actions = append(actions, MessageAction{Label: label, Value: value})
			}
		}
		return []FrameMapping{{textFrame(question, Frame{"actions": actions}), true}}
	case "busy":
		return []FrameMapping{{textFrame("⏳ Still working on the previous message — one moment.", nil), false}}
	case "run_started":
		return []FrameMapping{{Frame{"type": "run", "data": map[string]any{"status": "started"}}, false}}
	case "run_finished":
		return []FrameMapping{{Frame{"type": "run", "data": map[string]any{"status": "finished"}}, false}}
	case "run_error":
		return []FrameMapping{
			{textFrame("⚠️ "+ev.Error, nil), true},
			{Frame{"type": "run", "data": map[string]any{"status": "finished"}}, false},
		}
	}
	return nil
}
