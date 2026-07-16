"""Hand-built LangGraph StateGraph on botiva — the Python counterpart of
examples/langgraph-server.ts, but deterministic (a rule-based agent node stands
in for the LLM, so no API key is needed and the selftest is CI-safe):

    START → agent ⇄ tools → END

It exercises every botiva context pattern in real LangGraph code:

  • the agent node reads UserStore via config["configurable"]["botiva"]
    (the explicit, portable pattern — identical in the TS/Go/.NET ports),
  • the remember_name tool writes UserStore via botiva_context() (ambient),
  • the get_weather tool pushes a GenUI card via botiva_emit(ui(...)) (ambient),
  • generate_report_pdf pauses with interrupt() → approval chips in the
    client; "Approve" resumes the tool via Command(resume=...).

Needs: pip install langgraph  (>= 0.2; no model provider required)

    cd ports/python
    python examples/langgraph_server.py               # server on :8796
    python examples/langgraph_server.py --selftest    # + scripted client, exit 0/1

Swap the rule-based agent node for a bound chat model (e.g. ChatAnthropic +
bind_tools) and everything else — transport, engine, HITL — stays identical.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys

from selftest_common import Client, bot_text, passed, tool_done, user_text  # noqa: E402 — also fixes sys.path

from botiva import ConversationEngine, botiva_context, botiva_emit, ui  # noqa: E402
from botiva.langgraph import LangGraphRuntime  # noqa: E402
from botiva.ws import WebSocketServer  # noqa: E402

try:
    from langchain_core.messages import AIMessage
    from langchain_core.runnables import RunnableConfig
    from langchain_core.tools import tool
    from langgraph.graph import END, START, MessagesState, StateGraph
    from langgraph.prebuilt import ToolNode
    from langgraph.types import interrupt

    try:
        from langgraph.checkpoint.memory import InMemorySaver
    except ImportError:  # older langgraph
        from langgraph.checkpoint.memory import MemorySaver as InMemorySaver
except ImportError:
    print(
        "This demo needs LangGraph:  pip install langgraph\n"
        "(the dependency-free demo is examples/server.py)",
        file=sys.stderr,
    )
    sys.exit(1)

PORT = int(os.environ.get("PORT", "8796"))

# ── tools — botiva_emit / botiva_context / interrupt() inside real tools ─────


@tool
async def get_weather(city: str) -> str:
    """Returns a city's weather and shows a weather card in the chat."""
    seed = sum(ord(ch) for ch in city)
    data = {
        "city": city,
        "temp": 12 + seed % 20,
        "condition": ["Sunny", "Partly Cloudy", "Rainy"][seed % 3],
        "humidity": 40 + seed % 40,
    }
    # Ambient emit — the framework knows which conversation/user this turn
    # belongs to; no plumbing through the graph.
    botiva_emit(ui("weather", data))
    return json.dumps(data)


@tool
async def remember_name(name: str) -> str:
    """Stores the user's name in their permanent profile (UserStore)."""
    ctx = botiva_context()
    if ctx is None:
        return "no ambient turn context"
    await ctx.user_store.patch({"name": name})
    return f"Saved. The user's name is {name} (persisted for user {ctx.user_id})."


@tool
def generate_report_pdf(topic: str) -> str:
    """Generates a report PDF on a topic (asks the user for approval first)."""
    # Human approval: the run pauses here (written to the checkpoint);
    # the user's next message returns via Command(resume=...).
    answer = interrupt({
        "question": f'Generate the "{topic}" report as PDF?',
        "options": ["Approve", "Cancel"],
    })
    if not re.search(r"approve|yes|onay|evet", str(answer), re.IGNORECASE):
        return "The user declined — no report was generated."
    file_name = "report-" + re.sub(r"[^a-z0-9]+", "-", topic.lower()) + ".pdf"
    botiva_emit(ui("genui-card", {
        "title": f"📄 {file_name}",
        "description": f'"{topic}" report is ready.',
        "actions": [{"label": "⬇️ Download", "value": f"download {file_name}"}],
    }))
    return f"Report ready: {file_name} (download card shown)."


TOOLS = [get_weather, remember_name, generate_report_pdf]

# ── the graph (hand-built; a rule-based "model" keeps it deterministic) ──────

_NAME_RE = re.compile(r"(?:my name is|ad[ıi]m)\s+(\w+)", re.IGNORECASE | re.UNICODE)
_ASK_NAME_RE = re.compile(r"what.*my name|ad[ıi]m\s+ne", re.IGNORECASE)
# City only when explicitly "weather in <city>"; a bare "weather"/"hava" falls
# through to the Istanbul default rather than grabbing the next word.
_WEATHER_RE = re.compile(r"weather\s+in\s+(\w+)|weather|hava", re.IGNORECASE | re.UNICODE)
_REPORT_RE = re.compile(r"report|pdf|rapor", re.IGNORECASE)

_call_seq = 0


def _tool_call(name: str, args: dict) -> AIMessage:
    global _call_seq
    _call_seq += 1
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": f"call-{_call_seq}"}])


async def agent_node(state: MessagesState, config: RunnableConfig) -> dict:
    """Rule-based stand-in for an LLM node. Reads UserStore through the
    portable config path — swap in `llm.bind_tools(TOOLS)` for the real thing."""
    messages = state["messages"]
    last = messages[-1]

    # A tool just ran → phrase the final answer from its result.
    if getattr(last, "type", "") == "tool":
        text = str(last.content)
        if getattr(last, "name", "") == "get_weather":
            text = "Here is the current weather."
        return {"messages": [AIMessage(content=text or "Done.")]}

    text = last.content if isinstance(last.content, str) else ""
    # Ask-name BEFORE name-set: "adım ne?" ("what's my name") otherwise matches
    # the name-set pattern and clobbers the stored name with "ne".
    if _ASK_NAME_RE.search(text):
        # Explicit TurnContext access — identical in TS/Go/.NET (PROTOCOL.md §9).
        botiva = (config.get("configurable") or {}).get("botiva")
        user = (await botiva.user_store.get() or {}) if botiva else {}
        reply = (
            f"Your name is {user['name']}."
            if user.get("name")
            else "I don't know your name yet — tell me with “my name is …”."
        )
        return {"messages": [AIMessage(content=reply)]}
    if m := _NAME_RE.search(text):
        return {"messages": [_tool_call("remember_name", {"name": m.group(1)})]}
    if (m := _WEATHER_RE.search(text)) is not None:
        return {"messages": [_tool_call("get_weather", {"city": m.group(1) or "Istanbul"})]}
    if _REPORT_RE.search(text):
        return {"messages": [_tool_call("generate_report_pdf", {"topic": "iteration velocity"})]}
    return {"messages": [AIMessage(content=f"Echo: {text}")]}


def route(state: MessagesState) -> str:
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else END


def build_graph():
    builder = StateGraph(MessagesState)
    builder.add_node("agent", agent_node)
    builder.add_node("tools", ToolNode(TOOLS))
    builder.add_edge(START, "agent")
    builder.add_conditional_edges("agent", route, ["tools", END])
    builder.add_edge("tools", "agent")
    return builder.compile(checkpointer=InMemorySaver())


# ── the server (same shape as every botiva server) ───────────────────────────


def build_engine() -> ConversationEngine:
    return ConversationEngine(
        LangGraphRuntime(build_graph()),
        greeting=(
            "Hi! LangGraph (Python) demo. Try: 'My name is Ada', "
            "'What's the weather in Istanbul?', or 'Generate a PDF report' 👋"
        ),
    )


async def selftest(url: str) -> None:
    a = await Client.connect(url)
    welcome = await a.wait_for(lambda f: f.get("type") == "welcome", "welcome")
    user_id = welcome["data"]["userId"]
    conversation_id = welcome["data"]["conversationId"]
    passed("welcome frame (protocol botiva/1)")

    await a.send("My name is Botivan, please remember it.")
    await a.wait_for(lambda f: tool_done(f, "remember_name"), "remember_name tool")
    await a.wait_for(lambda f: bot_text(f, "Botivan"), "name confirmation")
    passed("remember_name tool → UserStore write (ambient botiva_context)")

    await a.send("What's the weather in Istanbul?")
    await a.wait_for(
        lambda f: f.get("type") == "genui" and (f.get("chunk") or {}).get("component") == "weather",
        "weather genui card",
    )
    passed("get_weather → botiva_emit GenUI card")

    await a.send("Generate a PDF report about velocity")
    await a.wait_for(lambda f: f.get("type") == "text" and f.get("actions"), "interrupt chips")
    passed("interrupt() → approval chips")

    await a.send("Approve")
    await a.wait_for(lambda f: tool_done(f, "generate_report_pdf"), "resume completes tool")
    await a.wait_for(
        lambda f: f.get("type") == "genui" and (f.get("chunk") or {}).get("component") == "genui-card",
        "download card after resume",
    )
    await a.wait_for(lambda f: bot_text(f, "Report ready"), "final answer after resume")
    passed("Command(resume) → tool completed + download card")

    b = await Client.connect(f"{url}?userId={user_id}&conversationId={conversation_id}&watermark=0")
    await b.wait_for(lambda f: user_text(f, "My name is Botivan"), "replay")
    passed("watermark replay on reconnect")

    c = await Client.connect(f"{url}?userId={user_id}")
    await c.wait_for(lambda f: f.get("type") == "welcome", "welcome (C)")
    await c.send("What is my name?")
    await c.wait_for(lambda f: bot_text(f, "Botivan"), "name recalled across conversations")
    passed("new conversation, same userId → UserStore recalled in the agent node")

    await a.close()
    await b.close()
    await c.close()


async def main() -> int:
    server = WebSocketServer(build_engine(), port=PORT)
    await server.start()
    print(f"\n✓ botiva LangGraph (Python) demo ready → ws://localhost:{PORT}/chat\n")

    if "--selftest" in sys.argv:
        try:
            await selftest(f"ws://localhost:{PORT}/chat")
        except (TimeoutError, AssertionError, ConnectionError) as err:
            print(f"\nLangGraph selftest failed ❌ {err}", file=sys.stderr)
            return 1
        finally:
            await server.close()
        print("\nLangGraph selftest passed ✅")
        return 0

    await server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
