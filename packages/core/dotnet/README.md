# botiva (.NET reference port)

.NET 8 port of the botiva conversation framework — same signatures as
`@botiva/core` (see [../../../PROTOCOL.md](../../../PROTOCOL.md) §8).

Five projects, aggregated by the repo-root `Botiva.slnx` (project file names —
and therefore assembly names/namespaces — are unchanged):

```
packages/core/dotnet/       Botiva.csproj           engine, protocol, events, stores, DemoRuntime (BCL only)
packages/server/dotnet/     Botiva.AspNetCore.csproj WebSocket transport — app.MapBotiva("/chat", engine)
packages/runtimes/dotnet/   Botiva.Agents.csproj    agent adapter for Microsoft.Extensions.AI IChatClient
examples/dotnet/Botiva.Example/   runnable ASP.NET Core demo server (:8797) with --selftest
  Tools/LocalTools.cs          in-process tools (Ambient.Emit / UserStore / Hitl.Interrupt)
  Mcp/IterationMcpTools.cs     MCP tool server (ModelContextProtocol, hosted at /mcp)
  Agents/ScriptedChatClient.cs deterministic offline "model" (default — no API key)
  Agents/ClaudeChatClient.cs   Claude Messages API layer (official Anthropic SDK)
  Agents/LazyRuntime.cs        defers wiring until the MCP endpoint is listening
  Program.cs                   composition root; SelfTest.cs scripted WS client
examples/dotnet/Botiva.SelfTest/  console engine self-test, exit 0/1
```

## Serve a bot (ASP.NET Core)

```csharp
using Botiva;
using Botiva.AspNetCore;

var engine = new ConversationEngine(new EngineOptions
{
    Runtime = new DemoRuntime(),   // swap for ChatClientRuntime below
    Greeting = "Hi! 👋",
});

var app = WebApplication.CreateBuilder(args).Build();
app.MapBotiva("/chat", engine);    // ws://localhost:8797/chat
app.Run();
```

Kestrel's built-in WebSockets — no extra NuGet package. The endpoint accepts
identity via query (`?userId=&conversationId=&watermark=`) **or** a first
`hello` frame, and handles watermark replay, fan-out and HITL exactly like the
TS transport.

## Agent framework — Microsoft.Extensions.AI

`Botiva.Agents.ChatClientRuntime` plugs **any `IChatClient`** into the Runtime
port — OpenAI/Azure OpenAI/Ollama clients, or Semantic Kernel via
`IChatCompletionService.AsChatClient()`. It runs a manual tool-calling loop so
every call becomes a `tool_call` frame, keeps chat memory in
`ConversationStore` (follows your StateStore — memory, Redis, …), and supports
LangGraph-style HITL via `Hitl.Interrupt`:

```csharp
using Botiva.Agents;
using Microsoft.Extensions.AI;

[Description("Generates a report PDF (asks the user for approval first).")]
static string GenerateReportPdf(string topic)
{
    var answer = Hitl.Interrupt(new       // ⏸ first pass: pause → approval chips
    {
        question = $"Generate the \"{topic}\" report as PDF?",
        options = new[] { "Approve", "Cancel" },
    });                                    // resume pass: the user's next message
    if (!Regex.IsMatch(answer as string ?? "", "approve|yes|onay|evet", RegexOptions.IgnoreCase))
        return "The user declined.";
    Ambient.Emit(AgentEvent.Ui("genui-card", new() { ["title"] = "📄 report.pdf" }));
    return "Report ready: report.pdf";
}

var runtime = new ChatClientRuntime(chatClient, new ChatClientRuntimeOptions
{
    Tools = [AIFunctionFactory.Create(GenerateReportPdf, "generate_report_pdf")],
    // per-turn system prompt — the place to inject UserStore facts:
    InstructionsFactory = async (ctx, ct) =>
    {
        var user = await ctx.UserStore.GetAsync(ct);
        return $"You are a helpful assistant. {(user?["name"] is { } n ? $"The user's name is {n}." : "")}";
    },
});
```

Inside tools, `Ambient.Context` gives the `TurnContext`
(UserStore/ConversationStore) and `Ambient.Emit(...)` pushes GenUI/events —
the .NET equivalents of `botivaContext()`/`botivaEmit()` (PROTOCOL.md §9).

## MCP tools — ModelContextProtocol

`Botiva.Example` hosts an MCP tool server (official `ModelContextProtocol`
C# SDK) on the same Kestrel at `/mcp` (Streamable HTTP) and consumes it the
way any external client would — so moving the tools to a separate service is
only a URL change:

```csharp
// server side (Program.cs):
builder.Services.AddMcpServer()
    .WithHttpTransport(o => o.Stateless = true)
    .WithToolsFromAssembly();          // [McpServerToolType] classes
app.MapMcp("/mcp");

// agent side: McpClientTool derives from AIFunction → drops straight into
// the ChatClientRuntime tool list next to the local tools
var mcp = await McpClient.CreateAsync(new HttpClientTransport(new() { Endpoint = new Uri("http://localhost:8797/mcp") }));
var tools = await mcp.ListToolsAsync();
new ChatClientRuntimeOptions { Tools = [.. LocalTools.All(), .. tools] };
```

MCP tools travel over HTTP, outside the botiva turn context — keep them pure
data tools; UserStore/GenUI/HITL tools stay local (`Tools/LocalTools.cs`).

## Claude — official Anthropic SDK

`Agents/ClaudeChatClient.cs` is an `IChatClient` over the official `Anthropic`
NuGet package (Claude Messages API): ChatMessage ⇄ `MessageParam` blocks,
`AIFunction` → tool definitions, `tool_use` → `FunctionCallContent`, tool
results → `tool_result` blocks. Model: `CLAUDE_MODEL` env or
`claude-opus-4-8`; key: `ANTHROPIC_API_KEY` or `anthropic-key.txt` in the
parent repo root (mirrors the TS demos' `loadAnthropicKey()`).

```sh
dotnet run --project examples/dotnet/Botiva.Example -- --claude    # real Claude behind the same agent loop
```

Everything else — tools, MCP, HITL chips, GenUI, UserStore memory — stays
identical between the scripted model and Claude; only the `IChatClient` swaps.

## Run / test

All from the repo root:

```sh
dotnet build Botiva.slnx                                           # all five projects
dotnet run --project examples/dotnet/Botiva.SelfTest               # engine self-test, exit 0/1
dotnet run --project examples/dotnet/Botiva.Example                # demo server on :8797 (PORT overridable)
dotnet run --project examples/dotnet/Botiva.Example -- --selftest  # + scripted WS client, exit 0/1
dotnet run --project examples/dotnet/Botiva.Example -- --claude    # real Claude (needs key, see above)
```

By default `Botiva.Example` uses the **scripted `IChatClient`** as the model,
so the whole agent loop — local tool calls, the MCP tool over Streamable
HTTP, `Hitl.Interrupt` approval, ambient GenUI, UserStore memory across
conversations — runs end-to-end without an API key (that's what `--selftest`
exercises). `--claude` swaps in the real model; nothing else changes.
