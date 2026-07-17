package langchaingo

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"testing"

	botiva "github.com/aimtune/botiva/core"
	"github.com/tmc/langchaingo/llms"
)

// scriptedModel routes user text to tool calls with simple rules — a stand-in
// LLM that makes the whole agent loop (including HITL resume) testable offline.
type scriptedModel struct{ calls int }

var (
	nameRe    = regexp.MustCompile(`(?i)my name is\s+(\p{L}+)`)
	weatherRe = regexp.MustCompile(`(?i)weather`)
	reportRe  = regexp.MustCompile(`(?i)report|pdf`)
)

func (m *scriptedModel) GenerateContent(_ context.Context, messages []llms.MessageContent, _ ...llms.CallOption) (*llms.ContentResponse, error) {
	last := messages[len(messages)-1]

	// A tool round just finished → phrase the final answer from its result.
	if last.Role == llms.ChatMessageTypeTool {
		response := last.Parts[0].(llms.ToolCallResponse)
		text := response.Content
		if response.Name == "get_weather" {
			text = "Here is the current weather."
		}
		return textResponse(text), nil
	}

	var input string
	for _, part := range last.Parts {
		if tc, ok := part.(llms.TextContent); ok {
			input += tc.Text
		}
	}
	switch {
	case nameRe.MatchString(input):
		return m.toolResponse("remember_name", fmt.Sprintf(`{"name":%q}`, nameRe.FindStringSubmatch(input)[1])), nil
	case weatherRe.MatchString(input):
		return m.toolResponse("get_weather", `{"city":"Istanbul"}`), nil
	case reportRe.MatchString(input):
		return m.toolResponse("generate_report_pdf", `{"topic":"velocity"}`), nil
	default:
		return textResponse("Echo: " + input), nil
	}
}

func (m *scriptedModel) Call(ctx context.Context, prompt string, options ...llms.CallOption) (string, error) {
	resp, err := m.GenerateContent(ctx, []llms.MessageContent{llms.TextParts(llms.ChatMessageTypeHuman, prompt)}, options...)
	if err != nil {
		return "", err
	}
	return resp.Choices[0].Content, nil
}

func textResponse(text string) *llms.ContentResponse {
	return &llms.ContentResponse{Choices: []*llms.ContentChoice{{Content: text}}}
}

func (m *scriptedModel) toolResponse(name, args string) *llms.ContentResponse {
	m.calls++
	return &llms.ContentResponse{Choices: []*llms.ContentChoice{{
		ToolCalls: []llms.ToolCall{{
			ID:           fmt.Sprintf("call-%d", m.calls),
			Type:         "function",
			FunctionCall: &llms.FunctionCall{Name: name, Arguments: args},
		}},
	}}}
}

func demoTools() []Tool {
	approveRe := regexp.MustCompile(`(?i)approve|yes|onay|evet`)
	return []Tool{
		{
			Name: "get_weather", Description: "Returns a city's weather.",
			Parameters: map[string]any{"type": "object", "properties": map[string]any{"city": map[string]any{"type": "string"}}},
			Execute: func(ctx context.Context, args map[string]any) (string, error) {
				// Ambient emit through the context (PROTOCOL.md §9).
				botiva.Emit(ctx, botiva.UI("weather", map[string]any{"city": args["city"], "temp": 22}))
				return `{"temp":22}`, nil
			},
		},
		{
			Name: "remember_name", Description: "Stores the user's name in UserStore.",
			Parameters: map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}}},
			Execute: func(ctx context.Context, args map[string]any) (string, error) {
				tc := botiva.FromContext(ctx)
				name, _ := args["name"].(string)
				if _, err := tc.UserStore.Patch(ctx, map[string]any{"name": name}); err != nil {
					return "", err
				}
				return "Saved. The user's name is " + name + ".", nil
			},
		},
		{
			Name: "generate_report_pdf", Description: "Generates a report (asks for approval first).",
			Parameters: map[string]any{"type": "object", "properties": map[string]any{"topic": map[string]any{"type": "string"}}},
			Execute: func(ctx context.Context, args map[string]any) (string, error) {
				answer, err := Interrupt(ctx, map[string]any{
					"question": "Generate the report?", "options": []any{"Approve", "Cancel"},
				})
				if err != nil {
					return "", err // pause
				}
				if !approveRe.MatchString(answer) {
					return "The user declined — no report was generated.", nil
				}
				return "Report ready: report-velocity.pdf", nil
			},
		},
	}
}

func botText(f botiva.Frame, contains string) bool {
	data, _ := f["data"].(map[string]any)
	text, _ := data["text"].(string)
	return f["type"] == "text" && f["from"] == "bot" && strings.Contains(text, contains)
}

func toolFrame(f botiva.Frame, name, status string) bool {
	if f["type"] != "tool_call" {
		return false
	}
	raw, _ := json.Marshal(f["data"])
	var data struct{ Name, Status string }
	_ = json.Unmarshal(raw, &data)
	return data.Name == name && data.Status == status
}

func TestLangChainRuntimeEndToEnd(t *testing.T) {
	ctx := context.Background()
	stateStore := botiva.NewMemoryStateStore()
	engine := botiva.NewConversationEngine(botiva.EngineOptions{
		Runtime:    New(&scriptedModel{}, Options{Tools: demoTools()}),
		StateStore: stateStore,
	})

	// Deliver may be invoked concurrently — an ambient botiva.Emit inside a tool
	// dispatches on the runtime goroutine while the engine drains the event
	// channel on another — so guard the frame log (the ws transport serializes
	// its own writes via writeMu).
	var framesMu sync.Mutex
	var frames []botiva.Frame
	conn, err := engine.Connect(ctx, botiva.ConnectParams{
		Deliver: func(f botiva.Frame) {
			framesMu.Lock()
			frames = append(frames, f)
			framesMu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	send := func(text string) {
		t.Helper()
		payload, _ := json.Marshal(map[string]any{"type": "text", "data": map[string]any{"text": text}})
		if err := conn.Receive(ctx, string(payload)); err != nil {
			t.Fatal(err)
		}
	}
	expect := func(label string, pred func(botiva.Frame) bool) {
		t.Helper()
		framesMu.Lock()
		defer framesMu.Unlock()
		for _, f := range frames {
			if pred(f) {
				return
			}
		}
		t.Fatalf("%s: no matching frame in %d frames", label, len(frames))
	}

	// 1. plain text turn
	send("hello world")
	expect("echo", func(f botiva.Frame) bool { return botText(f, "Echo: hello world") })

	// 2. tool turn: UserStore write + trace, model summarizes the result
	send("my name is Botivan")
	expect("tool trace", func(f botiva.Frame) bool { return toolFrame(f, "remember_name", "completed") })
	expect("summarized result", func(f botiva.Frame) bool { return botText(f, "Botivan") })

	// 3. genui via ambient emit inside the tool
	send("weather please")
	expect("genui", func(f botiva.Frame) bool { return f["type"] == "genui" })
	expect("weather answer", func(f botiva.Frame) bool { return botText(f, "Here is the current weather") })

	// 4. HITL: interrupt chips → approve resumes the SAME tool call
	send("generate the report pdf")
	expect("approval chips", func(f botiva.Frame) bool {
		if f["type"] != "text" || f["actions"] == nil {
			return false
		}
		raw, _ := json.Marshal(f["actions"]) // in-process frames keep the typed slice
		var actions []any
		_ = json.Unmarshal(raw, &actions)
		return len(actions) > 0
	})
	expect("paused tool trace", func(f botiva.Frame) bool { return toolFrame(f, "generate_report_pdf", "running") })

	frames = frames[:0]
	send("Approve")
	expect("resumed tool completes", func(f botiva.Frame) bool { return toolFrame(f, "generate_report_pdf", "completed") })
	expect("final answer", func(f botiva.Frame) bool { return botText(f, "Report ready") })

	// 5. chat memory persisted in ConversationStore (survives reconnects)
	store, err := botiva.NewConversationStore(stateStore, conn.ConversationID).Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if store == nil || store["chatMessages"] == nil {
		t.Fatal("chatMessages not persisted in ConversationStore")
	}
	if store["pendingToolCall"] != nil {
		t.Fatal("pendingToolCall should be cleared after resume")
	}

	// 6. decline path
	send("another report pdf")
	frames = frames[:0]
	send("Cancel")
	expect("decline answer", func(f botiva.Frame) bool { return botText(f, "declined") })
}
