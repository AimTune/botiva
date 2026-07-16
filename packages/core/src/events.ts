// botiva agent events — the common language between runtimes (LangGraph,
// LangChain, custom code, any language) and the ConversationEngine.
//
// A turn produces this event sequence:
//   run_started → (tool_call | message | genui | interrupt)* → run_finished | run_error
//
// tool_call: emitted multiple times with the same id (running → completed/error);
// clients upsert by id (chativa renders this as the ToolCallActivity strip).
// interrupt: human-in-the-loop — the run pauses, the user's next message is fed
// back to the runtime as `resume`.
// genui: mounts/updates a component registered in the client GenUIRegistry.

export type ToolCallStatus = "running" | "completed" | "error";

/** Mirrors the chativa ToolCall entity. */
export interface ToolCall {
    id: string;
    name: string;
    status: ToolCallStatus;
    params?: unknown;
    result?: unknown;
    error?: string;
    startedAt?: number;
    endedAt?: number;
}

/** Mirrors the chativa MessageAction chip. */
export interface MessageAction {
    label: string;
    value?: string;
}

/** Mirrors the chativa AIChunk. */
export type GenUIChunk =
    | { type: "ui"; component: string; props?: Record<string, unknown>; id?: string | number }
    | { type: "text"; content: string; id?: string | number }
    | { type: "event"; name: string; payload?: unknown; id?: string | number };

/** Recommended interrupt payload shape — rendered as a question + action chips. */
export interface InterruptQuestion {
    question?: string;
    message?: string;
    options?: Array<string | MessageAction>;
    [key: string]: unknown;
}

export type AgentEvent =
    | { type: "run_started" }
    | { type: "run_finished" }
    | { type: "run_error"; error: string }
    | { type: "message"; text: string; actions?: MessageAction[] }
    | { type: "tool_call"; toolCall: ToolCall }
    | { type: "interrupt"; payload: unknown; id?: string | null }
    | { type: "genui"; chunk: GenUIChunk; streamId?: string; done?: boolean }
    | { type: "busy" };

// ── factories ────────────────────────────────────────────────────────────────

export const runStarted = (): AgentEvent => ({ type: "run_started" });
export const runFinished = (): AgentEvent => ({ type: "run_finished" });
export const runError = (error: unknown): AgentEvent => ({ type: "run_error", error: String(error) });

export const message = (text: string, actions?: MessageAction[]): AgentEvent =>
    actions ? { type: "message", text, actions } : { type: "message", text };

export const busy = (): AgentEvent => ({ type: "busy" });

export const toolCall = (
    id: string,
    name: string,
    status: ToolCallStatus,
    extra: Partial<Omit<ToolCall, "id" | "name" | "status">> = {},
): AgentEvent => ({ type: "tool_call", toolCall: { id, name, status, ...extra } });

/** Recommended payload shape: { question, options? } → rendered as action chips. */
export const interrupt = (payload: unknown, id: string | null = null): AgentEvent => ({
    type: "interrupt",
    payload,
    id,
});

/**
 * Generative UI chunk. `streamId` is optional — the engine groups all chunks
 * of a turn under one stream and closes it automatically.
 */
export const genui = (chunk: GenUIChunk, opts: { streamId?: string; done?: boolean } = {}): AgentEvent => ({
    type: "genui",
    chunk,
    ...(opts.streamId !== undefined ? { streamId: opts.streamId } : {}),
    ...(opts.done !== undefined ? { done: opts.done } : {}),
});

/** Shorthand: mount a client-side component (chativa GenUIRegistry) in the chat. */
export const ui = (component: string, props: Record<string, unknown> = {}): AgentEvent =>
    genui({ type: "ui", component, props });
