# botiva language ports

Reference implementations of the botiva core (engine + protocol + ports) in
other languages. All of them speak **Botiva Wire Protocol v1** (see
[PROTOCOL.md](../PROTOCOL.md)) and keep the same names and signatures as
`@botiva/core`, so a team can move between stacks without relearning anything:

| Concept            | TypeScript                   | Go                          | C# (.NET)                     | Python                     |
|--------------------|------------------------------|-----------------------------|-------------------------------|-----------------------------|
| Engine             | `ConversationEngine`         | `botiva.ConversationEngine` | `Botiva.ConversationEngine`   | `botiva.ConversationEngine` |
| Attach a client    | `engine.connect(params)`     | `engine.Connect(ctx, p)`    | `engine.ConnectAsync(p)`      | `await engine.connect(...)` |
| Runtime port       | `run(input, ctx): AsyncIterable` | `Run(ctx, in, tc) (<-chan, error)` | `RunAsync(...): IAsyncEnumerable` | `async def run(...) -> AsyncIterator` |
| Ambient emit       | `botivaEmit(ev)` (AsyncLocalStorage) | `botiva.Emit(ctx, ev)` (context.Context) | `Ambient.Emit(ev)` (AsyncLocal) | `botiva_emit(ev)` (contextvars) |
| User state         | `UserStore`                  | `UserStore`                 | `UserStore`                   | `UserStore`                 |
| Conversation state | `ConversationStore`          | `ConversationStore`         | `ConversationStore`           | `ConversationStore`         |
| Transcript/replay  | `HistoryStore`               | `HistoryStore`              | `IHistoryStore`               | `HistoryStore`              |
| WebSocket transport | `@botiva/websocket`         | `botiva/ws` (stdlib)        | `Botiva.AspNetCore` (`app.MapBotiva`) | `botiva.ws` (stdlib asyncio) |
| Agent adapter      | `@botiva/langgraph` (LangGraph) | `adapters/langchaingo` (langchaingo) | `Botiva.Agents` (M.E.AI `IChatClient`) | `botiva.langgraph` (LangGraph) |
| HITL inside a tool | LangGraph `interrupt()`      | `langchaingo.Interrupt(ctx, p)` | `Hitl.Interrupt(p)`       | LangGraph `interrupt()`     |

Each port ships a `DemoRuntime` and a self-test that runs the exact same
scenario as the TypeScript smoke test (welcome/identity, echo, user state,
tool_call + HITL resume, ambient-emit GenUI with auto stream close, watermark
replay, multi-connection fan-out, cross-conversation user state):

```sh
# Go            (verified ✅)
cd go && go test ./...                                  # engine + ws transport
cd go && go run ./examples/server --selftest            # E2E over the wire
cd go/adapters/langchaingo && go test ./...             # agent adapter (separate module)

# .NET          (verified ✅)
cd dotnet && dotnet run --project Botiva.SelfTest                 # engine
cd dotnet && dotnet run --project Botiva.Example -- --selftest    # E2E + agent loop

# Python 3.10+  (verified ✅)
cd python && python -m botiva.selftest                  # engine
cd python && python -m botiva.selftest_langgraph        # adapter (no langgraph needed)
cd python && python examples/server.py --selftest       # E2E over the wire
cd python && python examples/langgraph_server.py --selftest   # real LangGraph (pip install langgraph)
```

Each port also ships a **WebSocket transport** and an **agent-framework
adapter** (see the per-port READMEs: [go](go/README.md),
[dotnet](dotnet/README.md), [python](python/README.md)). Per PROTOCOL.md §8 a
transport adapter stays thin in any language — map socket open → `Connect`,
inbound data → `Receive`, socket close → `Close`, `Deliver` → socket write —
so wiring the same engine to SSE, SignalR, FastAPI/Starlette or gRPC follows
the same four calls.

Runnable demo servers (all deterministic, no API key; any botiva client can
talk to any of them):

| Server | Port | Runtime behind it |
|---|---|---|
| `go run ./examples/server` | 8793 | `botiva.DemoRuntime` |
| `dotnet run --project Botiva.Example` | 8797 | `Botiva.Agents.ChatClientRuntime` + scripted `IChatClient`; MCP tools at `/mcp` (ModelContextProtocol); `-- --claude` → real Claude via the official Anthropic SDK |
| `python examples/server.py` | 8795 | `botiva.DemoRuntime` |
| `python examples/langgraph_server.py` | 8796 | `botiva.langgraph.LangGraphRuntime` + real LangGraph graph |
