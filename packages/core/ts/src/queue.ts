// Minimal unbounded async queue — used by the engine to merge the runtime's
// yielded events with out-of-band botivaEmit() events into a single stream.

export class AsyncQueue<T> implements AsyncIterable<T> {
    #values: T[] = [];
    #resolvers: Array<(result: IteratorResult<T>) => void> = [];
    #closed = false;

    push(value: T): void {
        if (this.#closed) return;
        const resolve = this.#resolvers.shift();
        if (resolve) resolve({ value, done: false });
        else this.#values.push(value);
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const resolve of this.#resolvers.splice(0)) {
            resolve({ value: undefined as never, done: true });
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: (): Promise<IteratorResult<T>> => {
                if (this.#values.length > 0) {
                    return Promise.resolve({ value: this.#values.shift() as T, done: false });
                }
                if (this.#closed) {
                    return Promise.resolve({ value: undefined as never, done: true });
                }
                return new Promise((resolve) => this.#resolvers.push(resolve));
            },
        };
    }
}
