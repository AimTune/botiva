import type { AuthContext, AuthResult, Authenticator } from "@botiva/core";

/**
 * Verifies a shared secret / API key against a static token → userId map.
 * The simplest real authenticator — good for service-to-service links and
 * fixtures.
 *
 *   new StaticTokenAuthenticator({ "sk-alice": "user-alice", "sk-bob": "user-bob" })
 */
export class StaticTokenAuthenticator implements Authenticator {
    readonly #tokens: Map<string, string>;

    constructor(tokens: Record<string, string> | Map<string, string>) {
        this.#tokens = tokens instanceof Map ? new Map(tokens) : new Map(Object.entries(tokens));
    }

    authenticate(ctx: AuthContext): AuthResult {
        if (!ctx.token) return { ok: false, reason: "missing token" };
        const userId = this.#tokens.get(ctx.token);
        if (!userId) return { ok: false, reason: "invalid token" };
        return { ok: true, userId };
    }
}
