using System.Net;
using System.Text;
using System.Text.Json;

namespace BellBeast.SelfTest;

/// <summary>
/// Self-tests for <see cref="EngineAdminService"/>.
/// Verifies that each method calls the correct Uroboros URL, HTTP method, and request body.
/// Uses a <see cref="CapturingHandler"/> to intercept outgoing requests without a live backend.
/// </summary>
internal static class ST_EngineAdminService
{
    // ── Fake infrastructure ───────────────────────────────────────────────────

    /// <summary>
    /// Records the last outgoing <see cref="HttpRequestMessage"/> and its body,
    /// then returns a configurable <see cref="HttpResponseMessage"/>.
    /// </summary>
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

    /// <summary>Always returns one <see cref="HttpClient"/> backed by the given handler.</summary>
    private sealed class SingleClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;
        public SingleClientFactory(HttpMessageHandler handler) => _handler = handler;
        public HttpClient CreateClient(string name) => new(_handler);
    }

    private static EngineAdminService Make(CapturingHandler handler)
        => new(new SingleClientFactory(handler));

    // ── Tests ─────────────────────────────────────────────────────────────────

    public static IEnumerable<SelfTestCase> Run()
    {
        // ── Route / method checks ─────────────────────────────────────────────

        yield return SelfTestRunner.Run("EngineAdminService | PauseAsync → POST admin/pause", () =>
        {
            var h = new CapturingHandler();
            Make(h).PauseAsync().GetAwaiter().GetResult();

            SelfTestRunner.AssertNotNull(h.LastRequest);
            SelfTestRunner.AssertEqual("POST",         h.LastRequest!.Method.Method);
            SelfTestRunner.AssertEqual("admin/pause",  h.LastRequest.RequestUri!.AbsolutePath.TrimStart('/'));
        });

        yield return SelfTestRunner.Run("EngineAdminService | ResumeAsync → POST admin/resume", () =>
        {
            var h = new CapturingHandler();
            Make(h).ResumeAsync().GetAwaiter().GetResult();

            SelfTestRunner.AssertEqual("POST",          h.LastRequest!.Method.Method);
            SelfTestRunner.AssertEqual("admin/resume",  h.LastRequest.RequestUri!.AbsolutePath.TrimStart('/'));
        });

        yield return SelfTestRunner.Run("EngineAdminService | CancelAllAsync → POST admin/cancelall", () =>
        {
            var h = new CapturingHandler();
            Make(h).CancelAllAsync().GetAwaiter().GetResult();

            SelfTestRunner.AssertEqual("POST",            h.LastRequest!.Method.Method);
            SelfTestRunner.AssertEqual("admin/cancelall", h.LastRequest.RequestUri!.AbsolutePath.TrimStart('/'));
        });

        yield return SelfTestRunner.Run("EngineAdminService | EnqueueAsync → POST tasks/enqueue", () =>
        {
            var h = new CapturingHandler();
            Make(h).EnqueueAsync("ANY").GetAwaiter().GetResult();

            SelfTestRunner.AssertEqual("POST",           h.LastRequest!.Method.Method);
            SelfTestRunner.AssertEqual("tasks/enqueue",  h.LastRequest.RequestUri!.AbsolutePath.TrimStart('/'));
        });

        yield return SelfTestRunner.Run("EngineAdminService | GetStatusAsync → GET admin/tasks/status", () =>
        {
            var h = new CapturingHandler();
            Make(h).GetStatusAsync().GetAwaiter().GetResult();

            SelfTestRunner.AssertEqual("GET",                  h.LastRequest!.Method.Method);
            SelfTestRunner.AssertEqual("admin/tasks/status",   h.LastRequest.RequestUri!.AbsolutePath.TrimStart('/'));
        });

        yield return SelfTestRunner.Run("EngineAdminService | GetConfigAsync → GET admin/tasks/config", () =>
        {
            var h = new CapturingHandler();
            Make(h).GetConfigAsync().GetAwaiter().GetResult();

            SelfTestRunner.AssertEqual("GET",                  h.LastRequest!.Method.Method);
            SelfTestRunner.AssertEqual("admin/tasks/config",   h.LastRequest.RequestUri!.AbsolutePath.TrimStart('/'));
        });

        yield return SelfTestRunner.Run("EngineAdminService | RunTestsAsync → GET admin/test/run", () =>
        {
            var h = new CapturingHandler();
            Make(h).RunTestsAsync().GetAwaiter().GetResult();

            SelfTestRunner.AssertEqual("GET",             h.LastRequest!.Method.Method);
            SelfTestRunner.AssertEqual("admin/test/run",  h.LastRequest.RequestUri!.AbsolutePath.TrimStart('/'));
        });

        // ── Request body checks ───────────────────────────────────────────────

        yield return SelfTestRunner.Run("EngineAdminService | EnqueueAsync sends {name} in body", () =>
        {
            var h = new CapturingHandler();
            Make(h).EnqueueAsync("MY_TASK").GetAwaiter().GetResult();

            SelfTestRunner.AssertNotNull(h.LastBody, "body was null");
            using var doc  = JsonDocument.Parse(h.LastBody!);
            var found = doc.RootElement.TryGetProperty("name", out var prop);
            SelfTestRunner.Assert(found, "body JSON missing 'name' key");
            SelfTestRunner.AssertEqual("MY_TASK", prop.GetString(), "name value mismatch");
        });

        yield return SelfTestRunner.Run("EngineAdminService | PauseAsync sends no body", () =>
        {
            var h = new CapturingHandler();
            Make(h).PauseAsync().GetAwaiter().GetResult();

            // PostAsync(url, null) — content should be null or empty
            SelfTestRunner.Assert(
                h.LastBody is null || h.LastBody.Length == 0,
                $"Expected no body but got [{h.LastBody}]");
        });

        // ── Response handling checks ──────────────────────────────────────────

        yield return SelfTestRunner.Run("EngineAdminService | RunTestsAsync 5xx → returns null", () =>
        {
            var h = new CapturingHandler(
                _ => new HttpResponseMessage(HttpStatusCode.InternalServerError));
            var result = Make(h).RunTestsAsync().GetAwaiter().GetResult();
            SelfTestRunner.AssertNull(result);
        });

        yield return SelfTestRunner.Run("EngineAdminService | RunTestsAsync 200 → returns non-null", () =>
        {
            const string json = """{"ok":true,"total":5,"passed":5,"failed":0,"durationMs":12}""";
            var h = new CapturingHandler(
                _ => new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(json, Encoding.UTF8, "application/json")
                });
            var result = Make(h).RunTestsAsync().GetAwaiter().GetResult();
            SelfTestRunner.AssertNotNull(result);
        });
    }
}
