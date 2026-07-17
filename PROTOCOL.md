# Botiva Wire Protocol — `botiva/1`

The transport- and language-agnostic contract between a **botiva server** (any
language: TypeScript, Go, .NET, Python, …) and a **botiva client connector**
(one connector on the UI side, e.g. `@chativa/connector-botiva`).

Design lineage: a simplified, open take on Bot Framework's DirectLine — a
*connector* sits between the realtime client and the agent runtime; clients
are addressed by identity, not by socket.

```
client(s) ⇄ transport connector ⇄ ConversationEngine ⇄ Runtime (LangGraph/…)
   ws / socket.io / sse …               │
                        ExtensionRegistry │ StateStore │ HistoryStore
```

---

## 1. Identity model

| Id               | Lifetime                  | Purpose                                            |
|------------------|---------------------------|----------------------------------------------------|
| `userId`         | permanent                 | Stable user identity. Owns `UserStore` state. Survives devices, tabs, conversations. |
| `conversationId` | until deleted             | One conversation/thread. Owns `ConversationStore` state, transcript, pending HITL interrupt. Maps to the runtime's thread (LangGraph `thread_id`). |
| `connectionId`   | one socket                | One live attachment. Any number may attach to the same conversation (multi-tab / multi-device). |
| `watermark`      | per client, monotonic int | Highest `seq` the client has seen. Reconnect with it to replay only what was missed. |

The server generates missing ids and announces them in the `welcome` frame;
clients should persist `userId` + `conversationId` (e.g. localStorage) and send
them back on reconnect.

## 2. Handshake per transport

The frames are identical everywhere; only how `hello` data travels differs.

| Transport      | Identity in                                                              | Frames on                     |
|----------------|--------------------------------------------------------------------------|-------------------------------|
| WebSocket      | query string `?userId=&conversationId=&watermark=` **or** first `hello` frame | the socket itself (JSON text) |
| Socket.IO      | `auth: { userId, conversationId, watermark, meta }` (or query)           | one event, default `"botiva"`, both directions |
| SSE + HTTP POST (future) | query/headers on the SSE request                                | SSE `data:` lines / POST body |

A server MUST accept connections with no identity at all (fresh visitor) and
generate ids — **unless** an authenticator is configured (§2.1).

## 2.1 Authentication (opt-in)

By default identity is client-asserted and every connection is accepted (§2).
A server MAY configure an **Authenticator** to gate `connect()`; this profile
overrides the "accept anyone" rule above.

**Credential transport** (a server reads the first that is present):

| Transport | Credential in                                                            |
|-----------|--------------------------------------------------------------------------|
| WebSocket | `?token=` query param · `hello` frame `token` · `Authorization: Bearer …` header |
| Socket.IO | `auth: { token }` · `?token=` query                                      |

Request **headers are forwarded** to the authenticator, so a cookie-based
verifier can read `Cookie` without any client-side token plumbing (browsers
attach cookies automatically).

**Verdict** — the authenticator returns `{ ok, userId?, claims?, reason? }`:

* `ok: false` ⇒ the server MUST send a transient `error` frame
  `{ "type": "error", "data": { "code": "unauthorized", "message": … } }` and
  then close the connection — WebSocket with **close code 4401**, Socket.IO with
  `disconnect(true)`. No `welcome` is sent.
* `ok: true` ⇒ a returned `userId` is the **verified** identity and overrides
  any client-asserted `userId` (so a valid token cannot be used to spoof a
  different user); `claims` are exposed to the runtime as `TurnContext.meta.auth`.

Authentication is connection-time only — no authorization/RBAC is implied.
Reference adapters ship in `@botiva/authentication`
(`StaticTokenAuthenticator`, `HmacJwtAuthenticator`, `CookieAuthenticator`);
the port itself (`Authenticator`) lives in `@botiva/core` (§8).

## 3. Frame catalog

Persistence classes:

* **persistent** — appended to conversation history with monotonic `seq`
  (1-based), replayed on reconnect: `text`, `tool_call`, `genui`.
* **transient** — delivery-only, never replayed: `hello`, `welcome`, `run`,
  `error`, and the busy notice.

Clients and servers MUST ignore unknown frame types and unknown fields
(forward compatibility).

### Client → server

```jsonc
// optional handshake (first frame, when not using query/auth)
// `token` is the auth credential (§2.1), only needed when the server authenticates
{ "type": "hello", "userId": "user-…", "conversationId": "conv-…", "watermark": 12, "token": "…", "meta": {} }

// user message
{ "type": "text", "id": "optional-client-id", "data": { "text": "hello" } }
```

### Server → client

```jsonc
// 1) first frame after connect (transient)
{ "type": "welcome", "data": {
    "protocol": "botiva/1",
    "conversationId": "conv-…", "userId": "user-…", "connectionId": "connection-…",
    "watermark": 42 } }

// bot bubble (persistent) — `actions` = HITL/suggestion chips
{ "type": "text", "id": "msg-…", "seq": 43, "from": "bot",
  "data": { "text": "…" }, "actions": [{ "label": "Approve" }], "timestamp": 1752570000000 }

// user bubble fan-out/replay (persistent; not echoed to the sender's own connection)
{ "type": "text", "id": "msg-…", "seq": 44, "from": "user", "data": { "text": "…" }, "timestamp": … }

// tool activity upsert by data.id (persistent)
{ "type": "tool_call", "seq": 45, "data": {
    "id": "…", "name": "get_weather", "status": "running|completed|error",
    "params": {}, "result": "…", "error": "…", "startedAt": …, "endedAt": … } }

// generative UI chunk (persistent) — chunk mirrors the chativa AIChunk
{ "type": "genui", "seq": 46, "streamId": "stream-…", "done": false,
  "chunk": { "type": "ui", "component": "weather", "props": {}, "id": 1 } }

// typing indicator (transient)
{ "type": "run", "data": { "status": "started" } }
{ "type": "run", "data": { "status": "finished" } }

// out-of-band error (transient) — e.g. auth rejection; followed by a close (§2.1)
{ "type": "error", "data": { "code": "unauthorized", "message": "invalid token" } }
```

## 4. Turn lifecycle

```
user text ──► engine
  1. Extension.onMessage chain (null ⇒ swallowed)
  2. busy? per-conversation turn lock ⇒ transient busy notice to the sender only
  3. persist + fan out the user frame (all connections except the sender)
  4. pending interrupt? input = {resume} else {text}
  5. Runtime.run(input, ctx) events  ⊎  emit()/botivaEmit() events   (merged)
  6. per event: Extension.onEvent chain → frame mapping → history append (seq) → fan out
  7. genui chunks grouped under one auto streamId; auto-closed at turn end
```

Canonical `AgentEvent` → frame mapping (must match `eventToFrames` in
`@botiva/core/src/protocol.ts` exactly):

| AgentEvent                       | Frame(s)                                              | persistent |
|----------------------------------|-------------------------------------------------------|------------|
| `message {text, actions?}`       | `text` from=bot                                       | yes |
| `tool_call {toolCall}`           | `tool_call`                                           | yes |
| `genui {chunk, streamId?, done?}`| `genui`                                               | yes |
| `interrupt {payload}`            | `text` from=bot + `actions` chips (defaults Approve/Cancel) | yes |
| `run_started` / `run_finished`   | `run {status}`                                        | no |
| `run_error {error}`              | `text` "⚠️ …" **then** `run {finished}`               | text yes, run no |
| `busy`                           | `text` "⏳ …" to the **sender only**                  | no |

## 5. Human-in-the-loop (HITL)

1. Runtime yields `interrupt {payload}` (recommended payload
   `{ question, options? }`). The engine stores it as the conversation's
   *pending interrupt* and the client renders chips.
2. The user's **next message** in that conversation is delivered as
   `RunInput { resume: <text>, interrupt: <the pending one> }`.
3. LangGraph adapter: `interrupt()` inside a tool pauses the graph
   (checkpointer required); resume is forwarded as `Command({ resume })`.

## 6. State

Two scopes over one `StateStore` (key/value, JSON values):

| Store               | Key                     | Typical content                    |
|---------------------|-------------------------|------------------------------------|
| `UserStore`         | `user:{userId}`         | profile, preferences, long-term memory |
| `ConversationStore` | `conv:{conversationId}` | conversation-local scratch state   |
| (engine internal)   | `conv:{conversationId}:botiva` | owner userId, createdAt, pendingInterrupt |

## 7. Resume & multi-device

* Every persistent frame gets `seq` (1-based, per conversation).
* On connect the server sends `welcome` (with current `watermark`) and then
  every persistent frame with `seq > client watermark` (default 0 = full
  transcript).
* All live connections of a conversation receive every new frame; the sender's
  own user frame is not echoed back to it.

## 8. Ports — canonical signatures per language

Implementations SHOULD keep these names and shapes so codebases stay
recognizable across stacks.

### Runtime (the only thing an agent framework adapter implements)

```ts
// TypeScript
interface Runtime {
    run(input: RunInput, ctx: TurnContext): AsyncIterable<AgentEvent>;
}
```
```python
# Python
class Runtime(Protocol):
    def run(self, input: RunInput, ctx: TurnContext) -> AsyncIterator[AgentEvent]: ...
```
```csharp
// C#
public interface IRuntime {
    IAsyncEnumerable<AgentEvent> RunAsync(RunInput input, TurnContext ctx, CancellationToken ct = default);
}
```
```go
// Go
type Runtime interface {
    Run(ctx context.Context, input RunInput, tc *TurnContext) (<-chan AgentEvent, error)
}
```

### RunInput / TurnContext

```ts
interface RunInput  { text?: string; resume?: unknown; interrupt?: PendingInterrupt }
interface TurnContext {
    conversationId: string; userId: string;
    userStore: UserStore; conversationStore: ConversationStore;
    emit(event: AgentEvent): void;      // out-of-band events into the current turn
    log: Logger; meta: Record<string, unknown>;
}
```

### StateStore / HistoryStore

```ts
interface StateStore {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
}
interface HistoryStore {
    append(conversationId: string, frame: Frame): Promise<number>; // assigned seq
    after(conversationId: string, watermark: number): Promise<Frame[]>;
    latest(conversationId: string): Promise<number>;
}
```
(Go: `Get(ctx, key) (json.RawMessage, error)` etc.; C#: `Task<T?> GetAsync<T>(string key)`;
Python: `async def get(self, key) -> Any`.)

### Extension

```ts
interface Extension {
    name: string;
    onMessage?(msg: IncomingMessage, ctx: TurnContext): IncomingMessage | null;   // null = swallow
    onEvent?(ev: AgentEvent, ctx: TurnContext): AgentEvent | null;                // null = drop
    onConversationStart?/onConversationEnd?(ctx: ConversationContext): void;
    onConnect?/onDisconnect?(info: { connectionId }, ctx: ConversationContext): void;
}
```

### Authenticator (optional connect-time gate, §2.1)

```ts
interface Authenticator {
    authenticate(ctx: AuthContext): AuthResult | Promise<AuthResult>;
}
interface AuthContext {
    transport: string; token?: string;
    query?: Record<string, string>; headers?: Record<string, string>;
    userId?: string; conversationId?: string;   // client-asserted (unverified)
}
interface AuthResult { ok: boolean; userId?: string; claims?: Record<string, unknown>; reason?: string }
```
A rejecting authenticator makes `connect()` throw `AuthenticationError`, which
the transport turns into an `error` frame + close (WS code `AUTH_CLOSE_CODE` =
4401). The port lives in core; reference adapters in `@botiva/authentication`.
(Go: `Authenticate(ctx, AuthContext) (AuthResult, error)`; C#:
`Task<AuthResult> AuthenticateAsync(AuthContext)`; Python: `async def
authenticate(self, ctx) -> AuthResult`.)

### Engine surface (transport adapters call exactly this)

```ts
class ConversationEngine {
    connect(params: {
        userId?, conversationId?, watermark?,
        deliver(frame: Frame): void, meta?,
        auth?: { transport?, token?, query?, headers? },   // material for the Authenticator (§2.1)
    }): Promise<Connection>;
    handleMessage(conversationId, msg: IncomingMessage, opts?): Promise<void>;
    post(conversationId, event: AgentEvent): Promise<void>;   // proactive push
}
interface Connection {
    id; userId; conversationId;
    receive(raw: unknown): Promise<void>;   // inbound wire payload
    close(): Promise<void>;
}
```

A transport adapter is therefore ~50 lines in any language:
map socket open → `connect`, inbound data → `receive`, socket close → `close`,
and `deliver` → socket write.

## 9. Ambient turn context (`botivaEmit`)

Emitting events from deep inside agent code without threading the context:

| Language   | Mechanism                                   | API                                  |
|------------|---------------------------------------------|--------------------------------------|
| Node/TS    | `AsyncLocalStorage`                         | `botivaEmit(event)`, `botivaContext()` |
| Python     | `contextvars.ContextVar[TurnContext]`       | `botiva_emit(event)`, `botiva_context()` |
| .NET       | `AsyncLocal<TurnContext>`                   | `Ambient.Emit(event)`, `Ambient.Context` |
| Go         | explicit `context.Context` value            | `botiva.Emit(ctx, event)`, `botiva.FromContext(ctx)` |

LangGraph additionally exposes the context explicitly as
`config.configurable.botiva` inside nodes/tools — the recommended pattern for
languages without ambient context (and the most portable one).

## 10. Scaling

* State & history → `@botiva/redis` (or equivalents). LangGraph checkpoints →
  `@langchain/langgraph-checkpoint-redis`.
* The per-conversation turn lock and the live-connection registry are
  process-local → use sticky sessions per `conversationId`, or implement a
  store-based lock + a pub/sub fan-out bus for multi-instance fan-out.

## 11. Versioning

`welcome.data.protocol` carries `"botiva/<major>"`. Breaking frame changes bump
the major. Additive fields/types do not — receivers must ignore unknowns.
