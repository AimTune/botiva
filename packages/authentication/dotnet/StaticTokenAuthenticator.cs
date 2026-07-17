using Botiva;

namespace Botiva.Authentication;

/// <summary>
/// Verifies a shared secret / API key against a static token → userId map —
/// the simplest real authenticator.
///
///   new StaticTokenAuthenticator(new() { ["sk-alice"] = "user-alice" })
/// </summary>
public sealed class StaticTokenAuthenticator(IReadOnlyDictionary<string, string> tokens) : IAuthenticator
{
    private readonly Dictionary<string, string> _tokens = new(tokens);

    public Task<AuthResult> AuthenticateAsync(AuthContext ctx, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(ctx.Token))
            return Task.FromResult(new AuthResult { Ok = false, Reason = "missing token" });
        return Task.FromResult(_tokens.TryGetValue(ctx.Token, out var userId)
            ? new AuthResult { Ok = true, UserId = userId }
            : new AuthResult { Ok = false, Reason = "invalid token" });
    }
}
