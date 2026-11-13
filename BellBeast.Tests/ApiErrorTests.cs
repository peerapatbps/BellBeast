using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

/// <summary>Runs as Production, where UseExceptionHandler("/Error") is active (the case that redirected to /Login).</summary>
public sealed class BellBeastProductionFactory : BellBeastBaseFactory
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.UseEnvironment("Production");
    }
}

/// <summary>
/// When Uroboros is down, the public dashboard proxies (/api/tps/summary, /api/online_lab, /api/ptc/series, …)
/// must answer 502 JSON — not 302 → /Login?ReturnUrl=/Error, which MHxView cannot read.
/// </summary>
public sealed class ApiErrorTests : IClassFixture<BellBeastProductionFactory>
{
    private readonly BellBeastProductionFactory _f;
    public ApiErrorTests(BellBeastProductionFactory f) => _f = f;

    private HttpClient Client() => _f.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

    [Theory]
    [InlineData("GET", "/api/tps/summary")]
    [InlineData("GET", "/api/dps/summary")]
    [InlineData("GET", "/api/rws/summary")]
    [InlineData("GET", "/api/chem/summary")]
    [InlineData("GET", "/api/ptc/series?key=UZ5411P")]
    [InlineData("POST", "/api/online_lab")]
    public async Task Upstream_Down_Returns_502_Json_Not_Login_Redirect(string method, string path)
    {
        _f.EngineHandler.RequestHandler = _ => throw new HttpRequestException("No connection could be made (localhost:8888)");

        var req = new HttpRequestMessage(new HttpMethod(method), path);
        if (method == "POST") req.Content = new StringContent("""{"hourWindow":4,"sources":[]}""", Encoding.UTF8, "text/plain");
        var r = await Client().SendAsync(req);

        Assert.Equal(HttpStatusCode.BadGateway, r.StatusCode);
        Assert.Null(r.Headers.Location);
        using var doc = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
        Assert.False(doc.RootElement.GetProperty("ok").GetBoolean());
        Assert.Equal("upstream_unavailable", doc.RootElement.GetProperty("error").GetString());
    }

    [Fact]
    public async Task Upstream_Timeout_Returns_502()
    {
        _f.EngineHandler.RequestHandler = _ => throw new TaskCanceledException("timeout", new TimeoutException());

        var r = await Client().GetAsync("/api/tps/summary");

        Assert.Equal(HttpStatusCode.BadGateway, r.StatusCode);
    }

    [Fact]
    public async Task Other_Exception_Returns_500_Json()
    {
        _f.EngineHandler.RequestHandler = _ => throw new InvalidOperationException("bug");

        var r = await Client().GetAsync("/api/tps/summary");

        Assert.Equal(HttpStatusCode.InternalServerError, r.StatusCode);
        Assert.Contains("internal_error", await r.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Upstream_Up_Still_Proxies_200()
    {
        _f.EngineHandler.RequestHandler = _ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"ok":true}""", Encoding.UTF8, "application/json"),
        };

        var r = await Client().GetAsync("/api/tps/summary");

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("\"ok\":true", await r.Content.ReadAsStringAsync());
    }
}
