// Hand-built LangGraph StateGraph + Claude on botiva — the LLM-powered version
// of the pattern this framework was designed around. Unlike demo-server.ts
// (which uses the prebuilt createReactAgent), the graph here is wired by hand:
//
//   START → agent ⇄ tools → END          (agent = ChatAnthropic with bound tools)
//
// and shows every botiva context pattern in real agent code:
//
//   • agent node reads UserStore via config.configurable.botiva (the explicit,
//     portable pattern — identical in the Go/.NET/Python ports) and injects
//     what it knows about the user into the system prompt,
//   • remember_name tool writes UserStore via botivaContext() (ambient),
//   • get_weather tool pushes a GenUI card via botivaEmit(ui(...)) (ambient),
//   • generate_report_pdf pauses with interrupt() → approval chips in the
//     client; "Approve" resumes the tool via Command({ resume }).
//
//   pnpm demo:graph                       # server on :8792 (ws + socket.io)
//   pnpm exec tsx examples/langgraph-server.ts --selftest   # live LLM check
//
// Needs ANTHROPIC_API_KEY (or anthropic-key.txt in the parent repo root).
// For the deterministic, LLM-free end-to-end test use `pnpm smoke` instead.

import { createServer } from "node:http";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { ChatAnthropic } from "@langchain/anthropic";
import { SystemMessage, type AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { END, interrupt, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import {
    botivaContext,
    botivaEmit,
    ConversationEngine,
    ui,
    type TurnContext,
} from "@botiva/core";
import { WebSocketConnector } from "@botiva/websocket";
import { SocketIOConnector } from "@botiva/socket.io";
import { LangGraphRuntime } from "@botiva/langgraph";
// @ts-ignore parent repo helper (plain JS)
import { loadAnthropicKey } from "../../../langgraph/config.mjs";

const port = Number(process.env.PORT ?? 8792);
loadAnthropicKey();

// ── tools — botivaEmit / botivaContext / interrupt() inside real tools ──────

const getWeather = tool(
    async ({ city }: { city: string }) => {
        const seed = [...city].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        const data = {
            city,
            temp: 12 + (seed % 20),
            condition: ["Sunny", "Partly Cloudy", "Rainy"][seed % 3],
            humidity: 40 + (seed % 40),
        };
        // Ambient emit — the framework knows which conversation/user this
        // turn belongs to; no plumbing through the graph.
        botivaEmit(ui("weather", data));
        return JSON.stringify(data);
    },
    {
        name: "get_weather",
        description: "Returns a city's weather and shows a weather card in the chat.",
        schema: z.object({ city: z.string().describe("e.g. Istanbul") }),
    },
);

const rememberName = tool(
    async ({ name }: { name: string }) => {
        // Ambient TurnContext inside a tool: write UserStore — this survives
        // across conversations and devices for the same userId.
        const ctx = botivaContext();
        await ctx?.userStore.patch({ name });
        return `Saved. The user's name is ${name} (persisted for user ${ctx?.userId ?? "?"}).`;
    },
    {
        name: "remember_name",
        description: "Stores the user's name in their permanent profile (UserStore).",
        schema: z.object({ name: z.string() }),
    },
);

const generateReportPdf = tool(
    async ({ topic }: { topic: string }) => {
        // Human approval: the run pauses here (written to the checkpoint);
        // the user's next message returns via Command({ resume }).
        const answer = interrupt({
            question: `Generate the "${topic}" report as PDF?`,
            options: ["Approve", "Cancel"],
        });
        if (!/approve|yes|onay|evet/i.test(String(answer))) {
            return "The user declined — no report was generated.";
        }
        const fileName = `report-${topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`;
        botivaEmit(
            ui("genui-card", {
                title: `📄 ${fileName}`,
                description: `"${topic}" report is ready.`,
                actions: [{ label: "⬇️ Download", value: `download ${fileName}` }],
            }),
        );
        return `Report ready: ${fileName} (download card shown).`;
    },
    {
        name: "generate_report_pdf",
        description: "Generates a report PDF on a topic (asks the user for approval first).",
        schema: z.object({ topic: z.string() }),
    },
);

const tools = [getWeather, rememberName, generateReportPdf];

// ── the graph (hand-built — no createReactAgent) ────────────────────────────

const llm = new ChatAnthropic({
    model: process.env.CLAUDE_MODEL ?? "claude-opus-4-8",
    maxTokens: 1500,
}).bindTools(tools);

type GraphState = typeof MessagesAnnotation.State;

/** Agent node — reads UserStore through the portable config path. */
async function agentNode(state: GraphState, config?: { configurable?: { botiva?: TurnContext } }) {
    const botiva = config?.configurable?.botiva;
    const user = ((await botiva?.userStore.get()) ?? {}) as { name?: string };
    const system = new SystemMessage(
        [
            "You are the botiva LangGraph demo assistant.",
            "When the user tells you their name, ALWAYS call remember_name.",
            "For weather questions ALWAYS call get_weather; the card is shown automatically, so answer in one short sentence without repeating the numbers.",
            "If the user asks for a PDF/report, call generate_report_pdf directly WITHOUT asking for confirmation — the tool asks for approval itself.",
            user.name
                ? `You already know this user: their name is ${user.name} (from UserStore, it survives across conversations).`
                : "",
            "Reply in the user's language, short and to the point.",
        ]
            .filter(Boolean)
            .join(" "),
    );
    const response = await llm.invoke([system, ...state.messages]);
    return { messages: [response] };
}

const route = (state: GraphState) => {
    const last = state.messages.at(-1) as AIMessage | undefined;
    return last?.tool_calls?.length ? "tools" : END;
};

const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", route, ["tools", END])
    .addEdge("tools", "agent")
    .compile({ checkpointer: new MemorySaver() });

// ── the server (same shape as every botiva server) ──────────────────────────

const engine = new ConversationEngine({
    runtime: new LangGraphRuntime(graph),
    greeting:
        "Hi! Hand-built LangGraph + Claude demo. Try: 'My name is Ada', 'What's the weather in Istanbul?', or 'Generate a PDF report about street food' 👋",
});

const app = express();
app.get("/healthz", (_req, res) => {
    res.json({ ok: true, engine: "botiva-langgraph-llm-demo" });
});
const server = createServer(app);
new WebSocketConnector({ engine, server });
const io = new SocketIOServer(server, { cors: { origin: "*" } });
new SocketIOConnector({ engine, io });

await new Promise<void>((resolve) => server.listen(port, resolve));
console.log(`\n✓ botiva LangGraph demo (LLM) ready → ws://localhost:${port}/chat (and socket.io)\n`);

// ── optional scripted self-test (live LLM — needs the API key) ──────────────

if (process.argv.includes("--selftest")) {
    const { default: WebSocket } = await import("ws");
    const LLM_TIMEOUT = 90_000;

    class Client {
        frames: any[] = [];
        #listeners = new Set<(f: any) => void>();
        #ws: InstanceType<typeof WebSocket>;

        constructor(query = "") {
            this.#ws = new WebSocket(`ws://localhost:${port}/chat${query}`);
            this.#ws.on("message", (raw) => {
                const frame = JSON.parse(raw.toString());
                this.frames.push(frame);
                for (const listener of [...this.#listeners]) listener(frame);
            });
        }

        open() {
            return new Promise((resolve, reject) => {
                this.#ws.on("open", resolve);
                this.#ws.on("error", reject);
            });
        }

        send(text: string) {
            this.#ws.send(JSON.stringify({ type: "text", data: { text } }));
        }

        close() {
            this.#ws.close();
        }

        /** Wait for a frame matching pred, arriving at index >= from. */
        waitFor(pred: (f: any) => boolean, label: string, from = 0): Promise<any> {
            const existing = this.frames.slice(from).find(pred);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.#listeners.delete(check);
                    reject(new Error(`timeout: ${label}`));
                }, LLM_TIMEOUT);
                const check = (f: any) => {
                    if (!pred(f)) return;
                    clearTimeout(timer);
                    this.#listeners.delete(check);
                    resolve(f);
                };
                this.#listeners.add(check);
            });
        }

        /** Send a message, then await pred AND the end of that run. */
        async turn(text: string, pred: (f: any) => boolean, label: string) {
            const from = this.frames.length;
            this.send(text);
            const frame = await this.waitFor(pred, label, from);
            await this.waitFor(
                (f) => f.type === "run" && f.data?.status === "finished",
                `${label} (run finished)`,
                from,
            );
            return frame;
        }
    }

    const toolDone = (f: any, name: string) =>
        f.type === "tool_call" && f.data?.name === name && f.data?.status === "completed";
    const botText = (f: any, re: RegExp) =>
        f.type === "text" && f.from === "bot" && re.test(f.data?.text ?? "");

    try {
        const a = new Client();
        await a.open();
        const welcome = await a.waitFor((f) => f.type === "welcome", "welcome");
        const userId = welcome.data.userId;

        await a.turn(
            "My name is Botivan, please remember it.",
            (f) => toolDone(f, "remember_name"),
            "remember_name tool via LLM",
        );
        console.log("  ✅ LLM called remember_name → UserStore write");

        const weather = await a.turn(
            "What's the weather in Istanbul?",
            (f) => f.type === "genui" && f.chunk?.component === "weather",
            "weather genui via botivaEmit",
        );
        console.log(`  ✅ get_weather → botivaEmit GenUI card (streamId ${weather.streamId ? "ok" : "MISSING"})`);

        await a.turn(
            "Generate a PDF report about street food.",
            (f) => f.type === "text" && Array.isArray(f.actions) && f.actions.length > 0,
            "interrupt approval chips",
        );
        console.log("  ✅ generate_report_pdf paused via interrupt() → approval chips");

        const fromApprove = a.frames.length;
        a.send("Approve");
        await a.waitFor((f) => toolDone(f, "generate_report_pdf"), "resume completes tool", fromApprove);
        await a.waitFor(
            (f) => f.type === "genui" && f.chunk?.component === "genui-card",
            "download card after resume",
            fromApprove,
        );
        console.log("  ✅ Command({resume}) → tool completed + download card");

        // New conversation, same user → the agent node reads UserStore.
        const b = new Client(`?userId=${userId}`);
        await b.open();
        await b.waitFor((f) => f.type === "welcome", "welcome (B)");
        await b.turn("What is my name?", (f) => botText(f, /Botivan/i), "name recalled across conversations");
        console.log("  ✅ new conversation, same userId → agent recalled the name from UserStore");

        a.close();
        b.close();
        console.log("\nLangGraph LLM selftest passed ✅");
        process.exit(0);
    } catch (err) {
        console.error(`\nLangGraph LLM selftest failed ❌ ${(err as Error).message}`);
        process.exit(1);
    }
}
