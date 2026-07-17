// Package botiva is the Go reference port of the botiva conversation
// framework (Botiva Wire Protocol v1). Signatures mirror @botiva/core —
// see PROTOCOL.md §8 for the cross-language contract.
package botiva

// ToolCall mirrors the chativa ToolCall entity.
type ToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"` // running | completed | error
	Params    any    `json:"params,omitempty"`
	Result    any    `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
	StartedAt int64  `json:"startedAt,omitempty"`
	EndedAt   int64  `json:"endedAt,omitempty"`
}

// MessageAction mirrors the chativa MessageAction chip.
type MessageAction struct {
	Label string `json:"label"`
	Value string `json:"value,omitempty"`
}

// GenUIChunk mirrors the chativa AIChunk ("ui" | "text" | "event").
type GenUIChunk struct {
	Type      string         `json:"type"`
	Component string         `json:"component,omitempty"`
	Props     map[string]any `json:"props,omitempty"`
	Content   string         `json:"content,omitempty"`
	Name      string         `json:"name,omitempty"`
	Payload   any            `json:"payload,omitempty"`
	ID        any            `json:"id,omitempty"`
}

// AgentEvent is the runtime → engine event. One struct with a Type
// discriminator keeps the wire mapping identical to the TS union.
type AgentEvent struct {
	Type     string          `json:"type"` // run_started|run_finished|run_error|message|tool_call|interrupt|genui|busy
	Text     string          `json:"text,omitempty"`
	Actions  []MessageAction `json:"actions,omitempty"`
	ToolCall *ToolCall       `json:"toolCall,omitempty"`
	Payload  any             `json:"payload,omitempty"`
	ID       string          `json:"id,omitempty"`
	Chunk    *GenUIChunk     `json:"chunk,omitempty"`
	StreamID string          `json:"streamId,omitempty"`
	Done     bool            `json:"done,omitempty"`
	Error    string          `json:"error,omitempty"`
}

// ── factories (mirror @botiva/core) ─────────────────────────────────────────

func RunStarted() AgentEvent          { return AgentEvent{Type: "run_started"} }
func RunFinished() AgentEvent         { return AgentEvent{Type: "run_finished"} }
func RunError(err string) AgentEvent  { return AgentEvent{Type: "run_error", Error: err} }
func Busy() AgentEvent                { return AgentEvent{Type: "busy"} }
func Message(text string) AgentEvent  { return AgentEvent{Type: "message", Text: text} }

func ToolCallEvent(tc ToolCall) AgentEvent { return AgentEvent{Type: "tool_call", ToolCall: &tc} }

// Interrupt: recommended payload {question, options} → rendered as chips.
func Interrupt(payload any, id string) AgentEvent {
	return AgentEvent{Type: "interrupt", Payload: payload, ID: id}
}

func GenUI(chunk GenUIChunk) AgentEvent { return AgentEvent{Type: "genui", Chunk: &chunk} }

// UI mounts a client-registered component (chativa GenUIRegistry).
func UI(component string, props map[string]any) AgentEvent {
	return GenUI(GenUIChunk{Type: "ui", Component: component, Props: props})
}
