// Scripted self-test — a real ClientWebSocket driving the server over the
// wire (same scenario as the Go/TS example selftests), including a check that
// a tool served over MCP flows through the agent loop.

using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Botiva;

namespace Botiva.Example;

public static class SelfTest
{
    public static async Task<bool> RunAsync(string port)
    {
        var url = $"ws://localhost:{port}/chat";
        try
        {
            var a = await Client.ConnectAsync(url);
            var welcome = await a.WaitFor(f => (string?)f["type"] == "welcome", "welcome");
            if ((string?)welcome["data"]?["protocol"] != Protocol.Version)
                throw new Exception($"unexpected protocol {welcome["data"]?["protocol"]}");
            var conversationId = (string)welcome["data"]!["conversationId"]!;
            var userId = (string)welcome["data"]!["userId"]!;
            Pass("welcome frame (protocol botiva/1)");

            await a.WaitFor(f => BotText(f, ".NET agent demo"), "greeting");
            Pass("greeting delivered");

            await a.Send("My name is Botivan, please remember it.");
            await a.WaitFor(f => ToolDone(f, "remember_name"), "remember_name completed");
            await a.WaitFor(f => BotText(f, "Botivan"), "name confirmation");
            Pass("tool call → UserStore write (remember_name)");

            await a.Send("What's the weather in Istanbul?");
            await a.WaitFor(f => (string?)f["type"] == "genui" && (string?)f["chunk"]?["component"] == "weather",
                "weather genui card");
            await a.WaitFor(f => (string?)f["type"] == "genui" && (bool?)f["done"] == true, "genui auto close");
            Pass("Ambient.Emit GenUI card + auto stream close");

            await a.Send("Show me the iteration performance please");
            await a.WaitFor(f => ToolDone(f, "get_iteration_performance"), "MCP tool completed", 30);
            await a.WaitFor(f => BotText(f, "velocity"), "MCP tool result in the answer");
            Pass("MCP tool (ModelContextProtocol over Streamable HTTP) → tool_call frame");

            await a.Send("Generate a PDF report about velocity");
            await a.WaitFor(f => (string?)f["type"] == "text" && f["actions"] is JsonArray { Count: > 0 },
                "interrupt approval chips");
            Pass("Hitl.Interrupt → approval chips");

            await a.Send("Approve");
            await a.WaitFor(f => ToolDone(f, "generate_report_pdf"), "resume completes the tool");
            await a.WaitFor(f => (string?)f["type"] == "genui" && (string?)f["chunk"]?["component"] == "genui-card",
                "download card after resume");
            await a.WaitFor(f => BotText(f, "Report ready"), "final answer after resume");
            Pass("resume re-runs the paused tool (Command({resume}) equivalent)");

            var b = await Client.ConnectAsync($"{url}?userId={userId}&conversationId={conversationId}&watermark=0");
            await b.WaitFor(f => UserText(f, "My name is Botivan"), "replay: user frame");
            await b.WaitFor(f => BotText(f, "Report ready"), "replay: bot frame");
            Pass("watermark replay on reconnect");

            await b.Send("sync test");
            await a.WaitFor(f => UserText(f, "sync test"), "fan-out to first connection");
            Pass("multi-connection fan-out");

            var c = await Client.ConnectAsync($"{url}?userId={userId}");
            await c.WaitFor(f => (string?)f["type"] == "welcome", "welcome (C)");
            await c.Send("What is my name?");
            await c.WaitFor(f => BotText(f, "Botivan"), "name recalled across conversations");
            Pass("UserStore across conversations (recall_name)");

            // authentication over the wire (/chat-secure, PROTOCOL.md §2.1)
            var secureUrl = $"ws://localhost:{port}/chat-secure";
            var noAuth = await Client.ConnectAsync(secureUrl);
            await noAuth.WaitFor(f => (string?)f["type"] == "error" && (string?)f["data"]?["code"] == "unauthorized",
                "auth error frame");
            Pass("unauthenticated connect → error frame (transport)");

            var authed = await Client.ConnectAsync($"{secureUrl}?token=good-token&userId=user-spoof");
            var authWelcome = await authed.WaitFor(f => (string?)f["type"] == "welcome", "welcome (auth)");
            if ((string?)authWelcome["data"]?["userId"] != "user-verified")
                throw new Exception("verified userId not applied by the transport");
            Pass("valid token → verified userId overrides claim (transport)");

            a.Dispose();
            b.Dispose();
            c.Dispose();
            noAuth.Dispose();
            authed.Dispose();
            Console.WriteLine("\n.NET agent selftest passed ✅");
            return true;
        }
        catch (Exception err)
        {
            Console.Error.WriteLine($"\n.NET agent selftest failed ❌ {err.Message}");
            return false;
        }
    }

    private static void Pass(string name) => Console.WriteLine($"  ✅ {name}");

    private static bool BotText(JsonObject f, string contains) =>
        (string?)f["type"] == "text" && (string?)f["from"] == "bot" &&
        ((string?)f["data"]?["text"] ?? "").Contains(contains);

    private static bool UserText(JsonObject f, string contains) =>
        (string?)f["type"] == "text" && (string?)f["from"] == "user" &&
        ((string?)f["data"]?["text"] ?? "").Contains(contains);

    private static bool ToolDone(JsonObject f, string name) =>
        (string?)f["type"] == "tool_call" && (string?)f["data"]?["name"] == name &&
        (string?)f["data"]?["status"] == "completed";

    private sealed class Client : IDisposable
    {
        private readonly ClientWebSocket _socket = new();
        private readonly List<JsonObject> _frames = [];
        private readonly SemaphoreSlim _arrived = new(0);
        private readonly CancellationTokenSource _cts = new();

        public static async Task<Client> ConnectAsync(string url)
        {
            var client = new Client();
            await client._socket.ConnectAsync(new Uri(url), CancellationToken.None);
            _ = client.ReceiveLoopAsync();
            return client;
        }

        public async Task Send(string text)
        {
            var frame = new JsonObject { ["type"] = "text", ["data"] = new JsonObject { ["text"] = text } };
            await _socket.SendAsync(Encoding.UTF8.GetBytes(frame.ToJsonString()),
                WebSocketMessageType.Text, true, CancellationToken.None);
        }

        public async Task<JsonObject> WaitFor(Func<JsonObject, bool> pred, string label, int timeoutSeconds = 10)
        {
            var scanned = 0;
            var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
            while (true)
            {
                lock (_frames)
                {
                    for (; scanned < _frames.Count; scanned++)
                    {
                        if (pred(_frames[scanned])) return _frames[scanned];
                    }
                }
                var remaining = deadline - DateTime.UtcNow;
                if (remaining <= TimeSpan.Zero || !await _arrived.WaitAsync(remaining))
                    throw new TimeoutException($"timeout: {label}");
            }
        }

        private async Task ReceiveLoopAsync()
        {
            var buffer = new byte[16384];
            using var message = new MemoryStream();
            try
            {
                while (!_cts.IsCancellationRequested)
                {
                    var result = await _socket.ReceiveAsync(buffer, _cts.Token);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    message.Write(buffer, 0, result.Count);
                    if (!result.EndOfMessage) continue;
                    var text = Encoding.UTF8.GetString(message.ToArray());
                    message.SetLength(0);
                    if (JsonNode.Parse(text) is JsonObject frame)
                    {
                        lock (_frames) _frames.Add(frame);
                        _arrived.Release();
                    }
                }
            }
            catch (Exception)
            {
                // socket torn down — WaitFor will time out with its own label
            }
        }

        public void Dispose()
        {
            _cts.Cancel();
            _socket.Dispose();
        }
    }
}
