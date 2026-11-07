// The add-in's end of ArcGIS Pro sync (REQ-GAP-65): plain .NET, no ArcGIS reference, so it builds and
// runs without ArcGIS Pro. Its contract with the sidecar is sidecar/pro-addin/contract/sync-contract.json,
// replayed against a real sidecar by MockAddin. Only 127.0.0.1, never a proxy.

using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GwbProSync.Core;

public sealed record SyncView(
    [property: JsonPropertyName("lon")] double Lon,
    [property: JsonPropertyName("lat")] double Lat,
    [property: JsonPropertyName("mpp")] double Mpp,
    [property: JsonPropertyName("rotation")] double Rotation);

public sealed record SyncCursor(
    [property: JsonPropertyName("lon")] double Lon,
    [property: JsonPropertyName("lat")] double Lat,
    [property: JsonPropertyName("visible")] bool Visible);

public sealed record SyncPublish(
    [property: JsonPropertyName("view"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SyncView? View,
    [property: JsonPropertyName("cursor"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SyncCursor? Cursor);

public sealed record SyncUpdate(
    [property: JsonPropertyName("seq")] ulong Seq,
    [property: JsonPropertyName("peer")] bool Peer,
    [property: JsonPropertyName("view")] SyncView? View,
    [property: JsonPropertyName("cursor")] SyncCursor? Cursor);

public sealed record SyncHello(
    [property: JsonPropertyName("service")] string Service,
    [property: JsonPropertyName("paired")] bool Paired,
    [property: JsonPropertyName("app")] bool App,
    [property: JsonPropertyName("direction")] string? Direction);

public sealed record PairStart(
    [property: JsonPropertyName("pairing_id")] string PairingId,
    [property: JsonPropertyName("code")] string Code);

public sealed record PairStatus(
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("token")] string? Token);

/// <summary>A refusal of the sidecar, by its code, or a connection that failed (status 0).</summary>
public sealed class SyncException : Exception
{
    public int Status { get; }
    public string Code { get; }

    public SyncException(int status, string code, string message) : base(message)
    {
        Status = status;
        Code = code;
    }
}

public sealed class SyncClient : IDisposable
{
    public static readonly int[] Ports = [47821, 47822, 47823];
    /// <summary>A long poll is held 25 s by the sidecar: this is the most one call may take.</summary>
    static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(40);

    readonly HttpClient _http;
    public int Port { get; }
    public string? Token { get; set; }

    public SyncClient(int port, string? token = null, HttpMessageHandler? handler = null)
    {
        if (Array.IndexOf(Ports, port) < 0 && handler is null && Environment.GetEnvironmentVariable("GWB_SIDECAR_TEST") != "1")
            throw new ArgumentException("the sidecar listens on 47821-47823", nameof(port));
        Port = port;
        Token = token;
        // UseProxy = false: a system proxy must never see a loopback call or its token.
        _http = new HttpClient(handler ?? new SocketsHttpHandler { UseProxy = false, AllowAutoRedirect = false, UseCookies = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{port}/"),
            Timeout = CallTimeout,
        };
    }

    public void Dispose() => _http.Dispose();

    /// <summary>The first sidecar that answers, or null.</summary>
    public static async Task<SyncClient?> DiscoverAsync(string? token, CancellationToken ct = default)
    {
        foreach (var p in Ports)
        {
            var c = new SyncClient(p, token);
            try
            {
                var h = await c.HelloAsync(ct).ConfigureAwait(false);
                if (h.Service == "gwb-sidecar") return c;
            }
            catch (SyncException) { }
            c.Dispose();
        }
        return null;
    }

    async Task<(int Status, string Body)> SendAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, path);
        if (Token is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, new MediaTypeHeaderValue("application/json"));
        try
        {
            using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
            return ((int)resp.StatusCode, await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
        }
        catch (HttpRequestException e)
        {
            throw new SyncException(0, "connect", e.Message);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new SyncException(0, "timeout", "the sidecar did not answer");
        }
    }

    /// <summary>One request, as the contract states it. Tests and the two-way calls below use it.</summary>
    public Task<(int Status, string Body)> RawAsync(string method, string path, JsonElement? body, CancellationToken ct = default) =>
        SendAsync(new HttpMethod(method), path, body, ct);

    static T Parse<T>(int status, string body)
    {
        if (status is >= 200 and < 300)
            return JsonSerializer.Deserialize<T>(body) ?? throw new SyncException(status, "bad_answer", "an empty answer");
        string code = "http", message = body;
        try
        {
            using var d = JsonDocument.Parse(body);
            code = d.RootElement.GetProperty("code").GetString() ?? code;
            message = d.RootElement.GetProperty("error").GetString() ?? message;
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException) { }
        throw new SyncException(status, code, message);
    }

    async Task<T> CallAsync<T>(HttpMethod m, string path, object? body, CancellationToken ct)
    {
        var (s, b) = await SendAsync(m, path, body, ct).ConfigureAwait(false);
        return Parse<T>(s, b);
    }

    public Task<SyncHello> HelloAsync(CancellationToken ct = default) => CallAsync<SyncHello>(HttpMethod.Get, "sync/v1/hello", null, ct);

    public Task<PairStart> PairStartAsync(string client, CancellationToken ct = default) => CallAsync<PairStart>(HttpMethod.Post, "sync/v1/pair", new Dictionary<string, string> { ["client"] = client }, ct);

    public Task<PairStatus> PairPollAsync(string id, CancellationToken ct = default) => CallAsync<PairStatus>(HttpMethod.Get, $"sync/v1/pair/{id}", null, ct);

    public async Task<ulong> PublishAsync(SyncView? view, SyncCursor? cursor, CancellationToken ct = default)
    {
        var r = await CallAsync<JsonElement>(HttpMethod.Post, "sync/v1/state", new SyncPublish(view, cursor), ct).ConfigureAwait(false);
        return r.GetProperty("seq").GetUInt64();
    }

    /// <summary>What the page published since <paramref name="after"/>; empty after the sidecar's hold.</summary>
    public Task<SyncUpdate> NextAsync(ulong after, CancellationToken ct = default) => CallAsync<SyncUpdate>(HttpMethod.Get, $"sync/v1/next?after={after}", null, ct);

    public async Task ForgetAsync(CancellationToken ct = default)
    {
        var (s, b) = await SendAsync(HttpMethod.Delete, "sync/v1/pair", null, ct).ConfigureAwait(false);
        if (s != (int)HttpStatusCode.NoContent) Parse<JsonElement>(s, b);
    }
}
