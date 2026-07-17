"""botiva Python demo server — DemoRuntime behind the stdlib WebSocket
transport. Deterministic, no dependencies, no API key: welcome/identity, echo,
UserStore, tool_call + HITL resume, ambient-emit GenUI, watermark replay.

    python examples/python/server.py               # from the repo root, server on :8795
    python examples/python/server.py --selftest    # + scripted WS client, exit 0/1

Browser console:
    s = new WebSocket("ws://localhost:8795/chat")
    s.onmessage = e => console.log(JSON.parse(e.data))
    s.onopen = () => s.send(JSON.stringify({type:"text",data:{text:"report please"}}))
"""

from __future__ import annotations

import asyncio
import os
import sys

from selftest_common import Client, bot_text, passed, user_text  # noqa: E402 — also fixes sys.path

from botiva import ConversationEngine, DemoRuntime  # noqa: E402
from botiva_ws import WebSocketServer  # noqa: E402

PORT = int(os.environ.get("PORT", "8795"))


def build_engine() -> ConversationEngine:
    return ConversationEngine(
        DemoRuntime(),
        greeting="Hi! botiva Python demo. Try: 'my name is Ada', 'weather', or 'report please' 👋",
    )


async def selftest(url: str) -> None:
    """Same scenario as the Go/.NET example selftests."""
    a = await Client.connect(url)
    welcome = await a.wait_for(lambda f: f.get("type") == "welcome", "welcome")
    assert welcome["data"]["protocol"] == "botiva/1", welcome
    conversation_id = welcome["data"]["conversationId"]
    user_id = welcome["data"]["userId"]
    passed("welcome frame (protocol botiva/1)")

    await a.wait_for(lambda f: bot_text(f, "Python demo"), "greeting")
    passed("greeting delivered")

    await a.send("hello world")
    await a.wait_for(lambda f: bot_text(f, "Echo: hello world"), "echo")
    passed("echo turn over the wire")

    await a.send("my name is Botivan")
    await a.wait_for(lambda f: bot_text(f, "Botivan"), "name saved")
    passed("UserStore write")

    await a.send("report please")
    await a.wait_for(lambda f: f.get("type") == "tool_call", "tool_call frame")
    await a.wait_for(
        lambda f: f.get("type") == "text" and f.get("actions"), "interrupt chips"
    )
    passed("tool_call + interrupt chips")

    await a.send("Approve")
    await a.wait_for(lambda f: bot_text(f, "Approved"), "HITL resume")
    passed("HITL resume via next message")

    await a.send("weather")
    await a.wait_for(lambda f: f.get("type") == "genui", "genui frame")
    await a.wait_for(
        lambda f: f.get("type") == "genui" and f.get("done") is True, "genui auto close"
    )
    passed("ambient-emit GenUI + auto stream close")

    b = await Client.connect(f"{url}?userId={user_id}&conversationId={conversation_id}&watermark=0")
    await b.wait_for(lambda f: user_text(f, "hello world"), "replay: user frame")
    await b.wait_for(lambda f: bot_text(f, "Echo: hello world"), "replay: bot frame")
    passed("watermark replay on reconnect")

    await b.send("sync test")
    await a.wait_for(lambda f: user_text(f, "sync test"), "fan-out")
    passed("multi-connection fan-out")

    c = await Client.connect(url)
    await c.send_raw({"type": "hello", "userId": user_id})
    await c.wait_for(lambda f: f.get("type") == "welcome", "welcome via hello frame")
    await c.send("what's my name")
    await c.wait_for(lambda f: bot_text(f, "Your name is Botivan"), "cross-conversation state")
    passed("hello-frame identity + UserStore across conversations")

    await a.close()
    await b.close()
    await c.close()


async def main() -> int:
    server = WebSocketServer(build_engine(), port=PORT)
    await server.start()
    print(f"\n✓ botiva Python demo ready → ws://localhost:{PORT}/chat\n")

    if "--selftest" in sys.argv:
        try:
            await selftest(f"ws://localhost:{PORT}/chat")
        except (TimeoutError, AssertionError, ConnectionError) as err:
            print(f"\nPython transport selftest failed ❌ {err}", file=sys.stderr)
            return 1
        finally:
            await server.close()
        print("\nPython transport selftest passed ✅")
        return 0

    await server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
