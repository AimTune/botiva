"""State & history ports (PROTOCOL.md §6, §8) — asyncio implementations."""

from __future__ import annotations

from typing import Any, Protocol

from .protocol import Frame


class StateStore(Protocol):
    async def get(self, key: str) -> Any: ...
    async def set(self, key: str, value: Any) -> None: ...
    async def delete(self, key: str) -> None: ...


class MemoryStateStore:
    def __init__(self) -> None:
        self._map: dict[str, Any] = {}

    async def get(self, key: str) -> Any:
        return self._map.get(key)

    async def set(self, key: str, value: Any) -> None:
        self._map[key] = value

    async def delete(self, key: str) -> None:
        self._map.pop(key, None)


class ScopedStore:
    """A namespaced view over one StateStore key."""

    def __init__(self, store: StateStore, key: str) -> None:
        self._store = store
        self.key = key

    async def get(self) -> dict[str, Any] | None:
        return await self._store.get(self.key)

    async def set(self, value: dict[str, Any]) -> None:
        await self._store.set(self.key, value)

    async def patch(self, partial: dict[str, Any]) -> dict[str, Any]:
        """Shallow-merge; ``None`` values delete keys."""
        current = dict(await self.get() or {})
        for k, v in partial.items():
            if v is None:
                current.pop(k, None)
            else:
                current[k] = v
        await self.set(current)
        return current

    async def delete(self) -> None:
        await self._store.delete(self.key)


class UserStore(ScopedStore):
    """Per-user state — survives conversations, devices and reconnects."""

    def __init__(self, store: StateStore, user_id: str) -> None:
        super().__init__(store, f"user:{user_id}")
        self.user_id = user_id


class ConversationStore(ScopedStore):
    """Per-conversation state — shared by every attached connection."""

    def __init__(self, store: StateStore, conversation_id: str) -> None:
        super().__init__(store, f"conv:{conversation_id}")
        self.conversation_id = conversation_id


class HistoryStore(Protocol):
    async def append(self, conversation_id: str, frame: Frame) -> int: ...
    async def after(self, conversation_id: str, watermark: int) -> list[Frame]: ...
    async def latest(self, conversation_id: str) -> int: ...


class MemoryHistoryStore:
    def __init__(self, max_frames: int = 1000) -> None:
        self._max_frames = max_frames
        self._convs: dict[str, dict[str, Any]] = {}

    async def append(self, conversation_id: str, frame: Frame) -> int:
        conv = self._convs.setdefault(conversation_id, {"base_seq": 0, "frames": []})
        seq = conv["base_seq"] + len(conv["frames"]) + 1
        conv["frames"].append({**frame, "seq": seq})
        while len(conv["frames"]) > self._max_frames:
            conv["frames"].pop(0)
            conv["base_seq"] += 1
        return seq

    async def after(self, conversation_id: str, watermark: int) -> list[Frame]:
        conv = self._convs.get(conversation_id)
        if not conv:
            return []
        return [f for f in conv["frames"] if f.get("seq", 0) > watermark]

    async def latest(self, conversation_id: str) -> int:
        conv = self._convs.get(conversation_id)
        return conv["base_seq"] + len(conv["frames"]) if conv else 0
