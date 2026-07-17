"""botiva — Python reference port of the botiva conversation framework.

Signatures mirror @botiva/core (see PROTOCOL.md §8):

    engine = ConversationEngine(runtime, greeting="hi")
    conn = await engine.connect(deliver, user_id=..., conversation_id=..., watermark=...)
    await conn.receive(raw)      # inbound wire payload
    await conn.close()

    class MyRuntime:             # the only port an adapter implements
        async def run(self, input, ctx) -> AsyncIterator[AgentEvent]: ...

Ambient context (contextvars): botiva_emit(event) / botiva_context().
"""

from .auth import (
    AUTH_CLOSE_CODE,
    AllowAllAuthenticator,
    AuthContext,
    AuthenticationError,
    Authenticator,
    AuthInput,
    AuthResult,
)
from .engine import (
    Connection,
    ConversationEngine,
    Runtime,
    TurnContext,
    botiva_context,
    botiva_emit,
)
from .events import (
    AgentEvent,
    busy,
    genui,
    interrupt,
    message,
    run_error,
    run_finished,
    run_started,
    tool_call,
    ui,
)
from .protocol import (
    PERSISTENT_FRAME_TYPES,
    PROTOCOL_VERSION,
    Frame,
    IncomingMessage,
    error_frame,
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
from .demo import DemoRuntime

__all__ = [
    "AUTH_CLOSE_CODE", "AgentEvent", "AllowAllAuthenticator", "AuthContext",
    "AuthInput", "AuthResult", "AuthenticationError", "Authenticator",
    "Connection", "ConversationEngine", "ConversationStore",
    "DemoRuntime", "Frame", "HistoryStore", "IncomingMessage",
    "MemoryHistoryStore", "MemoryStateStore", "PERSISTENT_FRAME_TYPES",
    "PROTOCOL_VERSION", "Runtime", "ScopedStore", "StateStore", "TurnContext",
    "UserStore", "botiva_context", "botiva_emit", "busy", "error_frame",
    "event_to_frames", "genui", "interrupt", "message", "parse_incoming",
    "run_error", "run_finished", "run_started", "tool_call", "ui",
]

__version__ = "0.1.0"
