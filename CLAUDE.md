# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

botiva is a pnpm monorepo implementing a transport- and framework-agnostic conversational-agent server (a simplified, open take on Bot Framework's DirectLine). Chat clients speak the **botiva/1 wire protocol** to a `ConversationEngine`; agent runtimes (LangGraph, or anything else) plug in behind it. **PROTOCOL.md is the normative spec** — the frame catalog, turn lifecycle, HITL flow, and the canonical `AgentEvent → Frame` mapping that every implementation (TS and the Go/.NET/Python ports) must reproduce exactly.

## Commands

```bash
pnpm build          # tsc -b (TypeScript project references)
pnpm clean          # tsc -b --clean
pnpm smoke          # build + examples/smoke-test.ts  — deterministic E2E, no API key, exit 0/1
pnpm demo:graph     # build + examples/langgraph-server.ts on :8792 — real LLM, needs Anthropic key
pnpm exec tsx examples/langgraph-server.ts --selftest   # starts :8792 AND runs scripted WS client, exit 0/1
pnpm demo           # build + examples/demo-server.ts on :8790 — real LLM, needs Anthropic key
pnpm demo:mcp       # build + examples/mcp-demo-server.ts on :8791 — needs key; boots examples/mcp-server.ts (SQL-backed shop MCP, :8794) in-process, loads its tools over Streamable HTTP, and runs Extension middleware that hides/redacts sensitive tool traffic
pnpm exec tsx examples/mcp-demo-server.ts --selftest    # scripted WS client against the MCP demo, exit 0/1
```

There is no test framework or linter on the TS side; `pnpm smoke` and the `--selftest` flag are the tests. Ports are overridable via `PORT`.

Language ports (outside the pnpm workspace, no root script builds them). Each port = engine + WebSocket transport + agent-framework adapter + runnable example; all selftests are deterministic (no API key), exit 0/1:

```bash
cd ports/go && go test ./...                      # engine test + botiva/ws transport E2E (httptest)
cd ports/go && go run ./examples/server --selftest        # :8793 demo + scripted WS client
cd ports/go/adapters/langchaingo && go test ./...         # langchaingo agent adapter (SEPARATE module — not covered by the root go test)
cd ports/dotnet && dotnet run --project Botiva.SelfTest   # console self-test, exit 0/1
cd ports/dotnet && dotnet run --project Botiva.Example -- --selftest   # :8797 ASP.NET Core + ChatClientRuntime + MCP E2E
cd ports/dotnet && dotnet run --project Botiva.Example -- --claude     # same server, real Claude via the official Anthropic SDK (needs ANTHROPIC_API_KEY or anthropic-key.txt in the parent repo root; NOT part of CI)
cd ports/python && python -m botiva.selftest              # engine self-test
cd ports/python && python -m botiva.selftest_langgraph    # LangGraph adapter vs fake graph (langgraph NOT required)
cd ports/python && python examples/server.py --selftest   # :8795 stdlib ws transport E2E
cd ports/python && python examples/langgraph_server.py --selftest   # :8796, needs `pip install langgraph` (>=0.2), still no API key
```

No Python on this Windows machine — run the Python commands through WSL (`wsl -e bash -c "cd /mnt/c/... && python3 ..."`; python3 + langgraph are installed there).

### Credentials / env

- `demo`, `demo:graph` and `demo:mcp` call `loadAnthropicKey()`: `ANTHROPIC_API_KEY` env var **or** `anthropic-key.txt` in the parent repo root (`mency-report-bot/`, one level above `botiva/`). Missing key exits the process.
- `demo:mcp` env: `MCP_URL` points it at an external Streamable HTTP MCP server (skips booting the embedded one); `MCP_PORT` moves the embedded server. `examples/mcp-server.ts` also runs standalone (`pnpm exec tsx examples/mcp-server.ts`, no credentials, needs Node ≥ 22.5 for `node:sqlite`).
- `smoke` and every `ports/*` selftest are credential-free — the CI-safe tests.

## Architecture

Hexagonal, hub-and-spoke. `@botiva/core` defines the engine and four ports; every other package implements exactly one port and depends only on core (no cross-references between adapters):

- **`packages/core`** — `ConversationEngine` ([engine.ts](packages/core/src/engine.ts)): identity, per-conversation turn lock, seq/watermark replay, multi-connection fan-out, pending HITL interrupt, genui stream grouping. Ports: `Runtime`, `StateStore`, `HistoryStore`, `Extension` (with in-memory reference impls). `eventToFrames()` in [protocol.ts](packages/core/src/protocol.ts) is the **canonical mapping other-language ports must match byte-for-byte**. `botivaEmit()`/`botivaContext()` ([emit.ts](packages/core/src/emit.ts)) give ambient turn access via AsyncLocalStorage; emitted events are merged with runtime-yielded events through one `AsyncQueue`.
- **`packages/websocket`**, **`packages/socketio`** — thin transport adapters (~60–130 lines): socket open → `engine.connect()`, inbound → `connection.receive()`, close → `connection.close()`, `deliver` → socket write. The websocket package is the stated template for new transports. Naming gotcha: directory `packages/socketio` publishes as `@botiva/socket.io`.
- **`packages/langgraph`** — `LangGraphRuntime` wraps any compiled graph via `streamEvents` v2. LangGraph `thread_id` = botiva `conversationId`; the full `TurnContext` is injected as `config.configurable.botiva` (the portable pattern for nodes/tools). HITL: interrupt detection happens **after** the stream by inspecting `graph.getState().tasks[].interrupts`, and resume is `new Command({ resume })` when `input.resume !== undefined`.
- **`packages/redis`** — `RedisStateStore`/`RedisHistoryStore`, bring-your-own client (duck-typed `RedisClientLike`, works with ioredis and node-redis casing). Botiva state/transcript only; LangGraph checkpoints belong to `@langchain/langgraph-checkpoint-redis`.
- **`examples/`** — workspace member but *outside* the TS build graph (no tsconfig; run via tsx against built dist). Every server mounts **both** transports on one HTTP server sharing one engine. The LLM examples reach outside the monorepo (`../../langgraph/config.mjs` for the API key; `demo-server` also serves `../../web`) with `@ts-ignore` — the examples workspace is not self-contained.
- **`ports/go`, `ports/dotnet`, `ports/python`** — standalone ports of core (engine zero-dependency in all three). PROTOCOL.md §8 fixes the canonical type/method names per language; keep them mirrored when editing any port. Each port additionally ships:
  - a **WebSocket transport** mirroring `@botiva/websocket` semantics (query **or** hello-frame identity, ~300ms hello wait): Go `botiva/ws` (stdlib RFC 6455 server + `ws.Dial` client), .NET `Botiva.AspNetCore` (`app.MapBotiva(path, engine)`, Kestrel WebSockets — note: cancelling a WebSocket receive aborts the socket, hence the pending-read handoff in the hello wait), Python `botiva/ws.py` (stdlib asyncio server + `WebSocketClient`).
  - an **agent-framework adapter**: Python `botiva/langgraph.py` (mirrors `@botiva/langgraph`: `astream_events` v2, interrupt detection AFTER the stream via `aget_state().tasks[].interrupts`, resume via `Command(resume=...)`, `command_factory` injectable for langgraph-free tests); .NET `Botiva.Agents` (`ChatClientRuntime` over any Microsoft.Extensions.AI `IChatClient` — manual tool loop, chat history JSON-persisted in `ConversationStore` under `chatMessages`, HITL via `Hitl.Interrupt()` which throws `BotivaInterruptException` on first pass and returns the user's answer on the resume pass, pending call under `pendingToolCall`); Go `adapters/langchaingo` (same design over langchaingo `llms.Model`, HITL via `Interrupt(ctx, payload)`; **separate Go module** with a `replace` directive so the core module stays zero-dep — run its tests from its own directory).
  - a runnable **example server with `--selftest`**: Go `examples/server` (:8793), .NET `Botiva.Example` (:8797), Python `examples/server.py` (:8795) and `examples/langgraph_server.py` (:8796, real LangGraph with a rule-based agent node — `config` param must be typed `RunnableConfig`, not `dict`, or LangGraph 1.x won't inject it).
  - **`Botiva.Example` layering**: `Tools/LocalTools.cs` (in-process tools: Ambient/UserStore/Hitl), `Mcp/IterationMcpTools.cs` (MCP tool server via the official `ModelContextProtocol.AspNetCore` SDK, hosted at `/mcp` Streamable HTTP on the same Kestrel and consumed through a real `McpClient` — `McpClientTool : AIFunction`, so MCP tools drop into `ChatClientRuntimeOptions.Tools` untouched), `Agents/ScriptedChatClient.cs` (offline deterministic model, the default + what `--selftest` uses), `Agents/ClaudeChatClient.cs` (`IChatClient` over the official `Anthropic` NuGet SDK — Claude Messages API with tool bridge; `--claude` flag or `BOTIVA_MODEL=claude`; key from `ANTHROPIC_API_KEY` or parent-repo `anthropic-key.txt`; model `CLAUDE_MODEL` ?? `claude-opus-4-8`), `Agents/LazyRuntime.cs` (defers MCP-client wiring until Kestrel is listening — the MCP client dials our own `/mcp`). MCP tools run outside the botiva turn context (HTTP hop) — Ambient/Hitl only works in LocalTools.
  - Port allocation across the repo: 8790 demo, 8791 demo:mcp, 8792 demo:graph, 8793 Go, 8794 TS mcp-server, 8795/8796 Python, 8797 .NET.

### Cross-cutting contracts to keep in mind

- **Module system**: everything is ESM with `module: NodeNext` + `verbatimModuleSyntax` — relative imports need explicit `.js` extensions, type-only imports must use `import type`.
- **Turn lifecycle** (PROTOCOL.md §4): extension `onMessage` chain (null ⇒ swallow) → turn lock (busy notice to sender only) → persist + fan out user frame to every connection *except the sender* → pending interrupt turns the next message into `RunInput {resume, interrupt}` → events dispatched through `onEvent` chain → `eventToFrames` → history append (monotonic 1-based `seq`) → broadcast.
- **State keyspace**: one `StateStore`, three namespaces — `user:{userId}`, `conv:{conversationId}`, and engine-internal `conv:{conversationId}:botiva` (owner, createdAt, pendingInterrupt).
- **Watermark semantics**: on connect the server replays every persistent frame with `seq > watermark`. Because the sender's own user frames are persisted but never echoed back to it, a client's max *observed* seq can lag the server watermark — this is by design.
- **GenUI streams**: the first genui event of a turn fixes the `streamId`; if the runtime never sends `done: true` the engine emits a closing chunk at turn end.
- **Scaling caveat** (PROTOCOL.md §10): the turn lock and live-connection registry are process-local even with Redis stores — multi-instance deployment needs sticky sessions per `conversationId` or a store-based lock + pub/sub fan-out (not provided).
- **HITL resume convention in the demos**: the user's next message is matched with `/approve|yes|onay|evet/i` (Turkish included).
