# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

botiva is a polyglot monorepo implementing a transport- and framework-agnostic conversational-agent server (a simplified, open take on Bot Framework's DirectLine). Chat clients speak the **botiva/1 wire protocol** to a `ConversationEngine`; agent runtimes (LangGraph, or anything else) plug in behind it. **PROTOCOL.md is the normative spec** — the frame catalog, turn lifecycle, HITL flow, and the canonical `AgentEvent → Frame` mapping that every implementation (TS and the Go/.NET/Python ports) must reproduce exactly.

**Layout is capability-first with language leaves**: `packages/<capability>/<lang>` for library code, `examples/<lang>` for runnable servers. The `ts` leaves form the pnpm workspace; Go is four modules stitched by the repo-root `go.work`; .NET is five projects aggregated by the repo-root `Botiva.slnx`; Python is three importable packages (`botiva`, `botiva_ws`, `botiva_langgraph`).

```
packages/
  core/{ts,go,dotnet,python}     # engine + protocol + ports (zero-dep in every language)
  authentication/ts              # @botiva/authentication — Authenticator port SKELETON (docs/issues/authentication.md)
  server/
    ts/{websocket,socketio}      # @botiva/websocket, @botiva/socket.io (folder≠name gotcha lives on)
    {go,dotnet,python}           # ws transports: module …/server/ws | Botiva.AspNetCore | botiva_ws
  state/redis/ts                 # @botiva/redis (only TS has Redis — parity: docs/issues/redis-parity.md)
  runtimes/
    ts                           # @botiva/langgraph
    {go,dotnet,python}           # langchaingo | Botiva.Agents (ChatClientRuntime) | botiva_langgraph
  mcp/                           # README placeholder (docs/issues/mcp-package.md)
examples/{ts,go/server,dotnet/{Botiva.Example,Botiva.SelfTest},python}
docs/{LANGUAGES.md,issues/}      # cross-language overview + English issue drafts
go.work  Botiva.slnx             # Go workspace, .NET solution (repo root)
```

## Commands

```bash
pnpm build          # tsc -b (TypeScript project references)
pnpm clean          # tsc -b --clean
pnpm smoke          # build + examples/ts/smoke-test.ts — deterministic E2E, no API key, exit 0/1
pnpm demo:graph     # build + examples/ts/langgraph-server.ts on :8792 — real LLM, needs Anthropic key
pnpm exec tsx examples/ts/langgraph-server.ts --selftest   # starts :8792 AND runs scripted WS client, exit 0/1
pnpm demo           # build + examples/ts/demo-server.ts on :8790 — real LLM, needs Anthropic key
pnpm demo:mcp       # build + examples/ts/mcp-demo-server.ts on :8791 — needs key; boots examples/ts/mcp-server.ts (SQL-backed shop MCP, :8794) in-process, loads its tools over Streamable HTTP, and runs Extension middleware that hides/redacts sensitive tool traffic
pnpm exec tsx examples/ts/mcp-demo-server.ts --selftest    # scripted WS client against the MCP demo, exit 0/1
```

There is no test framework or linter on the TS side; `pnpm smoke` and the `--selftest` flag are the tests. Ports are overridable via `PORT`.

Language ports (all selftests deterministic, no API key, exit 0/1; run from the repo root unless a `cd` is shown):

```bash
go test github.com/aimtune/botiva/...                     # ALL Go modules via go.work (`go test ./...` from the root does NOT work — the root is not inside a module)
go run ./examples/go/server --selftest                    # :8793 demo + scripted WS client
# per module (standalone, replace-based): cd packages/core/go | packages/server/go | packages/runtimes/go && go test ./...

dotnet build Botiva.slnx                                  # all five projects (SDK 10 slnx at repo root)
dotnet run --project examples/dotnet/Botiva.SelfTest      # console self-test, exit 0/1
dotnet run --project examples/dotnet/Botiva.Example -- --selftest   # :8797 ASP.NET Core + ChatClientRuntime + MCP E2E
dotnet run --project examples/dotnet/Botiva.Example -- --claude     # same server, real Claude via the official Anthropic SDK (needs ANTHROPIC_API_KEY or anthropic-key.txt in the parent repo root; NOT part of CI)

cd packages/core/python && python -m botiva.selftest      # engine self-test
cd packages/runtimes/python && PYTHONPATH=../../core/python python -m botiva_langgraph.selftest   # adapter vs fake graph (langgraph NOT required)
python examples/python/server.py --selftest               # :8795 stdlib ws transport E2E (examples add the 3 package roots to sys.path themselves)
python examples/python/langgraph_server.py --selftest     # :8796, needs `pip install langgraph` (>=0.2), still no API key
```

No Python on this Windows machine — run the Python commands through WSL (`wsl -e bash -c "cd /mnt/c/... && python3 ..."`; python3 + langgraph are installed there).

### Credentials / env

- `demo`, `demo:graph` and `demo:mcp` call `loadAnthropicKey()`: `ANTHROPIC_API_KEY` env var **or** `anthropic-key.txt` in the parent repo root (`mency-report-bot/`, one level above `botiva/`). Missing key exits the process.
- `demo:mcp` env: `MCP_URL` points it at an external Streamable HTTP MCP server (skips booting the embedded one); `MCP_PORT` moves the embedded server. `examples/ts/mcp-server.ts` also runs standalone (`pnpm exec tsx examples/ts/mcp-server.ts`, no credentials, needs Node ≥ 22.5 for `node:sqlite`).
- `smoke` and every language-port selftest are credential-free — the CI-safe tests.

## Architecture

Hexagonal, hub-and-spoke. `@botiva/core` defines the engine and four ports; every other package implements exactly one port and depends only on core (no cross-references between adapters):

- **`packages/core/ts`** — `ConversationEngine` ([engine.ts](packages/core/ts/src/engine.ts)): identity, per-conversation turn lock, seq/watermark replay, multi-connection fan-out, pending HITL interrupt, genui stream grouping. Ports: `Runtime`, `StateStore`, `HistoryStore`, `Extension` (with in-memory reference impls). `eventToFrames()` in [protocol.ts](packages/core/ts/src/protocol.ts) is the **canonical mapping other-language ports must match byte-for-byte**. `botivaEmit()`/`botivaContext()` ([emit.ts](packages/core/ts/src/emit.ts)) give ambient turn access via AsyncLocalStorage; emitted events are merged with runtime-yielded events through one `AsyncQueue`.
- **`packages/authentication/ts`** — `@botiva/authentication`, a **skeleton**: `Authenticator`/`AuthContext`/`AuthResult` + `AllowAllAuthenticator`. Nothing calls it yet — engine hook, wire-level reject (error frame + WS 4401), and port parity are specced in [docs/issues/authentication.md](docs/issues/authentication.md). Today identity is client-asserted and `Extension.onConnect` cannot reject (thrown errors are swallowed); PROTOCOL.md §2 mandates accepting identity-less connections.
- **`packages/server/ts/websocket`**, **`packages/server/ts/socketio`** — thin transport adapters (~60–130 lines): socket open → `engine.connect()`, inbound → `connection.receive()`, close → `connection.close()`, `deliver` → socket write. The websocket package is the stated template for new transports. Naming gotcha: directory `socketio` publishes as `@botiva/socket.io`.
- **`packages/runtimes/ts`** — `@botiva/langgraph`: `LangGraphRuntime` wraps any compiled graph via `streamEvents` v2. LangGraph `thread_id` = botiva `conversationId`; the full `TurnContext` is injected as `config.configurable.botiva` (the portable pattern for nodes/tools). HITL: interrupt detection happens **after** the stream by inspecting `graph.getState().tasks[].interrupts`, and resume is `new Command({ resume })` when `input.resume !== undefined`.
- **`packages/state/redis/ts`** — `@botiva/redis`: `RedisStateStore`/`RedisHistoryStore`, bring-your-own client (duck-typed `RedisClientLike`, works with ioredis and node-redis casing). Botiva state/transcript only; LangGraph checkpoints belong to `@langchain/langgraph-checkpoint-redis`. Redis exists ONLY in TS — Go/.NET/Python parity is [docs/issues/redis-parity.md](docs/issues/redis-parity.md).
- **`packages/mcp/`** — README placeholder. MCP code lives in the examples (TS shop server + redaction Extension middleware, .NET `Botiva.Example/Mcp/`); promoting it to real packages is [docs/issues/mcp-package.md](docs/issues/mcp-package.md).
- **`examples/ts`** — workspace member but *outside* the TS build graph (no tsconfig; run via tsx against built dist). Every server mounts **both** transports on one HTTP server sharing one engine. The LLM examples reach outside the monorepo (`../../../langgraph/config.mjs` for the API key; `demo-server` also serves `../../../web`) with `@ts-ignore` — the examples workspace is not self-contained, and those escapes are depth-sensitive (`examples/ts/` must stay exactly two levels below the botiva root).

### Language ports (Go / .NET / Python)

Standalone ports of core (engine zero-dependency in all three). PROTOCOL.md §8 fixes the canonical type/method names per language; keep them mirrored when editing any port. Per language:

- **Go — four modules, stitched by the repo-root `go.work`** (import strings ↔ module paths):
  - `packages/core/go` = module `github.com/aimtune/botiva/core`, package `botiva` (import with alias: `botiva "github.com/aimtune/botiva/core"`).
  - `packages/server/go` = module `github.com/aimtune/botiva/server/ws`, package `ws` — stdlib RFC 6455 server + `ws.Dial` client, query **or** hello-frame identity, ~300ms hello wait.
  - `packages/runtimes/go` = module `github.com/aimtune/botiva/runtimes/langchaingo` — agent adapter over langchaingo `llms.Model`, HITL via `Interrupt(ctx, payload)`; separate module with a `replace` so core stays zero-dep.
  - `examples/go/server` = demo server (:8793) with `--selftest`.
  - Never add a `ws/` package dir inside `packages/core/go` (module path nesting). `go mod tidy` runs per module and resolves through the `replace` directives; `GOWORK=off go test ./...` in a module dir proves standalone integrity.
- **.NET — five projects, aggregated by `Botiva.slnx`** (csproj FILE names carry assembly/namespace — folders don't):
  - `packages/core/dotnet/Botiva.csproj` (BCL only), `packages/server/dotnet/Botiva.AspNetCore.csproj` (`app.MapBotiva(path, engine)`, Kestrel WebSockets — cancelling a WebSocket receive aborts the socket, hence the pending-read handoff in the hello wait), `packages/runtimes/dotnet/Botiva.Agents.csproj` (`ChatClientRuntime` over any Microsoft.Extensions.AI `IChatClient` — manual tool loop, chat history JSON-persisted under `chatMessages`, HITL via `Hitl.Interrupt()` which throws `BotivaInterruptException` on first pass and returns the user's answer on the resume pass, pending call under `pendingToolCall`).
  - `examples/dotnet/Botiva.SelfTest` (console self-test) and `examples/dotnet/Botiva.Example` (:8797): `Tools/LocalTools.cs` (in-process tools: Ambient/UserStore/Hitl), `Mcp/IterationMcpTools.cs` (MCP tool server via `ModelContextProtocol.AspNetCore`, hosted at `/mcp` Streamable HTTP on the same Kestrel and consumed through a real `McpClient` — `McpClientTool : AIFunction`, so MCP tools drop into `ChatClientRuntimeOptions.Tools` untouched), `Agents/ScriptedChatClient.cs` (offline deterministic model, the default + what `--selftest` uses), `Agents/ClaudeChatClient.cs` (`IChatClient` over the official `Anthropic` NuGet SDK; `--claude` flag or `BOTIVA_MODEL=claude`; key from `ANTHROPIC_API_KEY` or parent-repo `anthropic-key.txt`; model `CLAUDE_MODEL` ?? `claude-opus-4-8`), `Agents/LazyRuntime.cs` (defers MCP-client wiring until Kestrel is listening). MCP tools run outside the botiva turn context (HTTP hop) — Ambient/Hitl only works in LocalTools.
- **Python — three packages** (each dir has its own pyproject; examples insert all three roots into `sys.path` via `selftest_common.py`, which must stay imported BEFORE any `botiva*` import):
  - `packages/core/python/botiva/` (engine, protocol, events, state, demo, selftest), `packages/server/python/botiva_ws/` (stdlib asyncio ws server + `WebSocketClient`), `packages/runtimes/python/botiva_langgraph/` (mirrors `@botiva/langgraph`: `astream_events` v2, interrupt detection AFTER the stream via `aget_state().tasks[].interrupts`, resume via `Command(resume=...)`, `command_factory` injectable for langgraph-free tests; `selftest.py` inside it).
  - `examples/python/server.py` (:8795) and `examples/python/langgraph_server.py` (:8796, real LangGraph with a rule-based agent node — `config` param must be typed `RunnableConfig`, not `dict`, or LangGraph 1.x won't inject it).
- Port allocation across the repo: 8790 demo, 8791 demo:mcp, 8792 demo:graph, 8793 Go, 8794 TS mcp-server, 8795/8796 Python, 8797 .NET.

### Cross-cutting contracts to keep in mind

- **Module system (TS)**: everything is ESM with `module: NodeNext` + `verbatimModuleSyntax` — relative imports need explicit `.js` extensions, type-only imports must use `import type`. Workspace globs: `packages/*/ts`, `packages/*/ts/*`, `packages/*/*/ts`, `examples/ts`.
- **Turn lifecycle** (PROTOCOL.md §4): extension `onMessage` chain (null ⇒ swallow) → turn lock (busy notice to sender only) → persist + fan out user frame to every connection *except the sender* → pending interrupt turns the next message into `RunInput {resume, interrupt}` → events dispatched through `onEvent` chain → `eventToFrames` → history append (monotonic 1-based `seq`) → broadcast.
- **State keyspace**: one `StateStore`, three namespaces — `user:{userId}`, `conv:{conversationId}`, and engine-internal `conv:{conversationId}:botiva` (owner, createdAt, pendingInterrupt).
- **Watermark semantics**: on connect the server replays every persistent frame with `seq > watermark`. Because the sender's own user frames are persisted but never echoed back to it, a client's max *observed* seq can lag the server watermark — this is by design.
- **GenUI streams**: the first genui event of a turn fixes the `streamId`; if the runtime never sends `done: true` the engine emits a closing chunk at turn end.
- **Scaling caveat** (PROTOCOL.md §10): the turn lock and live-connection registry are process-local even with Redis stores — multi-instance deployment needs sticky sessions per `conversationId` or a store-based lock + pub/sub fan-out (not provided).
- **HITL resume convention in the demos**: the user's next message is matched with `/approve|yes|onay|evet/i` (Turkish included).
