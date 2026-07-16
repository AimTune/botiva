// Redis adapters for the botiva persistence ports. No Redis dependency is
// imposed — inject any ioredis- or node-redis(v4)-compatible client:
//
//   import Redis from "ioredis";
//   const redis = new Redis(process.env.REDIS_URL);
//   const engine = new ConversationEngine({
//       runtime,
//       stateStore: new RedisStateStore(redis, { ttlSeconds: 86_400 }),
//       historyStore: new RedisHistoryStore(redis, { ttlSeconds: 86_400 }),
//   });
//
// Note: LangGraph's own graph state (chat history / checkpoints) is separate —
// compile the graph with @langchain/langgraph-checkpoint-redis for that.
// These stores hold botiva's session metadata (pending interrupts, user &
// conversation state) and the wire-frame transcript used for reconnect replay.

import type { Frame, HistoryStore, StateStore } from "@botiva/core";

/** Minimal client surface — satisfied by ioredis and node-redis v4 alike. */
export interface RedisClientLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    del(key: string): Promise<unknown>;
    expire(key: string, seconds: number): Promise<unknown>;
    incr(key: string): Promise<number>;
    rpush?(key: string, value: string): Promise<unknown>;
    rPush?(key: string, value: string): Promise<unknown>;
    lrange?(key: string, start: number, stop: number): Promise<string[]>;
    lRange?(key: string, start: number, stop: number): Promise<string[]>;
}

export interface RedisStoreOptions {
    prefix?: string;
    /** TTL applied on every write (default: persistent). */
    ttlSeconds?: number;
}

export class RedisStateStore implements StateStore {
    #client: RedisClientLike;
    #prefix: string;
    #ttlSeconds?: number;

    constructor(client: RedisClientLike, { prefix = "botiva:state:", ttlSeconds }: RedisStoreOptions = {}) {
        this.#client = client;
        this.#prefix = prefix;
        this.#ttlSeconds = ttlSeconds;
    }

    async get(key: string): Promise<unknown> {
        const raw = await this.#client.get(this.#prefix + key);
        return raw == null ? undefined : (JSON.parse(raw) as unknown);
    }

    async set(key: string, value: unknown): Promise<void> {
        const fullKey = this.#prefix + key;
        await this.#client.set(fullKey, JSON.stringify(value));
        if (this.#ttlSeconds) await this.#client.expire(fullKey, this.#ttlSeconds);
    }

    async delete(key: string): Promise<void> {
        await this.#client.del(this.#prefix + key);
    }
}

export class RedisHistoryStore implements HistoryStore {
    #client: RedisClientLike;
    #prefix: string;
    #ttlSeconds?: number;
    #rpush: (key: string, value: string) => Promise<unknown>;
    #lrange: (key: string, start: number, stop: number) => Promise<string[]>;

    constructor(client: RedisClientLike, { prefix = "botiva:history:", ttlSeconds }: RedisStoreOptions = {}) {
        this.#client = client;
        this.#prefix = prefix;
        this.#ttlSeconds = ttlSeconds;
        const rpush = client.rpush ?? client.rPush;
        const lrange = client.lrange ?? client.lRange;
        if (!rpush || !lrange) {
            throw new Error("RedisHistoryStore: client must provide rpush/rPush and lrange/lRange.");
        }
        this.#rpush = rpush.bind(client);
        this.#lrange = lrange.bind(client);
    }

    #listKey(conversationId: string): string {
        return `${this.#prefix}${conversationId}`;
    }

    #seqKey(conversationId: string): string {
        return `${this.#prefix}${conversationId}:seq`;
    }

    async append(conversationId: string, frame: Frame): Promise<number> {
        const seq = await this.#client.incr(this.#seqKey(conversationId));
        await this.#rpush(this.#listKey(conversationId), JSON.stringify({ ...frame, seq }));
        if (this.#ttlSeconds) {
            await this.#client.expire(this.#listKey(conversationId), this.#ttlSeconds);
            await this.#client.expire(this.#seqKey(conversationId), this.#ttlSeconds);
        }
        return seq;
    }

    async after(conversationId: string, watermark: number): Promise<Frame[]> {
        // seq is 1-based and the list is append-only, so list index = seq - 1.
        const raw = await this.#lrange(this.#listKey(conversationId), Math.max(0, watermark), -1);
        return raw.map((item) => JSON.parse(item) as Frame);
    }

    async latest(conversationId: string): Promise<number> {
        const raw = await this.#client.get(this.#seqKey(conversationId));
        return raw == null ? 0 : Number(raw);
    }
}
