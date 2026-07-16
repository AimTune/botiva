using System.Text.Json.Nodes;

namespace Botiva;

/// <summary>Driving port (PROTOCOL.md §8): the only thing an agent framework adapter implements.</summary>
public interface IRuntime
{
    IAsyncEnumerable<AgentEvent> RunAsync(RunInput input, TurnContext ctx, CancellationToken ct = default);
}

/// <summary>Paused HITL question waiting for the user's answer.</summary>
public sealed record PendingInterrupt(string? Id, object? Payload, long At);

/// <summary>Input for one turn — exactly one of Text / Resume is set.</summary>
public sealed record RunInput
{
    public string? Text { get; init; }
    public string? Resume { get; init; }
    public PendingInterrupt? Interrupt { get; init; }
}

/// <summary>Turn-scoped context handed to IRuntime.RunAsync (mirrors @botiva/core).</summary>
public sealed class TurnContext
{
    public required string ConversationId { get; init; }
    public required string UserId { get; init; }
    public required UserStore UserStore { get; init; }
    public required ConversationStore ConversationStore { get; init; }
    public JsonObject Meta { get; init; } = new();
    internal Action<AgentEvent> Emitter { get; set; } = _ => { };

    /// <summary>Push an out-of-band event into the current turn.</summary>
    public void Emit(AgentEvent ev) => Emitter(ev);
}

/// <summary>
/// Ambient turn context — the .NET counterpart of botivaEmit()/botivaContext()
/// (AsyncLocal; see PROTOCOL.md §9).
/// </summary>
public static class Ambient
{
    private static readonly AsyncLocal<TurnContext?> Current = new();

    public static TurnContext? Context => Current.Value;

    /// <summary>Emit into the current turn; false when called outside a turn.</summary>
    public static bool Emit(AgentEvent ev)
    {
        var ctx = Current.Value;
        if (ctx is null) return false;
        ctx.Emit(ev);
        return true;
    }

    internal static IDisposable Enter(TurnContext ctx)
    {
        var previous = Current.Value;
        Current.Value = ctx;
        return new Scope(() => Current.Value = previous);
    }

    private sealed class Scope(Action dispose) : IDisposable
    {
        public void Dispose() => dispose();
    }
}

/// <summary>Extension port — apply in order, null = swallow/drop (mirrors @botiva/core).</summary>
public sealed class Extension
{
    public required string Name { get; init; }
    public Func<IncomingMessage, TurnContext, IncomingMessage?>? OnMessage { get; init; }
    public Func<AgentEvent, TurnContext, AgentEvent?>? OnEvent { get; init; }
    public Action<TurnContext>? OnConversationStart { get; init; }
    public Action<TurnContext>? OnConversationEnd { get; init; }
    public Action<string, TurnContext>? OnConnect { get; init; }
    public Action<string, TurnContext>? OnDisconnect { get; init; }
}

public sealed record ConnectParams
{
    public string? UserId { get; init; }
    public string? ConversationId { get; init; }
    public int Watermark { get; init; }
    public required Action<Frame> Deliver { get; init; }
    public JsonObject? Meta { get; init; }
}

public sealed record EngineOptions
{
    public required IRuntime Runtime { get; init; }
    public IStateStore? StateStore { get; init; }
    public IHistoryStore? HistoryStore { get; init; }
    public IReadOnlyList<Extension>? Extensions { get; init; }
    public string? Greeting { get; init; }
}

/// <summary>
/// ConversationEngine — .NET port of the botiva engine: identity, watermark
/// replay, per-conversation turn lock, HITL, multi-connection fan-out.
/// </summary>
public sealed class ConversationEngine(EngineOptions options)
{
    private readonly IRuntime _runtime = options.Runtime;
    private readonly IStateStore _store = options.StateStore ?? new MemoryStateStore();
    private readonly IHistoryStore _history = options.HistoryStore ?? new MemoryHistoryStore();
    private readonly IReadOnlyList<Extension> _extensions = options.Extensions ?? [];
    private readonly string? _greeting = options.Greeting;

    private readonly object _lock = new();
    private readonly Dictionary<string, HashSet<LiveConnection>> _live = [];
    private readonly HashSet<string> _turnLocks = [];

    internal sealed record LiveConnection(string Id, string UserId, string ConversationId, JsonObject Meta, Action<Frame> Deliver);

    /// <summary>Handle a transport holds for one attached client.</summary>
    public sealed class Connection
    {
        private readonly ConversationEngine _engine;
        private readonly LiveConnection _live;
        private bool _closed;

        internal Connection(ConversationEngine engine, LiveConnection live)
        {
            _engine = engine;
            _live = live;
        }

        public string Id => _live.Id;
        public string UserId => _live.UserId;
        public string ConversationId => _live.ConversationId;

        /// <summary>Feed one inbound wire payload (JSON string or JsonObject).</summary>
        public async Task ReceiveAsync(object? raw, CancellationToken ct = default)
        {
            var inbound = Protocol.ParseIncoming(raw);
            if (inbound is null) return;
            if (inbound.Hello is not null) return; // handshake happens at connect time
            await _engine.HandleMessageAsync(ConversationId, inbound.Message!, UserId, _live, ct);
        }

        /// <summary>Detach; the conversation itself stays resumable.</summary>
        public Task CloseAsync()
        {
            if (_closed) return Task.CompletedTask;
            _closed = true;
            _engine.Disconnect(_live);
            return Task.CompletedTask;
        }
    }

    public async Task<Connection> ConnectAsync(ConnectParams p, CancellationToken ct = default)
    {
        var conversationId = p.ConversationId ?? NewId("conv");
        var (record, fresh) = await LoadRecordAsync(conversationId, p.UserId, ct);
        var userId = p.UserId ?? (string?)record["userId"] ?? NewId("user");

        var live = new LiveConnection(NewId("connection"), userId, conversationId, p.Meta ?? new JsonObject(), p.Deliver);
        lock (_lock)
        {
            if (!_live.TryGetValue(conversationId, out var set))
                _live[conversationId] = set = [];
            set.Add(live);
        }

        var ctx = BuildContext(conversationId, userId, live.Meta);
        if (fresh)
            foreach (var ext in _extensions) ext.OnConversationStart?.Invoke(ctx);
        foreach (var ext in _extensions) ext.OnConnect?.Invoke(live.Id, ctx);

        // 1) welcome (transient)
        var latest = await _history.LatestAsync(conversationId, ct);
        live.Deliver(new Frame
        {
            ["type"] = "welcome",
            ["data"] = new JsonObject
            {
                ["protocol"] = Protocol.Version,
                ["conversationId"] = conversationId,
                ["userId"] = userId,
                ["connectionId"] = live.Id,
                ["watermark"] = latest,
            },
        });
        // 2) replay
        if (latest > p.Watermark)
            foreach (var frame in await _history.AfterAsync(conversationId, p.Watermark, ct))
                live.Deliver(frame);
        // 3) greeting on brand-new conversations
        if (fresh && _greeting is not null)
            await PostAsync(conversationId, AgentEvent.Message(_greeting), ct);

        return new Connection(this, live);
    }

    public async Task HandleMessageAsync(
        string conversationId, IncomingMessage rawMessage, string? userId = null,
        object? origin = null, CancellationToken ct = default)
    {
        var originLive = origin as LiveConnection;
        var (record, _) = await LoadRecordAsync(conversationId, userId, ct);
        userId ??= (string?)record["userId"] ?? "system";

        var ctx = BuildContext(conversationId, userId, originLive?.Meta ?? new JsonObject());

        // GenUI grouping state for this turn.
        string? streamId = null;
        var streamDone = false;
        var chunkSeq = 0;

        async Task Dispatch(AgentEvent ev, LiveConnection? only)
        {
            if (ev.Type == "interrupt")
            {
                record["pendingInterrupt"] = new JsonObject
                {
                    ["id"] = ev.Id,
                    ["payload"] = Protocol.ToNode(ev.Payload),
                    ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                };
                await SaveRecordAsync(conversationId, record, ct);
            }
            if (ev.Type == "genui")
            {
                streamId ??= ev.StreamId ?? NewId("stream");
                ev.StreamId ??= streamId;
                chunkSeq++;
                if (ev.Chunk is { Id: null } chunk) chunk.Id = chunkSeq;
                if (ev.Done) streamDone = true;
            }
            var outEvent = ev;
            foreach (var ext in _extensions)
            {
                if (ext.OnEvent is null) continue;
                var next = ext.OnEvent(outEvent, ctx);
                if (next is null) return;
                outEvent = next;
            }
            foreach (var (frame, persistent) in Protocol.EventToFrames(outEvent, NewId))
            {
                var f = frame;
                if (persistent)
                {
                    var seq = await _history.AppendAsync(conversationId, f, ct);
                    f = (Frame)f.DeepClone();
                    f["seq"] = seq;
                }
                if (only is not null) only.Deliver(f);
                else Broadcast(conversationId, f, null);
            }
        }

        // Out-of-band emits dispatch synchronously (same simplification as the Go port).
        ctx.Emitter = ev => Dispatch(ev, null).GetAwaiter().GetResult();

        var msg = rawMessage;
        foreach (var ext in _extensions)
        {
            if (ext.OnMessage is null) continue;
            var next = ext.OnMessage(msg, ctx);
            if (next is null) return;
            msg = next;
        }
        if (string.IsNullOrWhiteSpace(msg.Text)) return;

        lock (_lock)
        {
            if (!_turnLocks.Add(conversationId))
            {
                _ = Dispatch(AgentEvent.Busy(), originLive);
                return;
            }
        }
        try
        {
            // Persist + fan out the user's message (everyone but the sender).
            var userFrame = new Frame
            {
                ["type"] = "text",
                ["id"] = msg.Id ?? NewId("msg"),
                ["from"] = "user",
                ["data"] = new JsonObject { ["text"] = msg.Text },
                ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            var seq = await _history.AppendAsync(conversationId, userFrame, ct);
            userFrame["seq"] = seq;
            Broadcast(conversationId, userFrame, originLive);

            // Pending interrupt? Then this message is the HITL answer.
            RunInput input;
            if (record["pendingInterrupt"] is JsonObject pending)
            {
                input = new RunInput
                {
                    Resume = msg.Text,
                    Interrupt = new PendingInterrupt((string?)pending["id"], pending["payload"],
                        (long?)pending["at"] ?? 0),
                };
                record.Remove("pendingInterrupt");
                await SaveRecordAsync(conversationId, record, ct);
            }
            else
            {
                input = new RunInput { Text = msg.Text };
            }

            using (Ambient.Enter(ctx))
            {
                try
                {
                    await foreach (var ev in _runtime.RunAsync(input, ctx, ct))
                        await Dispatch(ev, null);
                }
                catch (Exception err)
                {
                    await Dispatch(AgentEvent.RunError(err.Message), null);
                }
            }

            // Close a genui stream the runtime left open.
            if (streamId is not null && !streamDone)
            {
                var closing = AgentEvent.GenUI(new GenUIChunk { Type = "event", Name = "stream_done" });
                closing.StreamId = streamId;
                closing.Done = true;
                await Dispatch(closing, null);
            }
        }
        finally
        {
            lock (_lock) _turnLocks.Remove(conversationId);
        }
    }

    /// <summary>Proactive, out-of-turn delivery (reminders, server pushes).</summary>
    public async Task PostAsync(string conversationId, AgentEvent ev, CancellationToken ct = default)
    {
        var (record, _) = await LoadRecordAsync(conversationId, null, ct);
        var userId = (string?)record["userId"] ?? "system";
        var ctx = BuildContext(conversationId, userId, new JsonObject());
        ctx.Emitter = inner => PostAsync(conversationId, inner, ct).GetAwaiter().GetResult();

        var outEvent = ev;
        foreach (var ext in _extensions)
        {
            if (ext.OnEvent is null) continue;
            var next = ext.OnEvent(outEvent, ctx);
            if (next is null) return;
            outEvent = next;
        }
        foreach (var (frame, persistent) in Protocol.EventToFrames(outEvent, NewId))
        {
            var f = frame;
            if (persistent)
            {
                var seq = await _history.AppendAsync(conversationId, f, ct);
                f = (Frame)f.DeepClone();
                f["seq"] = seq;
            }
            Broadcast(conversationId, f, null);
        }
    }

    // ── internals ────────────────────────────────────────────────────────────

    private void Disconnect(LiveConnection live)
    {
        bool empty;
        lock (_lock)
        {
            if (_live.TryGetValue(live.ConversationId, out var set)) set.Remove(live);
            empty = !_live.TryGetValue(live.ConversationId, out var remaining) || remaining.Count == 0;
            if (empty) _live.Remove(live.ConversationId);
        }
        var ctx = BuildContext(live.ConversationId, live.UserId, live.Meta);
        foreach (var ext in _extensions) ext.OnDisconnect?.Invoke(live.Id, ctx);
        if (empty)
            foreach (var ext in _extensions) ext.OnConversationEnd?.Invoke(ctx);
    }

    private void Broadcast(string conversationId, Frame frame, LiveConnection? except)
    {
        List<LiveConnection> targets;
        lock (_lock)
        {
            targets = _live.TryGetValue(conversationId, out var set)
                ? set.Where(c => c != except).ToList()
                : [];
        }
        foreach (var conn in targets) conn.Deliver(frame);
    }

    private async Task<(JsonObject Record, bool Fresh)> LoadRecordAsync(
        string conversationId, string? preferredUserId, CancellationToken ct)
    {
        var key = $"conv:{conversationId}:botiva";
        var record = await _store.GetAsync(key, ct);
        if (record is not null) return (record, false);
        record = new JsonObject
        {
            ["userId"] = preferredUserId ?? NewId("user"),
            ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        await _store.SetAsync(key, record, ct);
        return (record, true);
    }

    private Task SaveRecordAsync(string conversationId, JsonObject record, CancellationToken ct) =>
        _store.SetAsync($"conv:{conversationId}:botiva", (JsonObject)record.DeepClone(), ct);

    private TurnContext BuildContext(string conversationId, string userId, JsonObject meta) => new()
    {
        ConversationId = conversationId,
        UserId = userId,
        UserStore = new UserStore(_store, userId),
        ConversationStore = new ConversationStore(_store, conversationId),
        Meta = meta,
    };

    private static string NewId(string prefix) => $"{prefix}-{Guid.NewGuid():N}";
}
