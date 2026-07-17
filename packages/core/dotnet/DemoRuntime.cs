using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Botiva;

/// <summary>
/// Dependency-free reference implementation of IRuntime (same behavior as the
/// TS/Go DemoRuntime; used by the port's self-test).
/// </summary>
public sealed partial class DemoRuntime : IRuntime
{
    [GeneratedRegex(@"(?:my name is|ad[ıi]m)\s+(\p{L}+)", RegexOptions.IgnoreCase)]
    private static partial Regex NameRe();

    [GeneratedRegex(@"what.*my name|ad[ıi]m ne", RegexOptions.IgnoreCase)]
    private static partial Regex AskNameRe();

    [GeneratedRegex(@"approve|yes|onay|evet", RegexOptions.IgnoreCase)]
    private static partial Regex ApproveRe();

    public async IAsyncEnumerable<AgentEvent> RunAsync(
        RunInput input, TurnContext ctx, [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return AgentEvent.RunStarted();

        if (input.Resume is not null)
        {
            yield return AgentEvent.Message(ApproveRe().IsMatch(input.Resume)
                ? "✅ Approved — the PDF report is ready: report-2025.pdf"
                : "❌ Cancelled — no report was generated.");
            yield return AgentEvent.RunFinished();
            yield break;
        }

        var text = (input.Text ?? "").Trim();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        if (NameRe().Match(text) is { Success: true } m)
        {
            await ctx.UserStore.PatchAsync(new JsonObject { ["name"] = m.Groups[1].Value }, ct);
            yield return AgentEvent.Message($"Nice to meet you, {m.Groups[1].Value}! I'll remember that across conversations.");
        }
        else if (AskNameRe().IsMatch(text))
        {
            var user = await ctx.UserStore.GetAsync(ct);
            yield return AgentEvent.Message(user?["name"] is JsonNode name
                ? $"Your name is {name}."
                : "I don't know your name yet — tell me with “my name is …”.");
        }
        else if (text.Contains("weather", StringComparison.OrdinalIgnoreCase) ||
                 text.Contains("hava", StringComparison.OrdinalIgnoreCase))
        {
            // Out-of-band emit through the ambient context (AsyncLocal).
            Ambient.Emit(AgentEvent.Ui("weather", new() { ["city"] = "Istanbul", ["temp"] = 22 }));
            yield return AgentEvent.Message("Here is the current weather.");
        }
        else if (text.Contains("report", StringComparison.OrdinalIgnoreCase) ||
                 text.Contains("rapor", StringComparison.OrdinalIgnoreCase))
        {
            var id = $"demo-{now}";
            yield return AgentEvent.ToolCallEvent(new ToolCall
            {
                Id = id, Name = "get_sales_stats", Status = "running",
                Params = new { region = "EMEA", year = 2025 }, StartedAt = now,
            });
            yield return AgentEvent.ToolCallEvent(new ToolCall
            {
                Id = id, Name = "get_sales_stats", Status = "completed",
                Result = new { totalOrders = 42, growth = 0.87 }, EndedAt = now,
            });
            yield return AgentEvent.Interrupt(new
            {
                question = "42 orders, 87% growth in EMEA. Generate the PDF report?",
                options = new[] { "Approve", "Cancel" },
            });
        }
        else
        {
            yield return AgentEvent.Message($"Echo: {text}");
        }

        yield return AgentEvent.RunFinished();
    }
}
