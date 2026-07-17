"""Botiva Wire Protocol v1 — frame parsing + the canonical event→frame mapping.

Must stay byte-compatible with @botiva/core (PROTOCOL.md §3–4). Frames are
plain dicts; persistent frames get a monotonic ``seq`` from the HistoryStore.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

from .events import AgentEvent, now_ms

PROTOCOL_VERSION = "botiva/1"
PERSISTENT_FRAME_TYPES = ("text", "tool_call", "genui")

Frame = dict[str, Any]


@dataclass
class IncomingMessage:
    text: str
    id: str | None = None
    meta: dict[str, Any] | None = None


@dataclass
class Hello:
    user_id: str | None = None
    conversation_id: str | None = None
    watermark: int | None = None
    token: str | None = None  # auth credential (§2.1), when the server authenticates
    meta: dict[str, Any] | None = None


@dataclass
class Inbound:
    hello: Hello | None = None
    message: IncomingMessage | None = None


def parse_incoming(raw: Any) -> Inbound | None:
    """Accepts a JSON string, a parsed frame dict, bytes or plain text."""
    value: Any = raw
    if isinstance(raw, (bytes, bytearray)):
        value = raw.decode("utf-8", errors="replace")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            text = value.strip()
            return Inbound(message=IncomingMessage(text=text)) if text else None
    if not isinstance(value, dict):
        return None
    if value.get("type") == "hello":
        watermark = value.get("watermark")
        return Inbound(hello=Hello(
            user_id=value.get("userId"),
            conversation_id=value.get("conversationId"),
            watermark=int(watermark) if watermark is not None else None,
            token=value.get("token"),
            meta=value.get("meta"),
        ))
    data = value.get("data") if isinstance(value.get("data"), dict) else {}
    text = str(data.get("text") or value.get("text") or "").strip()
    if not text:
        return None
    return Inbound(message=IncomingMessage(
        text=text,
        id=value.get("id") if isinstance(value.get("id"), str) else None,
        meta=value.get("meta") if isinstance(value.get("meta"), dict) else None,
    ))


def error_frame(code: str, message: str) -> Frame:
    """Build a transient ``error`` frame (auth rejection, protocol error)."""
    return {"type": "error", "data": {"code": code, "message": message}}


@dataclass
class FrameMapping:
    frame: Frame
    persistent: bool


def event_to_frames(ev: AgentEvent, new_id: Callable[[str], str]) -> list[FrameMapping]:
    """The canonical AgentEvent → wire frame mapping (PROTOCOL.md §4)."""
    now = now_ms()

    def text_frame(text: str, **extra: Any) -> Frame:
        return {
            "type": "text",
            "id": new_id("msg"),
            "from": "bot",
            "data": {"text": text},
            "timestamp": now,
            **extra,
        }

    kind = ev.get("type")
    if kind == "message":
        extra = {"actions": ev["actions"]} if ev.get("actions") else {}
        return [FrameMapping(text_frame(ev.get("text", ""), **extra), True)]
    if kind == "tool_call":
        return [FrameMapping({"type": "tool_call", "data": ev.get("toolCall")}, True)]
    if kind == "genui":
        return [FrameMapping({
            "type": "genui",
            "streamId": ev.get("streamId") or new_id("stream"),
            "chunk": ev.get("chunk"),
            "done": ev.get("done") is True,
        }, True)]
    if kind == "interrupt":
        payload = ev.get("payload") or {}
        if isinstance(payload, str):
            question, options = payload, ["Approve", "Cancel"]
        else:
            question = str(payload.get("question") or payload.get("message")
                           or "Your confirmation is needed to continue.")
            options = payload.get("options") or ["Approve", "Cancel"]
        actions = [{"label": o} if isinstance(o, str) else o for o in options]
        return [FrameMapping(text_frame(question, actions=actions), True)]
    if kind == "busy":
        return [FrameMapping(text_frame("⏳ Still working on the previous message — one moment."), False)]
    if kind == "run_started":
        return [FrameMapping({"type": "run", "data": {"status": "started"}}, False)]
    if kind == "run_finished":
        return [FrameMapping({"type": "run", "data": {"status": "finished"}}, False)]
    if kind == "run_error":
        return [
            FrameMapping(text_frame(f"⚠️ {ev.get('error')}"), True),
            FrameMapping({"type": "run", "data": {"status": "finished"}}, False),
        ]
    return []
