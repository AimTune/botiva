// Local (in-process) tools — every botiva context pattern in real tool code:
//   Ambient.Emit      → GenUI cards without plumbing (AsyncLocal, PROTOCOL.md §9)
//   Ambient.Context   → UserStore/ConversationStore access inside a tool
//   Hitl.Interrupt    → LangGraph-style human-in-the-loop pause/resume
// These run in-process; tools that live in a separate service belong in the
// MCP server instead (see Mcp/IterationMcpTools.cs).

using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Botiva;
using Botiva.Agents;
using Microsoft.Extensions.AI;

namespace Botiva.Example.Tools;

public static partial class LocalTools
{
    /// <summary>The tool list for ChatClientRuntimeOptions.Tools.</summary>
    public static List<AITool> All() =>
    [
        AIFunctionFactory.Create(GetWeather, "get_weather"),
        AIFunctionFactory.Create(RememberName, "remember_name"),
        AIFunctionFactory.Create(RecallName, "recall_name"),
        AIFunctionFactory.Create(GenerateReportPdf, "generate_report_pdf"),
    ];

    [Description("Returns a city's weather and shows a weather card in the chat.")]
    public static string GetWeather([Description("e.g. Istanbul")] string city)
    {
        var seed = city.Sum(ch => (int)ch);
        var data = new Dictionary<string, object?>
        {
            ["city"] = city,
            ["temp"] = 12 + seed % 20,
            ["condition"] = new[] { "Sunny", "Partly Cloudy", "Rainy" }[seed % 3],
            ["humidity"] = 40 + seed % 40,
        };
        // Ambient emit — the framework knows which conversation/user this turn
        // belongs to; no plumbing through the agent loop.
        Ambient.Emit(AgentEvent.Ui("weather", data));
        return JsonSerializer.Serialize(data);
    }

    [Description("Stores the user's name in their permanent profile (UserStore).")]
    public static async Task<string> RememberName(string name)
    {
        var ctx = Ambient.Context;
        if (ctx is null) return "no ambient turn context";
        await ctx.UserStore.PatchAsync(new JsonObject { ["name"] = name });
        return $"Saved. The user's name is {name} (persisted for user {ctx.UserId}).";
    }

    [Description("Looks up the user's name from their permanent profile (UserStore).")]
    public static async Task<string> RecallName()
    {
        var user = Ambient.Context is { } ctx ? await ctx.UserStore.GetAsync() : null;
        return user?["name"] is JsonNode name
            ? $"Your name is {name}."
            : "I don't know your name yet — tell me with “my name is …”.";
    }

    [GeneratedRegex("approve|yes|onay|evet", RegexOptions.IgnoreCase)]
    private static partial Regex ApproveRe();

    [Description("Generates a report PDF on a topic (asks the user for approval first).")]
    public static string GenerateReportPdf(string topic)
    {
        // Human approval: the run pauses here; the user's next message comes
        // back as the return value of Hitl.Interrupt (PROTOCOL.md §5).
        var answer = Hitl.Interrupt(new
        {
            question = $"Generate the \"{topic}\" report as PDF?",
            options = new[] { "Approve", "Cancel" },
        });
        if (!ApproveRe().IsMatch(answer as string ?? ""))
            return "The user declined — no report was generated.";
        var fileName = $"report-{Regex.Replace(topic.ToLowerInvariant(), "[^a-z0-9]+", "-")}.pdf";
        Ambient.Emit(AgentEvent.Ui("genui-card", new Dictionary<string, object?>
        {
            ["title"] = $"📄 {fileName}",
            ["description"] = $"\"{topic}\" report is ready.",
            ["actions"] = new[]
            {
                new Dictionary<string, object?> { ["label"] = "⬇️ Download", ["value"] = $"download {fileName}" },
            },
        }));
        return $"Report ready: {fileName} (download card shown).";
    }
}
