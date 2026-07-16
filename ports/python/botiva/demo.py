"""DemoRuntime — dependency-free reference implementation of the Runtime port
(same behavior as the TS/Go/.NET DemoRuntime; used by ``python -m botiva.selftest``).
"""

from __future__ import annotations

import re
import time
from typing import Any, AsyncIterator

from .engine import TurnContext, botiva_emit
from .events import (
    AgentEvent,
    interrupt,
    message,
    run_finished,
    run_started,
    tool_call,
    ui,
)

_NAME_RE = re.compile(r"(?:my name is|ad[ıi]m)\s+(\w+)", re.IGNORECASE | re.UNICODE)
_ASK_NAME_RE = re.compile(r"what.*my name|ad[ıi]m ne", re.IGNORECASE)
_APPROVE_RE = re.compile(r"approve|yes|onay|evet", re.IGNORECASE)


class DemoRuntime:
    async def run(self, input: dict[str, Any], ctx: TurnContext) -> AsyncIterator[AgentEvent]:
        yield run_started()

        if "resume" in input:
            ok = bool(_APPROVE_RE.search(str(input["resume"])))
            yield message(
                "✅ Approved — the PDF report is ready: report-2025.pdf"
                if ok else "❌ Cancelled — no report was generated."
            )
            yield run_finished()
            return

        text = (input.get("text") or "").strip()

        if m := _NAME_RE.search(text):
            await ctx.user_store.patch({"name": m.group(1)})
            yield message(f"Nice to meet you, {m.group(1)}! I'll remember that across conversations.")
        elif _ASK_NAME_RE.search(text):
            user = await ctx.user_store.get() or {}
            yield message(
                f"Your name is {user['name']}." if user.get("name")
                else "I don't know your name yet — tell me with “my name is …”."
            )
        elif re.search(r"weather|hava", text, re.IGNORECASE):
            # Out-of-band emit through the ambient context (contextvars).
            botiva_emit(ui("weather", {"city": "Istanbul", "temp": 22, "condition": "Sunny"}))
            yield message("Here is the current weather.")
        elif re.search(r"report|rapor", text, re.IGNORECASE):
            tool_id = f"demo-{int(time.time() * 1000)}"
            yield tool_call(tool_id, "get_iteration_performance", "running",
                            params={"tribeId": 3, "iterationYear": 2025})
            yield tool_call(tool_id, "get_iteration_performance", "completed",
                            result={"velocity": 42, "commitmentRate": 0.87})
            yield interrupt({
                "question": "Velocity 42, commitment 87%. Generate the PDF report?",
                "options": ["Approve", "Cancel"],
            })
        else:
            yield message(f"Echo: {text}")

        yield run_finished()
