import type { AuthContext, AuthResult, Authenticator } from "@botiva/core";

export interface CookieAuthenticatorOptions {
    /** Cookie name carrying the credential (e.g. "botiva_session"). */
    cookie: string;
    /** Verifier the extracted cookie value is handed to (as `ctx.token`). */
    inner: Authenticator;
}

/**
 * Extracts a credential from a named cookie in the request headers, then
 * delegates verification to an inner authenticator. Browsers attach cookies
 * automatically, so this needs no client-side token plumbing — pair it with
 * `HmacJwtAuthenticator` or `StaticTokenAuthenticator`:
 *
 *   new CookieAuthenticator({
 *       cookie: "botiva_session",
 *       inner: new HmacJwtAuthenticator({ secret }),
 *   })
 */
export class CookieAuthenticator implements Authenticator {
    readonly #cookie: string;
    readonly #inner: Authenticator;

    constructor(opts: CookieAuthenticatorOptions) {
        if (!opts?.cookie) throw new Error("CookieAuthenticator requires a cookie name.");
        if (!opts?.inner) throw new Error("CookieAuthenticator requires an inner authenticator.");
        this.#cookie = opts.cookie;
        this.#inner = opts.inner;
    }

    authenticate(ctx: AuthContext): AuthResult | Promise<AuthResult> {
        const token = parseCookies(ctx.headers?.cookie)[this.#cookie];
        // Keep any existing token as a fallback (e.g. query/hello/Bearer).
        return this.#inner.authenticate({ ...ctx, token: token ?? ctx.token });
    }
}

/** Parse a `Cookie:` header value into a name → value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const pair of header.split(";")) {
        const eq = pair.indexOf("=");
        if (eq < 0) continue;
        const name = pair.slice(0, eq).trim();
        if (!name) continue;
        const value = pair.slice(eq + 1).trim();
        try {
            out[name] = decodeURIComponent(value);
        } catch {
            out[name] = value;
        }
    }
    return out;
}
