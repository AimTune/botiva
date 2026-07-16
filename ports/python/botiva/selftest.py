"""botiva Python port self-test — same scenario as the Go test / TS smoke test.

    python -m botiva.selftest
"""

from __future__ import annotations

import asyncio
import json
import sys

from . import ConversationEngine, DemoRuntime

CHECKS: list[tuple[str, bool]] = []


def check(name: str, ok: bool) -> None:
    CHECKS.append((name, ok))
    print(f"  {'✅' if ok else '❌'} {name}")


def bot_text(frame, contains):
    return (frame.get("type") == "text" and frame.get("from") == "bot"
            and contains in (frame.get("data") or {}).get("text", ""))


def user_text(frame, contains):
    return (frame.get("type") == "text" and frame.get("from") == "user"
            and contains in (frame.get("data") or {}).get("text", ""))


async def main() -> int:
    engine = ConversationEngine(DemoRuntime(), greeting="py-greeting")

    def msg(text: str) -> str:
        return json.dumps({"type": "text", "data": {"text": text}})

    # 1. fresh connect → welcome + greeting
    a: list = []
    conn_a = await engine.connect(a.append)
    welcome = next(f for f in a if f.get("type") == "welcome")
    check("welcome frame (protocol botiva/1)", welcome["data"]["protocol"] == "botiva/1")
    conversation_id = welcome["data"]["conversationId"]
    user_id = welcome["data"]["userId"]
    check("greeting delivered", any(bot_text(f, "py-greeting") for f in a))

    # 2. echo turn
    await conn_a.receive(msg("hello world"))
    check("echo reply", any(bot_text(f, "Echo: hello world") for f in a))
    check("run frames", any(f.get("type") == "run" for f in a))

    # 3. user state
    await conn_a.receive(msg("my name is Hamza"))
    check("UserStore write", any(bot_text(f, "Nice to meet you, Hamza") for f in a))

    # 4. tool_call + HITL + resume
    await conn_a.receive(msg("report please"))
    check("tool_call frames", any(f.get("type") == "tool_call" for f in a))
    check("interrupt chips", any(f.get("type") == "text" and f.get("actions") for f in a))
    await conn_a.receive(msg("Approve"))
    check("HITL resume", any(bot_text(f, "Approved") for f in a))

    # 5. botiva_emit genui + auto close
    await conn_a.receive(msg("weather"))
    check("botiva_emit genui frame", any(f.get("type") == "genui" for f in a))
    check("genui stream auto-closed",
          any(f.get("type") == "genui" and f.get("done") is True for f in a))

    # 6. replay on reconnect + fan-out
    b: list = []
    conn_b = await engine.connect(
        b.append, conversation_id=conversation_id, user_id=user_id, watermark=0)
    check("replay: user + bot frames",
          any(user_text(f, "hello world") for f in b) and
          any(bot_text(f, "Echo: hello world") for f in b))
    welcome_b = next(f for f in b if f.get("type") == "welcome")
    check("reconnect watermark > 0", welcome_b["data"]["watermark"] > 0)

    await conn_b.receive(msg("sync test"))
    check("fan-out to first connection", any(user_text(f, "sync test") for f in a))
    check("no self-echo to sender", not any(user_text(f, "sync test") for f in b))

    # 7. user state across conversations
    c: list = []
    conn_c = await engine.connect(c.append, user_id=user_id)
    await conn_c.receive(msg("what's my name"))
    check("UserStore across conversations", any(bot_text(f, "Your name is Hamza") for f in c))

    await conn_a.close()
    await conn_b.close()
    await conn_c.close()

    failed = sum(1 for _, ok in CHECKS if not ok)
    print("\nAll Python port checks passed ✅" if failed == 0 else f"\n{failed} check(s) failed ❌")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
