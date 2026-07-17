// @botiva/core — DirectLine-style conversation framework for AI agents.
// Server-side sibling of the chativa UI component library.
//
//   chativa widget ⇄ @botiva/* connector ⇄ ConversationEngine ⇄ Runtime
//
// Ports (implement these to extend):  Runtime · StateStore · HistoryStore · Extension
// Adapters shipped separately:        @botiva/websocket · @botiva/socket.io ·
//                                     @botiva/langgraph · @botiva/redis

export {
    busy,
    genui,
    interrupt,
    message,
    runError,
    runFinished,
    runStarted,
    toolCall,
    ui,
} from "./events.js";
export type {
    AgentEvent,
    GenUIChunk,
    InterruptQuestion,
    MessageAction,
    ToolCall,
    ToolCallStatus,
} from "./events.js";

export { PROTOCOL_VERSION, PERSISTENT_FRAME_TYPES, eventToFrames, parseIncoming, errorFrame } from "./protocol.js";
export type {
    ErrorFrame,
    Frame,
    FrameMapping,
    GenUIFrame,
    HelloFrame,
    Inbound,
    IncomingMessage,
    RunFrame,
    TextFrame,
    ToolCallFrame,
    WelcomeFrame,
} from "./protocol.js";

export { ConversationEngine } from "./engine.js";
export type { AuthInput, ConnectParams, Connection, EngineOptions } from "./engine.js";

export { AllowAllAuthenticator, AuthenticationError, AUTH_CLOSE_CODE } from "./auth.js";
export type { AuthContext, AuthResult, Authenticator } from "./auth.js";

export { ExtensionRegistry } from "./extensions.js";
export type { ConnectionInfo, Extension } from "./extensions.js";

export { ConversationStore, MemoryStateStore, ScopedStore, UserStore } from "./state.js";
export type { StateStore } from "./state.js";

export { MemoryHistoryStore } from "./history.js";
export type { HistoryStore } from "./history.js";

export { botivaContext, botivaEmit, runWithTurnContext } from "./emit.js";

export type {
    ConversationContext,
    Logger,
    PendingInterrupt,
    RunInput,
    Runtime,
    TurnContext,
} from "./runtime.js";

export { DemoRuntime } from "./demo.js";
export { AsyncQueue } from "./queue.js";
