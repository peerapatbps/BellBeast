using System.Net;
using System.Text;
using Xunit;

/// <summary>
/// Admin page task table goes same-origin through BellBeast (WiFi clients cannot reach Uroboros :8888):
///   GET/POST /api/admin/tasks/config, POST /api/admin/tasks/forcerun → relayed to Uroboros unchanged, admin login required.
/// </summary>
public sealed class AdminTaskProxyTests : IClassFixture<BellBeastAdminFactory>, IClassFixture<BellBeastBaseFactory>
{
    private readonly BellBeastAdminFactory _admin;
    private readonly BellBeastBaseFactory _anon;

    public AdminTaskProxyTests(BellBeastAdminFactory admin, BellBeastBaseFactory anon) { _admin = admin; _anon = anon; }

    private (List<(HttpMethod M, string Uri, string? Body)> Seen, HttpClient Client) Capture(int status, string body)
    {
        var seen = new List<(HttpMethod, string, string?)>();
        _admin.EngineHandler.RequestHandler = req =>
        {
            seen.Add((req.Method, req.RequestUri?.ToString() ?? "", req.Content?.ReadAsStringAsync().GetAwaiter().GetResult()));
            return new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        };
        return (seen, _admin.CreateClient());
    }

    [Fact]
    public async Task Get_Config_Is_Relayed_With_Body()
    {
        var (seen, c) = Capture(200, """{"tasks":[{"name":"A"}]}""");

        var r = await c.GetAsync("/api/admin/tasks/config");

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("""{"tasks":[{"name":"A"}]}""", await r.Content.ReadAsStringAsync());
        Assert.Equal("http://localhost:8888/admin/tasks/config", Assert.Single(seen).Uri);
    }

    [Theory]
    [InlineData("/api/admin/tasks/config", "http://localhost:8888/admin/tasks/config", """{"updates":[{"name":"A","enabled":false}]}""")]
    [InlineData("/api/admin/tasks/forcerun", "http://localhost:8888/admin/tasks/forcerun", """{"dueUnixMs":123,"enabledOnly":true}""")]
    public async Task Post_Forwards_Body_And_Keeps_Engine_Status(string path, string upstream, string json)
    {
        var (seen, c) = Capture(409, """{"error":"busy"}""");

        var r = await c.PostAsync(path, new StringContent(json, Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        var call = Assert.Single(seen);
        Assert.Equal(HttpMethod.Post, call.M);
        Assert.Equal(upstream, call.Uri);
        Assert.Equal(json, call.Body);
    }

    [Fact]
    public async Task Engine_Down_Returns_502_Json()
    {
        _admin.EngineHandler.RequestHandler = _ => throw new HttpRequestException("refused");

        var r = await _admin.CreateClient().GetAsync("/api/admin/tasks/config");

        Assert.Equal(HttpStatusCode.BadGateway, r.StatusCode);
        Assert.Contains("engine_offline", await r.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("GET", "/api/admin/tasks/config")]
    [InlineData("POST", "/api/admin/tasks/config")]
    [InlineData("POST", "/api/admin/tasks/forcerun")]
    public async Task Needs_Admin_Login(string method, string path)
    {
        var req = new HttpRequestMessage(new HttpMethod(method), path);
        if (method == "POST") req.Content = new StringContent("{}", Encoding.UTF8, "application/json");

        var r = await _anon.CreateClient().SendAsync(req);

        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }
}
