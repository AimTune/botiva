// Package langchaingo plugs any langchaingo llms.Model into the botiva
// Runtime port — the Go counterpart of @botiva/langgraph and Botiva.Agents:
//
//	llms.Model.GenerateContent (OpenAI, Anthropic, Ollama, ...)  → message events
//	Tool calls (manual invocation loop)                          → tool_call events
//	langchaingo.Interrupt(ctx, payload) inside a tool            → botiva interrupt (HITL)
//	the user's next message                                      → resumes the paused tool
//	botiva.Emit(ctx, botiva.UI(...)) inside a tool               → genui event
//
// Conversation memory lives in tc.ConversationStore (key conv:{id}), so it
// follows whatever StateStore the engine uses and survives reconnects.
//
// This is a separate Go module so the core port stays zero-dependency:
//
//	cd ports/go/adapters/langchaingo && go test ./...
package langchaingo

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/chativa/botiva-go/botiva"
	"github.com/tmc/langchaingo/llms"
)

// Tool is one callable exposed to the model.
type Tool struct {
	Name        string
	Description string
	Parameters  map[string]any // JSON Schema of the arguments
	Execute     func(ctx context.Context, args map[string]any) (string, error)
}

// Options tune the runtime; the zero value works.
type Options struct {
	// Instructions is a static system prompt prepended to every request.
	Instructions string
	// InstructionsFunc builds the system prompt per turn — the portable place
	// to inject UserStore facts (mirrors the LangGraph agent-node pattern).
	// Wins over Instructions.
	InstructionsFunc func(ctx context.Context, tc *botiva.TurnContext) (string, error)
	Tools            []Tool
	// DisableToolTrace turns off tool_call events for the client activity strip.
	DisableToolTrace bool
	// MaxToolRounds bounds model↔tool round-trips per turn. Default 8.
	MaxToolRounds int
	// CallOptions are extra langchaingo options applied to every request
	// (llms.WithTemperature, llms.WithModel, ...).
	CallOptions []llms.CallOption
}

// Runtime implements botiva.Runtime over a langchaingo llms.Model.
type Runtime struct {
	model    llms.Model
	opts     Options
	tools    map[string]Tool
	llmTools []llms.Tool
}

func New(model llms.Model, opts Options) *Runtime {
	if opts.MaxToolRounds <= 0 {
		opts.MaxToolRounds = 8
	}
	tools := map[string]Tool{}
	llmTools := make([]llms.Tool, 0, len(opts.Tools))
	for _, tool := range opts.Tools {
		tools[tool.Name] = tool
		llmTools = append(llmTools, llms.Tool{
			Type: "function",
			Function: &llms.FunctionDefinition{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  tool.Parameters,
			},
		})
	}
	return &Runtime{model: model, opts: opts, tools: tools, llmTools: llmTools}
}

// Run implements botiva.Runtime (PROTOCOL.md §8).
func (r *Runtime) Run(ctx context.Context, input botiva.RunInput, tc *botiva.TurnContext) (<-chan botiva.AgentEvent, error) {
	out := make(chan botiva.AgentEvent, 16)
	go func() {
		defer close(out)
		out <- botiva.RunStarted()
		if err := r.run(ctx, input, tc, out); err != nil {
			out <- botiva.RunError(err.Error())
		}
		out <- botiva.RunFinished()
	}()
	return out, nil
}

// ── stored message shape (neutral JSON — no langchaingo serialization) ──────

type storedToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // raw JSON string, as the model sent it
}

type storedToolResponse struct {
	CallID  string `json:"callId"`
	Name    string `json:"name"`
	Content string `json:"content"`
}

type storedMessage struct {
	Role         string              `json:"role"` // human | ai | tool
	Text         string              `json:"text,omitempty"`
	ToolCalls    []storedToolCall    `json:"toolCalls,omitempty"`
	ToolResponse *storedToolResponse `json:"toolResponse,omitempty"`
}

const (
	messagesKey = "chatMessages"
	pendingKey  = "pendingToolCall"
)

func (r *Runtime) run(ctx context.Context, input botiva.RunInput, tc *botiva.TurnContext, out chan<- botiva.AgentEvent) error {
	state, err := tc.ConversationStore.Get(ctx)
	if err != nil {
		return err
	}
	if state == nil {
		state = map[string]any{}
	}
	messages := decodeStored(state[messagesKey])
	// Tools see the turn context (stores, Emit) through the context — the Go
	// ambient pattern (PROTOCOL.md §9).
	toolCtx := botiva.WithTurnContext(ctx, tc)

	instructions := r.opts.Instructions
	if r.opts.InstructionsFunc != nil {
		if instructions, err = r.opts.InstructionsFunc(ctx, tc); err != nil {
			return err
		}
	}

	pending := loadPending(state)
	switch {
	case input.IsResume && len(pending) > 0:
		// HITL answer: re-run the paused tool calls — the interrupted one gets
		// the resume value (Interrupt returns it) and the siblings that never
		// ran on the previous pass run normally (PROTOCOL.md §5).
		delete(state, pendingKey)
		for i, call := range pending {
			toolExecCtx := toolCtx
			if i == 0 {
				toolExecCtx = withResume(toolCtx, input.Resume)
			}
			result, interrupted := r.execTool(toolExecCtx, call, out)
			if interrupted != nil { // a tool asked a follow-up question
				return r.saveInterrupted(ctx, tc, state, messages, pending[i:], interrupted, out)
			}
			messages = append(messages, storedMessage{Role: "tool", ToolResponse: &storedToolResponse{
				CallID: call.ID, Name: call.Name, Content: result,
			}})
		}
	default:
		// Not a resume. Any surviving pending call is drift (the engine's
		// interrupt record was cleared/evicted independently) — drop it and
		// repair a dangling tool_use so it never reaches the model.
		if state[pendingKey] != nil {
			delete(state, pendingKey)
			messages = repairDangling(messages)
		}
		text := input.Text
		if input.IsResume {
			text = input.Resume
		}
		messages = append(messages, storedMessage{Role: "human", Text: text})
	}

	finalText := ""
	for round := 0; round < r.opts.MaxToolRounds; round++ {
		callOpts := append([]llms.CallOption{}, r.opts.CallOptions...)
		if len(r.llmTools) > 0 {
			callOpts = append(callOpts, llms.WithTools(r.llmTools))
		}
		resp, err := r.model.GenerateContent(ctx, buildContent(instructions, messages), callOpts...)
		if err != nil {
			return err
		}
		if len(resp.Choices) == 0 {
			break
		}
		choice := resp.Choices[0]
		if len(choice.ToolCalls) == 0 {
			finalText = choice.Content
			// Don't persist an empty assistant turn — a stored message with no
			// text and no tool calls is rejected by providers on the next turn.
			if finalText != "" {
				messages = append(messages, storedMessage{Role: "ai", Text: finalText})
			}
			break
		}

		aiMsg := storedMessage{Role: "ai", Text: choice.Content}
		for _, call := range choice.ToolCalls {
			aiMsg.ToolCalls = append(aiMsg.ToolCalls, storedToolCall{
				ID: call.ID, Name: call.FunctionCall.Name, Arguments: call.FunctionCall.Arguments,
			})
		}
		messages = append(messages, aiMsg)

		for i, call := range aiMsg.ToolCalls {
			result, interrupted := r.execTool(toolCtx, call, out)
			if interrupted != nil {
				// Persist the interrupted call + not-yet-run siblings so resume
				// completes all of them; no fabricated placeholder results.
				return r.saveInterrupted(ctx, tc, state, messages, aiMsg.ToolCalls[i:], interrupted, out)
			}
			messages = append(messages, storedMessage{Role: "tool", ToolResponse: &storedToolResponse{
				CallID: call.ID, Name: call.Name, Content: result,
			}})
		}
	}

	state[messagesKey] = messages
	if err := tc.ConversationStore.Set(ctx, state); err != nil {
		return err
	}
	if finalText == "" {
		return fmt.Errorf("empty response")
	}
	out <- botiva.Message(finalText)
	return nil
}

// execTool runs one tool call, emitting trace events. A non-nil *InterruptError
// means the HITL pause (not a failure).
func (r *Runtime) execTool(ctx context.Context, call storedToolCall, out chan<- botiva.AgentEvent) (string, *InterruptError) {
	var args map[string]any
	if call.Arguments != "" {
		_ = json.Unmarshal([]byte(call.Arguments), &args)
	}
	// One place to gate + emit a trace frame instead of five copies of the guard.
	trace := func(tc botiva.ToolCall) {
		if !r.opts.DisableToolTrace {
			out <- botiva.ToolCallEvent(tc)
		}
	}
	now := time.Now().UnixMilli()
	trace(botiva.ToolCall{ID: call.ID, Name: call.Name, Status: "running", Params: args, StartedAt: now})

	tool, ok := r.tools[call.Name]
	if !ok {
		result := "unknown tool: " + call.Name
		trace(botiva.ToolCall{ID: call.ID, Name: call.Name, Status: "error", Error: result, EndedAt: now})
		return result, nil
	}

	result, err := tool.Execute(ctx, args)
	if interrupted, ok := asInterrupt(err); ok {
		// Not an error — the HITL pause (mirror of the LangGraph adapter).
		trace(botiva.ToolCall{ID: call.ID, Name: call.Name, Status: "completed",
			Result: "⏸ waiting for user approval", EndedAt: time.Now().UnixMilli()})
		return "", interrupted
	}
	if err != nil {
		trace(botiva.ToolCall{ID: call.ID, Name: call.Name, Status: "error",
			Error: err.Error(), EndedAt: time.Now().UnixMilli()})
		return "tool error: " + err.Error(), nil
	}
	trace(botiva.ToolCall{ID: call.ID, Name: call.Name, Status: "completed",
		Result: short(result), EndedAt: time.Now().UnixMilli()})
	return result, nil
}

func (r *Runtime) saveInterrupted(
	ctx context.Context, tc *botiva.TurnContext, state map[string]any,
	messages []storedMessage, pending []storedToolCall, interrupted *InterruptError,
	out chan<- botiva.AgentEvent,
) error {
	calls := make([]map[string]any, 0, len(pending))
	for _, c := range pending {
		calls = append(calls, map[string]any{"id": c.ID, "name": c.Name, "arguments": c.Arguments})
	}
	state[pendingKey] = map[string]any{"calls": calls}
	state[messagesKey] = messages
	if err := tc.ConversationStore.Set(ctx, state); err != nil {
		return err
	}
	id := ""
	if len(pending) > 0 {
		id = pending[0].ID
	}
	out <- botiva.Interrupt(interrupted.Payload, id)
	return nil
}

// ── codecs ───────────────────────────────────────────────────────────────────

func asInterrupt(err error) (*InterruptError, bool) {
	if err == nil {
		return nil, false
	}
	if interrupted, ok := err.(*InterruptError); ok {
		return interrupted, true
	}
	return nil, false
}

func buildContent(instructions string, messages []storedMessage) []llms.MessageContent {
	content := make([]llms.MessageContent, 0, len(messages)+1)
	if instructions != "" {
		content = append(content, llms.TextParts(llms.ChatMessageTypeSystem, instructions))
	}
	for _, msg := range messages {
		switch msg.Role {
		case "human":
			content = append(content, llms.TextParts(llms.ChatMessageTypeHuman, msg.Text))
		case "tool":
			if msg.ToolResponse != nil {
				content = append(content, llms.MessageContent{
					Role: llms.ChatMessageTypeTool,
					Parts: []llms.ContentPart{llms.ToolCallResponse{
						ToolCallID: msg.ToolResponse.CallID,
						Name:       msg.ToolResponse.Name,
						Content:    msg.ToolResponse.Content,
					}},
				})
			}
		default: // ai
			parts := []llms.ContentPart{}
			if msg.Text != "" {
				parts = append(parts, llms.TextContent{Text: msg.Text})
			}
			for _, call := range msg.ToolCalls {
				parts = append(parts, llms.ToolCall{
					ID:   call.ID,
					Type: "function",
					FunctionCall: &llms.FunctionCall{
						Name:      call.Name,
						Arguments: call.Arguments,
					},
				})
			}
			content = append(content, llms.MessageContent{Role: llms.ChatMessageTypeAI, Parts: parts})
		}
	}
	return content
}

// decodeStored reloads the message history from whatever the StateStore holds
// (a typed slice in-process, or []any after a JSON round-trip through Redis).
func decodeStored(value any) []storedMessage {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var messages []storedMessage
	_ = json.Unmarshal(raw, &messages)
	return messages
}

// loadPending reads the interrupted call plus every not-yet-run sibling.
func loadPending(state map[string]any) []storedToolCall {
	if state[pendingKey] == nil {
		return nil
	}
	raw, err := json.Marshal(state[pendingKey])
	if err != nil {
		return nil
	}
	var pending struct {
		Calls []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"calls"`
	}
	if json.Unmarshal(raw, &pending) != nil {
		return nil
	}
	out := make([]storedToolCall, 0, len(pending.Calls))
	for _, c := range pending.Calls {
		out = append(out, storedToolCall{ID: c.ID, Name: c.Name, Arguments: c.Arguments})
	}
	return out
}

// repairDangling drops a trailing assistant turn whose tool_use blocks were
// never all answered, so drift never leaves a dangling tool_use for the model.
func repairDangling(messages []storedMessage) []storedMessage {
	answered := map[string]bool{}
	for _, m := range messages {
		if m.ToolResponse != nil {
			answered[m.ToolResponse.CallID] = true
		}
	}
	for i := len(messages) - 1; i >= 0; i-- {
		for _, c := range messages[i].ToolCalls {
			if !answered[c.ID] {
				return messages[:i] // drop it + any partial results after it
			}
		}
	}
	return messages
}

// short compacts a tool result for the activity strip, trimming to a rune
// boundary so a multi-byte rune is never split into invalid UTF-8.
func short(value string) string {
	const limit = 600
	if len(value) <= limit {
		return value
	}
	end := limit
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end] + "…"
}
