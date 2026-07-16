// MCP tool server layer — tools exposed over the Model Context Protocol
// (Streamable HTTP) with the official ModelContextProtocol C# SDK.
//
// Program.cs hosts these on the same Kestrel at /mcp (AddMcpServer +
// MapMcp) and the agent consumes them THROUGH an MCP client — the same
// pattern as the TS examples/mcp-demo-server.ts, so the tools could just as
// well live in a separate process/service: only the endpoint URL changes.
//
// MCP tools run outside the botiva turn context (the call travels over HTTP),
// so no Ambient.* here — keep them pure data tools; UserStore/GenUI/HITL
// tools belong in Tools/LocalTools.cs.

using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;

namespace Botiva.Example.Mcp;

[McpServerToolType]
public static class IterationMcpTools
{
    [McpServerTool(Name = "get_iteration_performance")]
    [Description("Returns a tribe's iteration performance metrics (velocity, commitment rate) for a given year.")]
    public static string GetIterationPerformance(
        [Description("Tribe id, e.g. 3")] int tribeId,
        [Description("Iteration year, e.g. 2025")] int iterationYear)
    {
        var seed = tribeId * 31 + iterationYear % 100;
        return JsonSerializer.Serialize(new
        {
            tribeId,
            iterationYear,
            velocity = 30 + seed % 20,
            commitmentRate = Math.Round(0.70 + seed % 25 / 100.0, 2),
            completedStories = 40 + seed % 30,
        });
    }

    [McpServerTool(Name = "list_tribes")]
    [Description("Lists the tribes that have iteration data.")]
    public static string ListTribes() =>
        JsonSerializer.Serialize(new[]
        {
            new { id = 1, name = "Platform" },
            new { id = 2, name = "Payments" },
            new { id = 3, name = "Mobile" },
        });
}
