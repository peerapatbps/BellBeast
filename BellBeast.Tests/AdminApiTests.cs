using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Xunit;

/// <summary>
/// Regression tests for the BellBeast admin proxy API endpoints:
///   POST /api/admin/pause
///   POST /api/admin/resume
///   POST /api/admin/cancelall
///   POST /api/admin/enqueue
///   GET  /api/backend-config
///
/// All tests use <see cref="BellBeastBaseFactory"/> which replaces IHttpClientFactory
/// with a fake that returns configurable responses — no real Uroboros process needed.
/// </summary>
public sealed class AdminApiTests : IClassFixture<BellBeastBaseFactory>
{
    private readonly BellBeastBaseFactory _factory;

    public AdminApiTests(BellBeastBaseFactory factory) => _factory = factory;

    // ── /api/backend-config ───────────────────────────────────────────────

    [Fact]
    public async Task BackendConfig_Returns200WithBackendBaseUrl()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/backend-config");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var ct = response.Content.Headers.ContentType?.MediaType ?? "";
        Assert.Contains("application/json", ct, StringComparison.OrdinalIgnoreCase);

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(doc.RootElement.TryGetProperty("backendBaseUrl", out var prop),
            "Response JSON should contain 'backendBaseUrl'");
        var url = prop.GetString() ?? "";
        Assert.False(string.IsNullOrWhiteSpace(url), "backendBaseUrl must not be empty");
    }

    [Fact]
    public async Task BackendConfig_ContainsExpectedPaths()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/backend-config");
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = doc.RootElement;

        // All these keys are serialised by the /api/backend-config handler
        foreach (var key in new[] { "backendBaseUrl", "queryCsvPath", "wayfarerApiPath" })
        {
            Assert.True(root.TryGetProperty(key, out _), $"Missing key: {key}");
        }
    }

    // ── /api/admin/tasks/status (BellBeast proxy) ────────────────────────

    [Fact]
    public async Task AdminTasksStatus_Returns200()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/admin/tasks/status");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task AdminTasksStatus_ForwardsToEngineBackend()
    {
        HttpRequestMessage? captured = null;
        _factory.EngineHandler.RequestHandler = req =>
        {
            captured = req;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"ok":true,"paused":false,"tasks":[]}""",
                    Encoding.UTF8, "application/json")
            };
        };

        var client = _factory.CreateClient();
        await client.GetAsync("/api/admin/tasks/status");

        Assert.NotNull(captured);
        Assert.Equal(HttpMethod.Get, captured!.Method);
        Assert.Contains("admin/tasks/status", captured.RequestUri?.ToString() ?? "",
            StringComparison.OrdinalIgnoreCase);
    }

    // ── /api/admin/pause ─────────────────────────────────────────────────

    [Fact]
    public async Task AdminPause_Returns200()
    {
        var client = _factory.CreateClient();

        var response = await client.PostAsync("/api/admin/pause", null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task AdminPause_ForwardsToEngineBackend()
    {
        // Arrange: capture outbound requests made by EngineAdminService
        HttpRequestMessage? captured = null;
        _factory.EngineHandler.RequestHandler = req =>
        {
            captured = req;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            };
        };

        var client = _factory.CreateClient();
        await client.PostAsync("/api/admin/pause", null);

        Assert.NotNull(captured);
        Assert.Equal(HttpMethod.Post, captured!.Method);
        Assert.Contains("admin/pause", captured.RequestUri?.ToString() ?? "",
            StringComparison.OrdinalIgnoreCase);
    }

    // ── /api/admin/resume ────────────────────────────────────────────────

    [Fact]
    public async Task AdminResume_Returns200()
    {
        var client = _factory.CreateClient();

        var response = await client.PostAsync("/api/admin/resume", null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task AdminResume_ForwardsToEngineBackend()
    {
        HttpRequestMessage? captured = null;
        _factory.EngineHandler.RequestHandler = req =>
        {
            captured = req;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            };
        };

        var client = _factory.CreateClient();
        await client.PostAsync("/api/admin/resume", null);

        Assert.NotNull(captured);
        Assert.Contains("admin/resume", captured!.RequestUri?.ToString() ?? "",
            StringComparison.OrdinalIgnoreCase);
    }

    // ── /api/admin/cancelall ──────────────────────────────────────────────

    [Fact]
    public async Task AdminCancelAll_Returns200()
    {
        var client = _factory.CreateClient();

        var response = await client.PostAsync("/api/admin/cancelall", null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task AdminCancelAll_ForwardsToEngineBackend()
    {
        HttpRequestMessage? captured = null;
        _factory.EngineHandler.RequestHandler = req =>
        {
            captured = req;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            };
        };

        var client = _factory.CreateClient();
        await client.PostAsync("/api/admin/cancelall", null);

        Assert.NotNull(captured);
        Assert.Contains("admin/cancelall", captured!.RequestUri?.ToString() ?? "",
            StringComparison.OrdinalIgnoreCase);
    }

    // ── /api/admin/enqueue ────────────────────────────────────────────────

    [Fact]
    public async Task AdminEnqueue_MissingName_Returns400()
    {
        var client = _factory.CreateClient();

        // Send a valid JSON object that is missing the required "name" key
        var response = await client.PostAsync("/api/admin/enqueue",
            new StringContent("{}", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task AdminEnqueue_ValidName_Returns200()
    {
        var client = _factory.CreateClient();

        var body = JsonSerializer.Serialize(new { name = "TestTask" });
        var content = new StringContent(body, Encoding.UTF8, "application/json");

        var response = await client.PostAsync("/api/admin/enqueue", content);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task AdminEnqueue_ForwardsNameToEngineBackend()
    {
        string? sentBody = null;
        _factory.EngineHandler.RequestHandler = req =>
        {
            sentBody = req.Content?.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            };
        };

        var client = _factory.CreateClient();
        var payload = JsonSerializer.Serialize(new { name = "DpsRefreshTask" });
        await client.PostAsync("/api/admin/enqueue",
            new StringContent(payload, Encoding.UTF8, "application/json"));

        Assert.NotNull(sentBody);
        Assert.Contains("DpsRefreshTask", sentBody ?? "", StringComparison.Ordinal);
    }

    // ── Idempotency / repeated calls ──────────────────────────────────────

    [Theory]
    [InlineData("/api/admin/pause")]
    [InlineData("/api/admin/resume")]
    [InlineData("/api/admin/cancelall")]
    public async Task AdminEndpoints_CalledTwice_BothReturn200(string path)
    {
        var client = _factory.CreateClient();

        var r1 = await client.PostAsync(path, null);
        var r2 = await client.PostAsync(path, null);

        Assert.Equal(HttpStatusCode.OK, r1.StatusCode);
        Assert.Equal(HttpStatusCode.OK, r2.StatusCode);
    }
}
