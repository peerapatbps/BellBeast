using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

/// <summary>Short idle timeout (2 s) and remote IP chosen per request (X-Test-Remote-IP).</summary>
public sealed class ViewTokenFactory : BellBeastBaseFactory
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.UseSetting("ViewToken:IdleSeconds", "2");
        builder.UseSetting("ViewToken:PublishTrafficToRoom", "true");
        builder.ConfigureServices(s => s.AddTransient<IStartupFilter, RemoteIpStartupFilter>());
    }
}

public sealed class ViewTokenTests : IClassFixture<ViewTokenFactory>, IClassFixture<BellBeastAdminFactory>
{
    private const string PageApi = "/api/engine/sequence/status";   // MHxView ⚙️ engine tab
    private readonly ViewTokenFactory _f;
    private readonly BellBeastAdminFactory _admin;

    public ViewTokenTests(ViewTokenFactory f, BellBeastAdminFactory admin) { _f = f; _admin = admin; }

    private HttpClient Client(string ip, bool cookies = true)
    {
        var c = _f.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = cookies, AllowAutoRedirect = false });
        c.DefaultRequestHeaders.Add("X-Test-Remote-IP", ip);
        return c;
    }

    private static async Task<HttpResponseMessage> Get(HttpClient c, string path, string? token)
    {
        var r = new HttpRequestMessage(HttpMethod.Get, path);
        if (token is not null) r.Headers.Add(ViewTokenTestHelper.Header, token);
        return await c.SendAsync(r);
    }

    private static async Task<string> Error(HttpResponseMessage r) =>
        JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetString()!;

    /// <summary>Callers only ever see "unauthorized"; the real reason is recorded for the admin.</summary>
    private async Task AssertRejected(HttpResponseMessage r, string ip, string reason)
    {
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        var body = await r.Content.ReadAsStringAsync();
        Assert.Equal("unauthorized", JsonDocument.Parse(body).RootElement.GetProperty("error").GetString());
        Assert.DoesNotContain("view_", body);   // no hint about view tokens
        var views = _f.Services.GetRequiredService<BellBeast.ApiAccess.ViewTokenService>();
        Assert.Contains(views.ListRejections(), x => x.Ip == ip && x.LastReason == reason);
    }

    [Fact]
    public async Task Page_Render_Hands_Out_Token_And_Refresh_Cookie()
    {
        var c = Client("10.50.0.1", cookies: false);
        var page = await c.GetAsync("/Privacy");
        Assert.Contains("name=\"bb-view-token\" content=\"", await page.Content.ReadAsStringAsync());
        Assert.Contains("/js/bb-viewtoken.js", await page.Content.ReadAsStringAsync());

        var cookie = page.Headers.GetValues("Set-Cookie").Single(h => h.StartsWith("bb_vr="));
        Assert.Contains("path=/api/view", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=strict", cookie, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Page_Api_Needs_A_Live_Token()
    {
        var c = Client("10.50.0.2");
        await AssertRejected(await Get(c, PageApi, null), "10.50.0.2", "view_token_missing");
        await AssertRejected(await Get(c, PageApi, "made-up-token"), "10.50.0.2", "view_token_expired");

        var token = await c.PageTokenAsync();
        Assert.NotEqual(HttpStatusCode.Unauthorized, (await Get(c, PageApi, token)).StatusCode);

        // the same token from another machine is useless
        await AssertRejected(await Get(Client("10.50.0.99"), PageApi, token), "10.50.0.99", "view_token_wrong_ip");
    }

    [Fact]
    public async Task Idle_Token_Dies_But_Heartbeat_Keeps_It_Alive_And_Renew_Recovers()
    {
        var c = Client("10.50.0.3");
        var token = await c.PageTokenAsync();

        // heartbeat via the device-public alarm poll (as MHxView does every 5 s)
        for (var i = 0; i < 4; i++)
        {
            await Task.Delay(1000);
            await Get(c, "/api/alarm/active", token);
        }
        Assert.NotEqual(HttpStatusCode.Unauthorized, (await Get(c, PageApi, token)).StatusCode);

        // computer sleeps
        await Task.Delay(3000);
        await AssertRejected(await Get(c, PageApi, token), "10.50.0.3", "view_token_expired");

        // page script renews with the refresh cookie (no reload) and retries
        var renew = await c.PostAsync("/api/view/renew", new StringContent("{\"page\":\"/MHxViewer/MHxView\"}", System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, renew.StatusCode);
        var fresh = JsonDocument.Parse(await renew.Content.ReadAsStringAsync()).RootElement.GetProperty("token").GetString();
        Assert.NotEqual(token, fresh);
        Assert.NotEqual(HttpStatusCode.Unauthorized, (await Get(c, PageApi, fresh)).StatusCode);
    }

    [Fact]
    public async Task Renew_Needs_A_Valid_Refresh_Cookie()
    {
        var noCookie = await Client("10.50.0.4", cookies: false).PostAsync("/api/view/renew", null);
        Assert.Equal(HttpStatusCode.Unauthorized, noCookie.StatusCode);
        Assert.Equal("unauthorized", await Error(noCookie));

        var forged = new HttpRequestMessage(HttpMethod.Post, "/api/view/renew");
        forged.Headers.Add("Cookie", "bb_vr=not-a-real-ticket");
        forged.Headers.Add("X-Test-Remote-IP", "10.50.0.4");
        Assert.Equal(HttpStatusCode.Unauthorized, (await _f.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false }).SendAsync(forged)).StatusCode);
    }

    [Fact]
    public async Task Trusted_Callers_Skip_The_Token()
    {
        // the server itself (BellBeast Tester, tools on the box)
        Assert.NotEqual(HttpStatusCode.Unauthorized, (await Get(Client("127.0.0.1"), PageApi, null)).StatusCode);

        // signed-in admin (e.g. the Tester tab in an admin browser)
        Assert.NotEqual(HttpStatusCode.Unauthorized, (await _admin.CreateClient().GetAsync(PageApi)).StatusCode);
    }

    [Fact]
    public async Task Loopback_Exemption_Can_Be_Turned_Off()
    {
        using var strict = _f.WithWebHostBuilder(b => b.UseSetting("ViewToken:ExemptLoopback", "false"));
        var c = strict.CreateClient();
        c.DefaultRequestHeaders.Add("X-Test-Remote-IP", "127.0.0.1");
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync(PageApi)).StatusCode);
    }

    [Fact]
    public async Task Rejections_And_Viewers_Are_Visible_To_The_Admin_Not_In_The_Room()
    {
        var c = Client("10.50.0.5");
        await Get(c, PageApi, null);
        await Get(c, PageApi, null);
        var token = await c.PageTokenAsync("/MHxViewer/MHxView");
        await Get(c, PageApi, token);

        var views = _f.Services.GetRequiredService<BellBeast.ApiAccess.ViewTokenService>();
        Assert.Contains(views.ListRejections(), r => r.Ip == "10.50.0.5" && r.Count >= 2 && r.LastReason == "view_token_missing");
        Assert.Contains(views.ListViewers(), v => v.Ip == "10.50.0.5" && v.Pages.Contains("/MHxViewer/MHxView"));

        // the public room gets counts only (published at start-up, then every 30 s)
        var room = await Client("10.50.0.6").GetStringAsync("/api/iot/room/snapshot");
        Assert.Contains("bellbeast-traffic", room);
        Assert.Contains("rejected_last_min", room);
        Assert.DoesNotContain("10.50.0.5", room);
    }

    [Fact]
    public async Task Admin_Viewers_Api_Needs_Admin()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client("10.50.0.7").GetAsync("/api/admin/ip/viewers")).StatusCode);
        var ok = await _admin.CreateClient().GetStringAsync("/api/admin/ip/viewers");
        Assert.Contains("\"viewers\"", ok);
        Assert.Contains("\"rejected\"", ok);
    }
}
