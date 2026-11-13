using System.Net;
using System.Text;
using System.Text.Json;
using Xunit;

/// <summary>
/// Phase 0 security baseline: endpoints are closed unless explicitly public,
/// engine/tunnel controls need admin, CORS does not reflect foreign origins,
/// and the Aquadat token never reaches the browser.
/// </summary>
public sealed class SecurityBaselineTests : IClassFixture<BellBeastAdminFactory>, IClassFixture<BellBeastBaseFactory>
{
    private readonly BellBeastAdminFactory _admin;
    private readonly BellBeastBaseFactory _anon;

    public SecurityBaselineTests(BellBeastAdminFactory admin, BellBeastBaseFactory anon) { _admin = admin; _anon = anon; }

    private static HttpRequestMessage Req(string method, string path)
    {
        var req = new HttpRequestMessage(new HttpMethod(method), path);
        if (method != "GET") req.Content = new StringContent("{}", Encoding.UTF8, "application/json");
        return req;
    }

    [Theory]
    // engine control (was anonymous)
    [InlineData("POST", "/api/admin/pause")]
    [InlineData("POST", "/api/admin/resume")]
    [InlineData("POST", "/api/admin/cancelall")]
    [InlineData("POST", "/api/admin/enqueue")]
    [InlineData("GET", "/api/admin/tasks/status")]
    [InlineData("GET", "/api/admin/test/run")]
    [InlineData("GET", "/api/admin/test/run-local")]
    // tunnel control (was [AllowAnonymous])
    [InlineData("POST", "/api/iot/tunnel/start")]
    [InlineData("POST", "/api/iot/tunnel/stop")]
    // caught by the deny-by-default fallback policy (Index page needs login)
    [InlineData("POST", "/api/process")]
    [InlineData("POST", "/api/template/save")]
    [InlineData("GET", "/api/aqtable")]
    [InlineData("GET", "/api/stations")]
    [InlineData("GET", "/api/backend-config")]
    public async Task Anonymous_Is_Rejected(string method, string path)
    {
        var r = await _anon.CreateClient().SendAsync(Req(method, path));
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    [Theory]
    // used by anonymous pages (MHxView, reports, WebPM, IotRoom) — must stay reachable
    [InlineData("GET", "/api/dps/summary")]
    [InlineData("GET", "/api/engine/sequence/status")]
    [InlineData("GET", "/api/config/files")]
    [InlineData("GET", "/api/iot/tunnel/status")]
    [InlineData("GET", "/api/auth/me")]
    [InlineData("POST", "/api/admin/auth/logout")]
    public async Task Public_Endpoints_Stay_Open(string method, string path)
    {
        var r = await _anon.CreateClient().SendAsync(Req(method, path));
        Assert.NotEqual(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.NotEqual(HttpStatusCode.Forbidden, r.StatusCode);
    }

    [Fact]
    public async Task Cors_Does_Not_Reflect_Foreign_Origin()
    {
        var req = Req("GET", "/api/engine/sequence/status");
        req.Headers.Add("Origin", "https://evil.example");

        var r = await _anon.CreateClient().SendAsync(req);

        Assert.False(r.Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Fact]
    public async Task AuthMe_Does_Not_Expose_Token()
    {
        var body = await _anon.CreateClient().GetStringAsync("/api/auth/me");
        using var doc = JsonDocument.Parse(body);
        Assert.False(doc.RootElement.TryGetProperty("token", out _));
    }

    [Fact]
    public async Task Process_Overwrites_Client_Supplied_Token_And_User()
    {
        string? sent = null;
        _admin.EngineHandler.RequestHandler = req =>
        {
            sent = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("ok") };
        };
        try
        {
            var r = await _admin.CreateClient().PostAsync("/api/process",
                new StringContent("""{"begin":"2026-01-01","token":"forged","user":"someone-else"}""", Encoding.UTF8, "application/json"));

            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            using var doc = JsonDocument.Parse(sent!);
            Assert.NotEqual("forged", doc.RootElement.GetProperty("token").GetString());
            Assert.Equal("test-admin", doc.RootElement.GetProperty("user").GetString());
            Assert.Equal("2026-01-01", doc.RootElement.GetProperty("begin").GetString());
        }
        finally { _admin.EngineHandler.RequestHandler = null; }
    }

    [Fact]
    public async Task Process_Rejects_Non_Json_Body()
    {
        var r = await _admin.CreateClient().PostAsync("/api/process",
            new StringContent("not json", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }
}
