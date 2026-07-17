"""Authentication port — the Python counterpart of @botiva/core's auth port
(PROTOCOL.md §2.1).

An ``Authenticator`` gates ``engine.connect()``: it can reject a connection
attempt or replace the client-asserted ``user_id`` with a verified one.

Without an authenticator the engine behaves as before — identity is
client-asserted and every connection is accepted. With one, ``connect()`` raises
``AuthenticationError`` on rejection; transports translate that into a wire
``error`` frame + a close (WebSocket close code ``AUTH_CLOSE_CODE``). Concrete
authenticators (static tokens, HMAC JWT, cookies) live in ``botiva_auth``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

# WebSocket close code for an auth rejection (application range 4000–4999).
AUTH_CLOSE_CODE = 4401


@dataclass
class AuthContext:
    """Everything a transport knows about a connection attempt."""

    transport: str = "unknown"
    token: str | None = None
    query: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)  # lower-cased keys
    user_id: str | None = None
    conversation_id: str | None = None


@dataclass
class AuthResult:
    """Verdict returned by an Authenticator."""

    ok: bool
    user_id: str | None = None  # verified identity; overrides the asserted one
    claims: dict[str, Any] | None = None  # exposed via TurnContext.meta["auth"]
    reason: str | None = None  # rejection reason (only when ok is False)


@runtime_checkable
class Authenticator(Protocol):
    """The authentication port: decide whether a connection may proceed."""

    async def authenticate(self, ctx: AuthContext) -> AuthResult: ...


class AllowAllAuthenticator:
    """Default open-door authenticator — preserves the no-auth behaviour."""

    async def authenticate(self, ctx: AuthContext) -> AuthResult:
        return AuthResult(ok=True, user_id=ctx.user_id)


class AuthenticationError(Exception):
    """Raised by connect() when an authenticator rejects the attempt.

    Transports catch it and emit an ``error`` frame + close.
    """

    def __init__(self, reason: str, code: str = "unauthorized") -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code


@dataclass
class AuthInput:
    """Credential + request material a transport hands the authenticator."""

    transport: str = "unknown"
    token: str | None = None
    query: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
