using Botiva;

namespace Botiva.Authentication;

/// <summary>
/// Extracts a credential from a named cookie in the request headers, then
/// delegates verification to an inner authenticator. Browsers attach cookies
/// automatically, so this needs no client-side token plumbing — pair it with
/// an HMAC-JWT or static-token verifier.
///
///   new CookieAuthenticator("botiva_session", new HmacJwtAuthenticator(opts))
/// </summary>
public sealed class CookieAuthenticator(string cookie, IAuthenticator inner) : IAuthenticator
{
    private readonly string _cookie = !string.IsNullOrEmpty(cookie)
        ? cookie
        : throw new ArgumentException("CookieAuthenticator requires a cookie name.", nameof(cookie));
    private readonly IAuthenticator _inner = inner
        ?? throw new ArgumentNullException(nameof(inner));

    public Task<AuthResult> AuthenticateAsync(AuthContext ctx, CancellationToken ct = default)
    {
        var cookieHeader = ctx.Headers is not null && ctx.Headers.TryGetValue("cookie", out var c) ? c : null;
        var token = ParseCookies(cookieHeader).GetValueOrDefault(_cookie) ?? ctx.Token;
        return _inner.AuthenticateAsync(ctx with { Token = token }, ct);
    }

    /// <summary>Parse a Cookie header value into a name → value map.</summary>
    public static Dictionary<string, string> ParseCookies(string? header)
    {
        var result = new Dictionary<string, string>();
        if (string.IsNullOrEmpty(header)) return result;
        foreach (var pair in header.Split(';'))
        {
            var eq = pair.IndexOf('=');
            if (eq < 0) continue;
            var name = pair[..eq].Trim();
            if (name.Length == 0) continue;
            var value = pair[(eq + 1)..].Trim();
            result[name] = Uri.UnescapeDataString(value);
        }
        return result;
    }
}
