using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace BellBeast.Services;

/// <summary>
/// Compact lab view for the annunciator touch screen: GET /api/device/lab/glance.
///
/// The MHxView LAB card (wwwroot/js/LABview.js) asks Uroboros /api/lab/summary once per filter,
/// reads limits from LabVenture /api/scenarios/limits and works out first/bad in the browser.
/// A device must not hold that logic, so it is done here once: same data, same rules, same colours.
///
/// Status letters: o = ok · f = over the limit once (blue) · b = over twice or more in a row (red)
///                 n = no value · '-' = no limit for this point in the active scenario.
/// </summary>
public static class LabGlance
{
    public sealed record Group(string Id, string Filter, string Name, string Unit, string FallbackKey);

    // Filter = the name Uroboros expects; Name = what the screen shows.
    public static readonly Group[] Groups =
    {
        new("cw_turbid", "CW Turbid", "CW Turbid", "NTU", "CW T"),
        new("cw_precl", "CW Pre CL", "CW Pre CL", "mg/L", "CW CL"),
        new("fw_turbid", "FW Turbid", "FW Turbid", "NTU", "FW T"),
        new("tw_turbid", "TW Turbid", "TW Turbid", "NTU", "TW T"),
        new("tw_postcl", "TW Pos CL", "TW Post CL", "mg/L", "TW CL"),
    };

    /// <summary>16 dots of the card, in its order. Each row's history comes from the zone4 group named here.</summary>
    public static readonly (string Key, string GroupId)[] StatusKeys =
    {
        ("CW1 T","cw_turbid"), ("CW2 T","cw_turbid"), ("CW3 T","cw_turbid"), ("CW4 T","cw_turbid"),
        ("CW1 CL","cw_precl"), ("CW2 CL","cw_precl"), ("CW3 CL","cw_precl"), ("CW4 CL","cw_precl"),
        ("FW1 T","fw_turbid"), ("FW2 T","fw_turbid"), ("FW3 T","fw_turbid"), ("FW4 T","fw_turbid"),
        ("TW1 CL","tw_postcl"), ("TW2 CL","tw_postcl"), ("TW3 CL","tw_postcl"), ("TW4 CL","tw_postcl"),
    };

    public sealed record Rule(double? Min, double? Max)
    {
        public bool Exceeded(double v) => (Max.HasValue && v > Max.Value) || (Min.HasValue && v < Min.Value);
    }

    /// <summary>Fallback set when LabVenture is unreachable — LABview.js getStatusRules("normal").</summary>
    public static readonly Dictionary<string, Rule> FallbackRules = new()
    {
        ["CW T"] = new(null, 5),
        ["CW CL"] = new(null, 0.3),
        ["FW T"] = new(null, 1),
        ["TW T"] = new(null, 1),
        ["TW CL"] = new(1.0, 1.4),
    };

    /// <summary>Times a row was over its limit in a row at the end (empty rounds don't break it) — LABview.js streakOf.</summary>
    public static int StreakOf(IEnumerable<double?> values, Rule rule)
    {
        var streak = 0;
        foreach (var v in values)
        {
            if (v is null || !double.IsFinite(v.Value)) continue;
            streak = rule.Exceeded(v.Value) ? streak + 1 : 0;
        }
        return streak;
    }

    public static char StreakLetter(int streak) => streak >= 2 ? 'b' : streak == 1 ? 'f' : 'o';

    public sealed record Limits(string? ScenarioName, bool Epidemic, Dictionary<int, Rule?> ByCfg)
    {
        public Dictionary<int, string> KeyByCfg { get; init; } = new();
        public int? ScenarioId { get; init; }
    }

    public static Limits? ParseLimits(JsonElement? json)
    {
        if (json is not { ValueKind: JsonValueKind.Object } j) return null;
        var by = new Dictionary<int, Rule?>();
        var keys = new Dictionary<int, string>();
        if (j.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            foreach (var it in items.EnumerateArray())
            {
                var cfg = Num(it, "configparam_id");
                if (cfg is null) continue;
                if (it.TryGetProperty("param_key", out var pk) && pk.ValueKind == JsonValueKind.String) keys[(int)cfg.Value] = pk.GetString()!;
                var lo = Num(it, "lcl");
                var hi = Num(it, "ucl");
                by[(int)cfg.Value] = lo is null && hi is null ? null : new Rule(lo, hi);
            }
        }
        string? name = null;
        int? sid = null;
        if (j.TryGetProperty("scenario", out var sc) && sc.ValueKind == JsonValueKind.Object)
        {
            if (sc.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String) name = n.GetString();
            var idn = Num(sc, "id"); if (idn is not null) sid = (int)idn.Value;
        }
        var epi = j.TryGetProperty("epidemic", out var e) && e.ValueKind == JsonValueKind.True;
        return new Limits(name, epi, by) { KeyByCfg = keys, ScenarioId = sid };
    }

    /// <summary>Latest threshold period from LabVenture: a new one opens on every scenario / threshold / epidemic change.</summary>
    public sealed record Period(int Rev, string? Since, bool Test);

    public static Period? ParsePeriod(JsonElement? log)
    {
        if (log is not { } l) return null;
        var first = l.ValueKind == JsonValueKind.Array ? (l.GetArrayLength() > 0 ? l[0] : default) : l;
        if (first.ValueKind != JsonValueKind.Object) return null;
        var id = Num(first, "id");
        if (id is null) return null;
        string? since = first.TryGetProperty("started_at", out var st) && st.ValueKind == JsonValueKind.String ? st.GetString() : null;
        var test = first.TryGetProperty("is_test", out var t) && (t.ValueKind == JsonValueKind.True || (t.ValueKind == JsonValueKind.Number && t.GetDouble() != 0));
        return new Period((int)id.Value, since, test);
    }

    /// <summary>param_keys the epidemic overlay replaces (LabVenture /api/scenarios/epidemic/thresholds).</summary>
    public static HashSet<string> ParseEpidemicKeys(JsonElement? json)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (json is { ValueKind: JsonValueKind.Object } j && j.TryGetProperty("thresholds", out var arr) && arr.ValueKind == JsonValueKind.Array)
            foreach (var it in arr.EnumerateArray())
                if (it.TryGetProperty("param_key", out var k) && k.ValueKind == JsonValueKind.String) set.Add(k.GetString()!);
        return set;
    }

    /// <summary>null = this point has no limit in the active scenario (only possible when limits came from LabVenture).</summary>
    public static Rule? RuleFor(int? cfg, string fallbackKey, Limits? limits)
    {
        if (limits is null) return FallbackRules.GetValueOrDefault(fallbackKey);
        return cfg is int c && limits.ByCfg.TryGetValue(c, out var r) ? r : null;
    }

    public sealed record Series(int? Cfg, List<string> Ts, List<double?> Values);

    public static List<Series> ParseSeries(JsonElement? zone4)
    {
        var list = new List<Series>();
        if (zone4 is not { ValueKind: JsonValueKind.Object } z || !z.TryGetProperty("series", out var arr)
            || arr.ValueKind != JsonValueKind.Array) return list;
        foreach (var s in arr.EnumerateArray())
        {
            var ts = new List<string>();
            var vs = new List<double?>();
            if (s.TryGetProperty("points", out var pts) && pts.ValueKind == JsonValueKind.Array)
            {
                foreach (var p in pts.EnumerateArray())
                {
                    if (p.ValueKind != JsonValueKind.Array || p.GetArrayLength() < 2) continue;
                    ts.Add(p[0].ValueKind == JsonValueKind.String ? p[0].GetString() ?? "" : p[0].ToString());
                    vs.Add(AsNum(p[1]));
                }
            }
            var cfg = Num(s, "configparam_id");
            list.Add(new Series(cfg is null ? null : (int)cfg.Value, ts, vs));
        }
        return list;
    }

    /// <summary>
    /// zone4ByGroup: group id → that group's zone4 object from Uroboros (missing = the call failed).
    /// zone3Items: zone3.items from any successful call (latest value per dot).
    /// limits: LabVenture /api/scenarios/limits (null = unreachable → fallback rules).
    /// </summary>
    public static object Build(IReadOnlyDictionary<string, JsonElement> zone4ByGroup, JsonElement? zone3Items,
        JsonElement? limitsJson, DateTimeOffset now, JsonElement? epidemicJson = null, JsonElement? logJson = null)
    {
        var limits = ParseLimits(limitsJson);
        var period = limits is null ? null : ParsePeriod(logJson);
        var epiKeys = ParseEpidemicKeys(epidemicJson);
        var seriesByGroup = Groups.ToDictionary(g => g.Id,
            g => zone4ByGroup.TryGetValue(g.Id, out var z) ? ParseSeries(z) : null);

        string latestTs = "";
        var groups = new List<object>();
        foreach (var g in Groups)
        {
            var series = seriesByGroup[g.Id];
            var units = new List<object>();
            for (var i = 0; i < 4; i++)
            {
                var s = series is not null && i < series.Count ? series[i] : null;
                var vals = s?.Values ?? new List<double?>();
                var rule = RuleFor(s?.Cfg, g.FallbackKey, limits);
                char st;
                if (!vals.Any(v => v.HasValue)) st = 'n';                         // LABview classifyZone4: no value → "–"
                else if (rule is null) st = '-';
                else st = StreakLetter(StreakOf(vals, rule));
                var last = vals.LastOrDefault(v => v.HasValue);
                foreach (var t in s?.Ts ?? new List<string>())
                    if (string.CompareOrdinal(t, latestTs) > 0) latestTs = t;
                units.Add(new
                {
                    n = i + 1,
                    s = st.ToString(),
                    last = last.HasValue ? Math.Round(last.Value, 3) : (double?)null,
                    lcl = rule?.Min,
                    ucl = rule?.Max,
                    t = (s?.Ts ?? new List<string>()).Select(Hour).ToList(),
                    v = vals.Select(v => v.HasValue ? Math.Round(v.Value, 3) : (double?)null).ToList(),
                });
            }
            groups.Add(new { id = g.Id, name = g.Name, unit = g.Unit, ok = series is not null, units });
        }

        // 16 dots — LABview.js classifyStatusItem: latest value from zone3, streak from that group's zone4 history
        var z3 = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
        if (zone3Items is { ValueKind: JsonValueKind.Array } items)
            foreach (var it in items.EnumerateArray())
                if (it.TryGetProperty("key", out var k) && k.ValueKind == JsonValueKind.String)
                    z3[k.GetString()!.Trim()] = it;

        var status = new StringBuilder(16);
        var dots = new List<object>(16);
        foreach (var (key, groupId) in StatusKeys)
        {
            var g = Groups.First(x => x.Id == groupId);
            var unitIdx = key[2] - '1';
            char s = 'n';
            double? value = null;
            Rule? rule = null;
            string? ts = null;
            bool epi = false;
            if (z3.TryGetValue(key, out var item))
            {
                value = Num(item, "value_real") ?? (item.TryGetProperty("value_text", out var vt) && vt.ValueKind == JsonValueKind.String
                    && double.TryParse(vt.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null);
                if (item.TryGetProperty("ts_local", out var tl) && tl.ValueKind == JsonValueKind.String) ts = tl.GetString();
                var cfgN = Num(item, "configparam_id");
                int? cfg = cfgN is null ? null : (int)cfgN.Value;
                rule = RuleFor(cfg, g.FallbackKey, limits);
                epi = limits is { Epidemic: true } && cfg is int c && limits.KeyByCfg.TryGetValue(c, out var pk) && epiKeys.Contains(pk);
                if (value is not null)
                {
                    if (rule is null) s = limits is null ? 'n' : '-';
                    else
                    {
                        var hist = seriesByGroup[groupId] is { } ss && unitIdx < ss.Count ? ss[unitIdx].Values : null;
                        var streak = hist is not null && hist.Any(v => v.HasValue) ? StreakOf(hist, rule) : (rule.Exceeded(value.Value) ? 1 : 0);
                        s = StreakLetter(streak);
                    }
                }
            }
            status.Append(s);
            dots.Add(new
            {
                k = key,
                v = value.HasValue ? Math.Round(value.Value, 3) : (double?)null,
                s = s.ToString(),
                lcl = rule?.Min,
                ucl = rule?.Max,
                epi,
                ts,
            });
        }

        return new
        {
            ok = seriesByGroup.Values.Any(v => v is not null),
            updated_at = now.ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture),
            hm = latestTs.Length >= 16 ? latestTs.Substring(11, 5) : "",
            sample = latestTs,
            limits = limits is null ? "fallback" : "scenario",
            scenario = limits?.ScenarioName ?? "",
            scenario_id = limits?.ScenarioId,
            scenario_rev = period?.Rev ?? 0,
            scenario_since = period?.Since,
            scenario_test = period?.Test ?? false,
            epidemic = limits?.Epidemic ?? false,
            status = status.ToString(),
            dots,
            groups,
        };
    }

    private static string Hour(string ts) => ts.Length >= 13 ? ts.Substring(11, 2) : ts;

    private static double? Num(JsonElement obj, string name)
        => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) ? AsNum(v) : null;

    private static double? AsNum(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.Number => v.GetDouble(),
        JsonValueKind.String when double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
        _ => null,
    };
}

/// <summary>Fetches the 5 groups from Uroboros + limits from LabVenture and caches the result for 60 s (many devices, one upstream call).</summary>
public sealed class LabGlanceService
{
    public static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(60);
    // Thai stays as UTF-8 (the device parser does not decode escaped unicode)
    private static readonly JsonSerializerOptions JsonOut = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private readonly IHttpClientFactory _factory;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private (DateTimeOffset at, string json)? _cache;
    private int _cacheRev = -1;                                  // scenario_rev the cached glance was built with
    private (DateTimeOffset at, string json, int rev)? _scnCache;
    public static readonly TimeSpan ScenarioCacheFor = TimeSpan.FromSeconds(10);

    public LabGlanceService(IHttpClientFactory factory) => _factory = factory;

    /// <summary>Tests share one server instance — start each endpoint test from an empty cache.</summary>
    public void ResetCache() { _cache = null; _scnCache = null; _cacheRev = -1; }

    /// <summary>Returns the glance JSON (ok:false when Uroboros answered none of the 5 calls).</summary>
    private static async Task<JsonElement?> GetJson(HttpClient http, string url, CancellationToken ct)
    {
        try
        {
            using var r = await http.GetAsync(url, ct);
            if (!r.IsSuccessStatusCode) return null;
            using var d = JsonDocument.Parse(await r.Content.ReadAsStringAsync(ct));
            return d.RootElement.Clone();
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException) { return null; }
    }

    /// <summary>
    /// Small "what scenario is active" answer for the device's 30 s loop (GET /api/device/lab/scenario).
    /// When the revision differs from the one the cached glance was built with, the glance cache is dropped
    /// so the device's follow-up glance gets the new limits at once.
    /// </summary>
    public async Task<string> GetScenarioJsonAsync(string labVentureBase, CancellationToken ct)
    {
        var now = DateTimeOffset.Now;
        if (_scnCache is { } c && now - c.at < ScenarioCacheFor) return c.json;
        var http = _factory.CreateClient();
        http.Timeout = TimeSpan.FromSeconds(10);
        var limitsTask = GetJson(http, $"{labVentureBase}/api/scenarios/limits", ct);
        var logTask = GetJson(http, $"{labVentureBase}/api/scenarios/log?limit=1", ct);
        var limits = LabGlance.ParseLimits(await limitsTask);
        var period = LabGlance.ParsePeriod(await logTask);
        string json;
        int rev = period?.Rev ?? 0;
        if (limits is null)
            json = JsonSerializer.Serialize(new { ok = false, error = "labventure_unreachable" }, JsonOut);
        else
        {
            json = JsonSerializer.Serialize(new
            {
                ok = true, rev, id = limits.ScenarioId, name = limits.ScenarioName ?? "", epidemic = limits.Epidemic,
                since = period?.Since, test = period?.Test ?? false,
            }, JsonOut);
            if (_cacheRev >= 0 && rev != _cacheRev) _cache = null;   // limits changed -> next glance recomputes
        }
        _scnCache = (DateTimeOffset.Now, json, rev);
        return json;
    }

    public async Task<string> GetJsonAsync(string labSummaryUrl, string labVentureLimitsUrl, CancellationToken ct)
    {
        var now = DateTimeOffset.Now;
        if (_cache is { } c && now - c.at < CacheFor) return c.json;
        await _gate.WaitAsync(ct);
        try
        {
            if (_cache is { } c2 && DateTimeOffset.Now - c2.at < CacheFor) return c2.json;
            var http = _factory.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(60);

            var groupTasks = LabGlance.Groups.Select(async g =>
            {
                try
                {
                    var body = JsonSerializer.Serialize(new { rwZone = new { option = "TURBIDITY", fix = "TEMPERATURE" }, zone4 = new { filter = g.Filter } });
                    using var resp = await http.PostAsync(labSummaryUrl, new StringContent(body, Encoding.UTF8, "application/json"), ct);
                    if (!resp.IsSuccessStatusCode) return (g.Id, (JsonElement?)null);
                    using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
                    return (g.Id, (JsonElement?)(doc.RootElement.TryGetProperty("data", out var d) ? d.Clone() : (JsonElement?)null));
                }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
                {
                    return (g.Id, (JsonElement?)null);
                }
            }).ToList();

            // LabVenture: limits + epidemic overlay keys + latest threshold period (all small, local)
            var lvBase = labVentureLimitsUrl.EndsWith("/api/scenarios/limits", StringComparison.Ordinal)
                ? labVentureLimitsUrl[..^"/api/scenarios/limits".Length] : labVentureLimitsUrl;
            var limitsTask = GetJson(http, labVentureLimitsUrl, ct);
            var epiTask = GetJson(http, $"{lvBase}/api/scenarios/epidemic/thresholds", ct);
            var logTask = GetJson(http, $"{lvBase}/api/scenarios/log?limit=1", ct);
            JsonElement? limits = await limitsTask;
            if (limits is { ValueKind: not JsonValueKind.Object }) limits = null;
            var epidemic = await epiTask;
            var log = await logTask;

            var results = await Task.WhenAll(groupTasks);
            var zone4 = new Dictionary<string, JsonElement>();
            JsonElement? zone3 = null;
            foreach (var (id, data) in results)
            {
                if (data is not { } d) continue;
                if (d.TryGetProperty("zone4", out var z4)) zone4[id] = z4;
                if (zone3 is null && d.TryGetProperty("zone3", out var z3) && z3.TryGetProperty("items", out var its)) zone3 = its;
            }

            var json = JsonSerializer.Serialize(LabGlance.Build(zone4, zone3, limits, DateTimeOffset.Now, epidemic, log), JsonOut);
            _cacheRev = LabGlance.ParsePeriod(log)?.Rev ?? 0;
            // keep a failure only briefly so a device retry soon gets fresh data
            _cache = (zone4.Count > 0 ? DateTimeOffset.Now : DateTimeOffset.Now - CacheFor + TimeSpan.FromSeconds(10), json);
            return json;
        }
        finally { _gate.Release(); }
    }
}
