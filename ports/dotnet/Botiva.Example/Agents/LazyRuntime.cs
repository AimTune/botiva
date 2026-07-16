using System.Runtime.CompilerServices;
using Botiva;

namespace Botiva.Example.Agents;

/// <summary>
/// Defers runtime construction until the first turn. Needed because the MCP
/// client connects to /mcp on THIS server — which isn't listening yet when
/// the engine (and its endpoints) must be wired up.
///
/// Unlike a <c>Lazy&lt;Task&lt;T&gt;&gt;</c>, a failed build is NOT memoized: a transient
/// MCP-connect failure is retried on the next turn instead of wedging the agent
/// until the process restarts.
/// </summary>
public sealed class LazyRuntime(Func<Task<IRuntime>> factory) : IRuntime
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private IRuntime? _runtime;

    /// <summary>Kick construction eagerly (e.g. right after the server starts).</summary>
    public Task<IRuntime> WarmUpAsync() => ResolveAsync(CancellationToken.None);

    public async IAsyncEnumerable<AgentEvent> RunAsync(
        RunInput input, TurnContext ctx, [EnumeratorCancellation] CancellationToken ct = default)
    {
        var runtime = await ResolveAsync(ct);
        await foreach (var ev in runtime.RunAsync(input, ctx, ct)) yield return ev;
    }

    private async Task<IRuntime> ResolveAsync(CancellationToken ct)
    {
        if (_runtime is { } ready) return ready;
        await _gate.WaitAsync(ct);
        try
        {
            // Only a successful build is cached — a throw leaves _runtime null so
            // the next call rebuilds.
            return _runtime ??= await factory();
        }
        finally
        {
            _gate.Release();
        }
    }
}
