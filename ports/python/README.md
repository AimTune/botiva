# botiva (Python reference port)

Python 3.10+ port of the botiva conversation framework — same signatures as
`@botiva/core` (see [../../PROTOCOL.md](../../PROTOCOL.md) §8), asyncio-based,
zero dependencies (LangGraph only needed for the adapter's real-graph path).

```
botiva/                     engine, protocol, events, stores, DemoRuntime  (stdlib only)
botiva/ws.py                WebSocket transport — stdlib asyncio RFC 6455 server + client
botiva/langgraph.py         agent adapter for LangGraph (astream_events v2)
botiva/selftest.py          engine self-test                 python -m botiva.selftest
botiva/selftest_langgraph.py adapter self-test (fake graph)  python -m botiva.selftest_langgraph
examples/server.py          demo server (:8795) with --selftest        (stdlib only)
examples/langgraph_server.py real LangGraph demo (:8796) with --selftest (pip install langgraph)
```

## Serve a bot

```py
import asyncio
from botiva import ConversationEngine, DemoRuntime
from botiva.ws import serve

async def main():
    engine = ConversationEngine(DemoRuntime(), greeting="Hi! 👋")
    server = await serve(engine, port=8795)      # ws://localhost:8795/chat
    await server.serve_forever()

asyncio.run(main())
```

The transport accepts identity via query
(`?userId=&conversationId=&watermark=`) **or** a first `hello` frame, and
handles watermark replay, fan-out and HITL exactly like the TS transport.
`botiva.ws.WebSocketClient` is a matching minimal client for scripted tests.
For FastAPI/Starlette, map the same four calls onto their WebSocket objects —
socket open → `engine.connect(...)`, inbound → `conn.receive(...)`, close →
`conn.close()`, `deliver` → socket send.

## Agent framework — LangGraph

`botiva.langgraph.LangGraphRuntime` mirrors `@botiva/langgraph` exactly:
`astream_events` v2 → tool_call/message events, `interrupt()` → botiva
interrupt (approval chips), the user's next message → `Command(resume=...)`,
custom `genui` events → GenUI streams.

```py
from botiva import ConversationEngine, botiva_emit, botiva_context, ui
from botiva.langgraph import LangGraphRuntime
from langgraph.types import interrupt

@tool
def generate_report_pdf(topic: str) -> str:
    """Generates a report PDF (asks the user for approval first)."""
    answer = interrupt({"question": f'Generate "{topic}"?', "options": ["Approve", "Cancel"]})
    if not re.search(r"approve|yes|onay|evet", str(answer), re.I):
        return "The user declined."
    botiva_emit(ui("genui-card", {"title": "📄 report.pdf"}))     # ambient GenUI
    return "Report ready."

graph = builder.compile(checkpointer=InMemorySaver())   # checkpointer required
engine = ConversationEngine(LangGraphRuntime(graph), greeting="hi")
```

Inside nodes/tools, `botiva_context()` gives the `TurnContext`
(user_store/conversation_store) and `botiva_emit(...)` pushes GenUI/events
(contextvars); `config["configurable"]["botiva"]` is the explicit,
LangGraph-native alternative. `thread_id` = botiva `conversation_id`.

## Run / test

```sh
python -m botiva.selftest                       # engine self-test, exit 0/1
python -m botiva.selftest_langgraph             # adapter self-test (no langgraph needed)
python examples/server.py                       # demo server on :8795 (PORT overridable)
python examples/server.py --selftest            # + scripted WS client, exit 0/1
python examples/langgraph_server.py --selftest  # real LangGraph: interrupt()/Command(resume)
                                                # (pip install langgraph; no model/API key)
```

`examples/langgraph_server.py` is a hand-built `StateGraph` whose agent node
is rule-based, so the full LangGraph machinery — `ToolNode`, checkpointer,
`interrupt()`/`Command(resume=...)` — runs deterministically without an API
key. Swap the agent node for `llm.bind_tools(TOOLS)` and everything else stays
identical.
