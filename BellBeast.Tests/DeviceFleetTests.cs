using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using BellBeast.Services;
using Xunit;

/// <summary>
/// Annunciator fleet (P4): device key TOFU + approval, report → registry/audit log, config with ETag
/// (WiFi only for approved devices), OTA manifest per channel + firmware download, admin-only writes.
/// </summary>
public sealed class DeviceFleetTests : IClassFixture<BellBeastAdminFactory>, IClassFixture<BellBeastBaseFactory>
{
    private readonly BellBeastAdminFactory _admin;
    private readonly BellBeastBaseFactory _anon;

    public DeviceFleetTests(BellBeastAdminFactory admin, BellBeastBaseFactory anon)
    {
        _admin = admin;
        _anon = anon;
    }

    /// <summary>Fake ESP app image: magic 0xE9 + esp_app_desc_t (magic word + version) where the real image has it.</summary>
    internal static byte[] Image(string version)
    {
        var bin = new byte[4096];
        RandomNumberGenerator.Fill(bin);
        bin[0] = 0xE9;
        BitConverter.GetBytes(0xABCD5432u).CopyTo(bin, 0x20);
        Array.Clear(bin, 0x30, 32);
        Encoding.ASCII.GetBytes(version).CopyTo(bin, 0x30);
        return bin;
    }

    private static string NewKey() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private static string NewId() => "ann-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(3)).ToLowerInvariant();

    private static HttpRequestMessage Dev(HttpMethod m, string url, string key, object? body = null)
    {
        var r = new HttpRequestMessage(m, url);
        r.Headers.Add("X-Device-Key", key);
        if (body is not null) r.Content = JsonContent.Create(body);
        return r;
    }

    private static async Task<JsonElement> Json(HttpResponseMessage r) =>
        JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement.Clone();

    private async Task<JsonElement> DeviceRow(HttpClient c, string id)
    {
        var fleet = await c.GetFromJsonAsync<JsonElement>("/api/admin/fleet");
        return fleet.GetProperty("devices").EnumerateArray().Single(d => d.GetProperty("id").GetString() == id);
    }

    [Fact]
    public async Task First_Report_Registers_Pending_Device_And_Key_Is_Enforced()
    {
        var c = _admin.CreateClient();
        var id = NewId(); var key = NewKey();
        var rep = await c.SendAsync(Dev(HttpMethod.Post, $"/api/device/{id}/report", key, new
        {
            fw = "2.0.0", ip = "172.22.46.64", partition = "ota_0", wifi_tier = "bootstrap", rssi = -61, uptime_sec = 42,
            events = new object[]
            {
                new { ts = 1791600000L, type = "boot", detail = "power-on" },
                new { ts = 1791600060L, type = "played", alarm_id = "rwp1_flowp1_anomaly" },
                new { ts = 1791600090L, type = "ack", alarm_id = "rwp1_flowp1_anomaly", detail = "touch" },
            },
        }));
        Assert.Equal(HttpStatusCode.OK, rep.StatusCode);
        var j = await Json(rep);
        Assert.False(j.GetProperty("approved").GetBoolean());
        Assert.False(string.IsNullOrEmpty(j.GetProperty("config_etag").GetString()));

        var row = await DeviceRow(c, id);
        Assert.False(row.GetProperty("approved").GetBoolean());
        Assert.Equal("2.0.0", row.GetProperty("fw").GetString());
        Assert.Equal("bootstrap", row.GetProperty("wifi_tier").GetString());
        Assert.Equal("rwp1_flowp1_anomaly", row.GetProperty("last_ack_alarm").GetString());
        Assert.Equal(1, row.GetProperty("reports").GetInt64());
        Assert.DoesNotContain("key_sha256", row.ToString());                 // key hash never leaves the server

        var events = await c.GetFromJsonAsync<JsonElement>($"/api/admin/fleet/events?device={id}");
        var types = events.GetProperty("events").EnumerateArray().Select(e => e.GetProperty("type").GetString()).ToList();
        Assert.Equal(["ack", "played", "boot", "registered"], types);       // newest first

        // another key for the same id → 403 ; malformed → 400
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", NewKey()))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", "nothex"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.SendAsync(Dev(HttpMethod.Get, "/api/device/BAD_ID!/config", key))).StatusCode);
    }

    [Fact]
    public async Task Config_Has_Wifi_Only_After_Approval_And_Supports_Etag()
    {
        var c = _admin.CreateClient();
        var id = NewId(); var key = NewKey();
        Assert.Equal(HttpStatusCode.OK, (await c.PutAsJsonAsync("/api/admin/fleet/wifi", new
        {
            ssid = ".@MWA WiFi", identity = "00102616", current = "pw-current", next = "pw-next", next_valid_from = "2027-01-01T00:00:00+07:00",
        })).StatusCode);

        var pending = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key)));
        Assert.False(pending.GetProperty("approved").GetBoolean());
        Assert.Equal(JsonValueKind.Null, pending.GetProperty("wifi").ValueKind);
        Assert.Equal(5, pending.GetProperty("poll_sec").GetInt32());

        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { approved = true, zones = "rws, dps", remind_sec = 90 })).StatusCode);
        var resp = await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key));
        var cfg = await Json(resp);
        Assert.True(cfg.GetProperty("approved").GetBoolean());
        Assert.Equal("RWS,DPS", cfg.GetProperty("zones").GetString());
        Assert.Equal(90, cfg.GetProperty("remind_sec").GetInt32());
        Assert.Equal(300, cfg.GetProperty("lab_sec").GetInt32());   // fleet defaults for the lab loops
        Assert.Equal(30, cfg.GetProperty("scn_sec").GetInt32());
        var wifi = cfg.GetProperty("wifi");
        Assert.Equal("pw-current", wifi.GetProperty("current").GetString());
        Assert.Equal("pw-next", wifi.GetProperty("next").GetString());
        Assert.Equal(DateTimeOffset.Parse("2027-01-01T00:00:00+07:00").ToUnixTimeSeconds(), wifi.GetProperty("next_valid_from").GetInt64());

        var again = Dev(HttpMethod.Get, $"/api/device/{id}/config", key);
        again.Headers.IfNoneMatch.Add(resp.Headers.ETag!);
        Assert.Equal(HttpStatusCode.NotModified, (await c.SendAsync(again)).StatusCode);

        // admin view masks the passwords
        var view = await c.GetFromJsonAsync<JsonElement>("/api/admin/fleet");
        Assert.DoesNotContain("pw-current", view.ToString());
        Assert.EndsWith("nt", view.GetProperty("wifi").GetProperty("current").GetString());

        // reset key: next device with a new key re-binds and must be approved again
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { reset_key = true })).StatusCode);
        var newKey = NewKey();
        var rebound = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", newKey)));
        Assert.False(rebound.GetProperty("approved").GetBoolean());
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key))).StatusCode);
    }

    [Fact]
    public async Task Ota_Manifest_Follows_Channel_And_Firmware_Downloads_With_Sha()
    {
        var c = _admin.CreateClient();
        var id = NewId(); var key = NewKey();
        var bin = Image("2.1.0-test");
        var sha = Convert.ToHexString(SHA256.HashData(bin)).ToLowerInvariant();

        // label must match the version inside the image (else the device would reinstall forever)
        var wrong = new MultipartFormDataContent { { new StringContent("9.9.9"), "version" } };
        wrong.Add(new ByteArrayContent(bin), "file", "xiaozhi.bin");
        var wr = await c.PostAsync("/api/admin/ota/firmware", wrong);
        Assert.Equal(HttpStatusCode.BadRequest, wr.StatusCode);
        Assert.Contains("version_mismatch", await wr.Content.ReadAsStringAsync());

        var form = new MultipartFormDataContent { { new StringContent("2.1.0-test"), "version" }, { new StringContent("first fleet build"), "note" } };
        var fc = new ByteArrayContent(bin); fc.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        form.Add(fc, "file", "xiaozhi.bin");
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsync("/api/admin/ota/firmware", form)).StatusCode);

        var none = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/ota/manifest?device_id={id}", key)));
        Assert.Equal(JsonValueKind.Null, none.GetProperty("version").ValueKind);

        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync("/api/admin/ota/channel", new { channel = "stable", version = "2.1.0-test" })).StatusCode);
        var m = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/ota/manifest?device_id={id}", key)));
        Assert.Equal("stable", m.GetProperty("channel").GetString());
        Assert.Equal("2.1.0-test", m.GetProperty("version").GetString());
        Assert.Equal(sha, m.GetProperty("sha256").GetString());
        Assert.Equal(4096, m.GetProperty("size").GetInt64());

        var dl = await c.GetAsync(m.GetProperty("url").GetString());
        Assert.Equal(HttpStatusCode.OK, dl.StatusCode);
        Assert.Equal(bin, await dl.Content.ReadAsByteArrayAsync());
        Assert.Equal(sha, dl.Headers.GetValues("X-Firmware-Sha256").Single());

        // staged rollout: this device opts out
        await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { channel = "none" });
        var off = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/ota/manifest?device_id={id}", key)));
        Assert.Equal(JsonValueKind.Null, off.GetProperty("version").ValueKind);

        // firmware in use cannot be deleted; non-ESP image is rejected
        Assert.Equal(HttpStatusCode.BadRequest, (await c.DeleteAsync("/api/admin/ota/firmware/2.1.0-test")).StatusCode);
        var junk = new MultipartFormDataContent { { new StringContent("9.9.9"), "version" } };
        junk.Add(new ByteArrayContent(new byte[2048]), "file", "x.bin");
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsync("/api/admin/ota/firmware", junk)).StatusCode);
    }

    [Fact]
    public async Task Device_Can_Have_Its_Own_Wifi_Or_Fall_Back_To_Fleet_Wifi()
    {
        var c = _admin.CreateClient();
        var id = NewId(); var key = NewKey();
        await c.PutAsJsonAsync("/api/admin/fleet/wifi", new { ssid = ".@MWA WiFi", identity = "fleet-user", current = "pw-fleet" });
        await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key));

        // own set needs a current password; bad patch leaves the device untouched
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { approved = true, wifi = new { ssid = "Lab-IoT" } })).StatusCode);
        Assert.False((await DeviceRow(c, id)).GetProperty("approved").GetBoolean());

        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new
        {
            approved = true, wifi = new { ssid = "Lab-IoT", identity = "lab", current = "pw-own-device" },
        })).StatusCode);
        var cfg = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key)));
        Assert.Equal("Lab-IoT", cfg.GetProperty("wifi").GetProperty("ssid").GetString());
        Assert.Equal("pw-own-device", cfg.GetProperty("wifi").GetProperty("current").GetString());

        var view = await c.GetStringAsync("/api/admin/fleet");
        Assert.DoesNotContain("pw-own-device", view);
        Assert.Equal("Lab-IoT", (await DeviceRow(c, id)).GetProperty("wifi").GetProperty("ssid").GetString());

        // partial patch keeps the password
        await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { wifi = new { next = "pw-own-next" } });
        cfg = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key)));
        Assert.Equal("pw-own-device", cfg.GetProperty("wifi").GetProperty("current").GetString());
        Assert.Equal("pw-own-next", cfg.GetProperty("wifi").GetProperty("next").GetString());

        // null → back to the fleet set
        await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { wifi = (object?)null });
        cfg = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key)));
        Assert.Equal("pw-fleet", cfg.GetProperty("wifi").GetProperty("current").GetString());
        await c.DeleteAsync($"/api/admin/fleet/device/{id}");
    }

    private static MultipartFormDataContent Upload(byte[] bin, string? model)
    {
        var form = new MultipartFormDataContent();
        if (model is not null) form.Add(new StringContent(model), "model");
        form.Add(new ByteArrayContent(bin), "file", "xiaozhi.bin");
        return form;
    }

    [Fact]
    public async Task Firmware_Follows_Device_Model_Track_Or_Pin()
    {
        var c = _admin.CreateClient();
        var (a, ka) = (NewId(), NewKey());
        var (b, kb) = (NewId(), NewKey());
        var binA = Image("3.0.0-mt"); var binB = Image("3.0.0-mt"); var binB2 = Image("3.0.1-mt");
        // same version for two models is fine — images are kept per model
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsync("/api/admin/ota/firmware", Upload(binA, "Board-A"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsync("/api/admin/ota/firmware", Upload(binB, "board-b"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsync("/api/admin/ota/firmware", Upload(binB2, "board-b"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsync("/api/admin/ota/firmware", Upload(binA, "bad model!"))).StatusCode);

        await c.SendAsync(Dev(HttpMethod.Post, $"/api/device/{a}/report", ka, new { fw = "2.0.0", model = "board-a" }));   // model as reported
        await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{b}/config", kb));
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{b}", new { model = "board-b" })).StatusCode);

        // releasing board-a to stable reaches only board-a devices
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/admin/ota/channel", new { model = "board-a", channel = "stable", version = "3.0.1-mt" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync("/api/admin/ota/channel", new { model = "board-a", channel = "stable", version = "3.0.0-mt" })).StatusCode);
        var ma = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/ota/manifest?device_id={a}", ka)));
        Assert.Equal("3.0.0-mt", ma.GetProperty("version").GetString());
        Assert.Equal(binA, await c.GetByteArrayAsync(ma.GetProperty("url").GetString()));
        var mb = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/ota/manifest?device_id={b}", kb)));
        Assert.Equal(JsonValueKind.Null, mb.GetProperty("version").ValueKind);

        // pin: exact image for one device; another model's image is refused
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{b}", new { fw_pin = "board-a/3.0.0-mt" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{b}", new { fw_pin = "board-b/3.0.1-mt" })).StatusCode);
        mb = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/ota/manifest?device_id={b}", kb)));
        Assert.Equal("pin", mb.GetProperty("channel").GetString());
        Assert.Equal("3.0.1-mt", mb.GetProperty("version").GetString());
        Assert.Equal(binB2, await c.GetByteArrayAsync(mb.GetProperty("url").GetString()));
        var row = await DeviceRow(c, b);
        Assert.Equal("3.0.1-mt", row.GetProperty("target_fw").GetString());

        // pinned / released images cannot be deleted; an unused one can
        Assert.Equal(HttpStatusCode.BadRequest, (await c.DeleteAsync("/api/admin/ota/firmware/3.0.1-mt?model=board-b")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.DeleteAsync("/api/admin/ota/firmware/3.0.0-mt?model=board-a")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.DeleteAsync("/api/admin/ota/firmware/3.0.0-mt?model=board-b")).StatusCode);

        // model changed under a pin → nothing is served rather than the wrong board's image
        await c.PostAsJsonAsync($"/api/admin/fleet/device/{b}", new { model = "board-c" });
        mb = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/ota/manifest?device_id={b}", kb)));
        Assert.Equal(JsonValueKind.Null, mb.GetProperty("version").ValueKind);

        await c.PostAsJsonAsync($"/api/admin/fleet/device/{b}", new { fw_pin = (string?)null });
        await c.PostAsJsonAsync("/api/admin/ota/channel", new { model = "board-a", channel = "stable", version = (string?)null });
        await c.DeleteAsync($"/api/admin/fleet/device/{a}");
        await c.DeleteAsync($"/api/admin/fleet/device/{b}");
    }

    [Fact]
    public async Task Event_Log_Keeps_Newest_100_Per_Device()
    {
        var c = _admin.CreateClient();
        var id = NewId(); var key = NewKey();
        for (var r = 0; r < 3; r++)
            await c.SendAsync(Dev(HttpMethod.Post, $"/api/device/{id}/report", key, new
            {
                events = Enumerable.Range(0, 50).Select(i => new { type = "health", detail = $"r{r}-{i}" }).ToArray(),
            }));
        var ev = (await c.GetFromJsonAsync<JsonElement>($"/api/admin/fleet/events?device={id}&n=1000")).GetProperty("events").EnumerateArray().ToList();
        Assert.Equal(DeviceFleetService.MaxEventsPerDevice, ev.Count);
        Assert.Equal("r2-49", ev[0].GetProperty("detail").GetString());     // newest first
        Assert.Equal("r1-0", ev[^1].GetProperty("detail").GetString());     // registered + r0-* rolled off
        await c.DeleteAsync($"/api/admin/fleet/device/{id}");
    }

    [Fact]
    public async Task Admin_Validation_Rejects_Bad_Values()
    {
        var c = _admin.CreateClient();
        var id = NewId(); var key = NewKey();
        await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key));
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { zones = "R W S" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { poll_sec = 0 })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { channel = "nightly" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.PostAsJsonAsync("/api/admin/fleet/device/ann-nope", new { approved = true })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/admin/ota/channel", new { channel = "stable", version = "0.0.0-missing" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.PutAsJsonAsync("/api/admin/fleet/defaults", new { zones = "chem", poll_sec = 3 })).StatusCode);
        var cfg = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key)));
        Assert.Equal("CHEM", cfg.GetProperty("zones").GetString());
        Assert.Equal(3, cfg.GetProperty("poll_sec").GetInt32());
        await c.PutAsJsonAsync("/api/admin/fleet/defaults", new { zones = "", poll_sec = 5 });
        Assert.Equal(HttpStatusCode.OK, (await c.DeleteAsync($"/api/admin/fleet/device/{id}")).StatusCode);
    }

    [Fact]
    public async Task Admin_Endpoints_Need_Login_Device_Endpoints_Do_Not()
    {
        var c = _anon.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/admin/fleet")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PutAsJsonAsync("/api/admin/fleet/wifi", new { current = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsJsonAsync("/api/admin/ota/channel", new { channel = "stable" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{NewId()}/config", NewKey()))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/api/ota/manifest")).StatusCode);

        var page = await _anon.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false }).GetAsync("/Admin/Fleet");
        Assert.Equal(HttpStatusCode.Redirect, page.StatusCode);
    }
}
