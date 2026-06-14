using System.Net;
using System.Text;
using System.Text.Json;

namespace BellBeast.SelfTest;

/// <summary>
/// Self-tests for <see cref="SummaryProxyService"/>.
///
/// Two layers of coverage:
///  1. Default path constants — each card's fallback Uroboros path is the expected string.
///     If a constant is renamed or mistyped, the test fails before any HTTP call is made.
///  2. HTTP method / URL routing — each proxy method sends the right verb to the URL it receives.
///     Uses <see cref="CapturingHandler"/> so no live Uroboros is required.
/// </summary>
internal static class ST_SummaryProxy
{
    // ── Fake infrastructure (same pattern as ST_EngineAdminService) ───────────

    private sealed class CapturingHandler : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }
        public string?             LastBody    { get; private set; }

        private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;

        public CapturingHandler(
            Func<HttpRequestMessage, HttpResponseMessage>? responder = null)
        {
            _responder = responder ?? (_ => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            });
        }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
        {
            LastRequest = request;
            if (request.Content != null)
                LastBody = await request.Content.ReadAsStringAsync(ct);
            return _responder(request);
        }
    }

    private sealed class SingleClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;
        public SingleClientFactory(HttpMessageHandler handler) => _handler = handler;
        public HttpClient CreateClient(string name) => new(_handler);
    }

    private static SummaryProxyService Make(CapturingHandler handler)
        => new(new SingleClientFactory(handler));

    private const string Base = "http://localhost:8888";

    // ── Tests ─────────────────────────────────────────────────────────────────

    public static IEnumerable<SelfTestCase> Run()
    {
        // ── 1. Default path constants ─────────────────────────────────────────

        yield return SelfTestRunner.Run("SummaryProxy | DefaultDpsPath = /api/dps/summary", () =>
            SelfTestRunner.AssertEqual("/api/dps/summary", SummaryProxyService.DefaultDpsPath));

        yield return SelfTestRunner.Run("SummaryProxy | DefaultTpsPath = /api/tps/summary", () =>
            SelfTestRunner.AssertEqual("/api/tps/summary", SummaryProxyService.DefaultTpsPath));

        yield return SelfTestRunner.Run("SummaryProxy | DefaultRwsPath = /api/rps/summary (Uroboros-side route)", () =>
            SelfTestRunner.AssertEqual("/api/rps/summary", SummaryProxyService.DefaultRwsPath));

        yield return SelfTestRunner.Run("SummaryProxy | DefaultChemPath = /api/chem/summary", () =>
            SelfTestRunner.AssertEqual("/api/chem/summary", SummaryProxyService.DefaultChemPath));

        yield return SelfTestRunner.Run("SummaryProxy | DefaultEventPath = /api/event/summary", () =>
            SelfTestRunner.AssertEqual("/api/event/summary", SummaryProxyService.DefaultEventPath));

        yield return SelfTestRunner.Run("SummaryProxy | DefaultLabPath = /api/lab/summary", () =>
            SelfTestRunner.AssertEqual("/api/lab/summary", SummaryProxyService.DefaultLabPath));

        yield return SelfTestRunner.Run("SummaryProxy | DefaultClDetectorPath = /api/cldetector/summary", () =>
            SelfTestRunner.AssertEqual("/api/cldetector/summary", SummaryProxyService.DefaultClDetectorPath));

        // ── 2. HTTP method checks ─────────────────────────────────────────────

        yield return SelfTestRunner.Run("SummaryProxy | GetDpsSummaryAsync → GET", () =>
        {
            var h = new CapturingHandler();
            Make(h).GetDpsSummaryAsync($"{Base}{SummaryProxyService.DefaultDpsPath}").GetAwaiter().GetResult();
            SelfTestRunner.AssertEqual("GET", h.LastRequest!.Method.Method);
        });

        yield return SelfTestRunner.Run("SummaryProxy | GetTpsSummaryAsync → GET", () =>
        {
            var h = new CapturingHandler();
            Make(h).GetTpsSummaryAsync($"{Base}{SummaryProxyService.DefaultTpsPath}").GetAwaiter().GetResult();
            SelfTestRunner.AssertEqual("GET", h.LastRequest!.Method.Method);
        });

        yield return SelfTestRunner.Run("SummaryProxy | GetRwsSummaryAsync → GET", () =>
        {
            var h = new CapturingHandler();
            Make(h).GetRwsSummaryAsync($"{Base}{SummaryProxyService.DefaultRwsPath}").GetAwaiter().GetResult();
            SelfTestRunner.AssertEqual("GET", h.LastRequest!.Method.Method);
        });

        yield return SelfTestRunner.Run("SummaryProxy | GetChemSummaryAsync → GET", () =>
        {
            var h = new CapturingHandler();
            Make(h).GetChemSummaryAsync($"{Base}{SummaryProxyService.DefaultChemPath}").GetAwaiter().GetResult();
            SelfTestRunner.AssertEqual("GET", h.LastRequest!.Method.Method);
        });

        yield return SelfTestRunner.Run("SummaryProxy | GetEventSummaryAsync → GET", () =>
        {
            var h = new CapturingHandler();
            Make(h).GetEventSummaryAsync($"{Base}{SummaryProxyService.DefaultEventPath}").GetAwaiter().GetResult();
            SelfTestRunner.AssertEqual("GET", h.LastRequest!.Method.Method);
        });

        yield return SelfTestRunner.Run("SummaryProxy | GetClDetectorSummaryAsync → GET", () =>
        {
            var h = new CapturingHandler();
            Make(h).GetClDetectorSummaryAsync($"{Base}{SummaryProxyService.DefaultClDetectorPath}").GetAwaiter().GetResult();
            SelfTestRunner.AssertEqual("GET", h.LastRequest!.Method.Method);
        });

        yield return SelfTestRunner.Run("SummaryProxy | PostLabSummaryAsync → POST", () =>
        {
            var h = new CapturingHandler();
            var body = new StringContent("{}", Encoding.UTF8, "application/json");
            Make(h).PostLabSummaryAsync($"{Base}{SummaryProxyService.DefaultLabPath}", body).GetAwaiter().GetResult();
            SelfTestRunner.AssertEqual("POST", h.LastRequest!.Method.Method);
        });

        // ── 3. URL routing checks ─────────────────────────────────────────────

        yield return SelfTestRunner.Run("SummaryProxy | GetDpsSummaryAsync hits correct path", () =>
        {
            var h = new CapturingHandler();
            Make(h).GetDpsSummaryAsync($"{Base}{SummaryProxyService.DefaultDpsPath}").GetAwaiter().GetResult();
            SelfTestRunner.AssertEqual("/api/dps/summary",
                h.LastRequest!.RequestUri!.AbsolutePath);
        });

        yield return SelfTestRunner.Run("SummaryProxy | GetRwsSummaryAsync hits /api/rps/summary on Uroboros", () =>
        {
            var h = new CapturingHandler();
            Make(h).GetRwsSummaryAsync($"{Base}{SummaryProxyService.DefaultRwsPath}").GetAwaiter().GetResult();
            // BellBeast exposes /rws but Uroboros uses /rps — this test catches a swap
            SelfTestRunner.AssertEqual("/api/rps/summary",
                h.LastRequest!.RequestUri!.AbsolutePath);
        });

        yield return SelfTestRunner.Run("SummaryProxy | PostLabSummaryAsync forwards body", () =>
        {
            var h = new CapturingHandler();
            var payload = """{"filter":"today"}""";
            var body = new StringContent(payload, Encoding.UTF8, "application/json");
            Make(h).PostLabSummaryAsync($"{Base}{SummaryProxyService.DefaultLabPath}", body).GetAwaiter().GetResult();
            SelfTestRunner.AssertNotNull(h.LastBody, "body should not be null");
            using var doc = JsonDocument.Parse(h.LastBody!);
            SelfTestRunner.Assert(
                doc.RootElement.TryGetProperty("filter", out _),
                "forwarded body missing 'filter' key");
        });

        // ── 4. Response passthrough ───────────────────────────────────────────

        yield return SelfTestRunner.Run("SummaryProxy | 200 response is returned", () =>
        {
            var h = new CapturingHandler(
                _ => new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("""{"ok":true}""", Encoding.UTF8, "application/json")
                });
            var resp = Make(h).GetDpsSummaryAsync($"{Base}{SummaryProxyService.DefaultDpsPath}").GetAwaiter().GetResult();
            SelfTestRunner.Assert(resp.IsSuccessStatusCode, $"Expected 200 but got {(int)resp.StatusCode}");
        });

        yield return SelfTestRunner.Run("SummaryProxy | non-200 from upstream is returned as-is", () =>
        {
            var h = new CapturingHandler(
                _ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                {
                    Content = new StringContent("engine down", Encoding.UTF8, "text/plain")
                });
            var resp = Make(h).GetDpsSummaryAsync($"{Base}{SummaryProxyService.DefaultDpsPath}").GetAwaiter().GetResult();
            SelfTestRunner.AssertEqual(503, (int)resp.StatusCode, "upstream 503 should be passed through");
        });
    }
}
