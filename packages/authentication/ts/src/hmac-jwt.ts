import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthContext, AuthResult, Authenticator } from "@botiva/core";

export interface HmacJwtOptions {
    /** Shared HS256 secret the token was signed with. */
    secret: string;
    /** JWT claim carrying the user identity. Default "sub". */
    subjectClaim?: string;
    /** Clock-skew tolerance in seconds when checking `exp`/`nbf`. Default 0. */
    clockToleranceSec?: number;
}

/**
 * Verifies an HS256 JSON Web Token with zero dependencies (`node:crypto`).
 * Checks the signature, `exp` and `nbf`, then maps the subject claim to the
 * verified userId and exposes the full payload as claims.
 *
 *   new HmacJwtAuthenticator({ secret: process.env.JWT_SECRET! })
 */
export class HmacJwtAuthenticator implements Authenticator {
    readonly #secret: string;
    readonly #subject: string;
    readonly #skew: number;

    constructor(opts: HmacJwtOptions) {
        if (!opts?.secret) throw new Error("HmacJwtAuthenticator requires a secret.");
        this.#secret = opts.secret;
        this.#subject = opts.subjectClaim ?? "sub";
        this.#skew = opts.clockToleranceSec ?? 0;
    }

    authenticate(ctx: AuthContext): AuthResult {
        if (!ctx.token) return { ok: false, reason: "missing token" };
        const payload = this.#verify(ctx.token);
        if (!payload) return { ok: false, reason: "invalid or expired token" };
        const userId = payload[this.#subject];
        if (typeof userId !== "string" || userId.length === 0) {
            return { ok: false, reason: `token missing "${this.#subject}" claim` };
        }
        return { ok: true, userId, claims: payload };
    }

    #verify(token: string): Record<string, unknown> | null {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

        let expected: Buffer;
        let actual: Buffer;
        try {
            expected = createHmac("sha256", this.#secret).update(`${headerB64}.${payloadB64}`).digest();
            actual = Buffer.from(signatureB64, "base64url");
        } catch {
            return null;
        }
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

        let header: Record<string, unknown>;
        let payload: Record<string, unknown>;
        try {
            header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
            payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
        } catch {
            return null;
        }
        if (header.alg !== "HS256") return null;

        const now = Math.floor(Date.now() / 1000);
        if (typeof payload.exp === "number" && now > payload.exp + this.#skew) return null;
        if (typeof payload.nbf === "number" && now + this.#skew < payload.nbf) return null;
        return payload;
    }
}
