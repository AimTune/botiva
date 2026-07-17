using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Botiva;

namespace Botiva.Authentication;

public sealed class HmacJwtOptions
{
    /// <summary>Shared HS256 secret the token was signed with.</summary>
    public required string Secret { get; init; }
    /// <summary>Claim carrying the userId. Default "sub".</summary>
    public string SubjectClaim { get; init; } = "sub";
    /// <summary>Skew tolerance in seconds for exp/nbf. Default 0.</summary>
    public long ClockToleranceSec { get; init; }
}

/// <summary>
/// Verifies an HS256 JSON Web Token with the BCL only: checks the signature,
/// `exp` and `nbf`, then maps the subject claim to the verified userId and
/// exposes the full payload as claims.
///
///   new HmacJwtAuthenticator(new HmacJwtOptions { Secret = secret })
/// </summary>
public sealed class HmacJwtAuthenticator : IAuthenticator
{
    private readonly byte[] _secret;
    private readonly string _subject;
    private readonly long _skew;

    public HmacJwtAuthenticator(HmacJwtOptions options)
    {
        if (string.IsNullOrEmpty(options.Secret))
            throw new ArgumentException("HmacJwtAuthenticator requires a secret.", nameof(options));
        _secret = Encoding.UTF8.GetBytes(options.Secret);
        _subject = string.IsNullOrEmpty(options.SubjectClaim) ? "sub" : options.SubjectClaim;
        _skew = options.ClockToleranceSec;
    }

    public Task<AuthResult> AuthenticateAsync(AuthContext ctx, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(ctx.Token))
            return Task.FromResult(new AuthResult { Ok = false, Reason = "missing token" });
        var payload = Verify(ctx.Token);
        if (payload is null)
            return Task.FromResult(new AuthResult { Ok = false, Reason = "invalid or expired token" });
        var userId = (string?)payload[_subject];
        if (string.IsNullOrEmpty(userId))
            return Task.FromResult(new AuthResult { Ok = false, Reason = $"token missing \"{_subject}\" claim" });
        return Task.FromResult(new AuthResult { Ok = true, UserId = userId, Claims = payload });
    }

    private JsonObject? Verify(string token)
    {
        var parts = token.Split('.');
        if (parts.Length != 3) return null;

        byte[] signature;
        try { signature = DecodeBase64Url(parts[2]); }
        catch { return null; }
        using var hmac = new HMACSHA256(_secret);
        var expected = hmac.ComputeHash(Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"));
        if (!CryptographicOperations.FixedTimeEquals(signature, expected)) return null;

        JsonObject? header, payload;
        try
        {
            header = JsonNode.Parse(Encoding.UTF8.GetString(DecodeBase64Url(parts[0]))) as JsonObject;
            payload = JsonNode.Parse(Encoding.UTF8.GetString(DecodeBase64Url(parts[1]))) as JsonObject;
        }
        catch { return null; }
        if (header is null || payload is null || (string?)header["alg"] != "HS256") return null;

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (payload["exp"] is JsonValue ev && ev.TryGetValue<double>(out var exp) && now > (long)exp + _skew) return null;
        if (payload["nbf"] is JsonValue nv && nv.TryGetValue<double>(out var nbf) && now + _skew < (long)nbf) return null;
        return payload;
    }

    private static byte[] DecodeBase64Url(string s)
    {
        var b = s.Replace('-', '+').Replace('_', '/');
        return (b.Length % 4) switch
        {
            2 => Convert.FromBase64String(b + "=="),
            3 => Convert.FromBase64String(b + "="),
            _ => Convert.FromBase64String(b),
        };
    }
}
