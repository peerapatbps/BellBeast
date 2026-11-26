using System.Text.Json;

namespace BellBeast.Services;

/// <summary>Upstream (Uroboros) base URL + per-feature paths from App_Data/backend-config.json.</summary>
public sealed record BackendConfig(
    string BaseUrl,
    string QueryCsvPath,
    string DailyReportPath,
    string ChemReportPath,
    string ChemExportPath,
    string DpsSummaryPath,
    string TpsSummaryPath,
    string RwsSummaryPath,
    string ChemSummaryPath,
    string EventSummaryPath,
    string LabSummaryPath,
    string ClDetectorPath,
    string WayfarerApiPath,
    string CbApiPath = BackendConfigProvider.DefaultCbApiPath);

/// <summary>
/// Reads App_Data/backend-config.json and caches it until the file changes (mtime/size),
/// so edits still apply without a restart but requests no longer re-parse the file each time.
/// Missing file / empty or invalid backendBaseUrl throw, as before.
/// </summary>
public sealed class BackendConfigProvider
{
    /// <summary>Uroboros connector box API root (events, cases, monitor, registry), proxied by Endpoints/CbEndpoints.cs.</summary>
    public const string DefaultCbApiPath = "/api/cb";

    private readonly string _path;
    private (DateTime Mtime, long Size, BackendConfig Cfg)? _cache;

    public BackendConfigProvider(IWebHostEnvironment env)
        => _path = Path.Combine(env.ContentRootPath, "App_Data", "backend-config.json");

    public BackendConfig Current
    {
        get
        {
            var fi = new FileInfo(_path);
            if (!fi.Exists)
                throw new FileNotFoundException($"backend-config.json not found: {_path}");

            var cached = _cache;
            if (cached is { } c && c.Mtime == fi.LastWriteTimeUtc && c.Size == fi.Length)
                return c.Cfg;

            var cfg = Parse(File.ReadAllText(_path));
            _cache = (fi.LastWriteTimeUtc, fi.Length, cfg);
            return cfg;
        }
    }

    public static BackendConfig Parse(string jsonText)
    {
        using var doc = JsonDocument.Parse(jsonText, new JsonDocumentOptions
        {
            AllowTrailingCommas = true,
            CommentHandling = JsonCommentHandling.Skip
        });

        string GetStr(string name)
            => doc.RootElement.TryGetProperty(name, out var el) ? (el.GetString() ?? "").Trim() : "";

        var baseUrl = GetStr("backendBaseUrl").TrimEnd('/');
        if (string.IsNullOrWhiteSpace(baseUrl))
            throw new InvalidOperationException("backendBaseUrl is empty");
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out _))
            throw new InvalidOperationException($"backendBaseUrl invalid: {baseUrl}");

        string NormPath(string? p, string fallback)
        {
            p = (p ?? "").Trim();
            if (string.IsNullOrWhiteSpace(p)) p = fallback;
            if (!p.StartsWith("/")) p = "/" + p;
            return p;
        }

        return new BackendConfig(
            BaseUrl: baseUrl,
            QueryCsvPath: NormPath(GetStr("queryCsvPath"), "/api/process"),
            DailyReportPath: NormPath(GetStr("dailyReportPath"), "/api/dailyreport"),
            ChemReportPath: NormPath(GetStr("chemReportPath"), "/api/chem_report"),
            ChemExportPath: NormPath(GetStr("chemExportPath"), "/api/chem_report/export"),
            DpsSummaryPath: NormPath(GetStr("dpsSummaryPath"), SummaryProxyService.DefaultDpsPath),
            TpsSummaryPath: NormPath(GetStr("tpsSummaryPath"), SummaryProxyService.DefaultTpsPath),
            RwsSummaryPath: NormPath(GetStr("rwsSummaryPath"), SummaryProxyService.DefaultRwsPath),
            ChemSummaryPath: NormPath(GetStr("chemSummaryPath"), SummaryProxyService.DefaultChemPath),
            EventSummaryPath: NormPath(GetStr("eventSummaryPath"), SummaryProxyService.DefaultEventPath),
            LabSummaryPath: NormPath(GetStr("labSummaryPath"), SummaryProxyService.DefaultLabPath),
            ClDetectorPath: NormPath(GetStr("cldetectorPath"), SummaryProxyService.DefaultClDetectorPath),
            WayfarerApiPath: NormPath(GetStr("wayfarerApiPath"), "/api/wayfarer"),
            CbApiPath: NormPath(GetStr("cbApiPath"), DefaultCbApiPath).TrimEnd('/'));
    }
}
