// Authentication port — the fifth botiva port (alongside Runtime, StateStore,
// HistoryStore, Extension). An Authenticator gates engine.connect(): it can
// reject a connection attempt or replace the client-asserted userId with a
// verified one.
//
// Without an authenticator the engine behaves as before — identity is
// client-asserted and every connection is accepted (PROTOCOL.md §2). With one,
// connect() throws AuthenticationError on rejection; transports translate that
// into a wire `error` frame + a transport close (WebSocket close code
// AUTH_CLOSE_CODE). See PROTOCOL.md §2.1.
//
// Concrete authenticators (static API keys, HMAC JWT) live in
// @botiva/authentication — this file only defines the port + the trivial
// open-door default, the way MemoryStateStore ships with the StateStore port.

/** Everything a transport knows about a connection attempt. */
export interface AuthContext {
    /** Transport that accepted the socket, e.g. "websocket" | "socket.io". */
    transport: "websocket" | "socket.io" | string;
    /** Credential presented by the client, if any. */
    token?: string;
    /** Raw query parameters of the upgrade/handshake request. */
    query?: Record<string, string>;
    /** Raw request headers of the upgrade/handshake request (lower-cased keys). */
    headers?: Record<string, string>;
    /** Client-asserted identity (unverified). */
    userId?: string;
    conversationId?: string;
}

/** Verdict returned by an Authenticator. */
export interface AuthResult {
    ok: boolean;
    /** Verified identity; overrides the client-asserted userId when set. */
    userId?: string;
    /** Arbitrary verified claims, exposed to the runtime via `TurnContext.meta.auth`. */
    claims?: Record<string, unknown>;
    /** Human-readable rejection reason (only meaningful when ok is false). */
    reason?: string;
}

/** The authentication port: decide whether a connection attempt may proceed. */
export interface Authenticator {
    authenticate(ctx: AuthContext): AuthResult | Promise<AuthResult>;
}

/** Default open-door authenticator — preserves the no-auth behaviour. */
export class AllowAllAuthenticator implements Authenticator {
    authenticate(ctx: AuthContext): AuthResult {
        return { ok: true, userId: ctx.userId };
    }
}

/**
 * Thrown by engine.connect() when an authenticator rejects the attempt.
 * Transports catch it and emit an `error` frame + close (WS AUTH_CLOSE_CODE).
 */
export class AuthenticationError extends Error {
    readonly code: string;
    constructor(reason: string, code = "unauthorized") {
        super(reason);
        this.name = "AuthenticationError";
        this.code = code;
    }
}

/** WebSocket close code for an auth rejection (application range 4000–4999). */
export const AUTH_CLOSE_CODE = 4401;
