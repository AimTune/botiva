// HistoryStore port — the conversation transcript as persisted wire frames.
//
// Every persistent frame gets a monotonically increasing `seq` (1-based).
// A client reconnecting with `watermark: N` receives every frame with
// seq > N — this is what makes "rejoin the same conversation from any
// device/tab" work, DirectLine-style.

import type { Frame } from "./protocol.js";

export interface HistoryStore {
    /** Persist a frame; returns the assigned seq (the frame must be stored WITH it). */
    append(conversationId: string, frame: Frame): Promise<number>;
    /** Frames with seq > watermark, in order. */
    after(conversationId: string, watermark: number): Promise<Frame[]>;
    /** Current highest seq (0 when the conversation has no history). */
    latest(conversationId: string): Promise<number>;
}

export class MemoryHistoryStore implements HistoryStore {
    #conversations = new Map<string, { baseSeq: number; frames: Frame[] }>();
    #maxFrames: number;

    constructor({ maxFrames = 1000 }: { maxFrames?: number } = {}) {
        this.#maxFrames = maxFrames;
    }

    async append(conversationId: string, frame: Frame): Promise<number> {
        let conv = this.#conversations.get(conversationId);
        if (!conv) {
            conv = { baseSeq: 0, frames: [] };
            this.#conversations.set(conversationId, conv);
        }
        const seq = conv.baseSeq + conv.frames.length + 1;
        conv.frames.push({ ...frame, seq } as Frame);
        while (conv.frames.length > this.#maxFrames) {
            conv.frames.shift();
            conv.baseSeq++;
        }
        return seq;
    }

    async after(conversationId: string, watermark: number): Promise<Frame[]> {
        const conv = this.#conversations.get(conversationId);
        if (!conv) return [];
        return conv.frames.filter((f) => ((f as { seq?: number }).seq ?? 0) > watermark);
    }

    async latest(conversationId: string): Promise<number> {
        const conv = this.#conversations.get(conversationId);
        return conv ? conv.baseSeq + conv.frames.length : 0;
    }
}
