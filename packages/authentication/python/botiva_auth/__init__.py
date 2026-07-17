"""botiva_auth — concrete Authenticator adapters for the botiva auth port
(PROTOCOL.md §2.1), the Python counterpart of @botiva/authentication.

The port itself (Authenticator, AuthContext, AuthResult, AuthenticationError,
AllowAllAuthenticator) lives in the core ``botiva`` package; this package ships
the reusable verifiers and depends only on the standard library.

    from botiva import ConversationEngine
    from botiva_auth import CookieAuthenticator, HmacJwtAuthenticator

    engine = ConversationEngine(
        runtime,
        authenticator=CookieAuthenticator(
            "botiva_session", HmacJwtAuthenticator(secret),
        ),
    )
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import replace
from typing import Any
from urllib.parse import unquote

from botiva import AuthContext, AuthResult, Authenticator


class StaticTokenAuthenticator:
    """Verifies a shared secret / API key against a static token → userId map."""

    def __init__(self, tokens: dict[str, str]) -> None:
        self._tokens = dict(tokens)

    async def authenticate(self, ctx: AuthContext) -> AuthResult:
        if not ctx.token:
            return AuthResult(ok=False, reason="missing token")
        user_id = self._tokens.get(ctx.token)
        if user_id is None:
            return AuthResult(ok=False, reason="invalid token")
        return AuthResult(ok=True, user_id=user_id)


def _b64url_decode(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


class HmacJwtAuthenticator:
    """Verifies an HS256 JSON Web Token with the standard library only: checks
    the signature, ``exp`` and ``nbf``, then maps the subject claim to the
    verified userId and exposes the full payload as claims."""

    def __init__(self, secret: str, *, subject_claim: str = "sub", clock_tolerance_sec: int = 0) -> None:
        if not secret:
            raise ValueError("HmacJwtAuthenticator requires a secret")
        self._secret = secret.encode()
        self._subject = subject_claim
        self._skew = clock_tolerance_sec

    async def authenticate(self, ctx: AuthContext) -> AuthResult:
        if not ctx.token:
            return AuthResult(ok=False, reason="missing token")
        payload = self._verify(ctx.token)
        if payload is None:
            return AuthResult(ok=False, reason="invalid or expired token")
        user_id = payload.get(self._subject)
        if not isinstance(user_id, str) or not user_id:
            return AuthResult(ok=False, reason=f'token missing "{self._subject}" claim')
        return AuthResult(ok=True, user_id=user_id, claims=payload)

    def _verify(self, token: str) -> dict[str, Any] | None:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        try:
            signature = _b64url_decode(parts[2])
        except Exception:  # noqa: BLE001
            return None
        expected = hmac.new(self._secret, f"{parts[0]}.{parts[1]}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            return None
        try:
            header = json.loads(_b64url_decode(parts[0]))
            payload = json.loads(_b64url_decode(parts[1]))
        except Exception:  # noqa: BLE001
            return None
        if not isinstance(header, dict) or header.get("alg") != "HS256" or not isinstance(payload, dict):
            return None
        now = int(time.time())
        exp = payload.get("exp")
        if isinstance(exp, (int, float)) and now > exp + self._skew:
            return None
        nbf = payload.get("nbf")
        if isinstance(nbf, (int, float)) and now + self._skew < nbf:
            return None
        return payload


def parse_cookies(header: str | None) -> dict[str, str]:
    """Parse a Cookie header value into a name → value map."""
    result: dict[str, str] = {}
    if not header:
        return result
    for pair in header.split(";"):
        name, sep, value = pair.partition("=")
        name = name.strip()
        if not sep or not name:
            continue
        result[name] = unquote(value.strip())
    return result


class CookieAuthenticator:
    """Extracts a credential from a named cookie in the request headers, then
    delegates verification to an inner authenticator (browsers attach cookies
    automatically — no client-side token plumbing needed)."""

    def __init__(self, cookie: str, inner: Authenticator) -> None:
        if not cookie:
            raise ValueError("CookieAuthenticator requires a cookie name")
        self._cookie = cookie
        self._inner = inner

    async def authenticate(self, ctx: AuthContext) -> AuthResult:
        token = parse_cookies(ctx.headers.get("cookie")).get(self._cookie) or ctx.token
        result = self._inner.authenticate(replace(ctx, token=token))
        if hasattr(result, "__await__"):
            result = await result
        return result


__all__ = [
    "StaticTokenAuthenticator",
    "HmacJwtAuthenticator",
    "CookieAuthenticator",
    "parse_cookies",
]
