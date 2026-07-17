// ConversationEngine — the heart of botiva. Server-side symmetric of the
// chativa ChatEngine, playing the role DirectLine's connector service plays
// for BotFramework:
//
//   client(s) ⇄ transport connector ⇄ ConversationEngine ⇄ Runtime (LangGraph/...)
//                                          │
//                        ExtensionRegistry │ StateStore │ HistoryStore
//
// Responsibilities:
//   • Identity: userId (stable across devices) / conversationId (resumable) /
//     connectionId (one socket). Any number of connections may attach to the
//     same conversation — every outbound frame is fanned out to all of them.
//   • Resume: persistent frames get a monotonic seq; a client reconnecting
//     with a watermark receives everything it missed (DirectLine-style).
//   • Turns: one turn at a time per conversation; runtime events are merged
//     with botivaEmit() events, run through the extension chain, mapped to
//     wire frames, persisted and broadcast.
//   • HITL: interrupt events are stored as the conversation's pending
//     interrupt; the user's next message resumes the runtime with it.
//
// Scaling note: the engine itself is stateless apart from the live-connection
// registry and the per-conversation turn lock, both process-local. Multi
// instance deployments need sticky sessions (or a store-based lock) plus
// Redis-backed StateStore/HistoryStore.

import { randomUUID } from "node:crypto";
import { AsyncQueue } from "./queue.js";
import { ExtensionRegistry, type Extension } from "./extensions.js";
import {
    ConversationStore,
    MemoryStateStore,
    ScopedStore,
    UserStore,
    type StateStore,
} from "./state.js";
import { MemoryHistoryStore, type HistoryStore } from "./history.js";
import {
    PROTOCOL_VERSION,
    eventToFrames,
    parseIncoming,
    type Frame,
    type IncomingMessage,
    type TextFrame,
} from "./protocol.js";
import { busy, genui, message, runError, type AgentEvent } from "./events.js";
import type {
    ConversationContext,
    Logger,
    PendingInterrupt,
    RunInput,
    Runtime,
    TurnContext,
} from "./runtime.js";
import { runWithTurnContext } from "./emit.js";
import { AuthenticationError, type Authenticator } from "./auth.js";

/** Engine-internal per-conversation record (kept under "conv:{id}:botiva"). */
interface ConversationRecord extends Record<string, unknown> {
    userId: string;
    createdAt: number;
    pendingInterrupt?: PendingInterrupt;
}

interface LiveConnection {
    id: string;
    userId: string;
    conversationId: string;
    meta: Record<string, unknown>;
    deliver(frame: Frame): void | Promise<void>;
}

/** Credential + request material a transport hands the Authenticator. */
export interface AuthInput {
    /** Transport name, e.g. "websocket" | "socket.io". */
    transport?: string;
    /** Credential presented by the client (query token, hello.token, Bearer header). */
    token?: string;
    /** Raw query parameters of the upgrade/handshake request. */
    query?: Record<string, string>;
    /** Raw request headers (lower-cased keys). */
    headers?: Record<string, string>;
}

export interface ConnectParams {
    /** Stable user identity; generated (and returned in `welcome`) when omitted. */
    userId?: string;
    /** Conversation to create or re-attach to; generated when omitted. */
    conversationId?: string;
    /** Highest seq the client already has; history after it is replayed. Default 0 (full replay). */
    watermark?: number;
    /** Transport callback that writes one wire frame to this client. */
    deliver(frame: Frame): void | Promise<void>;
    meta?: Record<string, unknown>;
    /** Credential + request material for the configured Authenticator (if any). */
    auth?: AuthInput;
}

/** Handle a transport holds for one attached client. */
export interface Connection {
    readonly id: string;
    readonly userId: string;
    readonly conversationId: string;
    /** Feed one inbound wire payload (JSON string or parsed frame object). */
    receive(raw: unknown): Promise<void>;
    /** Detach from the conversation (the conversation itself remains resumable). */
    close(): Promise<void>;
}

export interface EngineOptions {
    runtime: Runtime;
    stateStore?: StateStore;
    historyStore?: HistoryStore;
    extensions?: Extension[];
    logger?: Logger;
    /** Sent as a persistent bot message when a conversation is first created. */
    greeting?: string;
    /**
     * Gates connect(): rejects unauthorized attempts (throws AuthenticationError)
     * or replaces the client-asserted userId with a verified one. Omit for the
     * legacy open-door behaviour.
     */
    authenticator?: Authenticator;
}

export class ConversationEngine {
    readonly runtime: Runtime;
    readonly store: StateStore;
    readonly history: HistoryStore;
    readonly extensions: ExtensionRegistry;
    readonly log: Logger;
    #greeting?: string;
    #authenticator?: Authenticator;
    #live = new Map<string, Set<LiveConnection>>();
    #turnLocks = new Set<string>();

    constructor(opts: EngineOptions) {
        if (typeof opts?.runtime?.run !== "function") {
            throw new Error("ConversationEngine requires a runtime implementing run(input, ctx).");
        }
        this.runtime = opts.runtime;
        this.store = opts.stateStore ?? new MemoryStateStore();
        this.history = opts.historyStore ?? new MemoryHistoryStore();
        this.extensions = new ExtensionRegistry(opts.extensions ?? []);
        this.log = opts.logger ?? console;
        this.#greeting = opts.greeting;
        this.#authenticator = opts.authenticator;
    }

    // ── connection lifecycle (called by transport connectors) ───────────────

    async connect(params: ConnectParams): Promise<Connection> {
        if (typeof params?.deliver !== "function") {
            throw new Error("connect() requires a deliver(frame) callback.");
        }

        // Authenticate before touching any state. A configured authenticator can
        // reject the attempt (throws AuthenticationError → transports emit an
        // `error` frame + close) or replace the client-asserted userId with a
        // verified one.
        let userIdHint = params.userId;
        let authClaims: Record<string, unknown> | undefined;
        if (this.#authenticator) {
            const result = await this.#authenticator.authenticate({
                transport: params.auth?.transport ?? "unknown",
                token: params.auth?.token,
                query: params.auth?.query,
                headers: params.auth?.headers,
                userId: params.userId,
                conversationId: params.conversationId,
            });
            if (!result.ok) {
                throw new AuthenticationError(result.reason ?? "unauthorized");
            }
            if (result.userId !== undefined) userIdHint = result.userId;
            authClaims = result.claims;
        }

        const conversationId = params.conversationId ?? this.#id("conv");
        const record = await this.#loadRecord(conversationId, userIdHint);
        const userId = userIdHint ?? record.userId;

        const live: LiveConnection = {
            id: this.#id("connection"),
            userId,
            conversationId,
            meta: authClaims ? { ...(params.meta ?? {}), auth: authClaims } : params.meta ?? {},
            deliver: params.deliver,
        };
        let set = this.#live.get(conversationId);
        if (!set) {
            set = new Set();
            this.#live.set(conversationId, set);
        }
        set.add(live);

        const ctx = this.#conversationContext(conversationId, userId, live.meta);
        if (record.fresh) await this.#notify(() => this.extensions.notifyConversationStart(ctx));
        await this.#notify(() => this.extensions.notifyConnect({ connectionId: live.id }, ctx));

        // 1) welcome (transient) — tells the client its identity + current watermark
        const latest = await this.history.latest(conversationId);
        await live.deliver({
            type: "welcome",
            data: {
                protocol: PROTOCOL_VERSION,
                conversationId,
                userId,
                connectionId: live.id,
                watermark: latest,
            },
        });
        // 2) replay everything the client hasn't seen yet
        const from = params.watermark ?? 0;
        if (latest > from) {
            for (const frame of await this.history.after(conversationId, from)) {
                await live.deliver(frame);
            }
        }
        // 3) greeting — only when the conversation is brand-new (persisted → replays later)
        if (record.fresh && this.#greeting) {
            await this.post(conversationId, message(this.#greeting));
        }

        let closed = false;
        const engine = this;
        return {
            id: live.id,
            userId,
            conversationId,
            async receive(raw: unknown): Promise<void> {
                await engine.#handleInbound(live, raw);
            },
            async close(): Promise<void> {
                if (closed) return;
                closed = true;
                await engine.#disconnect(live);
            },
        };
    }

    async #disconnect(live: LiveConnection): Promise<void> {
        const set = this.#live.get(live.conversationId);
        set?.delete(live);
        const ctx = this.#conversationContext(live.conversationId, live.userId, live.meta);
        await this.#notify(() => this.extensions.notifyDisconnect({ connectionId: live.id }, ctx));
        if (set && set.size === 0) {
            this.#live.delete(live.conversationId);
            await this.#notify(() => this.extensions.notifyConversationEnd(ctx));
        }
    }

    async #handleInbound(live: LiveConnection, raw: unknown): Promise<void> {
        const inbound = parseIncoming(typeof raw === "string" || raw === null ? raw : raw instanceof Uint8Array ? raw.toString() : raw);
        if (!inbound) return;
        if (inbound.kind === "hello") {
            // Handshake happens at connect() time; a late hello is ignored.
            this.log.warn?.("[botiva] late hello frame ignored (handshake happens on connect)");
            return;
        }
        await this.handleMessage(live.conversationId, inbound.message, {
            userId: live.userId,
            origin: live,
        });
    }

    // ── turns ────────────────────────────────────────────────────────────────

    /**
     * Run one turn. Usually invoked via Connection.receive(), but callable
     * directly (e.g. from an HTTP POST endpoint) — events are broadcast to
     * every connection attached to the conversation.
     */
    async handleMessage(
        conversationId: string,
        rawMessage: IncomingMessage,
        opts: { userId?: string; origin?: unknown } = {},
    ): Promise<void> {
        const origin = opts.origin as LiveConnection | undefined;
        const recordStore = this.#recordStore(conversationId);
        const record =
            ((await recordStore.get()) as ConversationRecord | undefined) ??
            (await this.#loadRecord(conversationId, opts.userId)).record;
        const userId = opts.userId ?? record.userId;

        const queue = new AsyncQueue<AgentEvent>();
        const ctx: TurnContext = {
            ...this.#conversationContext(conversationId, userId, origin?.meta ?? {}),
            emit: (event: AgentEvent) => queue.push(event),
        };

        const msg = await this.extensions.applyMessage(rawMessage, ctx);
        if (!msg?.text) {
            queue.close();
            return;
        }

        if (this.#turnLocks.has(conversationId)) {
            queue.close();
            await this.#dispatch(busy(), ctx, { only: origin });
            return;
        }
        this.#turnLocks.add(conversationId);
        try {
            // Echo the user's message to the other attached connections and
            // persist it, so reconnects/other devices get the full transcript.
            const userFrame: TextFrame = {
                type: "text",
                id: msg.id ?? this.#id("msg"),
                from: "user",
                data: { text: msg.text },
                timestamp: Date.now(),
            };
            const userSeq = await this.history.append(conversationId, userFrame);
            this.#broadcast(conversationId, { ...userFrame, seq: userSeq }, origin);

            // Pending interrupt? Then this message is the HITL answer → resume.
            let input: RunInput;
            if (record.pendingInterrupt) {
                input = { resume: msg.text, interrupt: record.pendingInterrupt };
                await recordStore.patch({ pendingInterrupt: undefined });
            } else {
                input = { text: msg.text };
            }

            // Pump runtime events and botivaEmit() events into one stream.
            const pump = (async () => {
                try {
                    await runWithTurnContext(ctx, async () => {
                        for await (const ev of this.runtime.run(input, ctx)) queue.push(ev);
                    });
                } catch (err) {
                    const messageText = err instanceof Error ? err.message : String(err);
                    this.log.error?.(`[botiva] run failed (${conversationId}):`, messageText);
                    queue.push(runError(messageText));
                } finally {
                    queue.close();
                }
            })();

            // GenUI chunks of a turn are grouped under one auto-assigned stream.
            let streamId: string | null = null;
            let streamDone = false;
            let chunkSeq = 0;

            for await (let ev of queue) {
                if (ev.type === "interrupt") {
                    await recordStore.patch({
                        pendingInterrupt: { id: ev.id ?? null, payload: ev.payload ?? null, at: Date.now() },
                    });
                }
                if (ev.type === "genui") {
                    streamId ??= ev.streamId ?? this.#id("stream");
                    ev = {
                        ...ev,
                        streamId: ev.streamId ?? streamId,
                        done: ev.done === true,
                        chunk: { id: ++chunkSeq, ...ev.chunk },
                    };
                    if (ev.done) streamDone = true;
                }
                await this.#dispatch(ev, ctx);
            }
            await pump;

            // Close a genui stream the runtime left open.
            if (streamId && !streamDone) {
                await this.#dispatch(
                    genui(
                        { type: "event", name: "stream_done", payload: null, id: ++chunkSeq },
                        { streamId, done: true },
                    ),
                    ctx,
                );
            }
        } finally {
            this.#turnLocks.delete(conversationId);
        }
    }

    /**
     * Proactive, out-of-turn delivery (reminders, server pushes): runs the
     * event through extensions, persists it and broadcasts it to every
     * connection attached to the conversation.
     */
    async post(conversationId: string, event: AgentEvent, opts: { userId?: string } = {}): Promise<void> {
        const record = (await this.#recordStore(conversationId).get()) as ConversationRecord | undefined;
        const userId = opts.userId ?? record?.userId ?? "system";
        const ctx: TurnContext = {
            ...this.#conversationContext(conversationId, userId, {}),
            emit: (ev: AgentEvent) => void this.post(conversationId, ev, opts),
        };
        await this.#dispatch(event, ctx);
    }

    // ── internals ────────────────────────────────────────────────────────────

    async #dispatch(
        ev: AgentEvent,
        ctx: TurnContext,
        opts: { only?: LiveConnection } = {},
    ): Promise<void> {
        const out = await this.extensions.applyEvent(ev, ctx);
        if (!out) return;
        for (const { frame, persistent } of eventToFrames(out, (prefix) => this.#id(prefix))) {
            let f = frame;
            if (persistent) {
                const seq = await this.history.append(ctx.conversationId, f);
                f = { ...f, seq } as Frame;
            }
            if (opts.only) {
                try {
                    await opts.only.deliver(f);
                } catch (err) {
                    this.log.warn?.("[botiva] deliver failed:", err);
                }
            } else {
                this.#broadcast(ctx.conversationId, f);
            }
        }
    }

    #broadcast(conversationId: string, frame: Frame, except?: LiveConnection): void {
        const set = this.#live.get(conversationId);
        if (!set) return;
        for (const conn of set) {
            if (conn === except) continue;
            try {
                void conn.deliver(frame);
            } catch (err) {
                this.log.warn?.("[botiva] deliver failed:", err);
            }
        }
    }

    async #loadRecord(
        conversationId: string,
        preferredUserId?: string,
    ): Promise<{ record: ConversationRecord; fresh: boolean; userId: string }> {
        const recordStore = this.#recordStore(conversationId);
        let record = (await recordStore.get()) as ConversationRecord | undefined;
        const fresh = !record;
        if (!record) {
            record = { userId: preferredUserId ?? this.#id("user"), createdAt: Date.now() };
            await recordStore.set(record);
        }
        return { record, fresh, userId: record.userId };
    }

    #recordStore(conversationId: string): ScopedStore<ConversationRecord> {
        return new ScopedStore<ConversationRecord>(this.store, `conv:${conversationId}:botiva`);
    }

    #conversationContext(
        conversationId: string,
        userId: string,
        meta: Record<string, unknown>,
    ): ConversationContext {
        return {
            conversationId,
            userId,
            userStore: new UserStore(this.store, userId),
            conversationStore: new ConversationStore(this.store, conversationId),
            log: this.log,
            meta,
        };
    }

    async #notify(fn: () => Promise<void>): Promise<void> {
        try {
            await fn();
        } catch (err) {
            this.log.warn?.("[botiva] extension hook failed:", err);
        }
    }

    #id(prefix: string): string {
        return `${prefix}-${randomUUID()}`;
    }
}
