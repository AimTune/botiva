// botiva .NET port self-test — same scenario as the Go test / TS smoke test.
// Run with: dotnet run --project Botiva.SelfTest

using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Botiva;
using Botiva.Authentication;

var failures = 0;

void Check(string name, bool ok)
{
    Console.WriteLine(ok ? $"  ✅ {name}" : $"  ❌ {name}");
    if (!ok) failures++;
}

var engine = new ConversationEngine(new EngineOptions
{
    Runtime = new DemoRuntime(),
    Greeting = "dotnet-greeting",
});

Frame? Find(List<Frame> frames, Func<Frame, bool> pred) => frames.FirstOrDefault(pred);
bool BotText(Frame f, string contains) =>
    (string?)f["type"] == "text" && (string?)f["from"] == "bot" &&
    ((string?)f["data"]?["text"] ?? "").Contains(contains);
bool UserText(Frame f, string contains) =>
    (string?)f["type"] == "text" && (string?)f["from"] == "user" &&
    ((string?)f["data"]?["text"] ?? "").Contains(contains);

// 1. fresh connect → welcome + greeting
var a = new List<Frame>();
var connA = await engine.ConnectAsync(new ConnectParams { Deliver = a.Add });
var welcome = Find(a, f => (string?)f["type"] == "welcome");
Check("welcome frame (protocol botiva/1)", welcome is not null &&
    (string?)welcome["data"]?["protocol"] == Protocol.Version);
var conversationId = (string)welcome!["data"]!["conversationId"]!;
var userId = (string)welcome["data"]!["userId"]!;
Check("greeting delivered", Find(a, f => BotText(f, "dotnet-greeting")) is not null);

// 2. echo turn
await connA.ReceiveAsync("""{"type":"text","data":{"text":"hello world"}}""");
Check("echo reply", Find(a, f => BotText(f, "Echo: hello world")) is not null);
Check("run frames", Find(a, f => (string?)f["type"] == "run") is not null);

// 3. user state
await connA.ReceiveAsync("""{"type":"text","data":{"text":"my name is Hamza"}}""");
Check("UserStore write", Find(a, f => BotText(f, "Nice to meet you, Hamza")) is not null);

// 4. tool_call + HITL + resume
await connA.ReceiveAsync("""{"type":"text","data":{"text":"report please"}}""");
Check("tool_call frames", Find(a, f => (string?)f["type"] == "tool_call") is not null);
Check("interrupt chips", Find(a, f => (string?)f["type"] == "text" && f["actions"] is JsonArray { Count: > 0 }) is not null);
await connA.ReceiveAsync("""{"type":"text","data":{"text":"Approve"}}""");
Check("HITL resume", Find(a, f => BotText(f, "Approved")) is not null);

// 5. botivaEmit (Ambient.Emit) genui + auto close
await connA.ReceiveAsync("""{"type":"text","data":{"text":"weather"}}""");
Check("Ambient.Emit genui frame", Find(a, f => (string?)f["type"] == "genui") is not null);
Check("genui stream auto-closed", Find(a, f => (string?)f["type"] == "genui" && (bool?)f["done"] == true) is not null);

// 6. replay on reconnect + fan-out
var b = new List<Frame>();
var connB = await engine.ConnectAsync(new ConnectParams
{
    ConversationId = conversationId, UserId = userId, Watermark = 0, Deliver = b.Add,
});
Check("replay: user + bot frames", Find(b, f => UserText(f, "hello world")) is not null &&
    Find(b, f => BotText(f, "Echo: hello world")) is not null);
var welcomeB = Find(b, f => (string?)f["type"] == "welcome");
Check("reconnect watermark > 0", (int?)welcomeB?["data"]?["watermark"] > 0);

await connB.ReceiveAsync("""{"type":"text","data":{"text":"sync test"}}""");
Check("fan-out to first connection", Find(a, f => UserText(f, "sync test")) is not null);
Check("no self-echo to sender", Find(b, f => UserText(f, "sync test")) is null);

// 7. user state across conversations
var c = new List<Frame>();
var connC = await engine.ConnectAsync(new ConnectParams { UserId = userId, Deliver = c.Add });
await connC.ReceiveAsync("""{"type":"text","data":{"text":"what's my name"}}""");
Check("UserStore across conversations", Find(c, f => BotText(f, "Your name is Hamza")) is not null);

await connA.CloseAsync();
await connB.CloseAsync();
await connC.CloseAsync();

// 8. authentication port (engine-level — the code path the transports drive)
const string jwtSecret = "selftest-secret";
string MakeJwt(string sub, JsonObject? extra = null)
{
    string Enc(JsonNode n) => Convert.ToBase64String(Encoding.UTF8.GetBytes(n.ToJsonString()))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');
    var head = Enc(new JsonObject { ["alg"] = "HS256", ["typ"] = "JWT" });
    var claims = extra ?? new JsonObject();
    claims["sub"] = sub;
    var body = Enc(claims);
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(jwtSecret));
    var sig = Convert.ToBase64String(hmac.ComputeHash(Encoding.ASCII.GetBytes($"{head}.{body}")))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');
    return $"{head}.{body}.{sig}";
}

var authEngine = new ConversationEngine(new EngineOptions
{
    Runtime = new DemoRuntime(),
    // Cookie "botiva_session" → JWT, with a query/hello/Bearer token fallback.
    Authenticator = new CookieAuthenticator("botiva_session",
        new HmacJwtAuthenticator(new HmacJwtOptions { Secret = jwtSecret })),
});

// (a) rejected: no credential → AuthenticationException
var rejected = false;
try
{
    await authEngine.ConnectAsync(new ConnectParams { Deliver = _ => { }, Auth = new AuthInput { Transport = "websocket" } });
}
catch (AuthenticationException ex)
{
    rejected = ex.Code == "unauthorized";
}
Check("unauthenticated connect throws AuthenticationException", rejected);

// (b) accepted via token → verified userId overrides the client claim
var authA = new List<Frame>();
var goodConn = await authEngine.ConnectAsync(new ConnectParams
{
    UserId = "user-spoof",
    Deliver = authA.Add,
    Auth = new AuthInput { Transport = "websocket", Token = MakeJwt("user-verified", new JsonObject { ["role"] = "admin" }) },
});
Check("valid token → verified userId overrides claim", goodConn.UserId == "user-verified");
var authWelcome = Find(authA, f => (string?)f["type"] == "welcome");
Check("welcome carries the verified userId", (string?)authWelcome?["data"]?["userId"] == "user-verified");

// (c) accepted via cookie (browser-style, no client token plumbing)
var cookieConn = await authEngine.ConnectAsync(new ConnectParams
{
    Deliver = _ => { },
    Auth = new AuthInput
    {
        Transport = "websocket",
        Headers = new Dictionary<string, string> { ["cookie"] = $"botiva_session={MakeJwt("user-cookie")}" },
    },
});
Check("cookie credential authenticates", cookieConn.UserId == "user-cookie");

// (d) a forged token cannot spoof identity
var forgedRejected = false;
try
{
    await authEngine.ConnectAsync(new ConnectParams
    {
        UserId = "user-spoof",
        Deliver = _ => { },
        Auth = new AuthInput { Transport = "websocket", Token = "not-a-jwt" },
    });
}
catch (AuthenticationException)
{
    forgedRejected = true;
}
Check("forged token cannot spoof identity", forgedRejected);

await goodConn.CloseAsync();
await cookieConn.CloseAsync();

Console.WriteLine(failures == 0 ? "\nAll .NET port checks passed ✅" : $"\n{failures} check(s) failed ❌");
return failures == 0 ? 0 : 1;
