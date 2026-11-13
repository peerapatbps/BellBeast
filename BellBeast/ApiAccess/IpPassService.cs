using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using BellBeast.Services;

namespace BellBeast.ApiAccess;

/// <summary>
/// IP passes: machines that cannot hold a view token (truck-scale PC, annunciators) may call chosen
/// page-level APIs without one.
/// - Manual passes: an admin enters an IP and the page APIs it may call (App_Data/ip-passes.json).
/// - Fleet passes: an approved fleet device gets the fleet routes from the connection IP its key last
///   checked out from (never the IP the device reports), for <see cref="FleetWindow"/>. DHCP changes
///   follow on the next report; an unapproved or silent device loses the pass on its own.
/// Only "page" APIs can be passed: public ones need nothing and user/admin ones still need a login.
/// </summary>
public sealed class IpPassService
{
    public const int MaxPasses = 200;
    public const int MaxRoutesPerPass = 60;
    public static readonly TimeSpan FleetWindow = TimeSpan.FromMinutes(10);
    /// <summary>Fleet routes until an admin sets them: the annunciator chlorine page (cl_glance).</summary>
    public static readonly IReadOnlyList<string> DefaultFleetRoutes = ["GET /api/cldetector/summary"];

    public sealed class IpPass
    {
        public string Ip { get; set; } = "";
        public List<string> Routes { get; set; } = new();
        public string? Note { get; set; }
        public DateTimeOffset CreatedAt { get; set; }
        public string? CreatedBy { get; set; }
        public DateTimeOffset? UpdatedAt { get; set; }
    }

    public sealed record Usage(long Hits, DateTimeOffset LastUsed, string LastRoute, string Via);

    private sealed class PassFile
    {
        public List<IpPass> Passes { get; set; } = new();
        public List<string>? FleetRoutes { get; set; }       // null = DefaultFleetRoutes
    }

    private sealed class Counter { public long Hits; public DateTimeOffset LastUsed; public string LastRoute = "", Via = ""; }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _path;
    private readonly DeviceFleetService _fleet;
    private readonly ILogger<IpPassService> _log;
    private readonly object _lock = new();
    private PassFile _file;
    private volatile Dictionary<string, HashSet<string>> _index;   // ip -> route ids
    private volatile HashSet<string> _fleetRoutes;
    private readonly ConcurrentDictionary<string, Counter> _usage = new(StringComparer.Ordinal);

    public IpPassService(IWebHostEnvironment env, DeviceFleetService fleet, ILogger<IpPassService> log)
    {
        _fleet = fleet;
        _log = log;
        _path = Path.Combine(env.ContentRootPath, "App_Data", "ip-passes.json");
        _file = Load();
        (_index, _fleetRoutes) = Index(_file);
    }

    // ── the check (view token middleware) ────────────────────────────────────

    /// <summary>True when this IP holds a pass for this page API (manual entry or an approved fleet device).</summary>
    public bool Allows(string ip, string routeId)
    {
        string? via = null;
        if (_index.TryGetValue(ip, out var routes) && routes.Contains(routeId)) via = "ip";
        else if (_fleetRoutes.Contains(routeId) && _fleet.ApprovedDeviceAt(ip, FleetWindow) is { } device) via = "fleet:" + device;
        if (via is null) return false;

        var c = _usage.GetOrAdd(ip, _ => new Counter());
        lock (c) { c.Hits++; c.LastUsed = DateTimeOffset.UtcNow; c.LastRoute = routeId; c.Via = via; }
        if (_usage.Count > 2000)
            foreach (var old in _usage.OrderBy(kv => kv.Value.LastUsed).Take(_usage.Count - 2000).ToList())
                _usage.TryRemove(old.Key, out _);
        return true;
    }

    // ── admin ────────────────────────────────────────────────────────────────

    public IReadOnlyList<IpPass> List()
    {
        lock (_lock) return _file.Passes.OrderBy(p => p.Ip, StringComparer.Ordinal).Select(Clone).ToList();
    }

    public IReadOnlyList<string> FleetRoutes()
    {
        lock (_lock) return (_file.FleetRoutes ?? DefaultFleetRoutes).ToList();
    }

    /// <summary>Since this BellBeast started: how often each IP used its pass (in memory).</summary>
    public IReadOnlyDictionary<string, Usage> UsageByIp() =>
        _usage.ToDictionary(kv => kv.Key, kv => { lock (kv.Value) return new Usage(kv.Value.Hits, kv.Value.LastUsed, kv.Value.LastRoute, kv.Value.Via); },
            StringComparer.Ordinal);

    /// <summary>Adds or replaces the pass for an IP. Returns an error code, or null.</summary>
    public string? Upsert(string? ipText, IEnumerable<string>? routes, string? note, Func<string, bool> isPageRoute, string? actor)
    {
        var ip = IpAccessService.Parse(ipText);
        if (ip is null) return "bad_ip";
        var (list, err) = CheckRoutes(routes, isPageRoute, allowEmpty: false);
        if (err is not null) return err;
        note = (note ?? "").Trim();
        if (note.Length > 200) return "note_too_long";

        var now = DateTimeOffset.UtcNow;
        lock (_lock)
        {
            var existing = _file.Passes.FirstOrDefault(p => p.Ip == ip);
            if (existing is null)
            {
                if (_file.Passes.Count >= MaxPasses) return "too_many_passes";
                _file.Passes.Add(new IpPass { Ip = ip, Routes = list!, Note = note.Length == 0 ? null : note, CreatedAt = now, CreatedBy = actor });
            }
            else
            {
                existing.Routes = list!;
                existing.Note = note.Length == 0 ? null : note;
                existing.UpdatedAt = now;
            }
            Commit();
        }
        _log.LogWarning("IP pass set: {Ip} → {Routes} by {Actor}", ip, string.Join(", ", list!), actor);
        return null;
    }

    public bool Remove(string? ipText, string? actor)
    {
        var ip = IpAccessService.Parse(ipText);
        if (ip is null) return false;
        lock (_lock)
        {
            if (_file.Passes.RemoveAll(p => p.Ip == ip) == 0) return false;
            Commit();
        }
        _log.LogWarning("IP pass removed: {Ip} by {Actor}", ip, actor);
        return true;
    }

    /// <summary>Sets the page APIs every approved fleet device may call (empty = none). Error code or null.</summary>
    public string? SetFleetRoutes(IEnumerable<string>? routes, Func<string, bool> isPageRoute, string? actor)
    {
        var (list, err) = CheckRoutes(routes, isPageRoute, allowEmpty: true);
        if (err is not null) return err;
        lock (_lock)
        {
            _file.FleetRoutes = list;
            Commit();
        }
        _log.LogWarning("Fleet IP pass routes set: {Routes} by {Actor}", list!.Count == 0 ? "(none)" : string.Join(", ", list), actor);
        return null;
    }

    private static (List<string>? List, string? Error) CheckRoutes(IEnumerable<string>? routes, Func<string, bool> isPageRoute, bool allowEmpty)
    {
        if (routes is null) return (null, "bad_routes");
        var list = routes.Select(r => (r ?? "").Trim()).Where(r => r.Length > 0).Distinct(StringComparer.Ordinal).ToList();
        if (list.Count == 0 && !allowEmpty) return (null, "no_routes");
        if (list.Count > MaxRoutesPerPass) return (null, "bad_routes");
        var bad = list.FirstOrDefault(r => !isPageRoute(r));
        return bad is null ? (list, null) : (null, "not_page_api:" + bad);
    }

    // ── persistence ──────────────────────────────────────────────────────────

    private void Commit()
    {
        Save();
        (_index, _fleetRoutes) = Index(_file);
    }

    private static (Dictionary<string, HashSet<string>>, HashSet<string>) Index(PassFile f) =>
        (f.Passes.GroupBy(p => p.Ip).ToDictionary(g => g.Key, g => g.Last().Routes.ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal),
         (f.FleetRoutes ?? DefaultFleetRoutes).ToHashSet(StringComparer.Ordinal));

    private static IpPass Clone(IpPass p) => new()
        { Ip = p.Ip, Routes = p.Routes.ToList(), Note = p.Note, CreatedAt = p.CreatedAt, CreatedBy = p.CreatedBy, UpdatedAt = p.UpdatedAt };

    private PassFile Load()
    {
        try
        {
            if (File.Exists(_path) && JsonSerializer.Deserialize<PassFile>(File.ReadAllText(_path), JsonOpts) is { } f)
            {
                f.Passes = (f.Passes ?? new()).Where(p => IpAccessService.Parse(p.Ip) is not null).ToList();
                foreach (var p in f.Passes) { p.Ip = IpAccessService.Parse(p.Ip)!; p.Routes ??= new(); }
                return f;
            }
        }
        catch (JsonException ex) { _log.LogError(ex, "ip-passes.json is invalid — no IP passes loaded"); }
        return new PassFile();
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_file, JsonOpts));
        File.Move(tmp, _path, overwrite: true);
    }
}
