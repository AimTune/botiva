// State ports — where user and conversation state live.
//
// StateStore is the persistence port (hexagonal "driven" adapter): a flat
// async key/value contract that is trivial to implement in any language and
// any backend (memory, Redis, DynamoDB, SQL, ...).
//
// UserStore / ConversationStore are scoped views over one StateStore:
//   UserStore          key = "user:{userId}"   — survives across conversations
//                                                and devices (stable identity)
//   ConversationStore  key = "conv:{conversationId}" — one conversation's state

export interface StateStore {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
}

export class MemoryStateStore implements StateStore {
    #map = new Map<string, unknown>();

    async get(key: string): Promise<unknown> {
        return this.#map.get(key);
    }

    async set(key: string, value: unknown): Promise<void> {
        this.#map.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.#map.delete(key);
    }
}

/** A typed, namespaced view over a StateStore key. */
export class ScopedStore<T extends Record<string, unknown> = Record<string, unknown>> {
    constructor(
        protected readonly store: StateStore,
        public readonly key: string,
    ) {}

    async get(): Promise<T | undefined> {
        return (await this.store.get(this.key)) as T | undefined;
    }

    async set(value: T): Promise<void> {
        await this.store.set(this.key, value);
    }

    /** Shallow-merge into the current value. Returns the merged result. */
    async patch(partial: Partial<T>): Promise<T> {
        const current = (await this.get()) ?? ({} as T);
        const next = { ...current, ...partial };
        await this.set(next);
        return next;
    }

    async delete(): Promise<void> {
        await this.store.delete(this.key);
    }
}

/** Per-user state — persists across conversations, devices and reconnects. */
export class UserStore<
    T extends Record<string, unknown> = Record<string, unknown>,
> extends ScopedStore<T> {
    constructor(
        store: StateStore,
        public readonly userId: string,
    ) {
        super(store, `user:${userId}`);
    }
}

/** Per-conversation state — shared by every connection attached to it. */
export class ConversationStore<
    T extends Record<string, unknown> = Record<string, unknown>,
> extends ScopedStore<T> {
    constructor(
        store: StateStore,
        public readonly conversationId: string,
    ) {
        super(store, `conv:${conversationId}`);
    }
}
