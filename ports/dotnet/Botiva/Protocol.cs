using System.Text.Json;
using System.Text.Json.Nodes;

namespace Botiva;

/// <summary>Parsed user message.</summary>
public sealed record IncomingMessage(string Text, string? Id = null, JsonObject? Meta = null);

/// <summary>Client handshake.</summary>
public sealed record HelloFrame(string? UserId, string? ConversationId, int? Watermark, JsonObject? Meta);

/// <summary>ParseIncoming result — exactly one property is non-null.</summary>
public sealed record Inbound(HelloFrame? Hello, IncomingMessage? Message);

public sealed record FrameMapping(Frame Frame, bool Persistent);

public static class Protocol
{
    public const string Version = "botiva/1";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static JsonNode? ToNode(object? value) =>
        value is null ? null : JsonSerializer.SerializeToNode(value, Json);

    /// <summary>
    /// Accepts a JSON string, a parsed JsonObject or plain text — mirrors
    /// parseIncoming in @botiva/core.
    /// </summary>
    public static Inbound? ParseIncoming(object? raw)
    {
        JsonObject? value = null;
        switch (raw)
        {
            case string s:
                try
                {
                    value = JsonNode.Parse(s) as JsonObject;
                }
                catch (JsonException)
                {
                    var text = s.Trim();
                    return text.Length == 0 ? null : new Inbound(null, new IncomingMessage(text));
                }
                break;
            case JsonObject o:
                value = o;
                break;
        }
        if (value is null) return null;

        if ((string?)value["type"] == "hello")
        {
            return new Inbound(new HelloFrame(
                (string?)value["userId"],
                (string?)value["conversationId"],
                value["watermark"] is JsonNode w ? (int?)w.GetValue<double>() : null,
                value["meta"] as JsonObject), null);
        }

        var body = (string?)(value["data"]?["text"]) ?? (string?)value["text"] ?? "";
        body = body.Trim();
        if (body.Length == 0) return null;
        return new Inbound(null, new IncomingMessage(body, (string?)value["id"], value["meta"] as JsonObject));
    }

    /// <summary>
    /// Canonical AgentEvent → wire frame mapping — must stay byte-compatible
    /// with @botiva/core eventToFrames (PROTOCOL.md §4).
    /// </summary>
    public static List<FrameMapping> EventToFrames(AgentEvent ev, Func<string, string> newId)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        Frame Text(string text, Action<Frame>? extra = null)
        {
            var frame = new Frame
            {
                ["type"] = "text",
                ["id"] = newId("msg"),
                ["from"] = "bot",
                ["data"] = new JsonObject { ["text"] = text },
                ["timestamp"] = now,
            };
            extra?.Invoke(frame);
            return frame;
        }

        switch (ev.Type)
        {
            case "message":
                return [new(Text(ev.Text ?? "", f =>
                {
                    if (ev.Actions is { Count: > 0 }) f["actions"] = ToNode(ev.Actions);
                }), true)];
            case "tool_call":
                return [new(new Frame { ["type"] = "tool_call", ["data"] = ToNode(ev.ToolCall) }, true)];
            case "genui":
                return [new(new Frame
                {
                    ["type"] = "genui",
                    ["streamId"] = ev.StreamId ?? newId("stream"),
                    ["chunk"] = ToNode(ev.Chunk),
                    ["done"] = ev.Done,
                }, true)];
            case "interrupt":
            {
                var question = "Your confirmation is needed to continue.";
                JsonArray options = ["Approve", "Cancel"];
                var payload = ToNode(ev.Payload);
                if (payload is JsonValue v && v.TryGetValue<string>(out var s)) question = s;
                else if (payload is JsonObject p)
                {
                    question = (string?)p["question"] ?? (string?)p["message"] ?? question;
                    if (p["options"] is JsonArray arr) options = (JsonArray)arr.DeepClone();
                }
                var actions = new JsonArray();
                foreach (var option in options)
                {
                    actions.Add(option is JsonValue sv && sv.TryGetValue<string>(out var label)
                        ? new JsonObject { ["label"] = label }
                        : option?.DeepClone());
                }
                return [new(Text(question, f => f["actions"] = actions), true)];
            }
            case "busy":
                return [new(Text("⏳ Still working on the previous message — one moment."), false)];
            case "run_started":
                return [new(new Frame { ["type"] = "run", ["data"] = new JsonObject { ["status"] = "started" } }, false)];
            case "run_finished":
                return [new(new Frame { ["type"] = "run", ["data"] = new JsonObject { ["status"] = "finished" } }, false)];
            case "run_error":
                return
                [
                    new(Text($"⚠️ {ev.Error}"), true),
                    new(new Frame { ["type"] = "run", ["data"] = new JsonObject { ["status"] = "finished" } }, false),
                ];
            default:
                return [];
        }
    }
}
