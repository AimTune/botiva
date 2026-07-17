# @botiva/authentication

**Status: skeleton — not wired into the engine or any transport yet.**

This package defines the botiva authentication port: the `Authenticator`
interface (`authenticate(ctx) → AuthResult`), the `AuthContext` a transport
hands it, and an `AllowAllAuthenticator` that preserves today's open-door
behaviour.

Nothing calls it yet. botiva currently has no authentication anywhere:
identity (`userId`, `conversationId`) is client-asserted, `engine.connect()`
takes no credential, extensions cannot reject a connection, and PROTOCOL.md §2
mandates accepting identity-less connections.

The full design — token transport (WS query / `hello` frame, Socket.IO
handshake auth), an engine-level gate, a reject signal on the wire (error
frame + close code), a PROTOCOL.md addendum, and parity implementations for
the Go/.NET/Python ports — is tracked in
[AimTune/botiva#1](https://github.com/AimTune/botiva/issues/1)
(draft: [docs/issues/authentication.md](../../../docs/issues/authentication.md)).
