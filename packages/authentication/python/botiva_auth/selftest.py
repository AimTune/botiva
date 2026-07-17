"""botiva_auth self-test — adapters + the engine connect() hook, deterministic.

    cd packages/authentication/python
    PYTHONPATH=../../core/python python -m botiva_auth.selftest
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import sys

from botiva import AuthContext, AuthenticationError, ConversationEngine, DemoRuntime

from . import CookieAuthenticator, HmacJwtAuthenticator, StaticTokenAuthenticator

_SECRET = "selftest-secret"
_CHECKS: list[tuple[str, bool]] = []


def _check(name: str, ok: bool) -> None:
    _CHECKS.append((name, ok))
    print(f"  {'✅' if ok else '❌'} {name}")


def _make_jwt(sub: str, **extra: object) -> str:
    def enc(obj: object) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    head = enc({"alg": "HS256", "typ": "JWT"})
    body = enc({"sub": sub, **extra})
    sig = base64.urlsafe_b64encode(
        hmac.new(_SECRET.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{head}.{body}.{sig}"


async def main() -> int:
    # StaticTokenAuthenticator
    static = StaticTokenAuthenticator({"sk-alice": "user-alice"})
    _check("static: valid token", (await static.authenticate(AuthContext(token="sk-alice"))).user_id == "user-alice")
    _check("static: invalid token rejected", not (await static.authenticate(AuthContext(token="nope"))).ok)
    _check("static: missing token rejected", not (await static.authenticate(AuthContext())).ok)

    # HmacJwtAuthenticator
    jwt = HmacJwtAuthenticator(_SECRET)
    good = await jwt.authenticate(AuthContext(token=_make_jwt("user-jwt", role="admin")))
    _check("jwt: valid token → verified sub + claims", good.ok and good.user_id == "user-jwt" and good.claims["role"] == "admin")
    forged = _make_jwt("user-jwt")[:-3] + "xxx"
    _check("jwt: forged signature rejected", not (await jwt.authenticate(AuthContext(token=forged))).ok)
    _check("jwt: expired token rejected", not (await jwt.authenticate(AuthContext(token=_make_jwt("u", exp=1)))).ok)
    _check("jwt: malformed token rejected", not (await jwt.authenticate(AuthContext(token="not-a-jwt"))).ok)

    # CookieAuthenticator wraps the JWT verifier
    cookie = CookieAuthenticator("botiva_session", jwt)
    cres = await cookie.authenticate(AuthContext(headers={"cookie": f"x=1; botiva_session={_make_jwt('user-cookie')}"}))
    _check("cookie: credential from Cookie header", cres.ok and cres.user_id == "user-cookie")
    _check("cookie: absent cookie rejected", not (await cookie.authenticate(AuthContext(headers={"cookie": "x=1"}))).ok)

    # Engine connect() hook: reject raises, accept overrides the asserted userId
    from botiva.auth import AuthInput

    engine = ConversationEngine(DemoRuntime(), authenticator=cookie)
    rejected = False
    try:
        await engine.connect(lambda _f: None, auth=AuthInput(transport="test"))
    except AuthenticationError:
        rejected = True
    _check("engine: unauthenticated connect raises", rejected)

    conn = await engine.connect(
        lambda _f: None,
        user_id="user-spoof",
        auth=AuthInput(transport="test", token=_make_jwt("user-verified")),
    )
    _check("engine: verified userId overrides client claim", conn.user_id == "user-verified")

    failed = sum(1 for _, ok in _CHECKS if not ok)
    print("\nAll botiva_auth checks passed ✅" if failed == 0 else f"\n{failed} check(s) failed ❌")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
