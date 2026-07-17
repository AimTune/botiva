// botiva deterministic smoke test — NO LLM or API key required.
// Boots an in-process server (DemoRuntime) with BOTH transports and verifies
// end to end:
//   • welcome handshake + generated identity
//   • echo turn, run started/finished frames
//   • tool_call lifecycle, HITL interrupt chips, resume
//   • user state (UserStore) surviving across conversations
//   • reconnect replay via watermark (full transcript catch-up)
//   • multi-connection fan-out (two tabs, one conversation)
//   • cross-transport fan-out (WebSocket tab + Socket.IO tab, one conversation)
//   • botivaEmit() GenUI stream with auto close
//
//   npm run smoke

import { createServer } from "node:http";
import WebSocket from "ws";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient } from "socket.io-client";
import { ConversationEngine, DemoRuntime, type Frame } from "@botiva/core";
import { WebSocketConnector } from "@botiva/websocket";
import { SocketIOConnector } from "@botiva/socket.io";
import { CookieAuthenticator, HmacJwtAuthenticator } from "@botiva/authentication";
import { createHmac } from "node:crypto";

const port = Number(process.env.PORT ?? 8795);

// ── in-process server ────────────────────────────────────────────────────────
const engine = new ConversationEngine({
    runtime: new DemoRuntime(),
    logger: { error: console.error },
    greeting: "smoke-greeting",
});
const server = createServer();
new WebSocketConnector({ engine, server, helloTimeoutMs: 100 });
const io = new SocketIOServer(server);
new SocketIOConnector({ engine, io });
await new Promise<void>((resolve) => server.listen(port, resolve));

// ── frame collection helpers ─────────────────────────────────────────────────
type AnyFrame = Frame & Record<string, any>;

class FrameCollector {
    frames: AnyFrame[] = [];
    #waiters: Array<{ pred: (f: AnyFrame) => boolean; resolve: (f: AnyFrame) => void }> = [];

    push(frame: AnyFrame): void {
        this.frames.push(frame);
        for (let i = this.#waiters.length - 1; i >= 0; i--) {
            if (this.#waiters[i]!.pred(frame)) {
                const [waiter] = this.#waiters.splice(i, 1);
                waiter!.resolve(frame);
            }
        }
    }

    waitFor(pred: (f: AnyFrame) => boolean, label: string, timeoutMs = 6000): Promise<AnyFrame> {
        const existing = this.frames.find(pred);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.#waiters.indexOf(waiter);
                if (index >= 0) this.#waiters.splice(index, 1);
                reject(new Error(`timeout waiting for: ${label}`));
            }, timeoutMs);
            const waiter = {
                pred,
                resolve: (f: AnyFrame) => {
                    clearTimeout(timer);
                    resolve(f);
                },
            };
            this.#waiters.push(waiter);
        });
    }
}

async function connectWs(query = "") {
    const ws = new WebSocket(`ws://localhost:${port}/chat${query}`);
    const col = new FrameCollector();
    ws.on("message", (raw) => col.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
    });
    return {
        col,
        send: (text: string) => ws.send(JSON.stringify({ type: "text", data: { text } })),
        close: () => ws.close(),
    };
}

const isBotText = (f: AnyFrame, includes: string) =>
    f.type === "text" && f.from === "bot" && String(f.data?.text ?? "").includes(includes);
const isUserText = (f: AnyFrame, includes: string) =>
    f.type === "text" && f.from === "user" && String(f.data?.text ?? "").includes(includes);

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
    checks.push([name, ok]);
    console.log(ok ? `  ✅ ${name}` : `  ❌ ${name}`);
};

try {
    // ── 1. fresh connect: handshake + greeting ───────────────────────────────
    const A = await connectWs();
    const welcomeA = await A.col.waitFor((f) => f.type === "welcome", "welcome (A)");
    const conversationId: string = welcomeA.data.conversationId;
    const userId: string = welcomeA.data.userId;
    check("welcome frame carries identity (protocol botiva/1)", welcomeA.data.protocol === "botiva/1" && !!conversationId && !!userId);
    check("welcome watermark starts at 0", welcomeA.data.watermark === 0);
    await A.col.waitFor((f) => isBotText(f, "smoke-greeting"), "greeting");

    // ── 2. echo turn ─────────────────────────────────────────────────────────
    A.send("hello world");
    await A.col.waitFor((f) => isBotText(f, "Echo: hello world"), "echo reply");
    check("echo reply", true);
    await A.col.waitFor((f) => f.type === "run" && f.data.status === "finished", "run finished");
    check(
        "run started/finished frames",
        A.col.frames.some((f) => f.type === "run" && f.data.status === "started") &&
            A.col.frames.some((f) => f.type === "run" && f.data.status === "finished"),
    );

    // ── 3. user state write ──────────────────────────────────────────────────
    A.send("my name is Hamza");
    await A.col.waitFor((f) => isBotText(f, "Nice to meet you, Hamza"), "name saved");
    check("UserStore write acknowledged", true);

    // ── 4. tool_call lifecycle + HITL ────────────────────────────────────────
    A.send("report please");
    await A.col.waitFor(
        (f) => f.type === "tool_call" && f.data.status === "running",
        "tool_call running",
    );
    const toolDone = await A.col.waitFor(
        (f) => f.type === "tool_call" && f.data.status === "completed",
        "tool_call completed",
    );
    check("tool_call running → completed (persistent seq)", typeof toolDone.seq === "number" && toolDone.seq > 0);
    const interruptFrame = await A.col.waitFor(
        (f) => f.type === "text" && Array.isArray(f.actions) && f.actions.length > 0,
        "interrupt chips",
    );
    check(
        "HITL interrupt rendered as action chips",
        interruptFrame.actions.some((a: { label: string }) => a.label === "Approve"),
    );
    A.send("Approve");
    await A.col.waitFor((f) => isBotText(f, "Approved"), "HITL resume");
    check("HITL resume completes the run", true);

    // ── 5. botivaEmit GenUI ──────────────────────────────────────────────────
    A.send("weather please");
    const genuiFrame = await A.col.waitFor(
        (f) => f.type === "genui" && f.chunk?.component === "weather",
        "genui chunk",
    );
    check("botivaEmit(ui(...)) delivered as genui frame", !!genuiFrame.streamId);
    await A.col.waitFor(
        (f) => f.type === "genui" && f.done === true && f.streamId === genuiFrame.streamId,
        "genui stream auto-close",
    );
    check("genui stream auto-closed by engine", true);

    // ── 6. reconnect replay (same conversation, watermark 0) ────────────────
    const B = await connectWs(`?conversationId=${conversationId}&userId=${userId}&watermark=0`);
    const welcomeB = await B.col.waitFor((f) => f.type === "welcome", "welcome (B)");
    check("reconnect welcome watermark > 0", welcomeB.data.watermark > 0);
    await B.col.waitFor((f) => isUserText(f, "hello world"), "replayed user frame");
    await B.col.waitFor((f) => isBotText(f, "Echo: hello world"), "replayed bot frame");
    check(
        "replay contains full transcript (user + bot + tools + genui)",
        B.col.frames.some((f) => f.type === "tool_call") &&
            B.col.frames.some((f) => f.type === "genui"),
    );

    // ── 7. multi-connection fan-out (two tabs, one conversation) ────────────
    B.send("sync test");
    await A.col.waitFor((f) => isUserText(f, "sync test"), "user frame fanned out to A");
    await A.col.waitFor((f) => isBotText(f, "Echo: sync test"), "bot reply fanned out to A");
    check("second tab's message fans out to first tab", true);
    check(
        "sender does not receive its own user-frame echo",
        !B.col.frames.some((f) => isUserText(f, "sync test")),
    );

    // ── 8. cross-transport: Socket.IO tab joins the same conversation ───────
    const C = new FrameCollector();
    const socket = ioClient(`http://localhost:${port}`, {
        auth: { conversationId, userId, watermark: 0 },
        transports: ["websocket"],
    });
    socket.on("botiva", (frame: AnyFrame) => C.push(frame));
    await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => resolve());
        socket.on("connect_error", reject);
    });
    await C.waitFor((f) => f.type === "welcome", "welcome (socket.io)");
    await C.waitFor((f) => isUserText(f, "hello world"), "replay over socket.io");
    check("Socket.IO client replays the same conversation", true);

    socket.emit("botiva", { type: "text", data: { text: "io ping" } });
    await C.waitFor((f) => isBotText(f, "Echo: io ping"), "echo over socket.io");
    await A.col.waitFor((f) => isUserText(f, "io ping"), "io user frame → ws tab");
    await A.col.waitFor((f) => isBotText(f, "Echo: io ping"), "io bot reply → ws tab");
    check("WebSocket ⇄ Socket.IO tabs share one conversation live", true);

    // ── 9. user state across conversations (same userId, new conversation) ──
    const D = await connectWs(`?userId=${userId}`);
    const welcomeD = await D.col.waitFor((f) => f.type === "welcome", "welcome (D)");
    check("new conversation for same user", welcomeD.data.conversationId !== conversationId);
    D.send("what's my name");
    await D.col.waitFor((f) => isBotText(f, "Your name is Hamza"), "user state across conversations");
    check("UserStore persists across conversations/devices", true);

    A.close();
    B.close();
    D.close();
    socket.close();

    // ── 10. authentication port (separate engine + server) ──────────────────
    const jwtSecret = "smoke-secret";
    const makeJwt = (sub: string, extra: Record<string, unknown> = {}) => {
        const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
        const head = enc({ alg: "HS256", typ: "JWT" });
        const body = enc({ sub, ...extra });
        const sig = createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest("base64url");
        return `${head}.${body}.${sig}`;
    };

    const authEngine = new ConversationEngine({
        runtime: new DemoRuntime(),
        logger: { error: () => {} },
        // Cookie "botiva_session" → JWT, with query/hello/Bearer token as fallback.
        authenticator: new CookieAuthenticator({
            cookie: "botiva_session",
            inner: new HmacJwtAuthenticator({ secret: jwtSecret }),
        }),
    });
    const authPort = port + 1;
    const authServer = createServer();
    new WebSocketConnector({ engine: authEngine, server: authServer, helloTimeoutMs: 100 });
    await new Promise<void>((resolve) => authServer.listen(authPort, resolve));

    // Raw WS helper capturing frames AND the close code.
    const rawConnect = (query = "", headers?: Record<string, string>) => {
        const ws = new WebSocket(`ws://localhost:${authPort}/chat${query}`, { headers });
        const col = new FrameCollector();
        const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
        ws.on("message", (raw) => col.push(JSON.parse(raw.toString())));
        const opened = new Promise<void>((resolve, reject) => {
            ws.on("open", () => resolve());
            ws.on("error", () => reject(new Error("ws error")));
        });
        return { ws, col, closed, opened };
    };

    // (a) rejected: no credential → error frame + close 4401, no welcome
    const bad = rawConnect();
    await bad.opened;
    const errFrame = await bad.col.waitFor((f) => f.type === "error", "auth error frame");
    check("unauthenticated connect gets an error frame", errFrame.data?.code === "unauthorized");
    const badCode = await bad.closed;
    check("auth rejection closes with 4401", badCode === 4401);
    check("no welcome frame for a rejected connection", !bad.col.frames.some((f) => f.type === "welcome"));

    // (b) accepted via query token → verified userId from the JWT `sub`
    const goodJwt = makeJwt("user-verified", { role: "admin" });
    const good = rawConnect(`?token=${goodJwt}`);
    await good.opened;
    const welcomeAuth = await good.col.waitFor((f) => f.type === "welcome", "welcome (auth)");
    check("valid token connects", !!welcomeAuth.data?.conversationId);
    check("verified userId overrides client claim", welcomeAuth.data?.userId === "user-verified");

    // (c) accepted via cookie (browser-style, no client token plumbing)
    const cookie = rawConnect("", { Cookie: `botiva_session=${makeJwt("user-cookie")}` });
    await cookie.opened;
    const welcomeCookie = await cookie.col.waitFor((f) => f.type === "welcome", "welcome (cookie)");
    check("cookie credential authenticates", welcomeCookie.data?.userId === "user-cookie");

    // (d) a forged/invalid token is rejected even when userId is asserted
    const forged = rawConnect(`?token=not-a-jwt&userId=user-spoof`);
    await forged.opened;
    await forged.col.waitFor((f) => f.type === "error", "forged token error");
    const forgedCode = await forged.closed;
    check("forged token cannot spoof identity", forgedCode === 4401 && !forged.col.frames.some((f) => f.type === "welcome"));

    good.ws.close();
    cookie.ws.close();
    authServer.close();
} catch (err) {
    check(`flow failed: ${(err as Error).message}`, false);
}

io.close();
server.close();

const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? "\nAll smoke checks passed ✅" : `\n${failed} check(s) failed ❌`);
process.exit(failed === 0 ? 0 : 1);
