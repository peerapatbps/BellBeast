using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BellBeast.ApiAccess;

/// <summary>
/// IP bans (whole site, persisted in App_Data/ip-bans.json) and an in-memory record of which IPs
/// write into the public IoT room (join / data / command), so an admin can spot a fake publisher and ban it.
/// </summary>
public sealed class IpAccessService
{
    public const int MaxActivityEntries = 2000;
    public const int MaxDevicesPerIp = 12;
    public const int MaxBanMinutes = 365 * 24 * 60;

    public sealed class IpBan
    {
        public string Ip { get; set; } = "";
        public string? Reason { get; set; }
        public DateTimeOffset CreatedAt { get; set; }
        public string? CreatedBy { get; set; }
        public DateTimeOffset? ExpiresAt { get; set; }       // null = permanent
    }

    public sealed record IpActivity(string Ip, DateTimeOffset FirstSeen, DateTimeOffset LastSeen, long Count,
        string LastAction, string? LastDevice, IReadOnlyList<string> Devices, bool Banned);

    private sealed class Activity
    {
        public DateTimeOffset FirstSeen, LastSeen;
        public long Count;
        public string LastAction = "";
        public string? LastDevice;
        public readonly List<string> Devices = new();
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _path;
    private readonly ILogger<IpAccessService> _log;
    private readonly object _lock = new();
    private List<IpBan> _bans;
    private volatile Dictionary<string, DateTimeOffset?> _banIndex;   // ip -> expiry (null = permanent)
    private readonly ConcurrentDictionary<string, Activity> _activity = new(StringComparer.Ordinal);

    public IpAccessService(IWebHostEnvironment env, ILogger<IpAccessService> log)
    {
        _log = log;
        _path = Path.Combine(env.ContentRootPath, "App_Data", "ip-bans.json");
        _bans = Load();
        _banIndex = Index(_bans);
    }

    // ── client IP ────────────────────────────────────────────────────────────

    /// <summary>
    /// The caller's IP. Behind the Cloudflare tunnel every request comes from loopback (cloudflared),
    /// so CF-Connecting-IP is trusted only then — a LAN client cannot spoof it.
    /// </summary>
    public static string ClientIp(HttpContext http)
    {
        var remote = http.Connection.RemoteIpAddress;
        if (remote is not null && IPAddress.IsLoopback(remote) &&
            http.Request.Headers["CF-Connecting-IP"].FirstOrDefault() is { Length: > 0 } cf &&
            IPAddress.TryParse(cf.Trim(), out var cfIp))
            return Normalize(cfIp);
        return remote is null ? "?" : Normalize(remote);
    }

    private static string Normalize(IPAddress ip) => (ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip).ToString();

    /// <summary>Canonical form of an admin-typed IP, or null if it is not an IP address.</summary>
    public static string? Parse(string? s) => IPAddress.TryParse((s ?? "").Trim(), out var ip) ? Normalize(ip) : null;

    // ── bans ─────────────────────────────────────────────────────────────────

    public bool IsBanned(string ip)
    {
        if (!_banIndex.TryGetValue(ip, out var exp)) return false;
        return exp is null || exp > DateTimeOffset.UtcNow;
    }

    public IReadOnlyList<IpBan> ListBans()
    {
        var now = DateTimeOffset.UtcNow;
        lock (_lock)
            return _bans.Where(b => b.ExpiresAt is null || b.ExpiresAt > now)
                        .OrderByDescending(b => b.CreatedAt).Select(Clone).ToList();
    }

    /// <summary>Bans an IP. Returns an error code, or null. The admin's own IP and loopback cannot be banned.</summary>
    public string? Ban(string? ipText, string? reason, int? minutes, string? actor, string actorIp)
    {
        var ip = Parse(ipText);
        if (ip is null) return "bad_ip";
        if (IPAddress.IsLoopback(IPAddress.Parse(ip))) return "cannot_ban_loopback";
        if (ip == actorIp) return "cannot_ban_self";
        if (minutes is < 1 or > MaxBanMinutes) return "bad_duration";
        reason = (reason ?? "").Trim();
        if (reason.Length > 200) return "reason_too_long";

        var now = DateTimeOffset.UtcNow;
        lock (_lock)
        {
            _bans.RemoveAll(b => b.Ip == ip || (b.ExpiresAt is { } e && e <= now));
            _bans.Add(new IpBan
            {
                Ip = ip, Reason = reason.Length == 0 ? null : reason, CreatedAt = now, CreatedBy = actor,
                ExpiresAt = minutes is int m ? now.AddMinutes(m) : null,
            });
            Save();
            _banIndex = Index(_bans);
        }
        _log.LogWarning("IP banned: {Ip} for {Minutes} min by {Actor} ({Reason})", ip, minutes?.ToString() ?? "ever", actor, reason);
        return null;
    }

    public bool Unban(string? ipText, string? actor)
    {
        var ip = Parse(ipText);
        if (ip is null) return false;
        lock (_lock)
        {
            if (_bans.RemoveAll(b => b.Ip == ip) == 0) return false;
            Save();
            _banIndex = Index(_bans);
        }
        _log.LogInformation("IP unbanned: {Ip} by {Actor}", ip, actor);
        return true;
    }

    // ── IoT room activity ────────────────────────────────────────────────────

    public void RecordRoomWrite(string ip, string action, string? device)
    {
        var now = DateTimeOffset.UtcNow;
        var a = _activity.GetOrAdd(ip, _ => new Activity { FirstSeen = now });
        lock (a)
        {
            a.LastSeen = now;
            a.Count++;
            a.LastAction = action;
            if (!string.IsNullOrWhiteSpace(device))
            {
                device = device.Trim();
                a.LastDevice = device;
                if (!a.Devices.Contains(device, StringComparer.OrdinalIgnoreCase))
                {
                    if (a.Devices.Count >= MaxDevicesPerIp) a.Devices.RemoveAt(0);
                    a.Devices.Add(device);
                }
            }
        }
        if (_activity.Count > MaxActivityEntries) Trim();
    }

    public IReadOnlyList<IpActivity> ListActivity()
    {
        return _activity.Select(kv =>
            {
                var a = kv.Value;
                lock (a) return new IpActivity(kv.Key, a.FirstSeen, a.LastSeen, a.Count, a.LastAction, a.LastDevice, a.Devices.ToList(), IsBanned(kv.Key));
            })
            .OrderByDescending(x => x.LastSeen)
            .ToList();
    }

    private void Trim()
    {
        foreach (var old in _activity.OrderBy(kv => kv.Value.LastSeen).Take(_activity.Count - MaxActivityEntries).ToList())
            _activity.TryRemove(old.Key, out _);
    }

    // ── persistence ──────────────────────────────────────────────────────────

    private static Dictionary<string, DateTimeOffset?> Index(List<IpBan> bans) =>
        bans.GroupBy(b => b.Ip).ToDictionary(g => g.Key, g => g.Last().ExpiresAt, StringComparer.Ordinal);

    private static IpBan Clone(IpBan b) => new()
        { Ip = b.Ip, Reason = b.Reason, CreatedAt = b.CreatedAt, CreatedBy = b.CreatedBy, ExpiresAt = b.ExpiresAt };

    private List<IpBan> Load()
    {
        try
        {
            if (File.Exists(_path) && JsonSerializer.Deserialize<List<IpBan>>(File.ReadAllText(_path), JsonOpts) is { } list)
                return list.Where(b => Parse(b.Ip) is not null).ToList();
        }
        catch (JsonException ex) { _log.LogError(ex, "ip-bans.json is invalid — no IP bans loaded"); }
        return new List<IpBan>();
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_bans, JsonOpts));
        File.Move(tmp, _path, overwrite: true);
    }
}

/// <summary>First thing in the pipeline: a banned IP gets 403 for every page, file and API.</summary>
public sealed class IpBanMiddleware
{
    private readonly RequestDelegate _next;
    public IpBanMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext ctx, IpAccessService ips)
    {
        if (!ips.IsBanned(IpAccessService.ClientIp(ctx))) { await _next(ctx); return; }

        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        ctx.Response.Headers.CacheControl = "no-store";
        if (ctx.Request.Path.StartsWithSegments("/api"))
            await ctx.Response.WriteAsJsonAsync(new { ok = false, error = "ip_banned" });
        else
        {
            ctx.Response.ContentType = "text/plain; charset=utf-8";
            await ctx.Response.WriteAsync("403 — this IP address is blocked.");
        }
    }
}
