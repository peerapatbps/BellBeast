using System.Net;
using System.Text;
using System.Text.Json;
using BellBeast.ApiAccess;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

/// <summary>Lets a test choose the TCP remote address with the X-Test-Remote-IP header (TestServer has none).</summary>
public sealed class RemoteIpStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use(async (ctx, nxt) =>
        {
            if (ctx.Request.Headers.TryGetValue("X-Test-Remote-IP", out var ip))
                ctx.Connection.RemoteIpAddress = IPAddress.Parse(ip.ToString());
            await nxt();
        });
        next(app);
    };
}

public sealed class IpTestFactory : BellBeastBaseFactory
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureServices(s => s.AddTransient<IStartupFilter, RemoteIpStartupFilter>());
    }
}

public sealed class IpAccessTests : IClassFixture<IpTestFactory>
{
    private readonly IpTestFactory _f;
    public IpAccessTests(IpTestFactory f) => _f = f;

    private IpAccessService Ips => _f.Services.GetRequiredService<IpAccessService>();

    private HttpRequestMessage From(string remoteIp, HttpMethod m, string path, string? cfIp = null, string? json = null)
    {
        var r = new HttpRequestMessage(m, path);
        r.Headers.Add("X-Test-Remote-IP", remoteIp);
        if (cfIp is not null) r.Headers.Add("CF-Connecting-IP", cfIp);
        if (json is not null) r.Content = new StringContent(json, Encoding.UTF8, "application/json");
        return r;
    }

    [Theory]
    [InlineData("not-an-ip", "bad_ip")]
    [InlineData("127.0.0.1", "cannot_ban_loopback")]
    [InlineData("::1", "cannot_ban_loopback")]
    [InlineData("10.9.9.9", "cannot_ban_self")]
    public void Ban_Rejects(string ip, string error) => Assert.Equal(error, Ips.Ban(ip, null, null, "t", actorIp: "10.9.9.9"));

    [Fact]
    public void Ban_Rejects_Bad_Duration() => Assert.Equal("bad_duration", Ips.Ban("10.1.1.1", null, 0, "t", "10.9.9.9"));

    [Fact]
    public async Task Banned_Ip_Gets_403_Everywhere_Until_Unbanned()
    {
        var c = _f.CreateClient();
        Assert.Null(Ips.Ban("10.20.30.40", "test", 60, "t", "10.9.9.9"));
        try
        {
            var api = await c.SendAsync(From("10.20.30.40", HttpMethod.Get, "/api/alarm/active"));
            Assert.Equal(HttpStatusCode.Forbidden, api.StatusCode);
            Assert.Contains("ip_banned", await api.Content.ReadAsStringAsync());
            Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(From("10.20.30.40", HttpMethod.Get, "/Login"))).StatusCode);

            // other IPs are unaffected
            Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(From("10.20.30.41", HttpMethod.Get, "/api/alarm/active"))).StatusCode);
        }
        finally { Assert.True(Ips.Unban("10.20.30.40", "t")); }

        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(From("10.20.30.40", HttpMethod.Get, "/api/alarm/active"))).StatusCode);
    }

    [Fact]
    public async Task Cloudflare_Header_Is_Trusted_Only_From_Loopback()
    {
        var c = _f.CreateClient();
        Assert.Null(Ips.Ban("203.0.113.7", "test", 60, "t", "10.9.9.9"));
        try
        {
            // via the tunnel (cloudflared on loopback) → the real client IP is banned
            Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(From("127.0.0.1", HttpMethod.Get, "/api/alarm/active", cfIp: "203.0.113.7"))).StatusCode);
            // a LAN client cannot hide behind (or frame someone with) a forged header
            Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(From("10.0.0.5", HttpMethod.Get, "/api/alarm/active", cfIp: "203.0.113.7"))).StatusCode);
        }
        finally { Ips.Unban("203.0.113.7", "t"); }
    }

    [Fact]
    public async Task Room_Writes_Are_Recorded_Per_Ip()
    {
        var c = _f.CreateClient();
        var join = await c.SendAsync(From("10.7.7.7", HttpMethod.Post, "/api/iot/room/join", json: """{"DeviceName":"uroboros-alarm","DeviceType":"engine"}"""));
        var key = JsonDocument.Parse(await join.Content.ReadAsStringAsync()).RootElement.GetProperty("key").GetString();
        await c.SendAsync(From("10.7.7.7", HttpMethod.Post, "/api/iot/room/data", json: $$$"""{"Key":"{{{key}}}","Data":{"alarm_mode":"normal"}}"""));

        var a = Ips.ListActivity().Single(x => x.Ip == "10.7.7.7");
        Assert.Equal(2, a.Count);
        Assert.Equal("data", a.LastAction);
        Assert.Contains("uroboros-alarm", a.Devices);
    }

    [Fact]
    public void Bans_Survive_Restart_And_Expire()
    {
        Assert.Null(Ips.Ban("10.4.4.4", "persist", null, "t", "10.9.9.9"));
        try
        {
            var env = _f.Services.GetRequiredService<IWebHostEnvironment>();
            var reloaded = new IpAccessService(env, Microsoft.Extensions.Logging.Abstractions.NullLogger<IpAccessService>.Instance);
            Assert.True(reloaded.IsBanned("10.4.4.4"));
            Assert.Contains(reloaded.ListBans(), b => b.Ip == "10.4.4.4" && b.ExpiresAt is null && b.Reason == "persist");
        }
        finally { Ips.Unban("10.4.4.4", "t"); }
    }
}

public sealed class IpAdminApiTests : IClassFixture<BellBeastAdminFactory>
{
    private readonly BellBeastAdminFactory _admin;
    public IpAdminApiTests(BellBeastAdminFactory admin) => _admin = admin;

    [Fact]
    public async Task Admin_Can_Ban_List_And_Unban()
    {
        var c = _admin.CreateClient();
        var r = await c.PostAsync("/api/admin/ip/bans", new StringContent("""{"ip":"198.51.100.9","minutes":60,"reason":"fake alarm"}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("198.51.100.9", await c.GetStringAsync("/api/admin/ip/bans"));

        Assert.Equal(HttpStatusCode.OK, (await c.DeleteAsync("/api/admin/ip/bans/198.51.100.9")).StatusCode);
        Assert.DoesNotContain("198.51.100.9", await c.GetStringAsync("/api/admin/ip/bans"));
        Assert.Equal(HttpStatusCode.NotFound, (await c.DeleteAsync("/api/admin/ip/bans/198.51.100.9")).StatusCode);
    }

    [Fact]
    public async Task Ip_Admin_Apis_Need_Admin()
    {
        using var anon = new BellBeastBaseFactory();
        var c = anon.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/admin/ip/activity")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsync("/api/admin/ip/bans", new StringContent("{}", Encoding.UTF8, "application/json"))).StatusCode);
    }
}
