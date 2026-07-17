namespace Botiva;

/// <summary>Mirrors the chativa ToolCall entity.</summary>
public sealed record ToolCall
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Status { get; init; } // running | completed | error
    public object? Params { get; init; }
    public object? Result { get; init; }
    public string? Error { get; init; }
    public long? StartedAt { get; init; }
    public long? EndedAt { get; init; }
}

/// <summary>Mirrors the chativa MessageAction chip.</summary>
public sealed record MessageAction(string Label, string? Value = null);

/// <summary>Mirrors the chativa AIChunk ("ui" | "text" | "event").</summary>
public sealed record GenUIChunk
{
    public required string Type { get; init; }
    public string? Component { get; init; }
    public Dictionary<string, object?>? Props { get; init; }
    public string? Content { get; init; }
    public string? Name { get; init; }
    public object? Payload { get; init; }
    public object? Id { get; set; }
}

/// <summary>
/// Runtime → engine event. One record with a Type discriminator keeps the
/// wire mapping identical to the TS union (PROTOCOL.md §4).
/// </summary>
public sealed record AgentEvent
{
    public required string Type { get; init; } // run_started|run_finished|run_error|message|tool_call|interrupt|genui|busy
    public string? Text { get; init; }
    public IReadOnlyList<MessageAction>? Actions { get; init; }
    public ToolCall? ToolCall { get; init; }
    public object? Payload { get; init; }
    public string? Id { get; init; }
    public GenUIChunk? Chunk { get; set; }
    public string? StreamId { get; set; }
    public bool Done { get; set; }
    public string? Error { get; init; }

    // ── factories (mirror @botiva/core) ─────────────────────────────────────
    public static AgentEvent RunStarted() => new() { Type = "run_started" };
    public static AgentEvent RunFinished() => new() { Type = "run_finished" };
    public static AgentEvent RunError(string error) => new() { Type = "run_error", Error = error };
    public static AgentEvent Busy() => new() { Type = "busy" };
    public static AgentEvent Message(string text, IReadOnlyList<MessageAction>? actions = null) =>
        new() { Type = "message", Text = text, Actions = actions };
    public static AgentEvent ToolCallEvent(ToolCall toolCall) => new() { Type = "tool_call", ToolCall = toolCall };
    /// <summary>Recommended payload shape: { question, options } → rendered as chips.</summary>
    public static AgentEvent Interrupt(object? payload, string? id = null) =>
        new() { Type = "interrupt", Payload = payload, Id = id };
    public static AgentEvent GenUI(GenUIChunk chunk) => new() { Type = "genui", Chunk = chunk };
    /// <summary>Mount a client-registered component (chativa GenUIRegistry).</summary>
    public static AgentEvent Ui(string component, Dictionary<string, object?>? props = null) =>
        GenUI(new GenUIChunk { Type = "ui", Component = component, Props = props ?? new() });
}
