// Botiva ASP.NET Core WebSocket transport — the .NET counterpart of
// @botiva/websocket (~a screenful, per PROTOCOL.md §8: socket open → Connect,
// inbound → Receive, close → Close, Deliver → socket write).
//
// Identity handshake (either works, PROTOCOL.md §2):
//   • Query params:  ws://host/chat?userId=u-1&conversationId=c-1&watermark=12
//   • Hello frame:   first message {type:"hello", userId?, conversationId?, watermark?, meta?}
// If neither arrives within HelloTimeout a fresh identity is generated and
// announced via the `welcome` frame (the client should persist it).
//
//   var engine = new ConversationEngine(new EngineOptions { Runtime = runtime });
//   var app = builder.Build();
//   app.MapBotiva("/chat", engine);
//   app.Run();

using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

namespace Botiva.AspNetCore;

public sealed class BotivaWebSocketOptions
{
    /// <summary>How long to wait for a hello frame when the URL carries no identity.</summary>
    public TimeSpan HelloTimeout { get; set; } = TimeSpan.FromMilliseconds(300);
}

public static class BotivaEndpointExtensions
{
    /// <summary>
    /// Mounts the botiva WebSocket endpoint at <paramref name="path"/> and
    /// enables the WebSocket middleware (idempotent to call once per app).
    /// </summary>
    public static IApplicationBuilder MapBotiva(
        this WebApplication app, string path, ConversationEngine engine, BotivaWebSocketOptions? options = null)
    {
        options ??= new BotivaWebSocketOptions();
        app.UseWebSockets();
        app.Map(path, async (HttpContext context) =>
        {
            if (!context.WebSockets.IsWebSocketRequest)
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                await context.Response.WriteAsync("websocket upgrade expected");
                return;
            }
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            await ServeAsync(engine, socket, context, options);
        });
        return app;
    }

    private static async Task ServeAsync(
        ConversationEngine engine, WebSocket socket, HttpContext context, BotivaWebSocketOptions options)
    {
        var aborted = context.RequestAborted;
        var query = context.Request.Query;
        string? userId = query["userId"].FirstOrDefault();
        string? conversationId = query["conversationId"].FirstOrDefault();
        var watermark = 0;
        var hasWatermark = int.TryParse(query["watermark"].FirstOrDefault(), out watermark);
        JsonObject? meta = null;
        string? buffered = null;

        // No identity in the URL → give the client a beat to send a hello frame.
        // Cancelling a WebSocket receive aborts the socket, so the wait must
        // not cancel the read — if the timeout wins, the still-pending read
        // simply becomes the first read of the message loop below.
        Task<string?>? pendingRead = null;
        if (userId is null && conversationId is null && !hasWatermark && options.HelloTimeout > TimeSpan.Zero)
        {
            pendingRead = ReceiveTextAsync(socket, aborted);
            var winner = await Task.WhenAny(pendingRead, Task.Delay(options.HelloTimeout, CancellationToken.None));
            if (winner == pendingRead)
            {
                var first = await pendingRead;
                pendingRead = null;
                if (first is null) return; // client closed before saying anything
                if (Protocol.ParseIncoming(first) is { Hello: { } hello })
                {
                    userId = hello.UserId;
                    conversationId = hello.ConversationId;
                    if (hello.Watermark is { } w) watermark = w;
                    meta = hello.Meta;
                }
                else
                {
                    buffered = first; // first frame was a normal message → handle after connect
                }
            }
            // else: fresh visitor — the engine generates ids
        }

        // Serialize socket writes: Deliver can be called from concurrent turns
        // (fan-out) and WebSocket.SendAsync allows one outstanding send.
        var sendLock = new SemaphoreSlim(1, 1);

        async Task SendAsync(string payload)
        {
            await sendLock.WaitAsync(CancellationToken.None);
            try
            {
                if (socket.State == WebSocketState.Open)
                {
                    await socket.SendAsync(Encoding.UTF8.GetBytes(payload),
                        WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None);
                }
            }
            catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or InvalidOperationException)
            {
                // client went away / socket disposed mid-send — the conversation
                // stays resumable; a fan-out race must not surface as an
                // unobserved task exception.
            }
            finally
            {
                sendLock.Release();
            }
        }

        var connection = await engine.ConnectAsync(new ConnectParams
        {
            UserId = userId,
            ConversationId = conversationId,
            Watermark = watermark,
            Meta = meta,
            // Fire-and-forget keeps the engine non-blocking; SemaphoreSlim's
            // FIFO async waiters preserve frame order.
            Deliver = frame => _ = SendAsync(frame.ToJsonString()),
        }, aborted);

        try
        {
            // The turn itself must NOT observe `aborted`: a client disconnect
            // mid-turn should let the run finish and persist so frames replay on
            // reconnect (matching the Go/TS/Python transports). `aborted` gates
            // only the socket reads below.
            if (buffered is not null) await connection.ReceiveAsync(buffered, CancellationToken.None);
            while (socket.State == WebSocketState.Open && !aborted.IsCancellationRequested)
            {
                var text = pendingRead is not null ? await pendingRead : await ReceiveTextAsync(socket, aborted);
                pendingRead = null;
                if (text is null) break;
                await connection.ReceiveAsync(text, CancellationToken.None);
            }
        }
        catch (OperationCanceledException)
        {
            // server shutting down / client aborted
        }
        catch (WebSocketException)
        {
            // abrupt disconnect
        }
        finally
        {
            await connection.CloseAsync();
        }
    }

    /// <summary>Guards against a hostile client streaming an unbounded message (matches Go/Python ports).</summary>
    private const int MaxMessageBytes = 16 << 20; // 16 MiB

    /// <summary>Reads one complete text message; null when the socket closes.</summary>
    private static async Task<string?> ReceiveTextAsync(WebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[4096];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                if (socket.State == WebSocketState.CloseReceived)
                {
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
                }
                return null;
            }
            message.Write(buffer, 0, result.Count);
            if (message.Length > MaxMessageBytes)
            {
                await socket.CloseOutputAsync(WebSocketCloseStatus.MessageTooBig, "message too large", CancellationToken.None);
                return null;
            }
            if (result.EndOfMessage) return Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
        }
    }
}
