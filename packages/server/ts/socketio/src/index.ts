// SocketIOConnector — botiva transport adapter for Socket.IO (express/socket.io stack).
//
// The whole Botiva Wire Protocol travels over ONE event channel (default
// "botiva") in both directions, so the client connector stays identical
// across transports — only the socket library changes:
//
//   // client
//   const socket = io("https://host", {
//       auth: { userId: "u-1", conversationId: "c-1", watermark: 12 },
//   });
//   socket.on("botiva", (frame) => render(frame));
//   socket.emit("botiva", { type: "text", data: { text: "hello" } });
//
// Identity comes from `socket.handshake.auth` (preferred) or query params.
//
// Authentication (PROTOCOL.md §2.1): when the engine has an authenticator, the
// credential is read from `auth.token` (or `?token=`); handshake headers are
// forwarded (so a CookieAuthenticator can read `Cookie`). A rejected attempt
// gets an `error` frame followed by `socket.disconnect(true)`.

import type { Server, Socket } from "socket.io";
import {
    AuthenticationError,
    errorFrame,
    type ConversationEngine,
    type Frame,
    type HelloFrame,
} from "@botiva/core";

export interface SocketIOConnectorOptions {
    engine: ConversationEngine;
    /** An existing socket.io Server instance (you own its lifecycle). */
    io: Server;
    namespace?: string;
    /** Event name carrying protocol frames in both directions. */
    event?: string;
}

export class SocketIOConnector {
    readonly engine: ConversationEngine;
    readonly event: string;

    constructor({ engine, io, namespace = "/", event = "botiva" }: SocketIOConnectorOptions) {
        this.engine = engine;
        this.event = event;
        io.of(namespace).on("connection", (socket) => {
            void this.#onConnection(socket).catch((err) => {
                this.engine.log.error?.("[botiva/socket.io] connection failed:", err);
                socket.disconnect(true);
            });
        });
    }

    async #onConnection(socket: Socket): Promise<void> {
        const auth = (socket.handshake.auth ?? {}) as Partial<HelloFrame> & Record<string, unknown>;
        const query = socket.handshake.query as Record<string, string | string[] | undefined>;
        const str = (v: string | string[] | undefined): string | undefined =>
            typeof v === "string" && v.length > 0 ? v : undefined;

        const watermarkRaw = auth.watermark ?? str(query.watermark);
        let connection: Awaited<ReturnType<ConversationEngine["connect"]>>;
        try {
            connection = await this.engine.connect({
                userId: (auth.userId as string | undefined) ?? str(query.userId),
                conversationId: (auth.conversationId as string | undefined) ?? str(query.conversationId),
                watermark: watermarkRaw !== undefined ? Number(watermarkRaw) : undefined,
                meta: (auth.meta as Record<string, unknown> | undefined) ?? undefined,
                auth: {
                    transport: "socket.io",
                    token: (auth.token as string | undefined) ?? str(query.token),
                    query: flattenQuery(query),
                    headers: flattenHeaders(socket.handshake.headers),
                },
                deliver: (frame: Frame) => {
                    if (socket.connected) socket.emit(this.event, frame);
                },
            });
        } catch (err) {
            if (err instanceof AuthenticationError) {
                socket.emit(this.event, errorFrame(err.code, err.message));
                socket.disconnect(true);
                return;
            }
            throw err;
        }

        socket.on(this.event, (payload: unknown) => void connection.receive(payload));
        socket.on("disconnect", () => void connection.close());
    }
}

/** socket.io handshake headers → a flat lower-cased string map. */
function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
    return out;
}

function flattenQuery(query: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        out[key] = Array.isArray(value) ? (value[0] ?? "") : value;
    }
    return out;
}
