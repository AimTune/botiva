/**
 * @botiva/authentication — the botiva authentication port (SKELETON).
 *
 * This package defines the `Authenticator` contract that will gate
 * `engine.connect()` once engine/transport integration lands. Today no
 * transport calls it and the engine accepts every connection (PROTOCOL.md §2
 * mandates open acceptance); wiring it in — token extraction per transport,
 * a reject signal on the wire, and parity across the Go/.NET/Python ports —
 * is tracked in the authentication issue (see README.md).
 */

/** Everything a transport knows about a connection attempt. */
export interface AuthContext {
    /** Transport that accepted the socket, e.g. "websocket" | "socket.io". */
    transport: "websocket" | "socket.io" | string;
    /** Credential presented by the client, if any. */
    token?: string;
    /** Raw query parameters of the upgrade/handshake request. */
    query?: Record<string, string>;
    /** Raw request headers of the upgrade/handshake request. */
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
    /** Arbitrary verified claims to expose to the runtime via meta. */
    claims?: Record<string, unknown>;
    /** Human-readable rejection reason (only meaningful when ok is false). */
    reason?: string;
}

/** The authentication port: decide whether a connection attempt may proceed. */
export interface Authenticator {
    authenticate(ctx: AuthContext): AuthResult | Promise<AuthResult>;
}

/** Default open-door authenticator — preserves today's behaviour. */
export class AllowAllAuthenticator implements Authenticator {
    authenticate(ctx: AuthContext): AuthResult {
        return { ok: true, userId: ctx.userId };
    }
}
