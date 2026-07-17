"""LangGraphRuntime — plugs any compiled LangGraph graph into the botiva
Runtime port (the Python counterpart of @botiva/langgraph; same event mapping).

    astream_events v2               → tool_call / message events
    LangGraph interrupt()           → botiva interrupt event (HITL)
    Command(resume=...)             → resumes the paused run with the user's answer
    adispatch_custom_event("genui", {"component": ..., "props": ...})
                                    → genui event (client GenUIRegistry component)

Inside graph nodes/tools you can also use the botiva context directly:

    from botiva import botiva_emit, botiva_context, ui

    async def my_node(state, config):
        botiva_emit(ui("weather-card", {"temp": 22}))       # ambient (contextvars)
        botiva = config["configurable"]["botiva"]           # explicit TurnContext
        await botiva.user_store.patch({"seen": True})

Requirement: compile the graph with a checkpointer (InMemorySaver, or a Redis/
Postgres saver at scale). LangGraph ``thread_id`` = botiva ``conversation_id``.

    from langgraph.graph import StateGraph
    from langgraph.checkpoint.memory import InMemorySaver
    graph = builder.compile(checkpointer=InMemorySaver())
    engine = ConversationEngine(LangGraphRuntime(graph), greeting="hi")
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, AsyncIterator, Callable

from botiva.engine import TurnContext
from botiva.events import (
    AgentEvent,
    genui,
    interrupt as interrupt_event,
    message,
    run_error,
    run_finished,
    run_started,
    tool_call,
)

__all__ = ["LangGraphRuntime"]


def _message_text(msg: Any) -> str:
    """Text of an AIMessage-like object (str content or content-block list)."""
    content = getattr(msg, "content", None)
    if content is None and isinstance(msg, dict):
        content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


def _short(value: Any, max_len: int = 600) -> str:
    if not isinstance(value, str):
        try:
            value = json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            value = str(value)
    return value[:max_len] + "…" if value and len(value) > max_len else (value or "")


_INTERRUPT_RE = re.compile(r"GraphInterrupt|NodeInterrupt|Interrupt", re.IGNORECASE)


def _is_interrupt_error(err: Any) -> bool:
    """interrupt() raises GraphInterrupt inside a tool; astream_events surfaces
    it in on_tool_error in varying shapes — recognize them all (mirror of the
    TS adapter's sniffing)."""
    if err is None:
        return False
    name = type(err).__name__
    if _INTERRUPT_RE.search(name):
        return True
    text = str(err)
    if _INTERRUPT_RE.search(text):
        return True
    # Sometimes the interrupt surfaces as the payload JSON string with no
    # "Interrupt" in it, e.g. '[{"value": {...}, "id": "..."}]'. (mirror of TS)
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return False
    return (
        isinstance(parsed, list)
        and len(parsed) > 0
        and all(isinstance(item, dict) and ("value" in item or "id" in item) for item in parsed)
    )


def _default_command_factory() -> Callable[[Any], Any]:
    try:
        from langgraph.types import Command  # noqa: PLC0415 — lazy on purpose
    except ImportError as err:  # pragma: no cover
        raise ImportError(
            "botiva_langgraph needs the `langgraph` package for HITL resume "
            "(pip install langgraph), or pass command_factory= explicitly."
        ) from err
    return lambda resume: Command(resume=resume)


class LangGraphRuntime:
    """The only port an agent framework adapter implements (PROTOCOL.md §8)."""

    def __init__(
        self,
        graph: Any,
        *,
        recursion_limit: int = 25,
        tool_trace: bool = True,
        config: dict[str, Any] | None = None,
        command_factory: Callable[[Any], Any] | None = None,
    ) -> None:
        """graph: anything with ``astream_events(input, config, version="v2")``
        and ``aget_state(config)`` — i.e. a compiled LangGraph graph.

        config: extra RunnableConfig merged into every run — callbacks
        (LangSmith/custom tracers), tags, metadata, configurable entries...
        """
        self.graph = graph
        self.recursion_limit = recursion_limit
        self.tool_trace = tool_trace
        self.config = config or {}
        self._command_factory = command_factory

    async def run(self, input: dict[str, Any], ctx: TurnContext) -> AsyncIterator[AgentEvent]:
        config: dict[str, Any] = {
            **self.config,
            "recursion_limit": self.recursion_limit,
            "configurable": {
                **(self.config.get("configurable") or {}),
                "thread_id": ctx.conversation_id,
                "botiva": ctx,  # explicit TurnContext for nodes/tools
            },
        }
        # resume → continue the paused run via Command; otherwise a fresh user message.
        if "resume" in input:
            factory = self._command_factory or _default_command_factory()
            payload: Any = factory(input["resume"])
        else:
            payload = {"messages": [{"role": "user", "content": input.get("text", "")}]}

        yield run_started()
        final_message: Any = None
        # Fallback for graphs without a chat model (deterministic StateGraphs):
        # the last message of the graph's own output state.
        graph_output_message: Any = None
        # interrupt() fires in the MIDDLE of a tool: its on_tool_end never
        # arrives. Track open calls so the client spinner doesn't hang.
        open_tool_calls: dict[str, str] = {}  # run_id → name

        async for ev in self.graph.astream_events(payload, config, version="v2"):
            kind = ev.get("event")
            name = ev.get("name")
            run_id = str(ev.get("run_id") or "tool")
            data = ev.get("data") or {}

            if kind == "on_custom_event" and name == "genui" and data:
                # Either a full AIChunk or the {component, props} shorthand.
                chunk = (
                    dict(data)
                    if data.get("type")
                    else {"type": "ui", "component": data.get("component", "unknown"),
                          "props": data.get("props") or {}}
                )
                yield genui(chunk)  # engine groups chunks & closes the stream
            elif kind == "on_tool_start":
                open_tool_calls[run_id] = name or "tool"
                if self.tool_trace:
                    yield tool_call(run_id, name or "tool", "running",
                                    params=data.get("input"), startedAt=_now_ms())
            elif kind == "on_tool_end":
                open_tool_calls.pop(run_id, None)
                if self.tool_trace:
                    output = data.get("output")
                    result = _short(_message_text(output) or getattr(output, "content", output))
                    yield tool_call(run_id, name or "tool", "completed",
                                    result=result or "(empty result)", endedAt=_now_ms())
            elif kind == "on_tool_error":
                open_tool_calls.pop(run_id, None)
                if not self.tool_trace:
                    continue
                err = data.get("error")
                if _is_interrupt_error(err):
                    # GraphInterrupt is not an error — it's the HITL pause.
                    yield tool_call(run_id, name or "tool", "completed",
                                    result="⏸ waiting for user approval", endedAt=_now_ms())
                else:
                    yield tool_call(run_id, name or "tool", "error",
                                    error=str(err or "tool error"), endedAt=_now_ms())
            elif kind == "on_chat_model_end":
                final_message = data.get("output")
            elif kind == "on_chain_end":
                output = data.get("output")
                messages = output.get("messages") if isinstance(output, dict) else None
                if isinstance(messages, list) and messages:
                    graph_output_message = messages[-1]

        # Did the graph stop on interrupt()? Then a pending task sits in the
        # checkpoint → HITL (the engine stores it; the next message resumes).
        state = await self.graph.aget_state({"configurable": {"thread_id": ctx.conversation_id}})
        pending = [
            intr
            for task in (getattr(state, "tasks", None) or ())
            for intr in (getattr(task, "interrupts", None) or ())
        ]
        if pending:
            if self.tool_trace:
                for open_id, open_name in open_tool_calls.items():
                    yield tool_call(open_id, open_name, "completed",
                                    result="⏸ waiting for user approval", endedAt=_now_ms())
            first = pending[0]
            yield interrupt_event(getattr(first, "value", first), getattr(first, "id", None))
            yield run_finished()
            return

        text = (_message_text(final_message) or _message_text(graph_output_message)).strip()
        if text:
            yield message(text)
        else:
            yield run_error("empty response")
        yield run_finished()


def _now_ms() -> int:
    return int(time.time() * 1000)
