using System.Net;
using System.Text;
using System.Text.Json;
using BellBeast.ApiAccess;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

public sealed class TightRateFactory : BellBeastBaseFactory
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.UseSetting("RateLimit:PerIpPerMinute", "3");
    }
}

/// <summary>Phase 2: API catalog (enable/disable), API-key clients (grants), rate limits.</summary>
public sealed class ApiAccessTests : IClassFixture<BellBeastBaseFactory>, IClassFixture<BellBeastAdminFactory>
{
    private const string GrantableApi = "GET /api/backend-config";   // user-level (login required) API
    private readonly BellBeastBaseFactory _anon;
    private readonly BellBeastAdminFactory _admin;

    public ApiAccessTests(BellBeastBaseFactory anon, BellBeastAdminFactory admin) { _anon = anon; _admin = admin; }

    private static JsonElement J(string json) => JsonDocument.Parse(json).RootElement;
    private static StringContent Body(string json) => new(json, Encoding.UTF8, "application/json");

    private string NewKey(string json)
    {
        var svc = _anon.Services.GetRequiredService<ApiClientService>();
        var catalog = _anon.Services.GetRequiredService<ApiCatalogService>();
        var grantable = catalog.List().Where(a => a.Access == "user").Select(a => a.Id).ToHashSet();
        var (_, key, err) = svc.Create(J(json), grantable.Contains, "test");
        Assert.Null(err);
        return key!;
    }

    private HttpRequestMessage Keyed(HttpMethod m, string path, string key)
    {
        var r = new HttpRequestMessage(m, path);
        r.Headers.Add("X-Api-Key", key);
        return r;
    }

    // ── catalog ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task Catalog_Lists_Apis_With_Access_Level()
    {
        var doc = J(await _admin.CreateClient().GetStringAsync("/api/admin/api/catalog"));
        var apis = doc.GetProperty("apis").EnumerateArray().ToDictionary(a => a.GetProperty("id").GetString()!, a => a);

        Assert.Equal("public", apis["GET /api/dps/summary"].GetProperty("access").GetString());
        Assert.Equal("user", apis[GrantableApi].GetProperty("access").GetString());
        Assert.Equal("admin", apis["POST /api/admin/pause"].GetProperty("access").GetString());
        Assert.True(apis["GET /api/admin/api/catalog"].GetProperty("locked").GetBoolean());
    }

    [Fact]
    public async Task Disabled_Api_Returns_404_Until_Enabled_Again()
    {
        var catalog = _anon.Services.GetRequiredService<ApiCatalogService>();
        const string id = "GET /api/engine/sequence/status";
        var c = _anon.CreateClient();
        try
        {
            Assert.Null(catalog.Set(id, false, "maintenance", "test"));
            var r = await c.GetAsync("/api/engine/sequence/status");
            Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
            Assert.Equal("api_disabled", J(await r.Content.ReadAsStringAsync()).GetProperty("error").GetString());
        }
        finally { catalog.Set(id, true, "", "test"); }

        Assert.NotEqual(HttpStatusCode.NotFound, (await c.GetAsync("/api/engine/sequence/status")).StatusCode);
    }

    [Fact]
    public async Task Admin_Catalog_Apis_Cannot_Be_Disabled()
    {
        var r = await _admin.CreateClient().PostAsync("/api/admin/api/catalog",
            Body("""{"id":"GET /api/admin/api/catalog","enabled":false}"""));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Contains("api_locked", await r.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Admin_Api_Page_Needs_Admin()
    {
        var anon = _anon.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        var r = await anon.GetAsync("/Admin/Api");
        Assert.Equal(HttpStatusCode.Redirect, r.StatusCode);
        Assert.Contains("/Admin/Login", r.Headers.Location?.ToString() ?? "", StringComparison.OrdinalIgnoreCase);

        var html = await _admin.CreateClient().GetStringAsync("/Admin/Api");
        Assert.Contains("/js/apiadmin.js", html);
        Assert.Contains("href=\"/Admin/Api\"", html);   // tab in the admin strip
    }

    // ── API clients ─────────────────────────────────────────────────────────

    [Fact]
    public async Task Admin_Creates_Client_And_Gets_Key_Once()
    {
        var c = _admin.CreateClient();
        var r = await c.PostAsync("/api/admin/api/clients", Body($$"""{"name":"partner","grants":["{{GrantableApi}}"],"rate_per_minute":60}"""));
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var doc = J(await r.Content.ReadAsStringAsync());
        Assert.StartsWith("bbk_", doc.GetProperty("key").GetString());
        var id = doc.GetProperty("client").GetProperty("id").GetString();

        var list = await c.GetStringAsync("/api/admin/api/clients");
        Assert.Contains(id!, list);
        Assert.DoesNotContain(doc.GetProperty("key").GetString()!, list);      // plain key never listed
        Assert.DoesNotContain("key_sha256", list);                              // nor its hash
    }

    [Fact]
    public async Task Admin_Apis_Are_Not_Grantable()
    {
        var r = await _admin.CreateClient().PostAsync("/api/admin/api/clients",
            Body("""{"name":"x","grants":["POST /api/admin/pause"]}"""));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Contains("not_grantable", await r.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Key_Opens_Only_Granted_Apis()
    {
        var granted = NewKey($$"""{"name":"granted","grants":["{{GrantableApi}}"]}""");
        var none = NewKey("""{"name":"none"}""");
        var c = _anon.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(Keyed(HttpMethod.Get, "/api/backend-config", granted))).StatusCode);

        var denied = await c.SendAsync(Keyed(HttpMethod.Get, "/api/backend-config", none));
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Contains("api_not_granted", await denied.Content.ReadAsStringAsync());

        // public APIs need no grant; admin APIs never accept a key
        Assert.NotEqual(HttpStatusCode.Forbidden, (await c.SendAsync(Keyed(HttpMethod.Get, "/api/engine/sequence/status", none))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.SendAsync(Keyed(HttpMethod.Post, "/api/admin/pause", granted))).StatusCode);
    }

    [Fact]
    public async Task Bearer_Header_Works_Too()
    {
        var key = NewKey($$"""{"name":"bearer","grants":["{{GrantableApi}}"]}""");
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/backend-config");
        req.Headers.Authorization = new("Bearer", key);
        Assert.Equal(HttpStatusCode.OK, (await _anon.CreateClient().SendAsync(req)).StatusCode);
    }

    [Fact]
    public async Task Unknown_Disabled_And_Rotated_Keys_Are_Rejected()
    {
        var c = _anon.CreateClient();
        var bad = await c.SendAsync(Keyed(HttpMethod.Get, "/api/engine/sequence/status", "bbk_nope"));
        Assert.Equal(HttpStatusCode.Unauthorized, bad.StatusCode);
        Assert.Contains("api_key_unknown", await bad.Content.ReadAsStringAsync());

        var svc = _anon.Services.GetRequiredService<ApiClientService>();
        var key = NewKey($$"""{"name":"rot","grants":["{{GrantableApi}}"]}""");
        var id = svc.List().First(x => x.Name == "rot").Id;

        var (newKey, _) = svc.Rotate(id, "test");
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.SendAsync(Keyed(HttpMethod.Get, "/api/backend-config", key))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(Keyed(HttpMethod.Get, "/api/backend-config", newKey!))).StatusCode);

        svc.Update(id, J("""{"enabled":false}"""), _ => true, "test");
        var off = await c.SendAsync(Keyed(HttpMethod.Get, "/api/backend-config", newKey!));
        Assert.Equal(HttpStatusCode.Unauthorized, off.StatusCode);
        Assert.Contains("api_key_disabled", await off.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Expired_Key_Is_Rejected()
    {
        var key = NewKey($$"""{"name":"old","grants":["{{GrantableApi}}"],"expires_at":"2020-01-01T00:00:00Z"}""");
        var r = await _anon.CreateClient().SendAsync(Keyed(HttpMethod.Get, "/api/backend-config", key));
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.Contains("api_key_expired", await r.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Client_Over_Its_Rate_Gets_429()
    {
        var key = NewKey($$"""{"name":"slow","grants":["{{GrantableApi}}"],"rate_per_minute":2}""");
        var c = _anon.CreateClient();
        for (var i = 0; i < 2; i++)
            Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(Keyed(HttpMethod.Get, "/api/backend-config", key))).StatusCode);
        var r = await c.SendAsync(Keyed(HttpMethod.Get, "/api/backend-config", key));
        Assert.Equal(HttpStatusCode.TooManyRequests, r.StatusCode);
        Assert.Contains("rate_limited", await r.Content.ReadAsStringAsync());
    }
}

public sealed class IpRateLimitTests : IClassFixture<TightRateFactory>
{
    private readonly TightRateFactory _f;
    public IpRateLimitTests(TightRateFactory f) => _f = f;

    [Fact]
    public async Task Per_Ip_Limit_Applies_To_Api_Only()
    {
        var c = _f.CreateClient();
        for (var i = 0; i < 3; i++)
            Assert.NotEqual(HttpStatusCode.TooManyRequests, (await c.GetAsync("/api/engine/sequence/status")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await c.GetAsync("/api/engine/sequence/status")).StatusCode);

        // pages are not rate limited
        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await c.GetAsync("/Login")).StatusCode);
    }
}
