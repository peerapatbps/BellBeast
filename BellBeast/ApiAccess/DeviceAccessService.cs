using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using BellBeast.Services;

namespace BellBeast.ApiAccess;

/// <summary>Endpoint metadata: a device API (alarm feed, clips, lab glance, IoT room, firmware download).</summary>
public sealed class DeviceApi { }

/// <summary>
/// Access to the device APIs (group <c>device</c>): besides what a page API accepts (live view token, login,
/// loopback, manual IP pass), a registered annunciator gets in with
/// <list type="bullet">
/// <item><c>X-Device-Id</c> + <c>X-Device-Key</c> of an <b>approved</b> fleet device (firmware ≥ ann-1.4), or</item>
/// <item>the fleet IP pass — the connection IP its key last checked out from, for <see cref="IpPassService.FleetWindow"/>
///   (older firmware; switch off with <c>allow_ip_pass</c> once every device sends its key).</item>
/// </list>
/// Mode <c>shadow</c> (default) lets everything through and only records who <i>would</i> be blocked;
/// <c>enforce</c> rejects them like a page API. Settings: App_Data/device-access.json (no restart needed).
/// </summary>
public sealed class DeviceAccessService
{
    public const string IdHeader = "X-Device-Id";
    public const string ModeShadow = "shadow", ModeEnforce = "enforce";
    public const int MaxTracked = 2000;

    public sealed class Settings
    {
        public string Mode { get; set; } = ModeShadow;
        public bool AllowIpPass { get; set; } = true;
        public DateTimeOffset? UpdatedAt { get; set; }
        public string? UpdatedBy { get; set; }
    }

    public enum Via { None, Key, IpPass }

    public sealed record Caller(string Ip, string? Device, string Via, long Hits, DateTimeOffset LastAt, string LastRoute);
    public sealed record WouldBlock(string Ip, long Count, DateTimeOffset FirstAt, DateTimeOffset LastAt, string LastRoute, string Reason, bool Blocked);

    private sealed class Counter { public string? Device; public string Via = ""; public long Hits; public DateTimeOffset LastAt; public string LastRoute = ""; }
    private sealed class Miss { public long Count; public DateTimeOffset FirstAt, LastAt; public string LastRoute = "", Reason = ""; public bool Blocked; }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _path;
    private readonly DeviceFleetService _fleet;
    private readonly ILogger<DeviceAccessService> _log;
    private readonly object _lock = new();
    private volatile Settings _settings;
    private readonly ConcurrentDictionary<string, Counter> _callers = new(StringComparer.Ordinal);   // key: ip|device
    private readonly ConcurrentDictionary<string, Miss> _misses = new(StringComparer.Ordinal);       // key: ip

    public DeviceAccessService(IWebHostEnvironment env, DeviceFleetService fleet, ILogger<DeviceAccessService> log)
    {
        _fleet = fleet;
        _log = log;
        _path = Path.Combine(env.ContentRootPath, "App_Data", "device-access.json");
        _settings = Load();
    }

    public Settings Current => _settings;
    public bool Enforcing => _settings.Mode == ModeEnforce;

    /// <summary>Device key first (a valid key always wins), then the fleet IP pass if allowed.</summary>
    public (Via Via, string? Device) Check(HttpContext ctx, string ip)
    {
        var id = ctx.Request.Headers[IdHeader].FirstOrDefault()?.Trim().ToLowerInvariant();
        var key = ctx.Request.Headers[DeviceFleetService.KeyHeader].FirstOrDefault()?.Trim().ToLowerInvariant();
        if (id is not null && key is not null && _fleet.VerifyApproved(id, key, ip)) return (Via.Key, id);
        if (_settings.AllowIpPass && _fleet.ApprovedDeviceAt(ip, IpPassService.FleetWindow) is { } dev) return (Via.IpPass, dev);
        return (Via.None, null);
    }

    public void RecordAllowed(string ip, string? device, Via via, string route)
    {
        var c = _callers.GetOrAdd(ip + "|" + (device ?? ""), _ => new Counter());
        lock (c) { c.Device = device; c.Via = via == Via.Key ? "key" : "ip_pass"; c.Hits++; c.LastAt = DateTimeOffset.UtcNow; c.LastRoute = route; }
        Trim(_callers, x => x.LastAt);
    }

    /// <summary>A caller with no valid way in: recorded (shadow) or blocked (enforce).</summary>
    public void RecordMiss(string ip, string route, string reason, bool blocked)
    {
        var now = DateTimeOffset.UtcNow;
        var m = _misses.GetOrAdd(ip, _ => new Miss { FirstAt = now });
        lock (m) { m.Count++; m.LastAt = now; m.LastRoute = route; m.Reason = reason; m.Blocked = blocked; }
        Trim(_misses, x => x.LastAt);
    }

    public IReadOnlyList<Caller> Callers() =>
        _callers.Select(kv => { var c = kv.Value; lock (c) return new Caller(kv.Key.Split('|')[0], c.Device, c.Via, c.Hits, c.LastAt, c.LastRoute); })
            .OrderByDescending(c => c.LastAt).ToList();

    public IReadOnlyList<WouldBlock> Misses() =>
        _misses.Select(kv => { lock (kv.Value) return new WouldBlock(kv.Key, kv.Value.Count, kv.Value.FirstAt, kv.Value.LastAt, kv.Value.LastRoute, kv.Value.Reason, kv.Value.Blocked); })
            .OrderByDescending(m => m.LastAt).ToList();

    public bool ClearMiss(string ip) => _misses.TryRemove(ip, out _);

    /// <summary>Returns an error code, or null.</summary>
    public string? Update(string? mode, bool? allowIpPass, string? actor)
    {
        if (mode is not null && mode is not (ModeShadow or ModeEnforce)) return "bad_mode";
        lock (_lock)
        {
            var s = new Settings
            {
                Mode = mode ?? _settings.Mode,
                AllowIpPass = allowIpPass ?? _settings.AllowIpPass,
                UpdatedAt = DateTimeOffset.UtcNow,
                UpdatedBy = actor,
            };
            var tmp = _path + ".tmp";
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            File.WriteAllText(tmp, JsonSerializer.Serialize(s, JsonOpts));
            File.Move(tmp, _path, overwrite: true);
            _settings = s;
        }
        _log.LogWarning("Device API access: mode={Mode} allow_ip_pass={IpPass} by {Actor}", _settings.Mode, _settings.AllowIpPass, actor);
        return null;
    }

    private Settings Load()
    {
        try
        {
            if (File.Exists(_path) && JsonSerializer.Deserialize<Settings>(File.ReadAllText(_path), JsonOpts) is { } s)
                return s.Mode is ModeShadow or ModeEnforce ? s : new Settings { AllowIpPass = s.AllowIpPass };
        }
        catch (JsonException ex) { _log.LogError(ex, "device-access.json is invalid — using shadow mode"); }
        return new Settings();
    }

    private static void Trim<T>(ConcurrentDictionary<string, T> d, Func<T, DateTimeOffset> last)
    {
        if (d.Count <= MaxTracked) return;
        foreach (var old in d.OrderBy(kv => last(kv.Value)).Take(d.Count - MaxTracked).ToList()) d.TryRemove(old.Key, out _);
    }
}
