// Runtime port — the single method a framework adapter must implement.
// This is the hexagonal "driving" port: LangGraph, LangChain, Vercel AI SDK,
// Microsoft Agent Framework or hand-written code all plug in here.
//
// Cross-language signature parity (see PROTOCOL.md §8):
//   TypeScript  run(input: RunInput, ctx: TurnContext): AsyncIterable<AgentEvent>
//   Python      async def run(self, input: RunInput, ctx: TurnContext) -> AsyncIterator[AgentEvent]
//   C#          IAsyncEnumerable<AgentEvent> RunAsync(RunInput input, TurnContext ctx, CancellationToken ct)
//   Go          Run(ctx context.Context, input RunInput, tc *TurnContext) (<-chan AgentEvent, error)

import type { AgentEvent } from "./events.js";
import type { ConversationStore, UserStore } from "./state.js";

export interface Logger {
    debug?(...args: unknown[]): void;
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
    error?(...args: unknown[]): void;
}

/** A paused human-in-the-loop question waiting for the user's answer. */
export interface PendingInterrupt {
    id: string | null;
    payload: unknown;
    at: number;
}

/** Input for one turn. Exactly one of `text` / `resume` is set. */
export interface RunInput {
    /** Normal turn: the user's message. */
    text?: string;
    /** HITL turn: the user's answer to the pending interrupt. */
    resume?: unknown;
    /** The interrupt being answered (when `resume` is set). */
    interrupt?: PendingInterrupt;
}

/** Conversation-scoped context (available outside turns too). */
export interface ConversationContext {
    conversationId: string;
    userId: string;
    /** Per-user state — persists across conversations and devices. */
    userStore: UserStore;
    /** Per-conversation state — shared by all attached connections. */
    conversationStore: ConversationStore;
    log: Logger;
    meta: Record<string, unknown>;
}

/**
 * Turn-scoped context handed to Runtime.run(). Also reachable from anywhere
 * in the async call tree via botivaEmit()/botivaContext() (emit.ts), and — for
 * LangGraph — via config.configurable.botiva inside nodes/tools.
 */
export interface TurnContext extends ConversationContext {
    /** Push an out-of-band event into the current turn (merged with yielded events). */
    emit(event: AgentEvent): void;
}

export interface Runtime {
    run(input: RunInput, ctx: TurnContext): AsyncIterable<AgentEvent>;
}
