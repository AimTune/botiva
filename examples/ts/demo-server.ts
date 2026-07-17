// botiva demo — REAL LLM (Claude) + LangGraph, served over BOTH transports at
// once: raw WebSocket (/chat) and Socket.IO (event "botiva"). One engine, one
// conversation space — a client may attach over either transport and even mix
// them across tabs/devices.
//
//   npm run demo          # → http://localhost:8790
//
// Try (in the chativa widget or any Botiva Protocol client):
//   1) "How touristic was Lisbon in 2025?"
//        → list_cities + get_city_stats stream into the activity strip
//   2) "Generate the PDF guide"
//        → generate_report_pdf pauses via LangGraph interrupt(), approval chips appear
//   3) "Approve" → the tool resumes and a GenUI download card drops in
//   4) "What's the weather in Istanbul?"
//        → get_weather renders the client-registered "weather" component
//
// Deterministic, LLM-free test: npm run smoke

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { ConversationEngine, type Extension } from "@botiva/core";
import { WebSocketConnector } from "@botiva/websocket";
import { SocketIOConnector } from "@botiva/socket.io";
import { LangGraphRuntime } from "@botiva/langgraph";
// @ts-ignore parent repo helper (plain JS)
import { loadAnthropicKey } from "../../../langgraph/config.mjs";
import { buildDemoAgent } from "./demo-agent.js";

const port = Number(process.env.PORT ?? 8790);

loadAnthropicKey();
const agent = buildDemoAgent();

// Example extension: log every message/event (telemetry/tracing skeleton).
const loggingExtension: Extension = {
    name: "logging",
    onMessage(msg, ctx) {
        console.log(`  → [${ctx.conversationId.slice(0, 13)}] ${ctx.userId.slice(0, 12)}: ${msg.text}`);
        return msg;
    },
    onEvent(ev, ctx) {
        const detail = ev.type === "tool_call" ? `:${ev.toolCall.name}(${ev.toolCall.status})` : "";
        console.log(`  ← [${ctx.conversationId.slice(0, 13)}] ${ev.type}${detail}`);
        return ev;
    },
};

const engine = new ConversationEngine({
    runtime: new LangGraphRuntime(agent),
    extensions: [loggingExtension],
    greeting:
        "Hi! botiva demo (Claude + LangGraph). Try: 'How touristic was Lisbon in 2025?' — then 'Generate the PDF guide' to test the HITL approval 👋",
});

const app = express();
app.use(express.static(fileURLToPath(new URL("../../../web", import.meta.url))));
app.get("/healthz", (_req, res) => {
    res.json({ ok: true, engine: "botiva-demo-llm", transports: ["websocket:/chat", "socket.io"] });
});

const server = createServer(app);

// Transport 1: raw WebSocket at /chat
new WebSocketConnector({ engine, server });
// Transport 2: Socket.IO on the same HTTP server (frames on the "botiva" event)
const io = new SocketIOServer(server, { cors: { origin: "*" } });
new SocketIOConnector({ engine, io });

server.listen(port, () => {
    console.log(`\n✓ botiva demo (LLM) ready → http://localhost:${port}`);
    console.log(`  ws:        ws://localhost:${port}/chat`);
    console.log(`  socket.io: http://localhost:${port} (event: "botiva")\n`);
});
