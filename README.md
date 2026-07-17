# botiva

**The server-side sibling of [chativa](https://github.com/AimTune/chativa).**
A runtime-agnostic conversation framework for AI agents — an open,
simplified take on BotFramework + DirectLine: a *connector* sits between the
realtime client and your agent runtime, and users are addressed by identity,
not by socket.

```
chativa widget ⇄ @chativa/connector-botiva ⇄ transport ⇄ ConversationEngine ⇄ Runtime
   (one client connector)        ws / socket.io / …           │            (LangGraph / …)
                                              ExtensionRegistry │ StateStore │ HistoryStore
```

- **One protocol, any transport.** WebSocket and Socket.IO servers ship today;
  every transport carries the exact same JSON frames (`botiva/1`), so the UI
  needs exactly **one** client connector.
- **Users have identity and state.** `userId` / `conversationId` /
  `connectionId` are separate. Any number of tabs/devices attach to the same
  conversation and stay in sync; `UserStore` state survives across
  conversations, `ConversationStore` state across reconnects.
- **DirectLine-style resume.** Persistent frames carry a monotonic `seq`
  (watermark). Reconnect with your watermark and replay only what you missed.
- **Human-in-the-loop.** A runtime yields `interrupt` → the client shows
  chips → the user's next message resumes the run (`Command({resume})` in
  LangGraph).
- **Ports & adapters.** `Runtime`, `StateStore`, `HistoryStore`, `Extension`
  are small language-agnostic ports. Go, .NET and Python reference ports live
  as language leaves next to each capability (`packages/<capability>/<lang>`,
  see [docs/LANGUAGES.md](docs/LANGUAGES.md)) with the same signatures.

## Packages (capability-first; `ts` leaves form the pnpm workspace)

| Package (folder)    | What                                                        |
|---------------------|-------------------------------------------------------------|
| `@botiva/core` (`packages/core/ts`) | `ConversationEngine`, protocol, events, stores, extensions, `botivaEmit`, `DemoRuntime` |
| `@botiva/authentication` (`packages/authentication/ts`) | `Authenticator` port + auth types — skeleton, engine integration tracked in [#1](https://github.com/AimTune/botiva/issues/1) |
| `@botiva/websocket` (`packages/server/ts/websocket`) | `WebSocketConnector` (`ws`) — coexists with Socket.IO on one HTTP server |
| `@botiva/socket.io` (`packages/server/ts/socketio`) | `SocketIOConnector` — all frames over one event channel (`"botiva"`) |
| `@botiva/langgraph` (`packages/runtimes/ts`) | `LangGraphRuntime` — streamEvents v2, HITL interrupts, GenUI, tracing passthrough |
| `@botiva/redis` (`packages/state/redis/ts`) | `RedisStateStore` + `RedisHistoryStore` (bring your own ioredis/node-redis client) |

## Quickstart

```ts
import { createServer } from "node:http";
import { ConversationEngine, DemoRuntime } from "@botiva/core";
import { WebSocketConnector } from "@botiva/websocket";

const engine = new ConversationEngine({
    runtime: new DemoRuntime(),          // swap for LangGraphRuntime(graph)
    greeting: "Hi! 👋",
});
const server = createServer();
new WebSocketConnector({ engine, server });   // ws://localhost:8790/chat
server.listen(8790);
```

With LangGraph and Socket.IO (express):

```ts
import express from "express";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { ConversationEngine } from "@botiva/core";
import { WebSocketConnector } from "@botiva/websocket";
import { SocketIOConnector } from "@botiva/socket.io";
import { LangGraphRuntime } from "@botiva/langgraph";

const engine = new ConversationEngine({ runtime: new LangGraphRuntime(graph) });
const server = createServer(express());
new WebSocketConnector({ engine, server });                    // transport 1
new SocketIOConnector({ engine, io: new SocketIOServer(server) }); // transport 2
server.listen(8790);
// Both transports share the same conversations — a ws tab and a socket.io tab
// attached to the same conversationId see each other's messages live.
```

Client side (chativa):

```ts
import { BotivaConnector } from "@chativa/connector-botiva";
const connector = new BotivaConnector({
    url: "ws://localhost:8790/chat",
    resumeConversation: true,   // persists userId/conversationId/watermark
});
```

## Emitting from inside your agent — `botivaEmit`

Anywhere in the async call tree of a turn (LangGraph node, tool, helper):

```ts
import { botivaEmit, botivaContext, ui, message } from "@botiva/core";

async function myGraphNode(state) {
    botivaEmit(ui("weather-card", { temp: 22 }));  // GenUI card, no plumbing
    const ctx = botivaContext();                   // who am I talking to?
    await ctx?.userStore.patch({ lastCity: "Istanbul" });
    return { messages: [...] };
}
```

Or explicitly — the pattern that ports 1:1 to Go/.NET/Python:

```ts
const myNode = async (state, config) => {
    const botiva = config.configurable?.botiva;    // TurnContext
    botiva?.emit(ui("weather-card", { temp: 22 }));
};
```

Language equivalents: Python `botiva_emit()` (contextvars), .NET
`Ambient.Emit()` (AsyncLocal), Go `botiva.Emit(ctx, ev)` (context.Context).

## Runtime port — plug in any framework

```ts
interface Runtime {
    run(input: RunInput, ctx: TurnContext): AsyncIterable<AgentEvent>;
}
```

That's the whole contract. Shipped adapters:

| Language   | Adapter                                | Framework                                                            |
|------------|----------------------------------------|----------------------------------------------------------------------|
| TypeScript | `@botiva/langgraph` `LangGraphRuntime` | LangGraph JS — `streamEvents` v2, `interrupt()`/`Command({resume})`   |
| Python     | `botiva_langgraph.LangGraphRuntime`    | LangGraph Python — `astream_events` v2, `interrupt()`/`Command`       |
| .NET       | `Botiva.Agents.ChatClientRuntime`      | Microsoft.Extensions.AI `IChatClient` (OpenAI/Azure/Ollama, Semantic Kernel via `AsChatClient()`) + LangGraph-style `Hitl.Interrupt()` |
| Go         | `runtimes/langchaingo.Runtime`         | langchaingo `llms.Model` (any provider) + `Interrupt(ctx, …)` HITL    |

All four map to the same botiva events: tool calls → `tool_call` frames, a
paused tool → `interrupt` + approval chips, the user's next message → resume,
GenUI emits → `genui` streams. Writing one for another framework (Vercel AI
SDK, hand-written loops, …) is the same ~100 lines — see
`packages/core/ts/src/demo.ts` for the reference implementation.

## Extensions — telemetry, tracing, customization

```ts
const tracing: Extension = {
    name: "tracing",
    onEvent(ev, ctx) {
        if (ev.type === "tool_call") {
            span(ctx.conversationId, ev.toolCall);   // → OpenTelemetry/LangSmith/...
        }
        return ev;                                    // null would drop the event
    },
};
new ConversationEngine({ runtime, extensions: [tracing] });
```

For LangChain-native tracing (LangSmith etc.), pass callbacks straight into
the runtime — they apply to every run:

```ts
new LangGraphRuntime(graph, { config: { callbacks: [tracer], tags: ["prod"] } });
```

## State

```ts
await ctx.userStore.patch({ name: "Hamza" });        // survives conversations/devices
await ctx.conversationStore.patch({ step: 3 });      // one conversation
```

Both are views over one `StateStore` (`user:{id}` / `conv:{id}`). In-memory by
default; `@botiva/redis` for scale.

## Running the examples

```sh
pnpm install
pnpm smoke        # deterministic end-to-end test, no LLM/API key (18 checks)
pnpm demo:graph   # hand-built StateGraph + Claude — botivaEmit from nodes/tools,
                  # UserStore-aware system prompt, HITL (needs ANTHROPIC_API_KEY;
                  # append --selftest for a scripted live check)
pnpm demo         # createReactAgent + Claude demo   (needs ANTHROPIC_API_KEY)
pnpm demo:mcp     # agent whose tools live in a separate MCP server, plus
                  # Extension middleware that hides/redacts sensitive tool
                  # traffic from clients (needs ANTHROPIC_API_KEY;
                  # append --selftest for a scripted live check)
```

And in the other languages (no API key needed — every server speaks the same
protocol and has a scripted `--selftest`, exit 0/1):

```sh
go run ./examples/go/server                                    # :8793 — Go engine + stdlib ws
dotnet run --project examples/dotnet/Botiva.Example            # :8797 — IChatClient agent loop + MCP
                                                               #   tools at /mcp (ModelContextProtocol);
                                                               #   -- --claude → real Claude (Anthropic SDK)
python examples/python/server.py                               # :8795 — Python engine + asyncio ws
python examples/python/langgraph_server.py                     # :8796 — real LangGraph interrupt/resume
                                                               #         (pip install langgraph)
```

Talk to any of them from a browser console:

```js
s = new WebSocket("ws://localhost:8793/chat");
s.onmessage = e => console.log(JSON.parse(e.data));
s.onopen = () => s.send(JSON.stringify({ type: "text", data: { text: "report please" } }));
```

## Scaling

- State/history → `@botiva/redis`; LangGraph checkpoints →
  `@langchain/langgraph-checkpoint-redis` (`thread_id` = `conversationId`).
- The live-connection registry and per-conversation turn lock are
  process-local → sticky-session on `conversationId`, or add a store lock +
  pub/sub fan-out for multi-instance.

## Protocol & other languages

The wire format, frame catalog, turn lifecycle and canonical port signatures
for TypeScript / Python / C# / Go are specified in
[PROTOCOL.md](PROTOCOL.md). Working reference ports — engine + WebSocket
transport + agent-framework adapter + runnable example, each with self-tests —
live as language leaves under `packages/` (see
[docs/LANGUAGES.md](docs/LANGUAGES.md)):

| Port | Transport | Agent adapter | Example |
|---|---|---|---|
| [Go](packages/core/go/README.md) | `packages/server/go` (stdlib RFC 6455) | `packages/runtimes/go` (langchaingo) | `examples/go/server` :8793 |
| [.NET](packages/core/dotnet/README.md) | `Botiva.AspNetCore` (`app.MapBotiva`) | `Botiva.Agents` (IChatClient) | `examples/dotnet/Botiva.Example` :8797 |
| [Python](packages/core/python/README.md) | `botiva_ws` (stdlib asyncio) | `botiva_langgraph` | `examples/python/*.py` :8795/:8796 |

## Roadmap

- [x] Runtime adapters: LangGraph (TS + Python), Microsoft.Extensions.AI /
      Semantic Kernel (.NET), langchaingo (Go)
- [ ] SSE / SignalR transport connectors
- [ ] `message` delta streaming (`on_chat_model_stream` → text chunks)
- [ ] Runtime adapters: LangChain AgentExecutor, Vercel AI SDK
- [ ] Store-based distributed turn lock + pub/sub fan-out bus
- [ ] Multi-conversation listing (`listConversations` for the chativa popup)
