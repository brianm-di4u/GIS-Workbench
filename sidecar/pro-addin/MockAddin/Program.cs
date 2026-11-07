// The mock add-in (REQ-GAP-65, SCN-65). ArcGIS Pro and its SDK need an account or a licence, so this
// runs everything of the add-in that does not touch Pro against a real sidecar:
//
//   MockAddin contract --port P --addin-token T --page-token T2
//       replays sync-contract.json: the wire, step by step, then the echo cases
//   MockAddin run --port P --addin-token T
//       a fake map following the page through the real SyncLoop. Reads commands on stdin
//       ("view lon lat mpp rotation", "cursor lon lat", "cursor-off", "quit") and prints one JSON line
//       per event on stdout, so a test sees what the map was told to do.

using System.Globalization;
using System.Text.Json;
using GwbProSync.Core;

string? Arg(string name)
{
    var i = Array.IndexOf(args, name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
}

var port = int.Parse(Arg("--port") ?? "47821", CultureInfo.InvariantCulture);
var token = Arg("--addin-token");

return args.FirstOrDefault() switch
{
    "contract" => await Contract(port, token ?? "", Arg("--page-token") ?? ""),
    "run" => await Run(port, token),
    _ => Usage(),
};

static int Usage()
{
    Console.Error.WriteLine("MockAddin contract|run --port P --addin-token T [--page-token T]");
    return 2;
}

static bool Subset(JsonElement want, JsonElement got)
{
    if (want.ValueKind == JsonValueKind.String && want.GetString() == "@any") return got.ValueKind != JsonValueKind.Undefined && got.ValueKind != JsonValueKind.Null;
    if (want.ValueKind == JsonValueKind.Object)
    {
        if (got.ValueKind != JsonValueKind.Object) return false;
        foreach (var p in want.EnumerateObject())
            if (!got.TryGetProperty(p.Name, out var g) || !Subset(p.Value, g)) return false;
        return true;
    }
    if (want.ValueKind == JsonValueKind.Number) return got.ValueKind == JsonValueKind.Number && want.GetDouble() == got.GetDouble();
    return want.GetRawText() == got.GetRawText();
}

static async Task<int> Contract(int port, string addinToken, string pageToken)
{
    var file = Path.Combine(AppContext.BaseDirectory, "sync-contract.json");
    using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(file));
    using var addin = new SyncClient(port, addinToken);
    using var none = new SyncClient(port);
    using var page = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
    var session = "";
    var (done, bad) = (0, 0);
    foreach (var step in doc.RootElement.GetProperty("steps").EnumerateArray())
    {
        var name = step.GetProperty("name").GetString();
        var who = step.GetProperty("who").GetString();
        var method = step.GetProperty("method").GetString()!;
        var path = step.GetProperty("path").GetString()!.Replace("$session", session).TrimStart('/');
        JsonElement? body = step.TryGetProperty("body", out var b) ? b : null;
        int status;
        string text;
        if (who is "page" or "addin-with-origin")
        {
            // The page's side, as a browser page would call it: Origin null. Only the test does this.
            using var req = new HttpRequestMessage(new HttpMethod(method), path);
            req.Headers.TryAddWithoutValidation("Origin", "null");
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {(who == "page" ? pageToken : addinToken)}");
            if (body is { } x) req.Content = new StringContent(x.GetRawText(), System.Text.Encoding.UTF8, "application/json");
            using var resp = await page.SendAsync(req);
            (status, text) = ((int)resp.StatusCode, await resp.Content.ReadAsStringAsync());
        }
        else
        {
            var c = who == "none" ? none : addin;
            var saved = c.Token;
            if (who == "page-token-no-origin") c.Token = pageToken;
            (status, text) = await c.RawAsync(method, path, body);
            c.Token = saved;
        }
        var expect = step.GetProperty("expect");
        var ok = status == expect.GetProperty("status").GetInt32();
        JsonElement got = default;
        if (text.Length > 0)
        {
            using var d = JsonDocument.Parse(text);
            got = d.RootElement.Clone();
        }
        if (expect.TryGetProperty("code", out var code)) ok &= got.ValueKind == JsonValueKind.Object && got.GetProperty("code").GetString() == code.GetString();
        if (expect.TryGetProperty("body", out var want)) ok &= got.ValueKind == JsonValueKind.Object && Subset(want, got);
        if (got.ValueKind == JsonValueKind.Object && got.TryGetProperty("session", out var s)) session = s.GetString()!;
        done++;
        if (!ok)
        {
            bad++;
            Console.WriteLine($"FAILED {name}: {status} {text}");
        }
    }
    // The typed client over the same wire: what the add-in itself calls.
    var hello = await addin.HelloAsync();
    if (!hello.Paired || hello.Service != "gwb-sidecar") { bad++; Console.WriteLine($"FAILED hello: {hello}"); }
    done++;
    try
    {
        await none.NextAsync(0);
        bad++;
        Console.WriteLine("FAILED no token: no refusal");
    }
    catch (SyncException e) when (e.Status == 401 && e.Code == "unauthorized") { }
    done++;
    var cases = 0;
    foreach (var c in doc.RootElement.GetProperty("echo").EnumerateArray())
    {
        var view = (JsonElement e) => new SyncView(e.GetProperty("lon").GetDouble(), e.GetProperty("lat").GetDouble(), e.GetProperty("mpp").GetDouble(), e.GetProperty("rotation").GetDouble());
        var g = new EchoGuard();
        var t0 = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        g.Applied(view(c.GetProperty("applied")), t0);
        var seen = g.IsEcho(view(c.GetProperty("seen")), t0.AddMilliseconds(c.GetProperty("after_ms").GetDouble()));
        cases++;
        if (seen != c.GetProperty("echo").GetBoolean())
        {
            bad++;
            Console.WriteLine($"FAILED echo: {c.GetProperty("name").GetString()}");
        }
    }
    Console.WriteLine(JsonSerializer.Serialize(new { steps = done, echo = cases, failed = bad }));
    return bad == 0 ? 0 : 1;
}

static async Task<int> Run(int port, string? token)
{
    using var client = new SyncClient(port, token);
    var host = new FakeMap();
    var loop = new SyncLoop(client, host);
    using var cts = new CancellationTokenSource();
    var run = loop.RunAsync(cts.Token);
    FakeMap.Say(new { @event = "ready" });
    while (await Console.In.ReadLineAsync() is { } line)
    {
        var f = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var n = (int i) => double.Parse(f[i], CultureInfo.InvariantCulture);
        switch (f.FirstOrDefault())
        {
            case "view":
                await loop.LocalViewAsync(new SyncView(n(1), n(2), n(3), n(4)));
                FakeMap.Say(new { @event = "sent", kind = "view" });
                break;
            case "cursor":
                await loop.LocalCursorAsync(new SyncCursor(n(1), n(2), true));
                FakeMap.Say(new { @event = "sent", kind = "cursor" });
                break;
            case "cursor-off":
                await loop.LocalCursorAsync(new SyncCursor(0, 0, false));
                FakeMap.Say(new { @event = "sent", kind = "cursor-off" });
                break;
            case "quit":
                cts.Cancel();
                await run;
                return 0;
        }
    }
    cts.Cancel();
    await run;
    return 0;
}

/// <summary>A map that writes down what it is told, and moves by itself as a real map would.</summary>
sealed class FakeMap : IMapHost
{
    static readonly object Out = new();

    public static void Say(object o)
    {
        lock (Out)
        {
            Console.WriteLine(JsonSerializer.Serialize(o));
            Console.Out.Flush();
        }
    }

    public Task ApplyViewAsync(SyncView v)
    {
        Say(new { @event = "view", v.Lon, v.Lat, v.Mpp, v.Rotation });
        return Task.CompletedTask;
    }

    public void ShowCursor(SyncCursor c) => Say(new { @event = "cursor", c.Lon, c.Lat, c.Visible });

    public void Status(string text) => Say(new { @event = "status", text });
}
