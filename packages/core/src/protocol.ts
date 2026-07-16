// Botiva Wire Protocol v1 ("botiva/1") — the transport-agnostic frame format.
//
// Every transport (WebSocket, Socket.IO, SSE, SignalR, ...) carries these exact
// JSON frames, so the client side needs exactly ONE connector regardless of
// transport, and server implementations in other languages (Go, .NET, Python)
// only have to reproduce this mapping. See PROTOCOL.md for the full spec.
//
// Frames are either:
//   persistent — appended to conversation history with a monotonic `seq`
//                (watermark) and replayed on reconnect: text, tool_call, genui
//   transient  — delivery-only, never replayed: welcome, run, busy notices

import type { GenUIChunk, MessageAction, AgentEvent, ToolCall } from "./events.js";

export const PROTOCOL_VERSION = "botiva/1";

// ── frames ───────────────────────────────────────────────────────────────────

/** Client → server handshake (also expressible as query params / socket.io auth). */
export interface HelloFrame {
    type: "hello";
    userId?: string;
    conversationId?: string;
    /** Highest `seq` the client has already seen; server replays newer frames. */
    watermark?: number;
    meta?: Record<string, unknown>;
}

/** Server → client, first frame after connect. Transient. */
export interface WelcomeFrame {
    type: "welcome";
    data: {
        protocol: string;
        conversationId: string;
        userId: string;
        connectionId: string;
        /** Current end of history — pass this back as `watermark` when reconnecting. */
        watermark: number;
    };
}

/** Chat bubble (both directions). Persistent. */
export interface TextFrame {
    type: "text";
    id: string;
    seq?: number;
    from: "bot" | "user";
    data: { text: string };
    /** Action chips (HITL questions, suggestions). */
    actions?: MessageAction[];
    timestamp: number;
}

/** Tool activity upsert (match by data.id). Persistent. */
export interface ToolCallFrame {
    type: "tool_call";
    seq?: number;
    data: ToolCall;
}

/** Generative UI chunk. Persistent. */
export interface GenUIFrame {
    type: "genui";
    seq?: number;
    streamId: string;
    chunk: GenUIChunk;
    done: boolean;
}

/** Run/typing status. Transient. */
export interface RunFrame {
    type: "run";
    data: { status: "started" | "finished" };
}

export type Frame = HelloFrame | WelcomeFrame | TextFrame | ToolCallFrame | GenUIFrame | RunFrame;

/** Frame types that get a `seq` and are replayed after reconnect. */
export const PERSISTENT_FRAME_TYPES = ["text", "tool_call", "genui"] as const;

// ── inbound parsing ──────────────────────────────────────────────────────────

export interface IncomingMessage {
    text: string;
    id?: string;
    meta?: Record<string, unknown>;
}

export type Inbound =
    | { kind: "hello"; hello: HelloFrame }
    | { kind: "message"; message: IncomingMessage };

/**
 * Parse anything a transport hands us: a JSON string, a parsed frame object,
 * or plain text. Returns null for empty/unrecognized input.
 */
export function parseIncoming(raw: unknown): Inbound | null {
    let value: unknown = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        } catch {
            const text = raw.trim();
            return text ? { kind: "message", message: { text } } : null;
        }
    }
    if (value === null || typeof value !== "object") return null;
    const frame = value as Record<string, unknown>;
    if (frame.type === "hello") return { kind: "hello", hello: frame as unknown as HelloFrame };

    const data = frame.data as Record<string, unknown> | undefined;
    const text = String(data?.text ?? frame.text ?? "").trim();
    if (!text) return null;
    return {
        kind: "message",
        message: {
            text,
            ...(typeof frame.id === "string" ? { id: frame.id } : {}),
            ...(frame.meta && typeof frame.meta === "object"
                ? { meta: frame.meta as Record<string, unknown> }
                : {}),
        },
    };
}

// ── event → frame mapping ────────────────────────────────────────────────────

export interface FrameMapping {
    frame: Frame;
    persistent: boolean;
}

/**
 * The canonical AgentEvent → wire frame mapping. Pure function — this is the
 * part every language implementation must reproduce byte-compatibly.
 */
export function eventToFrames(ev: AgentEvent, newId: (prefix: string) => string): FrameMapping[] {
    const now = Date.now();
    const text = (t: string, extra: Partial<TextFrame> = {}): TextFrame => ({
        type: "text",
        id: newId("msg"),
        from: "bot",
        data: { text: t },
        timestamp: now,
        ...extra,
    });

    switch (ev.type) {
        case "message":
            return [{ frame: text(ev.text, ev.actions ? { actions: ev.actions } : {}), persistent: true }];
        case "tool_call":
            return [{ frame: { type: "tool_call", data: ev.toolCall }, persistent: true }];
        case "genui":
            return [
                {
                    frame: {
                        type: "genui",
                        streamId: ev.streamId ?? newId("stream"),
                        chunk: ev.chunk,
                        done: ev.done === true,
                    },
                    persistent: true,
                },
            ];
        case "interrupt": {
            const p = (ev.payload ?? {}) as Record<string, unknown> | string;
            const question =
                typeof p === "string"
                    ? p
                    : String(p.question ?? p.message ?? "Your confirmation is needed to continue.");
            const rawOptions =
                typeof p === "object" && Array.isArray(p.options) ? p.options : ["Approve", "Cancel"];
            const actions: MessageAction[] = rawOptions.map((o: unknown) =>
                typeof o === "string" ? { label: o } : (o as MessageAction),
            );
            return [{ frame: text(question, { actions }), persistent: true }];
        }
        case "busy":
            return [
                {
                    frame: text("⏳ Still working on the previous message — one moment."),
                    persistent: false,
                },
            ];
        case "run_started":
            return [{ frame: { type: "run", data: { status: "started" } }, persistent: false }];
        case "run_finished":
            return [{ frame: { type: "run", data: { status: "finished" } }, persistent: false }];
        case "run_error":
            return [
                { frame: text(`⚠️ ${ev.error}`), persistent: true },
                { frame: { type: "run", data: { status: "finished" } }, persistent: false },
            ];
        default:
            return [];
    }
}
