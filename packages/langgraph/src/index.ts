// LangGraphRuntime — plugs any compiled LangGraph graph (e.g. the output of
// createReactAgent) into the botiva Runtime port.
//
//   streamEvents v2           → tool_call / message events
//   LangGraph interrupt()     → botiva interrupt event (HITL)
//   Command({ resume })       → resumes the paused run with the user's answer
//   dispatchCustomEvent("genui", { component, props })
//                             → genui event (client GenUIRegistry component)
//
// Inside graph nodes/tools you can also use the botiva context directly:
//
//   import { botivaEmit, botivaContext, ui } from "@botiva/core";
//   // inside any node/tool executed during a turn:
//   botivaEmit(ui("weather-card", { temp: 22 }));
//   const ctx = botivaContext();       // conversationId, userId, stores...
//
//   // or explicitly, without AsyncLocalStorage (works in every language):
//   const myNode = async (state, config) => {
//       const botiva = config.configurable?.botiva;   // TurnContext
//       botiva?.emit(ui("weather-card", { temp: 22 }));
//   };
//
// Tracing/customization: pass LangChain callbacks/tags/metadata via
// opts.config — e.g. a LangSmith tracer — and they apply to every run.
//
// Requirement: compile the graph with a checkpointer (MemorySaver, or
// @langchain/langgraph-checkpoint-redis at scale). thread_id = conversationId.

import { Command } from "@langchain/langgraph";
import {
    genui,
    interrupt as interruptEvent,
    message,
    runError,
    runFinished,
    runStarted,
    toolCall,
    type AgentEvent,
    type GenUIChunk,
    type RunInput,
    type Runtime,
    type TurnContext,
} from "@botiva/core";

/** Structural view of a compiled LangGraph — keeps the peer surface minimal. */
export interface CompiledGraphLike {
    streamEvents(input: unknown, config: Record<string, unknown>): AsyncIterable<StreamEvent>;
    getState(config: Record<string, unknown>): Promise<GraphStateLike | undefined>;
}

interface StreamEvent {
    event: string;
    name?: string;
    run_id?: string;
    data?: Record<string, unknown>;
}

interface GraphStateLike {
    tasks?: Array<{ interrupts?: Array<{ id?: string; value?: unknown }> }>;
}

export interface LangGraphRuntimeOptions {
    recursionLimit?: number;
    /** Emit tool_call events for the client activity strip. Default true. */
    toolTrace?: boolean;
    /**
     * Extra RunnableConfig merged into every run — callbacks (LangSmith/custom
     * tracers), tags, metadata, configurable entries...
     */
    config?: Record<string, unknown>;
}

function messageText(msg: unknown): string {
    const content = (msg as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((block): block is { type: string; text: string } => block?.type === "text")
            .map((block) => block.text)
            .join("\n");
    }
    return "";
}

function short(value: unknown, max = 600): string {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s && s.length > max ? s.slice(0, max) + "…" : (s ?? "");
}

// interrupt() throws GraphInterrupt inside a tool; streamEvents surfaces it
// inconsistently in on_tool_error: sometimes an Error object (whose name is
// not always "GraphInterrupt"), sometimes the interrupt payload as a JSON
// string. Recognize all shapes: name/type check + interrupt-JSON sniffing.
function isInterruptError(err: unknown): boolean {
    if (!err) return false;
    const name = String(
        (err as { name?: string }).name ?? (err as object)?.constructor?.name ?? "",
    );
    if (/interrupt/i.test(name)) return true;
    const texts = [
        typeof err === "string" ? err : "",
        String((err as { message?: string }).message ?? ""),
        String(err),
    ];
    if (texts.some((t) => /GraphInterrupt|NodeInterrupt/.test(t))) return true;
    for (const t of texts) {
        if (!t) continue;
        try {
            const parsed = JSON.parse(t) as unknown;
            if (
                Array.isArray(parsed) &&
                parsed.length > 0 &&
                parsed.every(
                    (item) => item && typeof item === "object" && ("value" in item || "id" in item),
                )
            ) {
                return true;
            }
        } catch {
            /* not interrupt JSON */
        }
    }
    return false;
}

export class LangGraphRuntime implements Runtime {
    readonly graph: CompiledGraphLike;
    readonly recursionLimit: number;
    readonly toolTrace: boolean;
    readonly config: Record<string, unknown>;

    constructor(graph: CompiledGraphLike, opts: LangGraphRuntimeOptions = {}) {
        this.graph = graph;
        this.recursionLimit = opts.recursionLimit ?? 25;
        this.toolTrace = opts.toolTrace ?? true;
        this.config = opts.config ?? {};
    }

    async *run(input: RunInput, ctx: TurnContext): AsyncGenerator<AgentEvent> {
        const config: Record<string, unknown> = {
            ...this.config,
            version: "v2",
            recursionLimit: this.recursionLimit,
            configurable: {
                ...((this.config.configurable as Record<string, unknown>) ?? {}),
                thread_id: ctx.conversationId,
                botiva: ctx, // explicit TurnContext for nodes/tools (config.configurable.botiva)
            },
        };
        // resume → continue the paused run via Command; otherwise a fresh user message.
        const payload =
            input.resume !== undefined
                ? new Command({ resume: input.resume })
                : { messages: [{ role: "user", content: input.text }] };

        yield runStarted();
        let finalMessage: unknown = null;
        // Fallback for graphs without a chat model (deterministic StateGraphs):
        // the last AI message of the graph's own output state.
        let graphOutputMessage: unknown = null;
        // interrupt() fires in the MIDDLE of a tool: its on_tool_end never
        // arrives. Track open calls so the client spinner doesn't hang.
        const openToolCalls = new Map<string, string>(); // run_id → name

        for await (const ev of this.graph.streamEvents(payload, config)) {
            switch (ev.event) {
                case "on_custom_event": {
                    if (ev.name !== "genui" || !ev.data) break;
                    const d = ev.data as { type?: GenUIChunk["type"]; component?: string; props?: Record<string, unknown> };
                    // Either a full AIChunk or the {component, props} shorthand.
                    const chunk: GenUIChunk = d.type
                        ? (d as GenUIChunk)
                        : { type: "ui", component: d.component ?? "unknown", props: d.props ?? {} };
                    yield genui(chunk); // engine groups chunks & closes the stream
                    break;
                }
                case "on_tool_start":
                    if (ev.run_id) openToolCalls.set(ev.run_id, ev.name ?? "tool");
                    if (this.toolTrace) {
                        yield toolCall(ev.run_id ?? "tool", ev.name ?? "tool", "running", {
                            params: ev.data?.input,
                            startedAt: Date.now(),
                        });
                    }
                    break;
                case "on_tool_end":
                    if (ev.run_id) openToolCalls.delete(ev.run_id);
                    if (this.toolTrace) {
                        const output = ev.data?.output as { content?: unknown } | undefined;
                        yield toolCall(ev.run_id ?? "tool", ev.name ?? "tool", "completed", {
                            result: short(messageText(output) || output?.content) || "(empty result)",
                            endedAt: Date.now(),
                        });
                    }
                    break;
                case "on_tool_error": {
                    if (ev.run_id) openToolCalls.delete(ev.run_id);
                    if (!this.toolTrace) break;
                    // GraphInterrupt is not an error — it's the HITL pause.
                    const err = ev.data?.error;
                    yield isInterruptError(err)
                        ? toolCall(ev.run_id ?? "tool", ev.name ?? "tool", "completed", {
                              result: "⏸ waiting for user approval",
                              endedAt: Date.now(),
                          })
                        : toolCall(ev.run_id ?? "tool", ev.name ?? "tool", "error", {
                              error: String((err as Error)?.message ?? err ?? "tool error"),
                              endedAt: Date.now(),
                          });
                    break;
                }
                case "on_chat_model_end":
                    finalMessage = ev.data?.output;
                    break;
                case "on_chain_end": {
                    const messages = (ev.data?.output as { messages?: unknown[] } | undefined)?.messages;
                    if (Array.isArray(messages) && messages.length > 0) {
                        graphOutputMessage = messages[messages.length - 1];
                    }
                    break;
                }
            }
        }

        // Did the graph stop on interrupt()? Then a pending task sits in the checkpoint → HITL.
        const state = await this.graph.getState({
            configurable: { thread_id: ctx.conversationId },
        });
        const pending = (state?.tasks ?? []).flatMap((task) => task.interrupts ?? []);
        if (pending.length > 0) {
            if (this.toolTrace) {
                for (const [runId, name] of openToolCalls) {
                    yield toolCall(runId, name, "completed", {
                        result: "⏸ waiting for user approval",
                        endedAt: Date.now(),
                    });
                }
            }
            const first = pending[0]!;
            yield interruptEvent(first.value ?? first, first.id ?? null);
            yield runFinished();
            return;
        }

        const text = (messageText(finalMessage) || messageText(graphOutputMessage)).trim();
        if (text) yield message(text);
        else yield runError("empty response");
        yield runFinished();
    }
}
