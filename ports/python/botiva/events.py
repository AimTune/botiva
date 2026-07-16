"""botiva agent events — factories mirror @botiva/core (PROTOCOL.md §4).

An AgentEvent is a plain dict with a ``type`` discriminator, which keeps the
wire mapping transparent and the port dependency-free:

    run_started | run_finished | run_error | message | tool_call |
    interrupt | genui | busy
"""

from __future__ import annotations

import time
from typing import Any

AgentEvent = dict[str, Any]


def run_started() -> AgentEvent:
    return {"type": "run_started"}


def run_finished() -> AgentEvent:
    return {"type": "run_finished"}


def run_error(error: Any) -> AgentEvent:
    return {"type": "run_error", "error": str(error)}


def busy() -> AgentEvent:
    return {"type": "busy"}


def message(text: str, actions: list[dict[str, Any]] | None = None) -> AgentEvent:
    ev: AgentEvent = {"type": "message", "text": text}
    if actions:
        ev["actions"] = actions
    return ev


def tool_call(id: str, name: str, status: str, **extra: Any) -> AgentEvent:
    """status: "running" | "completed" | "error"; extra: params/result/error/startedAt/endedAt."""
    return {"type": "tool_call", "toolCall": {"id": id, "name": name, "status": status, **extra}}


def interrupt(payload: Any, id: str | None = None) -> AgentEvent:
    """Recommended payload: {"question": str, "options": [...]} → rendered as chips."""
    return {"type": "interrupt", "payload": payload, "id": id}


def genui(chunk: dict[str, Any], stream_id: str | None = None, done: bool = False) -> AgentEvent:
    ev: AgentEvent = {"type": "genui", "chunk": chunk, "done": done}
    if stream_id is not None:
        ev["streamId"] = stream_id
    return ev


def ui(component: str, props: dict[str, Any] | None = None) -> AgentEvent:
    """Mount a client-registered component (chativa GenUIRegistry)."""
    return genui({"type": "ui", "component": component, "props": props or {}})


def now_ms() -> int:
    return int(time.time() * 1000)
