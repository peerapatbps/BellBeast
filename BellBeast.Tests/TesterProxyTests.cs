using System.Net;
using System.Text;
using BellBeast.Endpoints;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

/// <summary>
/// /tester/* → BellBeast Tester on 127.0.0.1:8890 and the /Admin/Tester tab:
/// admin only, path/query/body forwarded, admin cookie never forwarded, tester down → 502 page.
/// </summary>
public sealed class TesterProxyTests : IClassFixture<BellBeastAdminFactory>, IClassFixture<BellBeastBaseFactory>
{
    private readonly BellBeastAdminFactory _admin;
    private readonly BellBeastBaseFactory _anon;

    public TesterProxyTests(BellBeastAdminFactory admin, BellBeastBaseFactory anon) { _admin = admin; _anon = anon; }

    private static WebApplicationFactoryClientOptions NoRedirect => new() { AllowAutoRedirect = false };

    private sealed record Seen(HttpMethod Method, Uri? RequestUri, string? Body, bool HasCookie);

    private List<Seen> Capture(HttpStatusCode status, string body, Action<HttpResponseMessage>? tweak = null)
    {
        var seen = new List<Seen>();
        _admin.EngineHandler.RequestHandler = req =>
        {
            seen.Add(new Seen(req.Method, req.RequestUri, req.Content?.ReadAsStringAsync().GetAwaiter().GetResult(), req.Headers.Contains("Cookie")));
            var resp = new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "text/html") };
            tweak?.Invoke(resp);
            return resp;
        };
        return seen;
    }

    [Theory]
    [InlineData("/tester")]
    [InlineData("/tester/api/run")]
    [InlineData("/Admin/Tester")]
    public async Task Anonymous_Is_Sent_To_Admin_Login(string path)
    {
        var r = await _anon.CreateClient(NoRedirect).GetAsync(path);

        Assert.Equal(HttpStatusCode.Redirect, r.StatusCode);
        Assert.Contains("/Admin/Login", r.Headers.Location?.ToString() ?? "", StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Anonymous_Post_To_Tester_Api_Never_Reaches_Tester()
    {
        var reached = false;
        _anon.EngineHandler.RequestHandler = _ => { reached = true; return new HttpResponseMessage(HttpStatusCode.OK); };

        await _anon.CreateClient(NoRedirect).PostAsync("/tester/api/report", new StringContent("{}", Encoding.UTF8, "application/json"));

        Assert.False(reached);
    }

    [Theory]
    [InlineData("/tester", "http://127.0.0.1:8890/tester")]
    [InlineData("/tester/_next/static/css/a.css?v=1", "http://127.0.0.1:8890/tester/_next/static/css/a.css?v=1")]
    public async Task Admin_Get_Is_Forwarded_With_Path_And_Query(string path, string upstream)
    {
        var seen = Capture(HttpStatusCode.OK, "<html>tester</html>");

        var r = await _admin.CreateClient(NoRedirect).GetAsync(path);

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("<html>tester</html>", await r.Content.ReadAsStringAsync());
        Assert.Equal(upstream, Assert.Single(seen).RequestUri!.ToString());
        Assert.Equal("SAMEORIGIN", r.Headers.GetValues("X-Frame-Options").Single());
    }

    [Fact]
    public async Task Admin_Post_Forwards_Body_But_Not_Cookie()
    {
        var seen = Capture(HttpStatusCode.OK, """{"verdict":"pass"}""");
        var req = new HttpRequestMessage(HttpMethod.Post, "/tester/api/run")
        {
            Content = new StringContent("""{"id":"B4"}""", Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Cookie", "bb_admin=secret");

        var r = await _admin.CreateClient(NoRedirect).SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var sent = Assert.Single(seen);
        Assert.Equal(HttpMethod.Post, sent.Method);
        Assert.Equal("""{"id":"B4"}""", sent.Body);
        Assert.False(sent.HasCookie);
    }

    [Fact]
    public async Task Absolute_Redirect_From_Tester_Stays_On_BellBeast()
    {
        Capture(HttpStatusCode.PermanentRedirect, "", r => r.Headers.Location = new Uri("http://127.0.0.1:8890/tester"));

        var r = await _admin.CreateClient(NoRedirect).GetAsync("/tester/");

        Assert.Equal(HttpStatusCode.PermanentRedirect, r.StatusCode);
        Assert.Equal("/tester", r.Headers.Location?.ToString());
    }

    [Fact]
    public async Task Tester_Down_Returns_502_Page()
    {
        _admin.EngineHandler.RequestHandler = _ => throw new HttpRequestException("refused");

        var r = await _admin.CreateClient(NoRedirect).GetAsync("/tester");

        Assert.Equal(HttpStatusCode.BadGateway, r.StatusCode);
        Assert.Contains("start.bat", await r.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Admin_Tab_Embeds_Tester_And_Shows_In_Admin_Tabs()
    {
        var r = await _admin.CreateClient(NoRedirect).GetAsync("/Admin/Tester");

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var html = await r.Content.ReadAsStringAsync();
        Assert.Contains("<iframe class=\"ts-frame\" src=\"/tester\"", html);
        Assert.Contains("href=\"/Admin/Tester\"", html);
    }

    [Theory]
    [InlineData("http://127.0.0.1:8890/tester", "/tester")]
    [InlineData("http://127.0.0.1:8890", "/")]
    [InlineData("/tester", "/tester")]
    [InlineData("https://example.com/x", "https://example.com/x")]
    public void RewriteLocation_Strips_Tester_Origin(string location, string expected) =>
        Assert.Equal(expected, TesterEndpoints.RewriteLocation(location, TesterEndpoints.DefaultBaseUrl));
}
