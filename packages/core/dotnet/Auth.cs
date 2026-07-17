using System.Text.Json.Nodes;

namespace Botiva;

// Authentication port — the .NET counterpart of @botiva/core's auth port
// (PROTOCOL.md §2.1). An IAuthenticator gates ConnectAsync(): it can reject a
// connection attempt or replace the client-asserted UserId with a verified one.
//
// Without an authenticator the engine behaves as before — identity is
// client-asserted and every connection is accepted. With one, ConnectAsync()
// throws AuthenticationException on rejection; transports translate that into a
// wire `error` frame + a close (WebSocket close code Auth.CloseCode).

/// <summary>Everything a transport knows about a connection attempt.</summary>
public sealed record AuthContext
{
    public string Transport { get; init; } = "unknown";
    public string? Token { get; init; }
    public IReadOnlyDictionary<string, string>? Query { get; init; }
    /// <summary>Request headers, lower-cased keys (e.g. so a cookie verifier can read "cookie").</summary>
    public IReadOnlyDictionary<string, string>? Headers { get; init; }
    public string? UserId { get; init; }
    public string? ConversationId { get; init; }
}

/// <summary>Verdict returned by an IAuthenticator.</summary>
public sealed record AuthResult
{
    public bool Ok { get; init; }
    /// <summary>Verified identity; overrides the client-asserted one when set.</summary>
    public string? UserId { get; init; }
    /// <summary>Verified claims, exposed via TurnContext.Meta["auth"].</summary>
    public JsonObject? Claims { get; init; }
    /// <summary>Rejection reason (only meaningful when Ok is false).</summary>
    public string? Reason { get; init; }
}

/// <summary>The authentication port: decide whether a connection may proceed.</summary>
public interface IAuthenticator
{
    Task<AuthResult> AuthenticateAsync(AuthContext ctx, CancellationToken ct = default);
}

/// <summary>Default open-door authenticator — preserves the no-auth behaviour.</summary>
public sealed class AllowAllAuthenticator : IAuthenticator
{
    public Task<AuthResult> AuthenticateAsync(AuthContext ctx, CancellationToken ct = default) =>
        Task.FromResult(new AuthResult { Ok = true, UserId = ctx.UserId });
}

/// <summary>Thrown by ConnectAsync() when an authenticator rejects the attempt.</summary>
public sealed class AuthenticationException(string reason, string code = "unauthorized") : Exception(reason)
{
    public string Code { get; } = code;
    public string Reason => Message;
}

/// <summary>Credential + request material a transport hands the authenticator.</summary>
public sealed record AuthInput
{
    public string Transport { get; init; } = "unknown";
    public string? Token { get; init; }
    public IReadOnlyDictionary<string, string>? Query { get; init; }
    public IReadOnlyDictionary<string, string>? Headers { get; init; }
}

/// <summary>Authentication-related constants.</summary>
public static class Auth
{
    /// <summary>WebSocket close code for an auth rejection (application range 4000–4999).</summary>
    public const int CloseCode = 4401;
}
