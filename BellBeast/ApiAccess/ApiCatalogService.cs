using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;

namespace BellBeast.ApiAccess;

/// <summary>One /api endpoint as the admin sees it.</summary>
public sealed record ApiEntry(
    string Id,        // "GET /api/dps/summary" — methods + route template, stable across restarts
    string Methods,
    string Route,
    string Area,      // second path segment: /api/{area}/...
    string Access,    // public | user | admin
    bool Enabled,
    bool Locked,      // cannot be disabled (would lock the admin out of this page)
    string? Note,
    DateTimeOffset? ChangedAt);

/// <summary>
/// Catalog of every /api endpoint, built from the routing table, plus admin overrides
/// (enable/disable + note) persisted in App_Data/api-catalog.json.
/// IDs are derived from method + route template, so new endpoints appear automatically.
/// </summary>
public sealed class ApiCatalogService
{
    public const string AccessPublic = "public", AccessUser = "user", AccessAdmin = "admin";

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly EndpointDataSource _endpoints;
    private readonly ILogger<ApiCatalogService> _log;
    private readonly string _path;
    private readonly object _lock = new();
    private CatalogFile _file;
    private volatile HashSet<string> _disabled;

    public ApiCatalogService(EndpointDataSource endpoints, IWebHostEnvironment env, ILogger<ApiCatalogService> log)
    {
        _endpoints = endpoints;
        _log = log;
        _path = Path.Combine(env.ContentRootPath, "App_Data", "api-catalog.json");
        _file = Load();
        _disabled = DisabledSet(_file);
    }

    // ── identity of an endpoint ─────────────────────────────────────────────

    /// <summary>Catalog id for an /api endpoint, or null for pages / non-API routes.</summary>
    public static string? IdOf(Endpoint? endpoint)
    {
        if (endpoint is not RouteEndpoint re) return null;
        var route = re.RoutePattern.RawText;
        if (route is null || !route.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)) return null;
        return $"{MethodsOf(re)} {route}";
    }

    public static string AccessOf(Endpoint endpoint)
    {
        if (endpoint.Metadata.GetMetadata<IAllowAnonymous>() is not null) return AccessPublic;
        return endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Any(a => a.Policy == "AdminOnly")
            ? AccessAdmin : AccessUser;
    }

    private static string MethodsOf(RouteEndpoint re)
    {
        var m = re.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods;
        return m is { Count: > 0 } ? string.Join(",", m) : "ANY";
    }

    private static bool IsLocked(string route) =>
        route.StartsWith("/api/admin/api/", StringComparison.OrdinalIgnoreCase) ||
        route.StartsWith("/api/admin/auth/", StringComparison.OrdinalIgnoreCase);

    // ── queries ──────────────────────────────────────────────────────────────

    public bool IsEnabled(string id) => !_disabled.Contains(id);

    public IReadOnlyList<ApiEntry> List()
    {
        Dictionary<string, Override> overrides;
        lock (_lock) overrides = new(_file.Apis, StringComparer.Ordinal);

        return _endpoints.Endpoints.OfType<RouteEndpoint>()
            .Select(e => (e, id: IdOf(e)))
            .Where(x => x.id is not null)
            .GroupBy(x => x.id!, StringComparer.Ordinal)
            .Select(g =>
            {
                var e = g.First().e;
                var route = e.RoutePattern.RawText!;
                var segs = route.Split('/', StringSplitOptions.RemoveEmptyEntries);
                overrides.TryGetValue(g.Key, out var o);
                return new ApiEntry(g.Key, MethodsOf(e), route, segs.Length > 1 ? segs[1] : "",
                    AccessOf(e), o?.Enabled ?? true, IsLocked(route), o?.Note, o?.ChangedAt);
            })
            .OrderBy(a => a.Route, StringComparer.Ordinal).ThenBy(a => a.Methods, StringComparer.Ordinal)
            .ToList();
    }

    public ApiEntry? Find(string id) => List().FirstOrDefault(a => a.Id == id);

    // ── admin changes ────────────────────────────────────────────────────────

    /// <summary>Returns an error code, or null on success.</summary>
    public string? Set(string id, bool? enabled, string? note, string? actor)
    {
        var entry = Find(id);
        if (entry is null) return "unknown_api";
        if (enabled == false && entry.Locked) return "api_locked";
        if (note is { Length: > 200 }) return "note_too_long";

        lock (_lock)
        {
            _file.Apis.TryGetValue(id, out var o);
            o ??= new Override();
            if (enabled is bool en) o.Enabled = en;
            if (note is not null) o.Note = note.Trim().Length == 0 ? null : note.Trim();
            o.ChangedAt = DateTimeOffset.UtcNow;
            o.ChangedBy = actor;

            if (o.Enabled && o.Note is null) _file.Apis.Remove(id);
            else _file.Apis[id] = o;

            Save();
            _disabled = DisabledSet(_file);
        }

        _log.LogInformation("API catalog: {Id} enabled={Enabled} by {Actor}", id, enabled, actor);
        return null;
    }

    // ── persistence ──────────────────────────────────────────────────────────

    private sealed class CatalogFile
    {
        public Dictionary<string, Override> Apis { get; set; } = new(StringComparer.Ordinal);
    }

    private sealed class Override
    {
        public bool Enabled { get; set; } = true;
        public string? Note { get; set; }
        public DateTimeOffset? ChangedAt { get; set; }
        public string? ChangedBy { get; set; }
    }

    private static HashSet<string> DisabledSet(CatalogFile f) =>
        f.Apis.Where(kv => !kv.Value.Enabled).Select(kv => kv.Key).ToHashSet(StringComparer.Ordinal);

    private CatalogFile Load()
    {
        try
        {
            if (File.Exists(_path) &&
                JsonSerializer.Deserialize<CatalogFile>(File.ReadAllText(_path), JsonOpts) is { } f)
            {
                f.Apis = new Dictionary<string, Override>(f.Apis ?? new(), StringComparer.Ordinal);
                return f;
            }
        }
        catch (JsonException ex) { _log.LogError(ex, "api-catalog.json is invalid — starting with every API enabled"); }
        return new CatalogFile();
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_file, JsonOpts));
        File.Move(tmp, _path, overwrite: true);
    }
}
