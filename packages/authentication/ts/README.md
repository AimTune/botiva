# @botiva/authentication

Concrete `Authenticator` adapters for the `@botiva/core` auth port
(PROTOCOL.md §2.1). The port itself (`Authenticator`, `AuthContext`,
`AuthResult`, `AuthenticationError`, `AllowAllAuthenticator`) lives in
`@botiva/core` — this package ships the reusable verifiers, the way
`@botiva/redis` ships `StateStore` implementations.

## Adapters

| Adapter | Credential | Verifies |
|---|---|---|
| `StaticTokenAuthenticator` | `ctx.token` | a static `token → userId` map (API keys, fixtures) |
| `HmacJwtAuthenticator` | `ctx.token` | HS256 JWT (`node:crypto`, zero deps): signature + `exp`/`nbf`, `sub` → userId, payload → claims |
| `CookieAuthenticator` | a named cookie in `ctx.headers.cookie` | extracts the cookie, delegates to an inner authenticator |

Composable: wrap any verifier in `CookieAuthenticator` for browser sessions.

## Usage

```ts
import { ConversationEngine } from "@botiva/core";
import { CookieAuthenticator, HmacJwtAuthenticator } from "@botiva/authentication";

const engine = new ConversationEngine({
    runtime,
    authenticator: new CookieAuthenticator({
        cookie: "botiva_session",
        inner: new HmacJwtAuthenticator({ secret: process.env.JWT_SECRET! }),
    }),
});
```

The transports (`@botiva/websocket`, `@botiva/socket.io`) read the credential
from `?token=`, the `hello` frame's `token`, an `Authorization: Bearer …`
header, or (via `CookieAuthenticator`) the `Cookie` header, and translate a
rejection into an `error` frame + close (WebSocket code 4401). A returned
`userId` is the verified identity and overrides any client-asserted one.

## Writing your own

Implement the one-method port and pass it to the engine:

```ts
import type { Authenticator, AuthContext, AuthResult } from "@botiva/authentication";

class MyAuthenticator implements Authenticator {
    async authenticate(ctx: AuthContext): Promise<AuthResult> {
        const userId = await lookup(ctx.token);
        return userId ? { ok: true, userId } : { ok: false, reason: "denied" };
    }
}
```

Cross-language parity (Go/.NET/Python) is tracked in
[AimTune/botiva#1](https://github.com/AimTune/botiva/issues/1).
