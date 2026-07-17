# Authentication: Authenticator port + engine integration + wire-protocol support

## Problem

botiva has no authentication anywhere. Identity is entirely client-asserted:

- `engine.connect()` takes `userId`/`conversationId` but no credential, in all
  four languages (TS `packages/core/ts/src/engine.ts`, Go
  `packages/core/go/engine.go`, .NET `packages/core/dotnet/Engine.cs`, Python
  `packages/core/python/botiva/engine.py`).
- Any client can claim any `userId` and read that user's `UserStore` and
  conversation history — identity spoofing by design.
- The `Extension` port cannot reject a connection: `onConnect` returns void and
  thrown errors are swallowed (`#notify` catch in the TS engine; same pattern
  in the ports).
- There is no error/unauthorized frame in the wire protocol, and no close code
  convention for "rejected".
- PROTOCOL.md §2 currently *mandates* open acceptance: "A server MUST accept
  connections with no identity at all (fresh visitor) and generate ids."

## Proposal

The skeleton package `packages/authentication/ts` (`@botiva/authentication`)
already defines the contract: `Authenticator.authenticate(AuthContext) →
AuthResult { ok, userId?, claims?, reason? }`, plus `AllowAllAuthenticator`
(today's behaviour). This issue is about wiring it in:

1. **PROTOCOL.md addendum** (new §2.1 "Authentication", opt-in profile so the
   open-acceptance default stays valid):
   - Token transport: WebSocket `?token=` query param **or** `hello` frame
     `data.token`; Socket.IO `handshake.auth.token`.
   - Reject signal: a transient `error` frame
     `{ type: "error", data: { code: "unauthorized", message } }` followed by
     transport close (WS close code **4401**). Clients MUST ignore unknown
     frame types, so this is forward-compatible.
   - When an authenticator returns a verified `userId`, it overrides the
     client-asserted one; `claims` are exposed to the runtime via
     `TurnContext.meta.auth`.
2. **Engine hook (TS first)**: optional `authenticator` in the
   `ConversationEngine` options; `connect()` calls it before creating the
   connection and throws a typed `AuthenticationError` on rejection.
3. **Transports**: `@botiva/websocket` and `@botiva/socket.io` extract the
   token (query/hello/handshake), build `AuthContext` (including headers), and
   translate `AuthenticationError` into the error frame + close.
4. **Reference authenticators** in `@botiva/authentication`:
   - `StaticTokenAuthenticator` — shared secret / API-key → userId map.
   - `HmacJwtAuthenticator` — HS256 JWT verification with zero dependencies
     (`node:crypto`), claims → `AuthResult.claims`.
5. **Port parity** (per repo norm, PROTOCOL.md is normative for every
   language): mirror `Authenticator` + engine hook + WS transport handling +
   selftest coverage in Go (`packages/*/go`), .NET (`Botiva.Authentication` or
   core), and Python (`botiva_auth` or core). Deterministic selftests, no
   network dependencies.

## Non-goals

- No authorization/RBAC beyond connection-time authentication.
- No session refresh/expiry handling in v1 (a rejected reconnect is enough).
- No change to the default open-acceptance behaviour for anonymous demos.
