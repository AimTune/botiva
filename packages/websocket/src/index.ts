// WebSocketConnector — botiva transport adapter for `ws`.
//
// Identity handshake (either works):
//   • Query params:  wss://host/chat?userId=u-1&conversationId=c-1&watermark=12
//   • Hello frame:   first message {type:"hello", userId?, conversationId?, watermark?, meta?}
// If neither arrives within `helloTimeoutMs`, a fresh identity is generated
// and announced via the `welcome` frame (the client should persist it).
//
// The transport is intentionally thin: everything protocol-related (welcome,
// replay, broadcast, turn handling) lives in the engine, so this file is the
// template for writing new transports (SSE, SignalR, gRPC, ...) — and for
// porting botiva to Go, .NET or Python.

import type { IncomingMessage as HttpIncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Connection, ConversationEngine, Frame, HelloFrame } from "@botiva/core";

export interface WebSocketConnectorOptions {
    engine: ConversationEngine;
    /** HTTP server to attach the upgrade handler to. */
    server: HttpServer;
    path?: string;
    /** How long to wait for a hello frame when the URL carries no identity. */
    helloTimeoutMs?: number;
}

export class WebSocketConnector {
    readonly engine: ConversationEngine;
    readonly wss: WebSocketServer;
    #helloTimeoutMs: number;

    constructor({ engine, server, path = "/chat", helloTimeoutMs = 300 }: WebSocketConnectorOptions) {
        this.engine = engine;
        this.#helloTimeoutMs = helloTimeoutMs;
        // noServer + manual routing: upgrades for other paths (e.g. /socket.io)
        // are left untouched, so botiva coexists with Socket.IO & friends on
        // one HTTP server.
        this.wss = new WebSocketServer({ noServer: true });
        server.on("upgrade", (req, socket, head) => {
            const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
            if (pathname !== path) return;
            this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
        });
        this.wss.on("connection", (socket, req) => {
            void this.#onConnection(socket, req).catch((err) => {
                this.engine.log.error?.("[botiva/websocket] connection failed:", err);
                socket.close();
            });
        });
    }

    async #onConnection(socket: WebSocket, req: HttpIncomingMessage): Promise<void> {
        const url = new URL(req.url ?? "/", "http://localhost");
        const q = url.searchParams;
        let hello: HelloFrame = {
            type: "hello",
            userId: q.get("userId") ?? undefined,
            conversationId: q.get("conversationId") ?? undefined,
            watermark: q.has("watermark") ? Number(q.get("watermark")) : undefined,
        };

        let connection: Connection | null = null;
        let socketClosed = false;
        const buffered: string[] = [];
        let helloResolve: ((h: HelloFrame | null) => void) | null = null;

        socket.on("message", (raw) => {
            const text = raw.toString();
            if (!connection) {
                if (helloResolve) {
                    const parsed = tryParseHello(text);
                    const resolve = helloResolve;
                    helloResolve = null;
                    if (parsed) {
                        resolve(parsed);
                        return;
                    }
                    buffered.push(text);
                    resolve(null); // first frame was a normal message → stop waiting
                    return;
                }
                buffered.push(text);
                return;
            }
            void connection.receive(text);
        });
        socket.on("close", () => {
            socketClosed = true;
            void connection?.close();
        });

        // No identity in the URL → give the client a beat to send a hello frame.
        const hasQueryIdentity =
            hello.userId !== undefined || hello.conversationId !== undefined || hello.watermark !== undefined;
        if (!hasQueryIdentity && this.#helloTimeoutMs > 0) {
            const received = await new Promise<HelloFrame | null>((resolve) => {
                helloResolve = resolve;
                setTimeout(() => {
                    if (helloResolve) {
                        helloResolve = null;
                        resolve(null);
                    }
                }, this.#helloTimeoutMs);
            });
            if (received) hello = { ...hello, ...received, type: "hello" };
        }
        if (socketClosed) return;

        connection = await this.engine.connect({
            userId: hello.userId,
            conversationId: hello.conversationId,
            watermark: hello.watermark,
            meta: hello.meta,
            deliver: (frame: Frame) => {
                if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
            },
        });
        if (socketClosed) {
            await connection.close();
            return;
        }
        for (const raw of buffered.splice(0)) void connection.receive(raw);
    }

    close(): void {
        this.wss.close();
    }
}

function tryParseHello(text: string): HelloFrame | null {
    try {
        const parsed = JSON.parse(text) as { type?: string };
        return parsed && parsed.type === "hello" ? (parsed as HelloFrame) : null;
    } catch {
        return null;
    }
}
