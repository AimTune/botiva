namespace Botiva.Example.Agents;

/// <summary>
/// Mirrors the TS examples' loadAnthropicKey(): ANTHROPIC_API_KEY env var,
/// or an anthropic-key.txt found by walking up to the botiva repo root
/// (marked by PROTOCOL.md) and its parent (the parent repo keeps the key at
/// mency-report-bot/anthropic-key.txt). The ascent stops at that boundary so a
/// stray anthropic-key.txt further up the filesystem is never picked up.
/// </summary>
public static class AnthropicKey
{
    public static bool TryLoad(out string key)
    {
        var fromEnv = Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY");
        if (!string.IsNullOrWhiteSpace(fromEnv))
        {
            key = fromEnv.Trim();
            return true;
        }
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            {
                if (TryReadKey(dir, out key)) return true;
                // botiva repo root → also check its parent (documented key home), then stop.
                if (File.Exists(Path.Combine(dir.FullName, "PROTOCOL.md")))
                {
                    if (dir.Parent is { } parent && TryReadKey(parent, out key)) return true;
                    break;
                }
            }
        }
        key = "";
        return false;
    }

    private static bool TryReadKey(DirectoryInfo dir, out string key)
    {
        var candidate = Path.Combine(dir.FullName, "anthropic-key.txt");
        if (File.Exists(candidate))
        {
            key = File.ReadAllText(candidate).Trim();
            return key.Length > 0;
        }
        key = "";
        return false;
    }
}
