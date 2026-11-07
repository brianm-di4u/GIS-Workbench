// What keeps two maps following each other without a loop, with no ArcGIS reference. `IMapHost` is the
// whole of what it needs from a map: ProMapHost is the real one, MockAddin a fake one.

namespace GwbProSync.Core;

public interface IMapHost
{
    /// <summary>Move the map. The move comes back as a camera event, which EchoGuard stops.</summary>
    Task ApplyViewAsync(SyncView view);

    /// <summary>Show the other side's cursor, or hide it when it is not visible.</summary>
    void ShowCursor(SyncCursor cursor);

    /// <summary>The connection changed: for the status the add-in shows.</summary>
    void Status(string text);
}

/// <summary>
/// The rule that stops a loop: a view this side was told to apply, seen again as its own camera
/// change, is not published. Same numbers as app/src/sidecar/pro-sync.js; the cases that hold both to
/// it are in the contract's "echo" list.
/// </summary>
public sealed class EchoGuard
{
    public const double Pixels = 0.5;
    public const double ScaleRatio = 0.005;
    public const double Degrees = 0.05;
    public static readonly TimeSpan Life = TimeSpan.FromSeconds(2);
    const double MetresPerDegree = 111_320;

    SyncView? _applied;
    DateTime _at;

    public void Applied(SyncView v, DateTime now)
    {
        _applied = v;
        _at = now;
    }

    public static bool Same(SyncView a, SyncView b)
    {
        var east = (a.Lon - b.Lon) * MetresPerDegree * Math.Cos(a.Lat * Math.PI / 180);
        var north = (a.Lat - b.Lat) * MetresPerDegree;
        var metres = Math.Sqrt(east * east + north * north);
        return metres <= Pixels * a.Mpp && Math.Abs(a.Mpp / b.Mpp - 1) <= ScaleRatio && Math.Abs(a.Rotation - b.Rotation) <= Degrees;
    }

    public bool IsEcho(SyncView seen, DateTime now)
    {
        if (_applied is null || now - _at > Life) return false;
        return Same(_applied, seen);
    }
}

public sealed class SyncLoop(SyncClient client, IMapHost host, Func<DateTime>? clock = null)
{
    /// <summary>Cursor moves sent per second at most: the sidecar coalesces, this spares it the work.</summary>
    public const int CursorPerSecond = 30;

    readonly Func<DateTime> _now = clock ?? (() => DateTime.UtcNow);
    readonly EchoGuard _echo = new();
    readonly object _lock = new();
    DateTime _lastCursor = DateTime.MinValue;
    SyncPublish? _next;
    bool _sending;

    /// <summary>The map moved here. Sent unless it is the move this side was just told to make.</summary>
    public async Task LocalViewAsync(SyncView v, CancellationToken ct = default)
    {
        lock (_lock)
            if (_echo.IsEcho(v, _now())) return;
        await PublishQuietly(v, null, ct).ConfigureAwait(false);
    }

    public async Task LocalCursorAsync(SyncCursor c, CancellationToken ct = default)
    {
        lock (_lock)
        {
            var t = _now();
            if (c.Visible && (t - _lastCursor).TotalSeconds < 1.0 / CursorPerSecond) return;
            _lastCursor = t;
        }
        await PublishQuietly(null, c, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// One request at a time, as the page does: two at once could land in the wrong order and leave
    /// the other map on the older view. What arrives meanwhile waits, and only the newest goes.
    /// Refusals here are normal: no page has sync on, or this side follows the other.
    /// </summary>
    async Task PublishQuietly(SyncView? v, SyncCursor? c, CancellationToken ct)
    {
        lock (_lock)
        {
            _next = new SyncPublish(v ?? _next?.View, c ?? _next?.Cursor);
            if (_sending) return;
            _sending = true;
        }
        try
        {
            for (;;)
            {
                SyncPublish p;
                lock (_lock)
                {
                    if (_next is null) return;
                    p = _next;
                    _next = null;
                }
                try
                {
                    await client.PublishAsync(p.View, p.Cursor, ct).ConfigureAwait(false);
                }
                catch (SyncException) { }
            }
        }
        finally
        {
            lock (_lock) _sending = false;
        }
    }

    /// <summary>Follow the page until cancelled or until the sidecar no longer knows this add-in.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        ulong after = 0;
        var fails = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var u = await client.NextAsync(after, ct).ConfigureAwait(false);
                fails = 0;
                host.Status(u.Peer ? "Connected to GIS Workbench" : "Waiting for GIS Workbench: turn sync on in the app");
                after = u.Seq;
                if (u.View is { } v)
                {
                    lock (_lock) _echo.Applied(v, _now());
                    await host.ApplyViewAsync(v).ConfigureAwait(false);
                }
                if (u.Cursor is { } c) host.ShowCursor(c);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (SyncException e) when (e.Status == 401)
            {
                host.Status("This add-in is not paired with the sidecar any more");
                return;
            }
            catch (SyncException e)
            {
                host.Status($"The sidecar is not answering: {e.Message}");
                fails = Math.Min(fails + 1, 6);
                await Task.Delay(TimeSpan.FromMilliseconds(500 << fails), ct).ConfigureAwait(false);
            }
        }
    }
}
