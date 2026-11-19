using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using BellBeast.ApiAccess;
using BellBeast.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

/// <summary>
/// Device APIs (alarm feed, clips, lab glance, IoT room, firmware download): only our pages (view token),
/// staff, the server itself and approved annunciators — by device key, or by IP pass while old firmware is
/// around. Shadow mode lets everyone through and records who would be blocked.
/// </summary>
public sealed class DeviceAccessTests : IClassFixture<IpPassFactory>
{
    private const string Feed = "/api/alarm/active";
    private readonly IpPassFactory _f;

    public DeviceAccessTests(IpPassFactory f) => _f = f;

    private DeviceAccessService Access => _f.Services.GetRequiredService<DeviceAccessService>();
    private DeviceFleetService Fleet => _f.Services.GetRequiredService<DeviceFleetService>();

    private HttpClient Client(string ip)
    {
        var c = _f.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false, AllowAutoRedirect = false });
        c.DefaultRequestHeaders.Add("X-Test-Remote-IP", ip);
        return c;
    }

    private static string NewKey() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private static string NewId() => "ann-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(3)).ToLowerInvariant();

    private static HttpRequestMessage Get(string path, string? id = null, string? key = null)
    {
        var r = new HttpRequestMessage(HttpMethod.Get, path);
        if (id is not null) r.Headers.Add("X-Device-Id", id);
        if (key is not null) r.Headers.Add("X-Device-Key", key);
        return r;
    }

    /// <summary>A device that has reported once from <paramref name="ip"/>, approved or not.</summary>
    private async Task<(string Id, string Key)> Device(string ip, bool approved)
    {
        var (id, key) = (NewId(), NewKey());
        var r = new HttpRequestMessage(HttpMethod.Post, $"/api/device/{id}/report") { Content = JsonContent.Create(new { fw = "ann-1.3.1" }) };
        r.Headers.Add("X-Device-Key", key);
        Assert.Equal(HttpStatusCode.OK, (await Client(ip).SendAsync(r)).StatusCode);
        if (approved) Assert.Null(Fleet.UpdateDevice(id, JsonSerializer.SerializeToElement(new { approved = true })));
        return (id, key);
    }

    [Fact]
    public async Task Shadow_Mode_Lets_Everyone_Through_And_Records_Who_Would_Be_Blocked()
    {
        Assert.Null(Access.Update("shadow", true, "test"));
        Assert.Equal(HttpStatusCode.OK, (await Client("10.70.0.9").SendAsync(Get(Feed))).StatusCode);
        var miss = Access.Misses().Single(m => m.Ip == "10.70.0.9");
        Assert.Equal("GET " + Feed, miss.LastRoute);
        Assert.Equal("no_device_key", miss.Reason);
        Assert.False(miss.Blocked);
    }

    [Fact]
    public async Task Enforce_Allows_Approved_Device_Key_From_Any_Ip_And_Blocks_The_Rest()
    {
        Assert.Null(Access.Update("enforce", false, "test"));
        try
        {
            var (id, key) = await Device("10.70.1.1", approved: true);
            var (pid, pkey) = await Device("10.70.1.2", approved: false);

            Assert.Equal(HttpStatusCode.Unauthorized, (await Client("10.70.1.50").SendAsync(Get(Feed))).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await Client("10.70.1.99").SendAsync(Get(Feed, id, key))).StatusCode);       // key, not IP
            Assert.Equal(HttpStatusCode.Unauthorized, (await Client("10.70.1.99").SendAsync(Get(Feed, id, NewKey()))).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Client("10.70.1.2").SendAsync(Get(Feed, pid, pkey))).StatusCode);   // not approved
            Assert.Equal("device_key_invalid", Access.Misses().Single(m => m.Ip == "10.70.1.2").Reason);

            // the rest of the device APIs behind the same gate
            Assert.Equal(HttpStatusCode.Unauthorized, (await Client("10.70.1.50").SendAsync(Get("/api/iot/room/members"))).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Client("10.70.1.50").SendAsync(Get("/api/ota/firmware/1.0.0"))).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await Client("10.70.1.99").SendAsync(Get("/api/iot/room/members", id, key))).StatusCode);

            var caller = Access.Callers().First(c => c.Device == id);
            Assert.Equal("key", caller.Via);
            Assert.Equal("10.70.1.99", caller.Ip);

            // our own pages keep working with their view token
            var page = Client("10.70.1.60");
            await page.WithViewTokenAsync();
            Assert.Equal(HttpStatusCode.OK, (await page.SendAsync(Get(Feed))).StatusCode);
        }
        finally { Access.Update("shadow", true, "test"); }
    }

    [Fact]
    public async Task Ip_Pass_Bridges_Old_Firmware_Until_Switched_Off()
    {
        Assert.Null(Access.Update("enforce", true, "test"));
        try
        {
            var (id, _) = await Device("10.70.2.1", approved: true);
            Assert.Equal(HttpStatusCode.OK, (await Client("10.70.2.1").SendAsync(Get(Feed))).StatusCode);            // no key: old firmware
            Assert.Equal("ip_pass", Access.Callers().First(c => c.Device == id).Via);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Client("10.70.2.2").SendAsync(Get(Feed))).StatusCode);  // other IP

            Assert.Null(Access.Update(null, false, "test"));
            Assert.Equal(HttpStatusCode.Unauthorized, (await Client("10.70.2.1").SendAsync(Get(Feed))).StatusCode);
        }
        finally { Access.Update("shadow", true, "test"); }
    }

    [Fact]
    public void Bad_Mode_Is_Rejected() => Assert.Equal("bad_mode", Access.Update("off", null, "test"));
}
