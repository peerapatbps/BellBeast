using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using BellBeast.Services;

namespace BellBeast.ApiAccess;

/// <summary>
/// Admin-defined datasets for the public /api/v1: each one picks Uroboros realtime metrics
/// (stream + param) and publishes them under stable field names. Clients see field names,
/// never the plant tag names, so tags can be remapped without breaking anyone.
/// Persisted in App_Data/api-datasets.json.
/// </summary>
public sealed partial class DatasetService
{
    public const int MaxFields = 40;
    public const int MaxHistoryLimit = 1440;     // 1 day at Uroboros' 60 s interval

    public sealed class DatasetField
    {
        public string Name { get; set; } = "";   // published name, e.g. "raw_water_flow"
        public string Stream { get; set; } = "";
        public string Param { get; set; } = "";
        public string? Unit { get; set; }
        public string? Label { get; set; }
    }

    public sealed class Dataset
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public string? Description { get; set; }
        public bool Enabled { get; set; } = true;
        public int MaxHistory { get; set; } = 60;
        public int Version { get; set; } = 1;     // bumped whenever the field list changes
        public List<DatasetField> Fields { get; set; } = new();
        public DateTimeOffset UpdatedAt { get; set; }
        public string? UpdatedBy { get; set; }
    }

    public static string GrantId(string datasetId) => "dataset:" + datasetId;

    [GeneratedRegex("^[a-z0-9][a-z0-9-]{1,39}$")] private static partial Regex IdRx();
    [GeneratedRegex("^[a-z][a-z0-9_]{0,39}$")] private static partial Regex FieldRx();

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _path;
    private readonly ILogger<DatasetService> _log;
    private readonly object _lock = new();
    private List<Dataset> _sets;

    public DatasetService(IWebHostEnvironment env, ILogger<DatasetService> log)
    {
        _log = log;
        _path = Path.Combine(env.ContentRootPath, "App_Data", "api-datasets.json");
        _sets = Load();
    }

    public IReadOnlyList<Dataset> List()
    {
        lock (_lock) return _sets.OrderBy(d => d.Id, StringComparer.Ordinal).Select(Clone).ToList();
    }

    public Dataset? Get(string id)
    {
        lock (_lock) return _sets.FirstOrDefault(d => d.Id == id) is { } d ? Clone(d) : null;
    }

    /// <summary>Create or replace a dataset. <paramref name="knownMetrics"/> = "STREAM.param" set from the Uroboros schema.</summary>
    public (Dataset? Saved, string? Error) Save(JsonElement b, ISet<string> knownMetrics, string? actor)
    {
        if (b.ValueKind != JsonValueKind.Object) return (null, "bad_json");
        string Str(string n) => b.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()!.Trim() : "";

        var id = Str("id");
        if (!IdRx().IsMatch(id)) return (null, "bad_id");
        var title = Str("title");
        if (title.Length is 0 or > 80) return (null, "bad_title");
        var desc = Str("description");
        if (desc.Length > 500) return (null, "description_too_long");

        var maxHistory = 60;
        if (b.TryGetProperty("max_history", out var mh) && (!mh.TryGetInt32(out maxHistory) || maxHistory < 1 || maxHistory > MaxHistoryLimit))
            return (null, "bad_max_history");

        var enabled = !b.TryGetProperty("enabled", out var en) || en.ValueKind != JsonValueKind.False;

        if (!b.TryGetProperty("fields", out var fe) || fe.ValueKind != JsonValueKind.Array) return (null, "bad_fields");
        var fields = new List<DatasetField>();
        foreach (var f in fe.EnumerateArray())
        {
            if (f.ValueKind != JsonValueKind.Object) return (null, "bad_fields");
            string F(string n) => f.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()!.Trim() : "";
            var field = new DatasetField
            {
                Name = F("name"), Stream = F("stream"), Param = F("param"),
                Unit = F("unit") is { Length: > 0 } u ? u : null, Label = F("label") is { Length: > 0 } l ? l : null,
            };
            if (!FieldRx().IsMatch(field.Name)) return (null, "bad_field_name:" + field.Name);
            if (fields.Any(x => x.Name == field.Name)) return (null, "duplicate_field:" + field.Name);
            if (!knownMetrics.Contains(field.Stream + "." + field.Param)) return (null, "unknown_metric:" + field.Stream + "." + field.Param);
            if ((field.Unit?.Length ?? 0) > 20 || (field.Label?.Length ?? 0) > 80) return (null, "bad_field_text:" + field.Name);
            fields.Add(field);
        }
        if (fields.Count is 0 or > MaxFields) return (null, "bad_field_count");

        Dataset saved;
        lock (_lock)
        {
            var old = _sets.FirstOrDefault(d => d.Id == id);
            var shape = (Dataset d) => string.Join("|", d.Fields.Select(x => $"{x.Name}={x.Stream}.{x.Param}"));
            saved = new Dataset
            {
                Id = id, Title = title, Description = desc.Length == 0 ? null : desc, Enabled = enabled,
                MaxHistory = maxHistory, Fields = fields, UpdatedAt = DateTimeOffset.UtcNow, UpdatedBy = actor,
            };
            saved.Version = old is null ? 1 : shape(old) == shape(saved) ? old.Version : old.Version + 1;
            if (old is not null) _sets.Remove(old);
            _sets.Add(saved);
            Save();
        }
        _log.LogInformation("Dataset saved: {Id} v{Version} ({Count} fields) by {Actor}", id, saved.Version, fields.Count, actor);
        return (Clone(saved), null);
    }

    public bool Delete(string id, string? actor)
    {
        lock (_lock)
        {
            if (_sets.RemoveAll(d => d.Id == id) == 0) return false;
            Save();
        }
        _log.LogInformation("Dataset deleted: {Id} by {Actor}", id, actor);
        return true;
    }

    private static Dataset Clone(Dataset d) => new()
    {
        Id = d.Id, Title = d.Title, Description = d.Description, Enabled = d.Enabled, MaxHistory = d.MaxHistory,
        Version = d.Version, UpdatedAt = d.UpdatedAt, UpdatedBy = d.UpdatedBy,
        Fields = d.Fields.Select(f => new DatasetField { Name = f.Name, Stream = f.Stream, Param = f.Param, Unit = f.Unit, Label = f.Label }).ToList(),
    };

    private List<Dataset> Load()
    {
        try
        {
            if (File.Exists(_path) && JsonSerializer.Deserialize<List<Dataset>>(File.ReadAllText(_path), JsonOpts) is { } list)
                return list;
        }
        catch (JsonException ex) { _log.LogError(ex, "api-datasets.json is invalid — no datasets loaded"); }
        return new List<Dataset>();
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_sets, JsonOpts));
        File.Move(tmp, _path, overwrite: true);
    }
}

/// <summary>
/// Reads Uroboros' metric endpoints (/api/metrics/schema, /api/metrics/history).
/// Uroboros timestamps are plant-local without an offset; they are published as ISO 8601
/// with Uroboros:UtcOffset (default +07:00).
/// </summary>
public sealed class UroborosMetricsClient
{
    public sealed record Point(string Ts, double? Value);

    private static readonly TimeSpan SchemaTtl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan LatestTtl = TimeSpan.FromSeconds(15);

    private readonly IHttpClientFactory _http;
    private readonly BackendConfigProvider _backend;
    private readonly TimeSpan _offset;
    private (DateTimeOffset At, HashSet<string> Metrics, JsonElement Raw)? _schema;
    private readonly Dictionary<string, (DateTimeOffset At, Point? P)> _latest = new(StringComparer.Ordinal);

    public UroborosMetricsClient(IHttpClientFactory http, BackendConfigProvider backend, IConfiguration cfg)
    {
        _http = http;
        _backend = backend;
        _offset = TimeSpan.TryParse((cfg["Uroboros:UtcOffset"] ?? "+07:00").TrimStart('+'), CultureInfo.InvariantCulture, out var o) ? o : TimeSpan.FromHours(7);
    }

    private HttpClient Client()
    {
        var c = _http.CreateClient();
        c.Timeout = TimeSpan.FromSeconds(10);
        return c;
    }

    /// <summary>Realtime metrics Uroboros knows, as "STREAM.param" plus the raw realtime list for the admin picker.</summary>
    public async Task<(HashSet<string> Metrics, JsonElement Realtime)> SchemaAsync(CancellationToken ct, bool refresh = false)
    {
        if (!refresh && _schema is { } s && DateTimeOffset.UtcNow - s.At < SchemaTtl) return (s.Metrics, s.Raw);

        using var doc = JsonDocument.Parse(await Client().GetStringAsync($"{_backend.Current.BaseUrl}/api/metrics/schema", ct));
        var realtime = doc.RootElement.TryGetProperty("realtime", out var rt) && rt.ValueKind == JsonValueKind.Array ? rt.Clone() : JsonDocument.Parse("[]").RootElement;
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var m in realtime.EnumerateArray())
            if (m.TryGetProperty("stream", out var st) && m.TryGetProperty("param", out var pa))
                set.Add(st.GetString() + "." + pa.GetString());
        _schema = (DateTimeOffset.UtcNow, set, realtime);
        return (set, realtime);
    }

    public async Task<IReadOnlyList<Point>> HistoryAsync(string stream, string param, int n, CancellationToken ct)
    {
        var url = $"{_backend.Current.BaseUrl}/api/metrics/history?stream={Uri.EscapeDataString(stream)}&param={Uri.EscapeDataString(param)}&n={n}";
        using var doc = JsonDocument.Parse(await Client().GetStringAsync(url, ct));
        if (!doc.RootElement.TryGetProperty("points", out var pts) || pts.ValueKind != JsonValueKind.Array) return Array.Empty<Point>();
        return pts.EnumerateArray().Select(p => new Point(
            Iso(p.TryGetProperty("ts", out var t) ? t.GetString() : null),
            p.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null)).ToList();
    }

    public async Task<Point?> LatestAsync(string stream, string param, CancellationToken ct)
    {
        var key = stream + "." + param;
        lock (_latest)
            if (_latest.TryGetValue(key, out var c) && DateTimeOffset.UtcNow - c.At < LatestTtl) return c.P;
        var p = (await HistoryAsync(stream, param, 1, ct)).LastOrDefault();
        lock (_latest) _latest[key] = (DateTimeOffset.UtcNow, p);
        return p;
    }

    private string Iso(string? local) =>
        DateTime.TryParseExact(local, "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var dt)
            ? new DateTimeOffset(dt, _offset).ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture)
            : local ?? "";
}
