// Offline "model" layer — a deterministic IChatClient that routes user text to
// tool calls with simple rules and phrases tool results into final answers.
// It makes the whole agent loop (tool calls, MCP tools, HITL resume, GenUI,
// UserStore memory) runnable without an API key — in CI and in --selftest.
// Program.cs swaps this for ClaudeChatClient when a key is available.

using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.AI;

namespace Botiva.Example.Agents;

public sealed partial class ScriptedChatClient : IChatClient
{
    private int _calls;

    [GeneratedRegex(@"(?:my name is|ad[ıi]m)\s+(\p{L}+)", RegexOptions.IgnoreCase)]
    private static partial Regex NameRe();

    [GeneratedRegex(@"what.*my name|ad[ıi]m\s+ne", RegexOptions.IgnoreCase)]
    private static partial Regex AskNameRe();

    // City only when explicitly "weather in <city>"; a bare "weather"/"hava"
    // falls through to the Istanbul default rather than grabbing the next word.
    [GeneratedRegex(@"weather\s+in\s+(\p{L}+)|weather|hava", RegexOptions.IgnoreCase)]
    private static partial Regex WeatherRe();

    [GeneratedRegex(@"report|pdf|rapor", RegexOptions.IgnoreCase)]
    private static partial Regex ReportRe();

    [GeneratedRegex(@"iteration performance|iterasyon", RegexOptions.IgnoreCase)]
    private static partial Regex IterationRe();

    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        var list = messages.ToList();
        var last = list.LastOrDefault();

        // A tool round just finished → phrase the final answer from its result.
        if (last?.Role == ChatRole.Tool)
        {
            var result = last.Contents.OfType<FunctionResultContent>().FirstOrDefault();
            var calledTool = list.LastOrDefault(m => m.Role == ChatRole.Assistant)?
                .Contents.OfType<FunctionCallContent>().FirstOrDefault()?.Name;
            var text = result?.Result switch
            {
                string s => s,
                JsonElement je => je.ToString(),
                { } o => JsonSerializer.Serialize(o),
                null => "",
            };
            if (calledTool == "get_weather") text = "Here is the current weather.";
            return Reply(new ChatMessage(ChatRole.Assistant, text.Length > 0 ? text : "Done."));
        }

        var input = list.LastOrDefault(m => m.Role == ChatRole.User)?.Text ?? "";
        // Ask-name BEFORE name-set: "adım ne?" ("what's my name") otherwise
        // matches the name-set pattern and clobbers the stored name with "ne".
        if (AskNameRe().IsMatch(input))
            return CallTool("recall_name", new());
        if (NameRe().Match(input) is { Success: true } name)
            return CallTool("remember_name", new() { ["name"] = name.Groups[1].Value });
        if (WeatherRe().Match(input) is { Success: true } weather)
            return CallTool("get_weather", new() { ["city"] = weather.Groups[1].Success ? weather.Groups[1].Value : "Istanbul" });
        if (ReportRe().IsMatch(input))
            return CallTool("generate_report_pdf", new() { ["topic"] = "iteration velocity" });
        if (IterationRe().IsMatch(input)) // → the MCP tool (over Streamable HTTP)
            return CallTool("get_iteration_performance", new() { ["tribeId"] = 3, ["iterationYear"] = 2025 });
        return Reply(new ChatMessage(ChatRole.Assistant, $"Echo: {input}"));
    }

    private Task<ChatResponse> CallTool(string name, Dictionary<string, object?> args) =>
        Reply(new ChatMessage(ChatRole.Assistant,
            [new FunctionCallContent($"call-{Interlocked.Increment(ref _calls)}", name, args)]));

    private static Task<ChatResponse> Reply(ChatMessage message) =>
        Task.FromResult(new ChatResponse(message));

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var response = await GetResponseAsync(messages, options, cancellationToken);
        foreach (var update in response.ToChatResponseUpdates()) yield return update;
    }

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceType.IsInstanceOfType(this) ? this : null;

    public void Dispose() { }
}
