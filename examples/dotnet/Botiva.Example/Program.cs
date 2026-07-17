// botiva .NET demo server — the composition root. The layers live in:
//
//   Tools/LocalTools.cs          in-process tools (Ambient.Emit / UserStore / Hitl.Interrupt)
//   Mcp/IterationMcpTools.cs     MCP tool server (ModelContextProtocol, hosted at /mcp)
//   Agents/ScriptedChatClient.cs deterministic offline "model" (default — no API key)
//   Agents/ClaudeChatClient.cs   Claude Messages API layer (official Anthropic SDK)
//   Agents/LazyRuntime.cs        defers wiring until the MCP endpoint is listening
//   SelfTest.cs                  scripted WebSocket client, exit 0/1
//
// The agent loop itself is Botiva.Agents.ChatClientRuntime; the transport is
// Botiva.AspNetCore's app.MapBotiva. MCP tools are consumed through a real
// MCP client (Streamable HTTP against our own /mcp), so moving them to a
// separate service is only a URL change.
//
//   dotnet run --project examples/dotnet/Botiva.Example                # :8797, scripted model
//   dotnet run --project examples/dotnet/Botiva.Example -- --selftest  # + scripted WS client, exit 0/1
//   dotnet run --project examples/dotnet/Botiva.Example -- --claude    # real Claude (ANTHROPIC_API_KEY
//                                                      #   or anthropic-key.txt in repo root)
//
// Browser console:
//   s = new WebSocket("ws://localhost:8797/chat")
//   s.onmessage = e => console.log(JSON.parse(e.data))
//   s.onopen = () => s.send(JSON.stringify({type:"text",data:{text:"Show me the iteration performance"}}))

using Botiva;
using Botiva.Agents;
using Botiva.AspNetCore;
using Botiva.Authentication;
using Botiva.Example;
using Botiva.Example.Agents;
using Botiva.Example.Tools;
using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;

var port = Environment.GetEnvironmentVariable("PORT") ?? "8797";
var selftest = args.Contains("--selftest");
var useClaude = args.Contains("--claude") ||
                string.Equals(Environment.GetEnvironmentVariable("BOTIVA_MODEL"), "claude", StringComparison.OrdinalIgnoreCase);

// ── the runtime: local tools + MCP tools behind one IChatClient ─────────────

var runtime = new LazyRuntime(async () =>
{
    // Consume our own MCP server the way any external client would —
    // McpClientTool derives from AIFunction, so MCP tools drop straight
    // into the ChatClientRuntime tool list next to the local ones.
    var mcpClient = await McpClient.CreateAsync(new HttpClientTransport(new HttpClientTransportOptions
    {
        Endpoint = new Uri($"http://localhost:{port}/mcp"),
    }));
    var mcpTools = await mcpClient.ListToolsAsync();
    Console.WriteLine($"  → MCP tools loaded: {string.Join(", ", mcpTools.Select(t => t.Name))}");

    IChatClient model = useClaude ? new ClaudeChatClient() : (IChatClient)new ScriptedChatClient();
    Console.WriteLine($"  → model: {(useClaude ? "Claude (Anthropic SDK)" : "ScriptedChatClient (offline)")}");

    return new ChatClientRuntime(model, new ChatClientRuntimeOptions
    {
        Tools = [.. LocalTools.All(), .. mcpTools],
        // Per-turn system prompt — the portable place to inject UserStore
        // facts (the LangGraph agent-node pattern; used by the Claude path).
        InstructionsFactory = async (ctx, ct) =>
        {
            var user = await ctx.UserStore.GetAsync(ct);
            return "You are the botiva .NET agent demo. Use the tools for weather, names, reports "
                 + "and iteration performance; answer briefly in the user's language. "
                 + "If the user asks for a PDF/report, call generate_report_pdf directly WITHOUT asking "
                 + "for confirmation first — the tool asks for approval itself."
                 + (user?["name"] is { } name ? $" The user's name is {name} (from UserStore)." : "");
        },
    });
});

var engine = new ConversationEngine(new EngineOptions
{
    Runtime = runtime,
    Greeting = "Hi! botiva .NET agent demo. Try: 'My name is Ada', 'What's the weather in Istanbul?', "
             + "'Show me the iteration performance', or 'Generate a PDF report about velocity' 👋",
});

// ── the server: botiva transport + MCP endpoint on one Kestrel ──────────────

var builder = WebApplication.CreateBuilder();
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.WebHost.UseUrls($"http://localhost:{port}");
builder.Services.AddMcpServer()
    .WithHttpTransport(options => options.Stateless = true)
    .WithToolsFromAssembly(); // picks up [McpServerToolType] classes (Mcp/IterationMcpTools.cs)

// A second, authenticated endpoint (PROTOCOL.md §2.1) — demonstrates the
// transport rejecting/verifying credentials over the wire; --selftest checks it.
var secureEngine = new ConversationEngine(new EngineOptions
{
    Runtime = new DemoRuntime(),
    Authenticator = new StaticTokenAuthenticator(new Dictionary<string, string> { ["good-token"] = "user-verified" }),
});

var app = builder.Build();
app.MapGet("/healthz", () => Results.Json(new { ok = true, engine = "botiva-dotnet-demo" }));
app.MapMcp("/mcp");
app.MapBotiva("/chat", engine);
app.MapBotiva("/chat-secure", secureEngine);

await app.StartAsync();
await runtime.WarmUpAsync(); // connect the MCP client now that /mcp is live
Console.WriteLine($"\n✓ botiva .NET demo ready → ws://localhost:{port}/chat  (MCP: http://localhost:{port}/mcp)\n");

if (selftest)
{
    var ok = await SelfTest.RunAsync(port);
    await app.StopAsync();
    return ok ? 0 : 1;
}
await app.WaitForShutdownAsync();
return 0;
