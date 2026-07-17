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

import type { Server, Socket } from "socket.io";
import type { ConversationEngine, Frame, HelloFrame } from "@botiva/core";

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
        const connection = await this.engine.connect({
            userId: (auth.userId as string | undefined) ?? str(query.userId),
            conversationId: (auth.conversationId as string | undefined) ?? str(query.conversationId),
            watermark: watermarkRaw !== undefined ? Number(watermarkRaw) : undefined,
            meta: (auth.meta as Record<string, unknown> | undefined) ?? undefined,
            deliver: (frame: Frame) => {
                if (socket.connected) socket.emit(this.event, frame);
            },
        });

        socket.on(this.event, (payload: unknown) => void connection.receive(payload));
        socket.on("disconnect", () => void connection.close());
    }
}
