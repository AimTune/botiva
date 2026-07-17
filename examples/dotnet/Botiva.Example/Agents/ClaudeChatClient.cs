// Claude chat layer — an IChatClient over the official Anthropic C# SDK,
// bridging Microsoft.Extensions.AI to the Claude Messages API so
// ChatClientRuntime (Botiva.Agents) can drive Claude without knowing about
// Anthropic types:
//
//   ChatMessage (User/Assistant/Tool)  ⇄  MessageParam + content blocks
//   AIFunction (ChatOptions.Tools)     →  Anthropic Tool (JSON schema)
//   tool_use blocks                    →  FunctionCallContent
//   FunctionResultContent              →  tool_result blocks
//
// Key resolution mirrors the TS demos (AnthropicKey). Model: CLAUDE_MODEL
// env var or claude-opus-4-8.

using System.Runtime.CompilerServices;
using System.Text.Json;
using Anthropic;
using Anthropic.Models.Messages;
using Microsoft.Extensions.AI;
using AIChatMessage = Microsoft.Extensions.AI.ChatMessage;

namespace Botiva.Example.Agents;

public sealed class ClaudeChatClient : IChatClient
{
    private readonly AnthropicClient _client;
    private readonly string _model;
    private readonly long _maxTokens;

    public ClaudeChatClient(string? apiKey = null, string? model = null, long maxTokens = 1500)
    {
        if (apiKey is null && !AnthropicKey.TryLoad(out apiKey!))
            throw new InvalidOperationException(
                "No Anthropic key: set ANTHROPIC_API_KEY or put anthropic-key.txt in the parent repo root.");
        _client = new AnthropicClient { ApiKey = apiKey };
        _model = model ?? Environment.GetEnvironmentVariable("CLAUDE_MODEL") ?? "claude-opus-4-8";
        _maxTokens = maxTokens;
    }

    public async Task<ChatResponse> GetResponseAsync(
        IEnumerable<AIChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        var (system, mapped) = MapMessages(messages);
        // Honor caller-supplied ChatOptions instead of silently ignoring them.
        var model = options?.ModelId ?? _model;
        var maxTokens = options?.MaxOutputTokens is int m and > 0 ? m : _maxTokens;
        var parameters = new MessageCreateParams
        {
            Model = model,
            MaxTokens = maxTokens,
            Messages = mapped,
            System = system is null ? null : (MessageCreateParamsSystem)system,
            Tools = MapTools(options),
            ToolChoice = MapToolChoice(options?.ToolMode),
        };
        var response = await _client.Messages.Create(parameters, cancellationToken: cancellationToken);

        var contents = new List<AIContent>();
        foreach (var block in response.Content)
        {
            if (block.TryPickText(out var text)) contents.Add(new TextContent(text.Text));
            else if (block.TryPickToolUse(out var toolUse))
            {
                var args = toolUse.Input.ToDictionary(kv => kv.Key, kv => (object?)kv.Value);
                contents.Add(new FunctionCallContent(toolUse.ID, toolUse.Name, args));
            }
        }
        return new ChatResponse(new AIChatMessage(Microsoft.Extensions.AI.ChatRole.Assistant, contents))
        {
            ModelId = model,
        };
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<AIChatMessage> messages, ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var response = await GetResponseAsync(messages, options, cancellationToken);
        foreach (var update in response.ToChatResponseUpdates()) yield return update;
    }

    // ── Microsoft.Extensions.AI → Anthropic mapping ──────────────────────────

    private static (string? System, List<MessageParam> Messages) MapMessages(IEnumerable<AIChatMessage> messages)
    {
        var system = new List<string>();
        // Accumulate (role, blocks) and MERGE consecutive same-role turns. The
        // Messages API requires all tool_result blocks for one assistant turn in
        // a SINGLE user message (parallel tool calls → one Tool ChatMessage each →
        // consecutive user turns) and rejects consecutive same-role messages.
        var turns = new List<(Role Role, List<ContentBlockParam> Blocks)>();
        foreach (var message in messages)
        {
            if (message.Role == Microsoft.Extensions.AI.ChatRole.System)
            {
                if (!string.IsNullOrWhiteSpace(message.Text)) system.Add(message.Text);
                continue;
            }
            var blocks = new List<ContentBlockParam>();
            foreach (var content in message.Contents)
            {
                switch (content)
                {
                    case TextContent text when !string.IsNullOrEmpty(text.Text):
                        blocks.Add(new TextBlockParam { Text = text.Text });
                        break;
                    case FunctionCallContent call:
                        blocks.Add(new ToolUseBlockParam
                        {
                            ID = call.CallId,
                            Name = call.Name,
                            Input = ToInputDictionary(call.Arguments),
                        });
                        break;
                    case FunctionResultContent result:
                        blocks.Add(new ToolResultBlockParam
                        {
                            ToolUseID = result.CallId,
                            Content = ResultText(result.Result),
                        });
                        break;
                }
            }
            if (blocks.Count == 0) continue;
            // Anthropic has no "tool" role — tool_result blocks travel in a user
            // message; everything the model produced stays "assistant".
            var role = message.Role == Microsoft.Extensions.AI.ChatRole.Assistant
                ? Role.Assistant
                : Role.User;
            if (turns.Count > 0 && turns[^1].Role == role) turns[^1].Blocks.AddRange(blocks);
            else turns.Add((role, blocks));
        }
        var mapped = turns.Select(t => new MessageParam { Role = t.Role, Content = t.Blocks }).ToList();
        return (system.Count > 0 ? string.Join("\n\n", system) : null, mapped);
    }

    private static List<ToolUnion>? MapTools(ChatOptions? options)
    {
        var functions = options?.Tools?.OfType<AIFunction>().ToList();
        if (functions is null || functions.Count == 0) return null;
        return functions.Select(fn => (ToolUnion)new Tool
        {
            Name = fn.Name,
            Description = fn.Description,
            InputSchema = ToInputSchema(fn.JsonSchema),
        }).ToList();
    }

    private static ToolChoice? MapToolChoice(ChatToolMode? mode) => mode switch
    {
        RequiredChatToolMode { RequiredFunctionName: { } name } => (ToolChoice)new ToolChoiceTool { Name = name },
        RequiredChatToolMode => (ToolChoice)new ToolChoiceAny(),
        NoneChatToolMode => (ToolChoice)new ToolChoiceNone(),
        _ => null, // Auto or unset → leave the API default (auto)
    };

    private static InputSchema ToInputSchema(JsonElement schema)
    {
        // AIFunction.JsonSchema is already a complete JSON-schema object —
        // hand it to the SDK verbatim.
        var raw = new Dictionary<string, JsonElement>();
        if (schema.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in schema.EnumerateObject()) raw[property.Name] = property.Value;
        }
        if (!raw.ContainsKey("type")) raw["type"] = JsonSerializer.SerializeToElement("object");
        return InputSchema.FromRawUnchecked(raw);
    }

    private static Dictionary<string, JsonElement> ToInputDictionary(IDictionary<string, object?>? arguments) =>
        (arguments ?? new Dictionary<string, object?>()).ToDictionary(
            kv => kv.Key,
            kv => kv.Value is JsonElement element ? element : JsonSerializer.SerializeToElement(kv.Value));

    private static string ResultText(object? result) => result switch
    {
        string s => s,
        JsonElement je when je.ValueKind == JsonValueKind.String => je.GetString() ?? "",
        null => "",
        _ => JsonSerializer.Serialize(result),
    };

    public object? GetService(System.Type serviceType, object? serviceKey = null) =>
        serviceType.IsInstanceOfType(this) ? this : null;

    public void Dispose() { }
}
