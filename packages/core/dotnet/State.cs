using System.Collections.Concurrent;
using System.Text.Json.Nodes;

namespace Botiva;

/// <summary>Persistence port (PROTOCOL.md §8). Values are JSON objects.</summary>
public interface IStateStore
{
    Task<JsonObject?> GetAsync(string key, CancellationToken ct = default);
    Task SetAsync(string key, JsonObject value, CancellationToken ct = default);
    Task DeleteAsync(string key, CancellationToken ct = default);
}

public sealed class MemoryStateStore : IStateStore
{
    private readonly ConcurrentDictionary<string, string> _map = new();

    public Task<JsonObject?> GetAsync(string key, CancellationToken ct = default) =>
        Task.FromResult(_map.TryGetValue(key, out var raw) ? JsonNode.Parse(raw) as JsonObject : null);

    public Task SetAsync(string key, JsonObject value, CancellationToken ct = default)
    {
        _map[key] = value.ToJsonString();
        return Task.CompletedTask;
    }

    public Task DeleteAsync(string key, CancellationToken ct = default)
    {
        _map.TryRemove(key, out _);
        return Task.CompletedTask;
    }
}

/// <summary>A namespaced JSON-object view over one StateStore key.</summary>
public class ScopedStore(IStateStore store, string key)
{
    public string Key { get; } = key;

    public Task<JsonObject?> GetAsync(CancellationToken ct = default) => store.GetAsync(Key, ct);

    public Task SetAsync(JsonObject value, CancellationToken ct = default) => store.SetAsync(Key, value, ct);

    /// <summary>Shallow-merge into the current value; null values delete keys.</summary>
    public async Task<JsonObject> PatchAsync(JsonObject partial, CancellationToken ct = default)
    {
        var current = await GetAsync(ct) ?? new JsonObject();
        foreach (var (k, v) in partial)
        {
            if (v is null) current.Remove(k);
            else current[k] = v.DeepClone();
        }
        await SetAsync(current, ct);
        return current;
    }

    public Task DeleteAsync(CancellationToken ct = default) => store.DeleteAsync(Key, ct);
}

/// <summary>Per-user state — survives conversations, devices and reconnects.</summary>
public sealed class UserStore(IStateStore store, string userId) : ScopedStore(store, $"user:{userId}")
{
    public string UserId { get; } = userId;
}

/// <summary>Per-conversation state — shared by every attached connection.</summary>
public sealed class ConversationStore(IStateStore store, string conversationId)
    : ScopedStore(store, $"conv:{conversationId}")
{
    public string ConversationId { get; } = conversationId;
}

/// <summary>Transcript port (PROTOCOL.md §8).</summary>
public interface IHistoryStore
{
    Task<int> AppendAsync(string conversationId, Frame frame, CancellationToken ct = default);
    Task<IReadOnlyList<Frame>> AfterAsync(string conversationId, int watermark, CancellationToken ct = default);
    Task<int> LatestAsync(string conversationId, CancellationToken ct = default);
}

public sealed class MemoryHistoryStore(int maxFrames = 1000) : IHistoryStore
{
    private sealed class Entry
    {
        public int BaseSeq;
        public readonly List<string> Frames = [];
    }

    private readonly ConcurrentDictionary<string, Entry> _convs = new();

    public Task<int> AppendAsync(string conversationId, Frame frame, CancellationToken ct = default)
    {
        var entry = _convs.GetOrAdd(conversationId, _ => new Entry());
        lock (entry)
        {
            var seq = entry.BaseSeq + entry.Frames.Count + 1;
            var stored = (Frame)frame.DeepClone();
            stored["seq"] = seq;
            entry.Frames.Add(stored.ToJsonString());
            while (entry.Frames.Count > maxFrames)
            {
                entry.Frames.RemoveAt(0);
                entry.BaseSeq++;
            }
            return Task.FromResult(seq);
        }
    }

    public Task<IReadOnlyList<Frame>> AfterAsync(string conversationId, int watermark, CancellationToken ct = default)
    {
        if (!_convs.TryGetValue(conversationId, out var entry))
            return Task.FromResult<IReadOnlyList<Frame>>([]);
        lock (entry)
        {
            var result = entry.Frames
                .Select(raw => (Frame)JsonNode.Parse(raw)!)
                .Where(f => (int?)f["seq"] > watermark)
                .ToList();
            return Task.FromResult<IReadOnlyList<Frame>>(result);
        }
    }

    public Task<int> LatestAsync(string conversationId, CancellationToken ct = default)
    {
        if (!_convs.TryGetValue(conversationId, out var entry)) return Task.FromResult(0);
        lock (entry)
        {
            return Task.FromResult(entry.BaseSeq + entry.Frames.Count);
        }
    }
}
