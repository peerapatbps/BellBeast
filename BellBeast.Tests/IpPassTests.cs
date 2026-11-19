using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using BellBeast.ApiAccess;
using BellBeast.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

/// <summary>Anonymous callers with the remote IP chosen per request (X-Test-Remote-IP).</summary>
public sealed class IpPassFactory : BellBeastBaseFactory
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureServices(s => s.AddTransient<IStartupFilter, RemoteIpStartupFilter>());
    }
}

/// <summary>
/// IP passes: page APIs without a view token for the truck scale (admin-entered IP) and approved
/// fleet devices (connection IP of their last authenticated report) — only for the APIs granted.
/// </summary>
public sealed class IpPassTests : IClassFixture<IpPassFactory>, IClassFixture<BellBeastAdminFactory>
{
    private const string ClApi = "/api/cldetector/summary";            // annunciator chlorine page
    private const string ChemApi = "/api/chem/summary";                // TruckSidecar
    private const string OtherPageApi = "/api/engine/sequence/status";  // page API nobody was granted
    private readonly IpPassFactory _f;
    private readonly BellBeastAdminFactory _admin;

    public IpPassTests(IpPassFactory f, BellBeastAdminFactory admin)
    {
        _f = f; _admin = admin;
        // measure IpPassService alone: device APIs enforced, without the device-access IP bridge
        Assert.Null(f.Services.GetRequiredService<DeviceAccessService>().Update("enforce", false, "test"));
    }

    private HttpClient Client(string ip)
    {
        var c = _f.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false, AllowAutoRedirect = false });
        c.DefaultRequestHeaders.Add("X-Test-Remote-IP", ip);
        return c;
    }

    private static readonly Func<string, bool> AnyRoute = _ => true;

    private static async Task<HttpStatusCode> Status(HttpClient c, string path) => (await c.GetAsync(path)).StatusCode;

    private static string NewKey() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private static string NewId() => "ann-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(3)).ToLowerInvariant();

    private static async Task Report(HttpClient c, string id, string key, string? claimedIp = null)
    {
        var r = new HttpRequestMessage(HttpMethod.Post, $"/api/device/{id}/report") { Content = JsonContent.Create(new { fw = "1.3.0", ip = claimedIp }) };
        r.Headers.Add("X-Device-Key", key);
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(r)).StatusCode);
    }

    private void Approve(string id, bool approved) =>
        Assert.Null(_f.Services.GetRequiredService<DeviceFleetService>().UpdateDevice(id, JsonSerializer.SerializeToElement(new { approved })));

    [Fact]
    public async Task Manual_Pass_Opens_Only_The_Granted_Api_For_That_Ip()
    {
        var passes = _f.Services.GetRequiredService<IpPassService>();
        var scale = Client("10.60.0.1");
        var other = Client("10.60.0.2");

        Assert.Equal(HttpStatusCode.Unauthorized, await Status(scale, ChemApi));

        Assert.Null(passes.Upsert("10.60.0.1", ["GET " + ChemApi], "truck scale", AnyRoute, "test"));
        Assert.NotEqual(HttpStatusCode.Unauthorized, await Status(scale, ChemApi));
        Assert.Equal(HttpStatusCode.Unauthorized, await Status(scale, OtherPageApi));   // only what was granted
        Assert.Equal(HttpStatusCode.Unauthorized, await Status(other, ChemApi));        // only that IP
        Assert.True(passes.UsageByIp()["10.60.0.1"].Hits >= 1);

        Assert.True(passes.Remove("10.60.0.1", "test"));
        Assert.Equal(HttpStatusCode.Unauthorized, await Status(scale, ChemApi));
    }

    [Fact]
    public async Task Approved_Fleet_Device_Gets_Fleet_Routes_From_Its_Connection_Ip()
    {
        var dev = Client("10.61.0.5");
        var id = NewId();
        var key = NewKey();

        await Report(dev, id, key);                                                     // registers as pending
        Assert.Equal(HttpStatusCode.Unauthorized, await Status(dev, ClApi));

        Approve(id, true);
        Assert.NotEqual(HttpStatusCode.Unauthorized, await Status(dev, ClApi));         // default fleet route
        Assert.Equal(HttpStatusCode.Unauthorized, await Status(dev, OtherPageApi));
        Assert.Equal(HttpStatusCode.Unauthorized, await Status(Client("10.61.0.6"), ClApi));

        Approve(id, false);
        Assert.Equal(HttpStatusCode.Unauthorized, await Status(dev, ClApi));            // revoked at once
    }

    [Fact]
    public async Task Fleet_Pass_Ignores_The_Ip_A_Device_Claims_And_Follows_Dhcp()
    {
        var id = NewId();
        var key = NewKey();
        await Report(Client("10.62.0.5"), id, key, claimedIp: "10.62.0.99");
        Approve(id, true);

        Assert.Equal(HttpStatusCode.Unauthorized, await Status(Client("10.62.0.99"), ClApi));   // the claim gives nothing
        Assert.NotEqual(HttpStatusCode.Unauthorized, await Status(Client("10.62.0.5"), ClApi));

        // DHCP hands the device a new address: the next authenticated report moves the pass
        await Report(Client("10.62.0.7"), id, key);
        Assert.NotEqual(HttpStatusCode.Unauthorized, await Status(Client("10.62.0.7"), ClApi));
        Assert.Equal(HttpStatusCode.Unauthorized, await Status(Client("10.62.0.5"), ClApi));

        // a wrong key from another IP neither moves nor gets the pass
        var bad = new HttpRequestMessage(HttpMethod.Post, $"/api/device/{id}/report") { Content = JsonContent.Create(new { fw = "x" }) };
        bad.Headers.Add("X-Device-Key", NewKey());
        Assert.Equal(HttpStatusCode.Forbidden, (await Client("10.62.0.8").SendAsync(bad)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, await Status(Client("10.62.0.8"), ClApi));
    }

    [Fact]
    public void Fleet_Pass_Expires_When_The_Device_Stops_Reporting()
    {
        var fleet = _f.Services.GetRequiredService<DeviceFleetService>();
        var id = NewId();
        Assert.Equal(DeviceFleetService.AuthStatus.Registered, fleet.Authenticate(id, NewKey(), "10.63.0.5").Status);
        Approve(id, true);
        Assert.Null(fleet.ApprovedDeviceAt("10.63.0.5", TimeSpan.Zero));
        Assert.Equal(id, fleet.ApprovedDeviceAt("10.63.0.5", TimeSpan.FromMinutes(10)));
    }

    [Fact]
    public async Task Fleet_Routes_Can_Be_Changed_Or_Emptied()
    {
        var passes = _f.Services.GetRequiredService<IpPassService>();
        var id = NewId();
        var key = NewKey();
        var dev = Client("10.64.0.5");
        await Report(dev, id, key);
        Approve(id, true);
        try
        {
            Assert.Null(passes.SetFleetRoutes([], AnyRoute, "test"));
            Assert.Equal(HttpStatusCode.Unauthorized, await Status(dev, ClApi));
            Assert.Null(passes.SetFleetRoutes(["GET " + OtherPageApi], AnyRoute, "test"));
            Assert.NotEqual(HttpStatusCode.Unauthorized, await Status(dev, OtherPageApi));
            Assert.Equal(HttpStatusCode.Unauthorized, await Status(dev, ClApi));
        }
        finally { Assert.Null(passes.SetFleetRoutes(IpPassService.DefaultFleetRoutes, AnyRoute, "test")); }
    }

    [Fact]
    public async Task Admin_Api_Validates_And_Persists_Passes()
    {
        var c = _admin.CreateClient();
        async Task<string?> Post(string url, object body)
        {
            var r = await c.PostAsJsonAsync(url, body);
            var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;
            return j.GetProperty("ok").GetBoolean() ? null : j.GetProperty("error").GetString();
        }

        var view = JsonDocument.Parse(await c.GetStringAsync("/api/admin/ip/passes")).RootElement;
        var pageRoutes = view.GetProperty("page_routes").EnumerateArray().Select(x => x.GetString()).ToList();
        Assert.Contains("GET " + ChemApi, pageRoutes);
        Assert.Contains("GET /api/alarm/active", pageRoutes);                            // device APIs can be passed too
        Assert.DoesNotContain("GET /api/stage", pageRoutes);                             // public: needs no pass
        Assert.Equal("GET " + ClApi, view.GetProperty("fleet_routes")[0].GetString());

        Assert.Equal("bad_ip", await Post("/api/admin/ip/passes", new { ip = "not-an-ip", routes = new[] { "GET " + ChemApi } }));
        Assert.Equal("no_routes", await Post("/api/admin/ip/passes", new { ip = "10.65.0.1", routes = Array.Empty<string>() }));
        Assert.StartsWith("not_page_api:", await Post("/api/admin/ip/passes", new { ip = "10.65.0.1", routes = new[] { "GET /api/stage" } }));
        Assert.StartsWith("not_page_api:", await Post("/api/admin/ip/passes", new { ip = "10.65.0.1", routes = new[] { "POST /api/process" } }));
        Assert.StartsWith("not_page_api:", await Post("/api/admin/ip/passes/fleet", new { routes = new[] { "GET /api/admin/ip/bans" } }));

        Assert.Null(await Post("/api/admin/ip/passes", new { ip = " 10.65.0.1 ", routes = new[] { "GET " + ChemApi }, note = "truck scale" }));
        var file = Path.Combine(_admin.Services.GetRequiredService<IWebHostEnvironment>().ContentRootPath, "App_Data", "ip-passes.json");
        Assert.Contains("10.65.0.1", File.ReadAllText(file));
        var saved = _admin.Services.GetRequiredService<IpPassService>().List().Single(p => p.Ip == "10.65.0.1");
        Assert.Equal(["GET " + ChemApi], saved.Routes);
        Assert.Equal("truck scale", saved.Note);

        Assert.Equal(HttpStatusCode.OK, (await c.DeleteAsync("/api/admin/ip/passes/10.65.0.1")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.DeleteAsync("/api/admin/ip/passes/10.65.0.1")).StatusCode);
    }

    [Fact]
    public async Task Admin_Can_Clear_A_Rejected_Row()
    {
        var views = _admin.Services.GetRequiredService<ViewTokenService>();
        views.RecordRejection("10.67.0.1", ChemApi, "view_token_missing");
        var c = _admin.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await c.DeleteAsync("/api/admin/ip/rejected/10.67.0.1")).StatusCode);
        Assert.DoesNotContain(views.ListRejections(), r => r.Ip == "10.67.0.1");
        Assert.Equal(HttpStatusCode.NotFound, (await c.DeleteAsync("/api/admin/ip/rejected/10.67.0.1")).StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, (await Client("10.67.0.2").DeleteAsync("/api/admin/ip/rejected/10.67.0.1")).StatusCode);
    }

    [Fact]
    public async Task Pass_Admin_Api_Needs_Admin()
    {
        var c = Client("10.66.0.1");
        Assert.NotEqual(HttpStatusCode.OK, (await c.GetAsync("/api/admin/ip/passes")).StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, (await c.PostAsJsonAsync("/api/admin/ip/passes", new { ip = "10.66.0.1", routes = new[] { "GET " + ChemApi } })).StatusCode);
        Assert.DoesNotContain(_f.Services.GetRequiredService<IpPassService>().List(), p => p.Ip == "10.66.0.1");
    }
}
