"""LangGraphRuntime adapter self-test — runs WITHOUT langgraph installed by
driving the adapter with a fake graph (the real-graph end-to-end lives in
examples/langgraph_server.py).

    python -m botiva_langgraph.selftest
"""

from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace
from typing import Any

from botiva import ConversationEngine

from . import LangGraphRuntime

CHECKS: list[tuple[str, bool]] = []


def check(name: str, ok: bool) -> None:
    CHECKS.append((name, ok))
    print(f"  {'✅' if ok else '❌'} {name}")


class FakeCommand:
    def __init__(self, resume: Any) -> None:
        self.resume = resume


class FakeGraph:
    """Mimics a compiled LangGraph: astream_events v2 + aget_state, including
    the interrupt-in-checkpoint shape (state.tasks[].interrupts[])."""

    def __init__(self) -> None:
        self.pending_interrupt: Any = None
        self.seen_resume: Any = None

    async def astream_events(self, payload: Any, config: dict, version: str = "v2"):
        assert version == "v2"
        assert config["configurable"]["thread_id"], "thread_id must be set"
        assert config["configurable"]["botiva"] is not None, "botiva ctx must be injected"

        if isinstance(payload, FakeCommand):  # resume pass
            self.seen_resume = payload.resume
            self.pending_interrupt = None
            yield {"event": "on_tool_end", "name": "generate_report", "run_id": "run-1",
                   "data": {"output": {"content": "report done"}}}
            yield {"event": "on_chat_model_end",
                   "data": {"output": {"content": "✅ Approved and generated."}}}
            return

        text = payload["messages"][0]["content"]
        if "report" in text:
            yield {"event": "on_tool_start", "name": "generate_report", "run_id": "run-1",
                   "data": {"input": {"topic": "velocity"}}}
            # interrupt() fires mid-tool: no on_tool_end, pending task in state
            self.pending_interrupt = SimpleNamespace(
                value={"question": "Generate the report?", "options": ["Approve", "Cancel"]},
                id="intr-1",
            )
            return

        yield {"event": "on_custom_event", "name": "genui",
               "data": {"component": "weather", "props": {"temp": 22}}}
        yield {"event": "on_tool_start", "name": "get_weather", "run_id": "run-2",
               "data": {"input": {"city": "Istanbul"}}}
        yield {"event": "on_tool_end", "name": "get_weather", "run_id": "run-2",
               "data": {"output": {"content": '{"temp": 22}'}}}
        # deterministic graphs without a chat model → answer via on_chain_end
        yield {"event": "on_chain_end", "name": "LangGraph",
               "data": {"output": {"messages": [{"content": "Here is the weather."}]}}}

    async def aget_state(self, config: dict) -> Any:
        tasks = (
            [SimpleNamespace(interrupts=[self.pending_interrupt])]
            if self.pending_interrupt
            else []
        )
        return SimpleNamespace(tasks=tasks)


async def main() -> int:
    graph = FakeGraph()
    runtime = LangGraphRuntime(graph, command_factory=FakeCommand)
    engine = ConversationEngine(runtime)

    frames: list[dict[str, Any]] = []
    conn = await engine.connect(frames.append)

    def msg(text: str) -> str:
        import json

        return json.dumps({"type": "text", "data": {"text": text}})

    # 1. plain turn: genui custom event + tool trace + chain-end fallback text
    await conn.receive(msg("weather please"))
    check("genui custom event mapped",
          any(f.get("type") == "genui" and (f.get("chunk") or {}).get("component") == "weather"
              for f in frames))
    check("tool trace mapped (running + completed)",
          any(f.get("type") == "tool_call" and (f.get("data") or {}).get("status") == "running"
              for f in frames)
          and any(f.get("type") == "tool_call" and (f.get("data") or {}).get("status") == "completed"
                  for f in frames))
    check("graph-output fallback message",
          any((f.get("data") or {}).get("text") == "Here is the weather." for f in frames))

    # 2. interrupt turn: pending task in the checkpoint → chips + open-call close
    frames.clear()
    await conn.receive(msg("report please"))
    check("interrupt → approval chips",
          any(f.get("type") == "text" and f.get("actions") for f in frames))
    check("open tool call closed on interrupt",
          any(f.get("type") == "tool_call"
              and "waiting" in str((f.get("data") or {}).get("result", ""))
              for f in frames))

    # 3. resume turn: the next message becomes Command(resume=...)
    frames.clear()
    await conn.receive(msg("Approve"))
    check("resume forwarded via command_factory", graph.seen_resume == "Approve")
    check("resume answer delivered",
          any("Approved and generated" in str((f.get("data") or {}).get("text", ""))
              for f in frames))

    # 4. interrupt recognized even when it surfaces as a bare JSON payload string
    # (no "Interrupt" substring) — the on_tool_error classification path.
    from . import _is_interrupt_error
    check("interrupt recognized via class name", _is_interrupt_error(RuntimeError("GraphInterrupt raised")))
    check("interrupt recognized via JSON payload sniff",
          _is_interrupt_error('[{"value": {"question": "ok?"}, "id": "intr-1"}]'))
    check("plain tool error is not an interrupt", not _is_interrupt_error("boom: connection refused"))

    await conn.close()
    failed = sum(1 for _, ok in CHECKS if not ok)
    print("\nAll LangGraph adapter checks passed ✅" if failed == 0
          else f"\n{failed} check(s) failed ❌")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
