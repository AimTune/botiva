"""Shared scripted-client harness for the Python example selftests
(the counterpart of the Client class in examples/langgraph-server.ts)."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Callable

# Allow `python examples/server.py` straight from ports/python without install.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from botiva.ws import WebSocketClient  # noqa: E402


class Client:
    """Collects every frame from one socket; wait_for() blocks on a predicate."""

    def __init__(self, ws: WebSocketClient) -> None:
        self._ws = ws
        self.frames: list[dict[str, Any]] = []
        self._new_frame = asyncio.Event()
        self._pump_task = asyncio.create_task(self._pump())

    @classmethod
    async def connect(cls, url: str) -> "Client":
        return cls(await WebSocketClient.connect(url))

    async def _pump(self) -> None:
        while True:
            text = await self._ws.recv()
            if text is None:
                self._new_frame.set()
                return
            try:
                frame = json.loads(text)
            except json.JSONDecodeError:
                continue
            self.frames.append(frame)
            self._new_frame.set()

    async def send(self, text: str) -> None:
        await self._ws.send(json.dumps({"type": "text", "data": {"text": text}}))

    async def send_raw(self, frame: dict[str, Any]) -> None:
        await self._ws.send(json.dumps(frame))

    async def wait_for(
        self, pred: Callable[[dict[str, Any]], bool], label: str, timeout: float = 5.0
    ) -> dict[str, Any]:
        scanned = 0
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            while scanned < len(self.frames):
                frame = self.frames[scanned]
                scanned += 1
                if pred(frame):
                    return frame
            if self._pump_task.done():
                raise TimeoutError(f"{label}: connection closed before match")
            self._new_frame.clear()
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError(f"timeout: {label}")
            try:
                await asyncio.wait_for(self._new_frame.wait(), remaining)
            except asyncio.TimeoutError as err:
                raise TimeoutError(f"timeout: {label}") from err

    async def close(self) -> None:
        self._pump_task.cancel()
        await self._ws.close()


def bot_text(frame: dict[str, Any], contains: str) -> bool:
    return (
        frame.get("type") == "text"
        and frame.get("from") == "bot"
        and contains in (frame.get("data") or {}).get("text", "")
    )


def user_text(frame: dict[str, Any], contains: str) -> bool:
    return (
        frame.get("type") == "text"
        and frame.get("from") == "user"
        and contains in (frame.get("data") or {}).get("text", "")
    )


def tool_done(frame: dict[str, Any], name: str) -> bool:
    data = frame.get("data") or {}
    return (
        frame.get("type") == "tool_call"
        and data.get("name") == name
        and data.get("status") == "completed"
    )


def passed(name: str) -> None:
    print(f"  ✅ {name}")
