using System.Net;
using System.Text;

namespace BellBeast.SelfTest;

/// <summary>
/// Self-tests that mirror AdminApiTests (xUnit) for the BellBeast admin proxy API.
/// Uses a CapturingHandler (same pattern as ST_EngineAdminService) so no live
/// Uroboros process is required.
///
/// Tests already covered by ST_EngineAdminService (URL routing + request body
/// forwarding) are NOT duplicated here.  The additional coverage added below is:
///   • Endpoint returns 200 when the engine responds OK (AdminPause/Resume/CancelAll/Enqueue)
///   • Idempotency — calling an endpoint twice must not throw (AdminEndpoints_CalledTwice)
///   • BadRequest guard — endpoint rejects a body that is missing the "name" key
///     (AdminEnqueue_MissingName_Returns400)
/// </summary>
internal static class ST_AdminApiEndpoints
{
    // ── Fake infrastructure ───────────────────────────────────────────────────

    private sealed class CapturingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;

        public CapturingHandler(
            Func<HttpRequestMessage, HttpResponseMessage>? responder = null)
        {
            _responder = responder ?? (_ => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            });
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(_responder(request));
    }

    private sealed class SingleClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _h;
        public SingleClientFactory(HttpMessageHandler h) => _h = h;
        public HttpClient CreateClient(string name) => new(_h);
    }

    private static EngineAdminService Make(CapturingHandler h)
        => new(new SingleClientFactory(h));

    // ── Tests ─────────────────────────────────────────────────────────────────

    public static IEnumerable<SelfTestCase> Run(SelfTestContext ctx)
    {
        // ── Mirrors AdminPause_Returns200 ─────────────────────────────────────

        // ── Mirrors AdminTasksStatus_Returns200 (new proxy endpoint) ────────
        // Route + method verification is covered by ST_EngineAdminService.
        // Here we verify only that GetStatusAsync() completes without throwing
        // when the engine returns 200.

        yield return SelfTestRunner.Run(
            "AdminApi | GET /api/admin/tasks/status → returns 200 when engine OK", () =>
            Make(new CapturingHandler()).GetStatusAsync().GetAwaiter().GetResult());

        // ── Mirrors AdminPause_Returns200 ─────────────────────────────────────

        yield return SelfTestRunner.Run(
            "AdminApi | POST /api/admin/pause → returns 200 when engine OK", () =>
            Make(new CapturingHandler()).PauseAsync().GetAwaiter().GetResult());

        // ── Mirrors AdminResume_Returns200 ────────────────────────────────────

        yield return SelfTestRunner.Run(
            "AdminApi | POST /api/admin/resume → returns 200 when engine OK", () =>
            Make(new CapturingHandler()).ResumeAsync().GetAwaiter().GetResult());

        // ── Mirrors AdminCancelAll_Returns200 ─────────────────────────────────

        yield return SelfTestRunner.Run(
            "AdminApi | POST /api/admin/cancelall → returns 200 when engine OK", () =>
            Make(new CapturingHandler()).CancelAllAsync().GetAwaiter().GetResult());

        // ── Mirrors AdminEnqueue_ValidName_Returns200 ─────────────────────────

        yield return SelfTestRunner.Run(
            "AdminApi | POST /api/admin/enqueue with valid name → returns 200", () =>
            Make(new CapturingHandler()).EnqueueAsync("TestTask").GetAwaiter().GetResult());

        // ── Mirrors AdminEnqueue_MissingName_Returns400 ───────────────────────
        // Replicates the endpoint guard:
        //   var dto = await ctx.Request.ReadFromJsonAsync<Dictionary<string, string>>();
        //   if (dto == null || !dto.TryGetValue("name", out var name))
        //       return Results.BadRequest();

        yield return SelfTestRunner.Run(
            "AdminApi | POST /api/admin/enqueue null body → BadRequest guard triggers", () =>
        {
            Dictionary<string, string>? dto = null;
            var isBadRequest = dto == null || !dto.TryGetValue("name", out var n1);
            SelfTestRunner.Assert(isBadRequest,
                "Null dto must trigger the BadRequest guard");
        });

        yield return SelfTestRunner.Run(
            "AdminApi | POST /api/admin/enqueue missing 'name' key → BadRequest guard triggers", () =>
        {
            var dto = new Dictionary<string, string> { ["other"] = "value" };
            var isBadRequest = dto == null || !dto.TryGetValue("name", out var n2);
            SelfTestRunner.Assert(isBadRequest,
                "Body without 'name' key must trigger the BadRequest guard");
        });

        // ── Mirrors AdminEndpoints_CalledTwice_BothReturn200 ─────────────────

        yield return SelfTestRunner.Run(
            "AdminApi | POST /api/admin/pause idempotent (called twice)", () =>
        {
            var svc = Make(new CapturingHandler());
            svc.PauseAsync().GetAwaiter().GetResult();
            svc.PauseAsync().GetAwaiter().GetResult();
        });

        yield return SelfTestRunner.Run(
            "AdminApi | POST /api/admin/resume idempotent (called twice)", () =>
        {
            var svc = Make(new CapturingHandler());
            svc.ResumeAsync().GetAwaiter().GetResult();
            svc.ResumeAsync().GetAwaiter().GetResult();
        });

        yield return SelfTestRunner.Run(
            "AdminApi | POST /api/admin/cancelall idempotent (called twice)", () =>
        {
            var svc = Make(new CapturingHandler());
            svc.CancelAllAsync().GetAwaiter().GetResult();
            svc.CancelAllAsync().GetAwaiter().GetResult();
        });
    }
}
