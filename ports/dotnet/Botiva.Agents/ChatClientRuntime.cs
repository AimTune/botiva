// ChatClientRuntime — plugs any Microsoft.Extensions.AI IChatClient into the
// botiva Runtime port. This is the .NET counterpart of @botiva/langgraph:
//
//   IChatClient (OpenAI, Azure OpenAI, Ollama, Anthropic, or Semantic Kernel
//   via IChatCompletionService.AsChatClient())      → message events
//   AIFunction tool calls (manual invocation loop)  → tool_call events
//   Hitl.Interrupt(payload) inside a tool           → botiva interrupt (HITL)
//   the user's next message                         → resumes the paused tool
//   Ambient.Emit(AgentEvent.Ui(...)) inside a tool  → genui event
//
// Conversation memory lives in ctx.ConversationStore (key conv:{id}), so it
// follows whatever StateStore the engine uses (memory, Redis, ...) and
// survives reconnects — no per-process chat state.

using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;

namespace Botiva.Agents;

public sealed record ChatClientRuntimeOptions
{
    /// <summary>Static system prompt prepended to every request.</summary>
    public string? Instructions { get; init; }

    /// <summary>
    /// Per-turn system prompt builder — the portable place to inject UserStore
    /// facts (mirrors the LangGraph agent-node pattern). Wins over Instructions.
    /// </summary>
    public Func<TurnContext, CancellationToken, Task<string?>>? InstructionsFactory { get; init; }

    /// <summary>Tools exposed to the model (AIFunctionFactory.Create(...)).</summary>
    public IList<AITool>? Tools { get; init; }

    /// <summary>Emit tool_call events for the client activity strip. Default true.</summary>
    public bool ToolTrace { get; init; } = true;

    /// <summary>Upper bound on model↔tool round-trips per turn.</summary>
    public int MaxToolRounds { get; init; } = 8;

    /// <summary>Extra ChatOptions applied to every request (model id, temperature, ...).</summary>
    public ChatOptions? ChatOptions { get; init; }
}

public sealed class ChatClientRuntime(IChatClient client, ChatClientRuntimeOptions? options = null) : IRuntime
{
    private const string MessagesKey = "chatMessages";
    private const string PendingKey = "pendingToolCall";

    private readonly ChatClientRuntimeOptions _opts = options ?? new ChatClientRuntimeOptions();

    public async IAsyncEnumerable<AgentEvent> RunAsync(
        RunInput input, TurnContext ctx, [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return AgentEvent.RunStarted();

        var store = ctx.ConversationStore;
        var state = await store.GetAsync(ct) ?? new JsonObject();
        var messages = state[MessagesKey] is JsonArray history
            ? history.Deserialize<List<ChatMessage>>(AIJsonUtilities.DefaultOptions) ?? []
            : [];

        var tools = _opts.Tools ?? [];
        // Last definition wins on a name clash (a local tool and an MCP tool
        // sharing a name) instead of throwing — a collision must not brick the turn.
        var functions = new Dictionary<string, AIFunction>(StringComparer.OrdinalIgnoreCase);
        foreach (var fn in tools.OfType<AIFunction>()) functions[fn.Name] = fn;

        var instructions = _opts.InstructionsFactory is { } factory
            ? await factory(ctx, ct)
            : _opts.Instructions;

        var pending = LoadPending(state);
        if (input.Resume is { } resume && pending.Count > 0)
        {
            // HITL answer: re-run the paused tool calls — the interrupted one
            // gets the resume value (Hitl.Interrupt returns it) and the siblings
            // that never ran on the previous pass run normally (PROTOCOL.md §5).
            state.Remove(PendingKey);
            for (var i = 0; i < pending.Count; i++)
            {
                var call = pending[i];
                var outcome = await ExecuteToolAsync(call, functions, i == 0 ? resume : null, ct);
                foreach (var ev in outcome.Events) yield return ev;
                if (outcome.Interrupt is { } again) // a tool asked a follow-up question
                {
                    await SaveInterruptedAsync(store, state, messages, pending.Skip(i), ct);
                    yield return AgentEvent.Interrupt(again.Payload, call.CallId);
                    yield return AgentEvent.RunFinished();
                    yield break;
                }
                messages.Add(new ChatMessage(ChatRole.Tool, [new FunctionResultContent(call.CallId, outcome.Result)]));
            }
        }
        else
        {
            // Not a resume. Any surviving pending call is drift (e.g. the engine's
            // interrupt record was evicted independently, PROTOCOL.md §10) — drop it
            // and repair the transcript so a dangling tool_use never reaches the model.
            state.Remove(PendingKey);
            RepairDanglingToolResults(messages);
            messages.Add(new ChatMessage(ChatRole.User, input.Resume ?? input.Text ?? ""));
        }

        var finalText = "";
        for (var round = 0; round < _opts.MaxToolRounds; round++)
        {
            var request = string.IsNullOrEmpty(instructions)
                ? messages
                : [new ChatMessage(ChatRole.System, instructions), .. messages];
            var chatOptions = _opts.ChatOptions is { } co ? co.Clone() : new ChatOptions();
            if (tools.Count > 0) chatOptions.Tools = tools;

            var response = await client.GetResponseAsync(request, chatOptions, ct);
            messages.AddRange(response.Messages);

            var calls = response.Messages
                .SelectMany(m => m.Contents)
                .OfType<FunctionCallContent>()
                .ToList();
            if (calls.Count == 0)
            {
                finalText = response.Text?.Trim() ?? "";
                break;
            }

            for (var i = 0; i < calls.Count; i++)
            {
                var call = calls[i];
                var outcome = await ExecuteToolAsync(call, functions, resume: null, ct);
                foreach (var ev in outcome.Events) yield return ev;
                if (outcome.Interrupt is { } interrupt)
                {
                    // Persist the interrupted call plus the not-yet-run siblings so
                    // resume completes ALL of them; no fabricated placeholder results
                    // (they leave the not-yet-run calls unanswered until resume).
                    await SaveInterruptedAsync(store, state, messages, calls.Skip(i), ct);
                    yield return AgentEvent.Interrupt(interrupt.Payload, call.CallId);
                    yield return AgentEvent.RunFinished();
                    yield break;
                }
                messages.Add(new ChatMessage(ChatRole.Tool, [new FunctionResultContent(call.CallId, outcome.Result)]));
            }
        }

        state[MessagesKey] = JsonSerializer.SerializeToNode(messages, AIJsonUtilities.DefaultOptions);
        await store.SetAsync(state, ct);

        if (finalText.Length > 0) yield return AgentEvent.Message(finalText);
        else yield return AgentEvent.RunError("empty response");
        yield return AgentEvent.RunFinished();
    }

    private sealed record ToolOutcome(List<AgentEvent> Events, object? Result, BotivaInterruptException? Interrupt);

    private async Task<ToolOutcome> ExecuteToolAsync(
        FunctionCallContent call, Dictionary<string, AIFunction> functions, string? resume, CancellationToken ct)
    {
        var events = new List<AgentEvent>();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (_opts.ToolTrace)
        {
            events.Add(AgentEvent.ToolCallEvent(new ToolCall
            {
                Id = call.CallId, Name = call.Name, Status = "running",
                Params = call.Arguments, StartedAt = now,
            }));
        }

        if (!functions.TryGetValue(call.Name, out var function))
        {
            var error = $"unknown tool: {call.Name}";
            if (_opts.ToolTrace)
            {
                events.Add(AgentEvent.ToolCallEvent(new ToolCall
                {
                    Id = call.CallId, Name = call.Name, Status = "error", Error = error, EndedAt = now,
                }));
            }
            return new ToolOutcome(events, error, null);
        }

        try
        {
            if (resume is not null) Hitl.SetResume(resume);
            var result = await function.InvokeAsync(new AIFunctionArguments(call.Arguments), ct);
            if (_opts.ToolTrace)
            {
                events.Add(AgentEvent.ToolCallEvent(new ToolCall
                {
                    Id = call.CallId, Name = call.Name, Status = "completed",
                    Result = Short(result), EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                }));
            }
            return new ToolOutcome(events, result, null);
        }
        catch (BotivaInterruptException interrupt)
        {
            // Not an error — the HITL pause (mirror of the LangGraph adapter).
            if (_opts.ToolTrace)
            {
                events.Add(AgentEvent.ToolCallEvent(new ToolCall
                {
                    Id = call.CallId, Name = call.Name, Status = "completed",
                    Result = "⏸ waiting for user approval", EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                }));
            }
            return new ToolOutcome(events, null, interrupt);
        }
        catch (Exception err)
        {
            if (_opts.ToolTrace)
            {
                events.Add(AgentEvent.ToolCallEvent(new ToolCall
                {
                    Id = call.CallId, Name = call.Name, Status = "error",
                    Error = err.Message, EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                }));
            }
            return new ToolOutcome(events, $"tool error: {err.Message}", null);
        }
        finally
        {
            if (resume is not null) Hitl.SetResume(null);
        }
    }

    /// <summary>The interrupted call plus every sibling not yet run, in order.</summary>
    private static List<FunctionCallContent> LoadPending(JsonObject state)
    {
        var result = new List<FunctionCallContent>();
        if (state[PendingKey] is not JsonObject pending) return result;
        if (pending["calls"] is JsonArray calls)
            foreach (var c in calls.OfType<JsonObject>()) result.Add(ToCall(c));
        return result;

        static FunctionCallContent ToCall(JsonObject o) => new(
            (string?)o["callId"] ?? "tool",
            (string?)o["name"] ?? "tool",
            o["arguments"] is JsonObject a
                ? a.Deserialize<Dictionary<string, object?>>(AIJsonUtilities.DefaultOptions)
                : null);
    }

    private static async Task SaveInterruptedAsync(
        ConversationStore store, JsonObject state, List<ChatMessage> messages,
        IEnumerable<FunctionCallContent> pending, CancellationToken ct)
    {
        var calls = new JsonArray();
        foreach (var call in pending)
        {
            calls.Add(new JsonObject
            {
                ["callId"] = call.CallId,
                ["name"] = call.Name,
                ["arguments"] = call.Arguments is null
                    ? null
                    : JsonSerializer.SerializeToNode(call.Arguments, AIJsonUtilities.DefaultOptions),
            });
        }
        state[PendingKey] = new JsonObject { ["calls"] = calls };
        state[MessagesKey] = JsonSerializer.SerializeToNode(messages, AIJsonUtilities.DefaultOptions);
        await store.SetAsync(state, ct);
    }

    /// <summary>
    /// Drift repair: if the transcript tail is an assistant turn whose tool_use
    /// blocks were never all answered, drop that incomplete exchange so a dangling
    /// tool_use never reaches the model (which rejects it).
    /// </summary>
    private static void RepairDanglingToolResults(List<ChatMessage> messages)
    {
        var answered = messages
            .SelectMany(m => m.Contents).OfType<FunctionResultContent>()
            .Select(r => r.CallId).ToHashSet(StringComparer.Ordinal);
        for (var i = messages.Count - 1; i >= 0; i--)
        {
            if (messages[i].Contents.OfType<FunctionCallContent>().Any(c => !answered.Contains(c.CallId)))
            {
                messages.RemoveRange(i, messages.Count - i); // drop it + any partial results
                return;
            }
        }
    }

    /// <summary>Compact a tool result for the activity strip (mirror of the TS short()).</summary>
    private static string Short(object? value, int max = 600)
    {
        var s = value as string ?? JsonSerializer.Serialize(value, AIJsonUtilities.DefaultOptions);
        return s.Length > max ? s[..max] + "…" : s;
    }
}
