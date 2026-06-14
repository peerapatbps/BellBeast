/// <summary>
/// Thin HTTP proxy for the 7 MHxViewer summary endpoints.
/// Each card on the dashboard calls one of these to forward the request to Uroboros.
/// Keeping the default target paths as public constants lets the self-test suite
/// verify them without spinning up the full ASP.NET pipeline.
/// </summary>
public sealed class SummaryProxyService
{
    // ── Default Uroboros-side paths ───────────────────────────────────────────
    // These are the fallback values used when the key is absent from backend-config.json.
    // Program.cs references these constants so that the tests and the runtime always agree.

    public const string DefaultDpsPath        = "/api/dps/summary";
    public const string DefaultTpsPath        = "/api/tps/summary";
    public const string DefaultRwsPath        = "/api/rps/summary";   // BellBeast route: /rws, Uroboros: /rps
    public const string DefaultChemPath       = "/api/chem/summary";
    public const string DefaultEventPath      = "/api/event/summary";
    public const string DefaultLabPath        = "/api/lab/summary";
    public const string DefaultClDetectorPath = "/api/cldetector/summary";

    // ── HTTP client ───────────────────────────────────────────────────────────

    private readonly HttpClient _http;

    public SummaryProxyService(IHttpClientFactory factory)
    {
        _http = factory.CreateClient();
        _http.Timeout = TimeSpan.FromSeconds(30);
    }

    // ── Proxy methods ─────────────────────────────────────────────────────────
    // Each method receives the fully-qualified Uroboros URL (base + path),
    // already resolved from config by the calling Minimal API handler.

    public Task<HttpResponseMessage> GetDpsSummaryAsync(string targetUrl, CancellationToken ct = default)
        => GetCoreAsync(targetUrl, ct);

    public Task<HttpResponseMessage> GetTpsSummaryAsync(string targetUrl, CancellationToken ct = default)
        => GetCoreAsync(targetUrl, ct);

    public Task<HttpResponseMessage> GetRwsSummaryAsync(string targetUrl, CancellationToken ct = default)
        => GetCoreAsync(targetUrl, ct);

    public Task<HttpResponseMessage> GetChemSummaryAsync(string targetUrl, CancellationToken ct = default)
        => GetCoreAsync(targetUrl, ct);

    public Task<HttpResponseMessage> GetEventSummaryAsync(string targetUrl, CancellationToken ct = default)
        => GetCoreAsync(targetUrl, ct);

    public Task<HttpResponseMessage> GetClDetectorSummaryAsync(string targetUrl, CancellationToken ct = default)
        => GetCoreAsync(targetUrl, ct);

    /// <summary>LAB uses POST so the caller can forward the request body.</summary>
    public Task<HttpResponseMessage> PostLabSummaryAsync(
        string targetUrl, HttpContent? body, CancellationToken ct = default)
    {
        // LAB aggregates multiple data sources — give it a longer window.
        _http.Timeout = TimeSpan.FromSeconds(120);
        var req = new HttpRequestMessage(HttpMethod.Post, targetUrl) { Content = body };
        return _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private Task<HttpResponseMessage> GetCoreAsync(string url, CancellationToken ct)
        => _http.SendAsync(
            new HttpRequestMessage(HttpMethod.Get, url),
            HttpCompletionOption.ResponseHeadersRead, ct);
}
