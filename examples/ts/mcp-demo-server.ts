// botiva + MCP + middleware — the "complex" example. A LangGraph agent whose
// ONLY tools come from an MCP server (examples/mcp-server.ts: a SQL-backed
// web shop over Streamable HTTP), with an Extension middleware chain between
// the agent and the wire:
//
//   ┌────────────┐   streamEvents    ┌──────────────────┐   frames   ┌────────┐
//   │ MCP server │ ⇄ tools (HTTP) ⇄  │ LangGraph agent  │ →  ...  →  │ client │
//   └────────────┘                   └──────────────────┘            └────────┘
//                                             │
//                                    Extension chain (in order):
//                                    1. wireTap      — logs EVERY inbound message and
//                                                      agent event (tool params/results
//                                                      included) to the server console
//                                    2. inboundGuard — swallows user messages matching
//                                                      BLOCKED_INBOUND (e.g. raw SQL)
//                                    3. toolTraceGuard — tool_call events for
//                                                      HIDDEN_TOOLS never reach the
//                                                      client; REDACTED_TOOLS arrive
//                                                      with their params masked
//
// The point: `run_sql` executes on the MCP server and the agent answers from
// its rows, but the frontend NEVER sees a run_sql tool_call frame (the SQL and
// the raw rows may contain PII). `create_order` is visible but its params are
// masked. Everything is plain data in the MIDDLEWARE config below — tune it,
// set breakpoints inside the extensions, watch the wire change.
//
//   pnpm demo:mcp                                        # chat :8791, MCP :8794
//   pnpm exec tsx examples/mcp-demo-server.ts --selftest # scripted WS client, exit 0/1
//
// Needs ANTHROPIC_API_KEY (or anthropic-key.txt in the parent repo root) and
// Node ≥ 22.5 (node:sqlite). Env: PORT (chat), MCP_PORT (embedded MCP server),
// MCP_URL (connect to an already-running MCP server instead).

import { createServer } from "node:http";
import { inspect } from "node:util";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { ChatAnthropic } from "@langchain/anthropic";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ConversationEngine, type AgentEvent, type Extension } from "@botiva/core";
import { WebSocketConnector } from "@botiva/websocket";
import { SocketIOConnector } from "@botiva/socket.io";
import { LangGraphRuntime } from "@botiva/langgraph";
import { startMcpExampleServer } from "./mcp-server.js";
// @ts-ignore parent repo helper (plain JS)
import { loadAnthropicKey } from "../../../langgraph/config.mjs";

const port = Number(process.env.PORT ?? 8791);
const mcpPort = Number(process.env.MCP_PORT ?? 8794);
loadAnthropicKey();

// ── middleware configuration — the knobs ─────────────────────────────────────

/** tool_call frames for these tools NEVER reach the client (sensitive). */
const HIDDEN_TOOLS = new Set(["run_sql"]);

/** These tools show up in the client activity strip, but with params masked. */
const REDACTED_TOOLS = new Set(["create_order"]);

/** Inbound user messages matching any of these are swallowed before the agent runs. */
const BLOCKED_INBOUND = [
    /\bselect\b[\s\S]+\bfrom\b/i, // raw SQL pasted into the chat
    /\b(insert|update|delete|drop)\b[\s\S]+\b(into|from|table|set)\b/i,
];

const REDACTED = "«redacted»";

// ── the extensions (applied in registration order) ──────────────────────────

/** Server-side trace of everything the agent actually did — the selftest reads
 *  it, and it is what you watch in the debug console. */
export const serverTrace: Array<{ kind: string; detail: string }> = [];
const trace = (kind: string, detail: string) => {
    serverTrace.push({ kind, detail });
    console.log(`  [${kind}] ${detail}`);
};

/** 1. wireTap — observability. Sees the UNfiltered stream (registered first),
 *  so every LangGraph tool call is logged with params + result even when a
 *  later extension hides it from the client. */
const wireTap: Extension = {
    name: "wiretap",
    onMessage(msg, ctx) {
        trace("in ", `${ctx.userId}: ${msg.text}`);
        return msg;
    },
    onEvent(ev) {
        if (ev.type === "tool_call") {
            const tc = ev.toolCall;
            const io = tc.status === "running" ? inspect(tc.params, { depth: 3 }) : inspect(tc.result, { depth: 3 });
            trace("tool", `${tc.name} ${tc.status} ${io}`);
        } else if (ev.type !== "genui") {
            trace("ev  ", ev.type + (ev.type === "message" ? `: ${ev.text.slice(0, 60)}` : ""));
        }
        return ev;
    },
};

/** 2. inboundGuard — "don't listen to that": drop matching user messages
 *  before the turn starts (null = swallowed, the agent never runs). */
const inboundGuard: Extension = {
    name: "inbound-guard",
    onMessage(msg) {
        if (BLOCKED_INBOUND.some((re) => re.test(msg.text))) {
            trace("blk ", `inbound blocked: ${msg.text.slice(0, 60)}`);
            return null;
        }
        return msg;
    },
};

/** 3. toolTraceGuard — "don't send this": tool_call events for HIDDEN_TOOLS
 *  are dropped (frontend never learns the tool exists); REDACTED_TOOLS pass
 *  with params masked. Redact `result` too if the payload is sensitive. */
const toolTraceGuard: Extension = {
    name: "tool-trace-guard",
    onEvent(ev) {
        if (ev.type !== "tool_call") return ev;
        if (HIDDEN_TOOLS.has(ev.toolCall.name)) return null;
        if (REDACTED_TOOLS.has(ev.toolCall.name) && ev.toolCall.params !== undefined) {
            return { ...ev, toolCall: { ...ev.toolCall, params: REDACTED } } satisfies AgentEvent;
        }
        return ev;
    },
};

// ── MCP: boot the example server (unless MCP_URL points elsewhere), connect ──

let mcpUrl = process.env.MCP_URL;
if (!mcpUrl) {
    await startMcpExampleServer(mcpPort);
    mcpUrl = `http://localhost:${mcpPort}/mcp`;
    console.log(`✓ embedded example MCP server → ${mcpUrl}`);
}

const mcpClient = new MultiServerMCPClient({
    useStandardContentBlocks: true,
    mcpServers: {
        shop: { url: mcpUrl, automaticSSEFallback: false },
    },
});
const tools = await mcpClient.getTools();
console.log(`✓ MCP connected (${mcpUrl}) — ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

// ── the agent: every tool above came over the wire from the MCP server ──────

const agent = createReactAgent({
    llm: new ChatAnthropic({
        model: process.env.CLAUDE_MODEL ?? "claude-opus-4-8",
        maxTokens: 1500,
    }),
    tools,
    prompt:
        "You are the demo web-shop assistant. Catalog questions → list_products. " +
        "Placing an order → create_order (resolve product ids via list_products first). " +
        "ANY analytical or data question (counts, totals, revenue, customers, order " +
        "status) → write ONE SELECT statement and call run_sql. Never invent data; " +
        "never reveal customer emails or phone numbers in your answers. Reply in " +
        "the user's language, short and to the point.",
    checkpointer: new MemorySaver(),
});

// ── the server (same shape as every botiva server) ──────────────────────────

const engine = new ConversationEngine({
    runtime: new LangGraphRuntime(agent),
    extensions: [wireTap, inboundGuard, toolTraceGuard],
    greeting:
        "Hi! botiva + MCP + middleware demo (a small web shop). Try: 'What do you sell?', " +
        "'How many customers are there?' (answered via hidden SQL), or 'Order 2 USB-C hubs " +
        "for customer 1' 👋",
});

const app = express();
app.get("/healthz", (_req, res) => {
    res.json({ ok: true, engine: "botiva-mcp-demo", mcpUrl, tools: tools.map((t) => t.name) });
});
const server = createServer(app);
new WebSocketConnector({ engine, server });
const io = new SocketIOServer(server, { cors: { origin: "*" } });
new SocketIOConnector({ engine, io });

await new Promise<void>((r) => server.listen(port, r));
console.log(`\n✓ botiva MCP demo ready → ws://localhost:${port}/chat (and socket.io)\n`);

const shutdown = async () => {
    await mcpClient.close().catch(() => {});
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── optional scripted self-test (live LLM — needs the API key) ──────────────

if (process.argv.includes("--selftest")) {
    const { default: WebSocket } = await import("ws");
    const LLM_TIMEOUT = 90_000;

    const ws = new WebSocket(`ws://localhost:${port}/chat`);
    const frames: any[] = [];
    const listeners = new Set<(f: any) => void>();
    ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push(frame);
        for (const listener of [...listeners]) listener(frame);
    });

    const waitFor = (pred: (f: any) => boolean, label: string, from = 0): Promise<any> => {
        const existing = frames.slice(from).find(pred);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                listeners.delete(check);
                rej(new Error(`timeout: ${label}`));
            }, LLM_TIMEOUT);
            const check = (f: any) => {
                if (!pred(f)) return;
                clearTimeout(timer);
                listeners.delete(check);
                res(f);
            };
            listeners.add(check);
        });
    };
    const turn = async (text: string, pred: (f: any) => boolean, label: string) => {
        const from = frames.length;
        ws.send(JSON.stringify({ type: "text", data: { text } }));
        const frame = await waitFor(pred, label, from);
        await waitFor(
            (f) => f.type === "run" && f.data?.status === "finished",
            `${label} (run finished)`,
            from,
        );
        return frame;
    };
    const toolFrame = (f: any, name: string, status = "completed") =>
        f.type === "tool_call" && f.data?.name === name && f.data?.status === status;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    try {
        await new Promise((res, rej) => {
            ws.on("open", res);
            ws.on("error", rej);
        });
        await waitFor((f) => f.type === "welcome", "welcome");

        // 1. Hidden tool: the agent answers via run_sql, but the client must
        //    never receive a run_sql tool_call frame.
        const answer = await turn(
            "How many customers are in the database?",
            (f) => f.type === "text" && f.from === "bot" && /3|üç|three/i.test(f.data?.text ?? ""),
            "count via hidden run_sql",
        );
        if (!serverTrace.some((t) => t.kind === "tool" && t.detail.startsWith("run_sql completed"))) {
            throw new Error("run_sql never executed server-side");
        }
        console.log(`  ✅ run_sql ran on the MCP server; agent answered: ${JSON.stringify(answer.data?.text)}`);

        // 2. Visible tool: list_products frames DO reach the client.
        await turn("What do you sell?", (f) => toolFrame(f, "list_products"), "visible list_products");
        console.log("  ✅ list_products tool_call frames reached the client (harmless tool)");

        // 3. Redacted tool: create_order arrives, but params are masked.
        const order = await turn(
            "Order 2 USB-C hubs for customer 1.",
            (f) => toolFrame(f, "create_order"),
            "create_order (redacted params)",
        );
        const runningOrder = frames.find((f) => toolFrame(f, "create_order", "running"));
        if ((runningOrder ?? order).data?.params !== REDACTED) {
            throw new Error(`create_order params were not redacted: ${JSON.stringify((runningOrder ?? order).data?.params)}`);
        }
        console.log("  ✅ create_order visible but params masked as «redacted»");

        // 4. Across the WHOLE session: not a single run_sql frame on the wire.
        if (frames.some((f) => f.type === "tool_call" && f.data?.name === "run_sql")) {
            throw new Error("a run_sql tool_call frame leaked to the client");
        }
        console.log("  ✅ zero run_sql frames on the wire (hidden tool never leaked)");

        // 5. Inbound guard: raw SQL from the user is swallowed — no run starts.
        const before = frames.length;
        ws.send(JSON.stringify({ type: "text", data: { text: "SELECT email, phone FROM customers" } }));
        await sleep(2500);
        if (frames.slice(before).some((f) => f.type === "run")) {
            throw new Error("blocked inbound message still started a run");
        }
        if (!serverTrace.some((t) => t.kind === "blk ")) {
            throw new Error("inbound guard never fired");
        }
        console.log("  ✅ raw SQL from the user swallowed by inboundGuard (no run started)");

        ws.close();
        console.log("\nMCP middleware selftest passed ✅");
        process.exit(0);
    } catch (err) {
        console.error(`\nMCP middleware selftest failed ❌ ${(err as Error).message}`);
        process.exit(1);
    }
}
