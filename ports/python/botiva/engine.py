"""ConversationEngine — Python port of the botiva engine.

Same responsibilities as @botiva/core: identity (user/conversation/connection),
watermark replay, per-conversation turn lock, HITL pending interrupts,
multi-connection fan-out, extension chain, GenUI stream grouping.

The ambient turn context uses ``contextvars`` — the asyncio counterpart of
Node's AsyncLocalStorage (PROTOCOL.md §9):

    from botiva import botiva_emit, botiva_context, ui

    async def my_langgraph_node(state):        # no plumbing required
        botiva_emit(ui("weather-card", {"temp": 22}))
        ctx = botiva_context()
        await ctx.user_store.patch({"seen": True})
"""

from __future__ import annotations

import contextvars
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Protocol

from .events import AgentEvent, busy as busy_event, genui, message, run_error
from .protocol import (
    PROTOCOL_VERSION,
    Frame,
    IncomingMessage,
    event_to_frames,
    parse_incoming,
)
from .state import (
    ConversationStore,
    HistoryStore,
    MemoryHistoryStore,
    MemoryStateStore,
    ScopedStore,
    StateStore,
    UserStore,
)

logger = logging.getLogger("botiva")


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4()}"


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class TurnContext:
    conversation_id: str
    user_id: str
    user_store: UserStore
    conversation_store: ConversationStore
    meta: dict[str, Any] = field(default_factory=dict)
    _emit: Callable[[AgentEvent], Awaitable[None]] | None = None

    async def emit(self, event: AgentEvent) -> None:
        """Push an out-of-band event into the current turn."""
        if self._emit is not None:
            await self._emit(event)


class Runtime(Protocol):
    """The driving port — the only thing an agent framework adapter implements."""

    def run(self, input: dict[str, Any], ctx: TurnContext) -> AsyncIterator[AgentEvent]: ...


class Extension(Protocol):
    """Optional hooks; return None from on_message/on_event to swallow/drop."""

    name: str
    # async def on_message(self, msg, ctx) -> IncomingMessage | None
    # async def on_event(self, ev, ctx) -> AgentEvent | None
    # async def on_conversation_start/end(self, ctx) / on_connect/on_disconnect(...)


# ── ambient turn context (contextvars) ───────────────────────────────────────

_current_turn: contextvars.ContextVar[TurnContext | None] = contextvars.ContextVar(
    "botiva_turn", default=None
)


def botiva_context() -> TurnContext | None:
    """The TurnContext of the currently executing turn, if any."""
    return _current_turn.get()


def botiva_emit(event: AgentEvent) -> bool:
    """Emit into the current turn (fire-and-forget); False outside a turn.

    Events are queued synchronously and dispatched by the engine's turn loop.
    """
    ctx = _current_turn.get()
    if ctx is None or ctx._emit is None:
        return False
    pending = getattr(ctx, "_pending_emits", None)
    if pending is None:
        return False
    pending.append(event)
    return True


@dataclass
class Connection:
    """Handle a transport holds for one attached client."""

    id: str
    user_id: str
    conversation_id: str
    _engine: "ConversationEngine"
    _live: "_LiveConnection"
    _closed: bool = False

    async def receive(self, raw: Any) -> None:
        """Feed one inbound wire payload (JSON string, bytes or frame dict)."""
        inbound = parse_incoming(raw)
        if inbound is None:
            return
        if inbound.hello is not None:
            logger.warning("[botiva] late hello frame ignored (handshake happens on connect)")
            return
        await self._engine.handle_message(
            self.conversation_id, inbound.message, user_id=self.user_id, origin=self._live
        )

    async def close(self) -> None:
        """Detach; the conversation itself stays resumable."""
        if self._closed:
            return
        self._closed = True
        await self._engine._disconnect(self._live)


@dataclass(eq=False)  # identity semantics: lives in sets, compared with `is`
class _LiveConnection:
    id: str
    user_id: str
    conversation_id: str
    meta: dict[str, Any]
    deliver: Callable[[Frame], Any]


class ConversationEngine:
    def __init__(
        self,
        runtime: Runtime,
        *,
        state_store: StateStore | None = None,
        history_store: HistoryStore | None = None,
        extensions: list[Any] | None = None,
        greeting: str | None = None,
    ) -> None:
        self.runtime = runtime
        self.store: StateStore = state_store or MemoryStateStore()
        self.history: HistoryStore = history_store or MemoryHistoryStore()
        self.extensions = extensions or []
        self.greeting = greeting
        self._live: dict[str, set[_LiveConnection]] = {}
        self._turn_locks: set[str] = set()

    # ── connection lifecycle ────────────────────────────────────────────────

    async def connect(
        self,
        deliver: Callable[[Frame], Any],
        *,
        user_id: str | None = None,
        conversation_id: str | None = None,
        watermark: int = 0,
        meta: dict[str, Any] | None = None,
    ) -> Connection:
        conversation_id = conversation_id or _new_id("conv")
        record, fresh = await self._load_record(conversation_id, user_id)
        user_id = user_id or record["userId"]

        live = _LiveConnection(_new_id("connection"), user_id, conversation_id, meta or {}, deliver)
        self._live.setdefault(conversation_id, set()).add(live)

        ctx = self._context(conversation_id, user_id, live.meta)
        if fresh:
            await self._notify("on_conversation_start", ctx)
        await self._notify("on_connect", live.id, ctx)

        # 1) welcome (transient)
        latest = await self.history.latest(conversation_id)
        await self._deliver(live, {
            "type": "welcome",
            "data": {
                "protocol": PROTOCOL_VERSION,
                "conversationId": conversation_id,
                "userId": user_id,
                "connectionId": live.id,
                "watermark": latest,
            },
        })
        # 2) replay everything the client hasn't seen
        if latest > watermark:
            for frame in await self.history.after(conversation_id, watermark):
                await self._deliver(live, frame)
        # 3) greeting on brand-new conversations
        if fresh and self.greeting:
            await self.post(conversation_id, message(self.greeting))

        return Connection(live.id, user_id, conversation_id, self, live)

    async def _disconnect(self, live: _LiveConnection) -> None:
        conns = self._live.get(live.conversation_id)
        if conns:
            conns.discard(live)
        ctx = self._context(live.conversation_id, live.user_id, live.meta)
        await self._notify("on_disconnect", live.id, ctx)
        if conns is not None and not conns:
            self._live.pop(live.conversation_id, None)
            await self._notify("on_conversation_end", ctx)

    # ── turns ───────────────────────────────────────────────────────────────

    async def handle_message(
        self,
        conversation_id: str,
        raw_message: IncomingMessage,
        *,
        user_id: str | None = None,
        origin: Any = None,
    ) -> None:
        record_store = self._record_store(conversation_id)
        record, _ = await self._load_record(conversation_id, user_id)
        user_id = user_id or record["userId"]

        ctx = self._context(conversation_id, user_id, getattr(origin, "meta", {}) or {})

        # Turn-local GenUI grouping + pending emit queue for botiva_emit().
        turn = {"stream_id": None, "stream_done": False, "chunk_seq": 0}
        pending_emits: list[AgentEvent] = []
        ctx._pending_emits = pending_emits  # type: ignore[attr-defined]

        async def dispatch(ev: AgentEvent, only: _LiveConnection | None = None) -> None:
            if ev.get("type") == "interrupt":
                await record_store.patch({"pendingInterrupt": {
                    "id": ev.get("id"), "payload": ev.get("payload"), "at": _now_ms(),
                }})
            if ev.get("type") == "genui":
                turn["stream_id"] = turn["stream_id"] or ev.get("streamId") or _new_id("stream")
                turn["chunk_seq"] += 1
                chunk = dict(ev.get("chunk") or {})
                chunk.setdefault("id", turn["chunk_seq"])
                ev = {**ev, "streamId": ev.get("streamId") or turn["stream_id"],
                      "done": ev.get("done") is True, "chunk": chunk}
                if ev["done"]:
                    turn["stream_done"] = True
            out: AgentEvent | None = ev
            for ext in self.extensions:
                handler = getattr(ext, "on_event", None)
                if handler is None or out is None:
                    continue
                out = await handler(out, ctx)
                if out is None:
                    return
            for mapping in event_to_frames(out, _new_id):
                frame = mapping.frame
                if mapping.persistent:
                    seq = await self.history.append(conversation_id, frame)
                    frame = {**frame, "seq": seq}
                if only is not None:
                    await self._deliver(only, frame)
                else:
                    await self._broadcast(conversation_id, frame)

        async def drain_emits() -> None:
            while pending_emits:
                await dispatch(pending_emits.pop(0))

        ctx._emit = dispatch  # explicit ctx.emit() path

        msg: IncomingMessage | None = raw_message
        for ext in self.extensions:
            handler = getattr(ext, "on_message", None)
            if handler is None or msg is None:
                continue
            msg = await handler(msg, ctx)
            if msg is None:
                return
        if not msg.text:
            return

        if conversation_id in self._turn_locks:
            await dispatch(busy_event(), only=origin)
            return
        self._turn_locks.add(conversation_id)
        token = _current_turn.set(ctx)
        try:
            # Persist + fan out the user's message (everyone but the sender).
            user_frame: Frame = {
                "type": "text", "id": msg.id or _new_id("msg"), "from": "user",
                "data": {"text": msg.text}, "timestamp": _now_ms(),
            }
            seq = await self.history.append(conversation_id, user_frame)
            await self._broadcast(conversation_id, {**user_frame, "seq": seq}, except_=origin)

            # Pending interrupt? Then this message is the HITL answer.
            if record.get("pendingInterrupt"):
                run_input = {"resume": msg.text, "interrupt": record["pendingInterrupt"]}
                await record_store.patch({"pendingInterrupt": None})
            else:
                run_input = {"text": msg.text}

            try:
                async for ev in self.runtime.run(run_input, ctx):
                    await drain_emits()
                    await dispatch(ev)
                await drain_emits()
            except Exception as err:  # noqa: BLE001 — surfaced to the client
                logger.exception("[botiva] run failed (%s)", conversation_id)
                await dispatch(run_error(err))

            # Close a genui stream the runtime left open.
            if turn["stream_id"] and not turn["stream_done"]:
                turn["chunk_seq"] += 1
                await dispatch(genui(
                    {"type": "event", "name": "stream_done", "payload": None,
                     "id": turn["chunk_seq"]},
                    stream_id=turn["stream_id"], done=True,
                ))
        finally:
            _current_turn.reset(token)
            self._turn_locks.discard(conversation_id)

    async def post(self, conversation_id: str, event: AgentEvent, *, user_id: str | None = None) -> None:
        """Proactive, out-of-turn delivery (reminders, server pushes)."""
        record = await self._record_store(conversation_id).get() or {}
        user_id = user_id or record.get("userId") or "system"
        ctx = self._context(conversation_id, user_id, {})
        out: AgentEvent | None = event
        for ext in self.extensions:
            handler = getattr(ext, "on_event", None)
            if handler is None or out is None:
                continue
            out = await handler(out, ctx)
            if out is None:
                return
        for mapping in event_to_frames(out, _new_id):
            frame = mapping.frame
            if mapping.persistent:
                seq = await self.history.append(conversation_id, frame)
                frame = {**frame, "seq": seq}
            await self._broadcast(conversation_id, frame)

    # ── internals ───────────────────────────────────────────────────────────

    async def _broadcast(self, conversation_id: str, frame: Frame, except_: Any = None) -> None:
        for conn in list(self._live.get(conversation_id, ())):
            if conn is except_:
                continue
            await self._deliver(conn, frame)

    async def _deliver(self, live: _LiveConnection, frame: Frame) -> None:
        try:
            result = live.deliver(frame)
            if hasattr(result, "__await__"):
                await result
        except Exception:  # noqa: BLE001
            logger.warning("[botiva] deliver failed", exc_info=True)

    async def _load_record(
        self, conversation_id: str, preferred_user_id: str | None
    ) -> tuple[dict[str, Any], bool]:
        record_store = self._record_store(conversation_id)
        record = await record_store.get()
        if record is not None:
            return dict(record), False
        record = {"userId": preferred_user_id or _new_id("user"), "createdAt": _now_ms()}
        await record_store.set(record)
        return record, True

    def _record_store(self, conversation_id: str) -> ScopedStore:
        return ScopedStore(self.store, f"conv:{conversation_id}:botiva")

    def _context(self, conversation_id: str, user_id: str, meta: dict[str, Any]) -> TurnContext:
        return TurnContext(
            conversation_id=conversation_id,
            user_id=user_id,
            user_store=UserStore(self.store, user_id),
            conversation_store=ConversationStore(self.store, conversation_id),
            meta=meta,
        )

    async def _notify(self, hook: str, *args: Any) -> None:
        for ext in self.extensions:
            handler = getattr(ext, hook, None)
            if handler is None:
                continue
            try:
                result = handler(*args)
                if hasattr(result, "__await__"):
                    await result
            except Exception:  # noqa: BLE001
                logger.warning("[botiva] extension hook %s failed", hook, exc_info=True)
