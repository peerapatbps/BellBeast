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
/// (WiFi only for approved devices), OTA manifest per group / override + firmware download, admin-only writes.
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
        await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key));      // registers as pending
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new
        {
            wifi = new { ssid = ".@MWA WiFi", identity = "test-user", current = "pw-current", next = "pw-next", next_valid_from = "2027-01-01T00:00:00+07:00" },
        })).StatusCode);

        var pending = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key)));
        Assert.False(pending.GetProperty("approved").GetBoolean());
        Assert.Equal(JsonValueKind.Null, pending.GetProperty("wifi").ValueKind);   // not before approval
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
        Assert.False(view.TryGetProperty("wifi", out _));                            // no fleet-wide WiFi any more
        Assert.EndsWith("nt", (await DeviceRow(c, id)).GetProperty("wifi").GetProperty("current").GetString());

        // reset key: next device with a new key re-binds and must be approved again
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { reset_key = true })).StatusCode);
        var newKey = NewKey();
        var rebound = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", newKey)));
        Assert.False(rebound.GetProperty("approved").GetBoolean());
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key))).StatusCode);
    }

    private static MultipartFormDataContent Upload(byte[] bin)
    {
        var form = new MultipartFormDataContent();
        form.Add(new ByteArrayContent(bin), "file", "xiaozhi.bin");
        return form;
    }

    private async Task<string> NewGroup(HttpClient c, string name)
    {
        var r = await Json(await c.PostAsJsonAsync("/api/admin/fleet/groups", new { name }));
        return r.GetProperty("id").GetString()!;
    }

    private async Task<JsonElement> Manifest(HttpClient c, string id, string key) =>
        await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/ota/manifest?device_id={id}", key)));

    [Fact]
    public async Task Ota_Manifest_Follows_Group_And_Firmware_Downloads_With_Sha()
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

        // a device in no group gets nothing
        var none = await Manifest(c, id, key);
        Assert.Equal(JsonValueKind.Null, none.GetProperty("version").ValueKind);
        Assert.Equal("ungrouped", none.GetProperty("channel").GetString());

        var g = await NewGroup(c, "Lab " + id);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync($"/api/admin/fleet/groups/{g}/devices", new { devices = new[] { id } })).StatusCode);
        Assert.Equal(JsonValueKind.Null, (await Manifest(c, id, key)).GetProperty("version").ValueKind);    // group has no target yet

        Assert.Equal(HttpStatusCode.OK, (await c.PutAsJsonAsync($"/api/admin/fleet/groups/{g}", new { target = "2.1.0-test" })).StatusCode);
        var m = await Manifest(c, id, key);
        Assert.Equal("group", m.GetProperty("channel").GetString());
        Assert.Equal("2.1.0-test", m.GetProperty("version").GetString());
        Assert.Equal(sha, m.GetProperty("sha256").GetString());
        Assert.Equal(4096, m.GetProperty("size").GetInt64());

        var dl = await c.GetAsync(m.GetProperty("url").GetString());
        Assert.Equal(HttpStatusCode.OK, dl.StatusCode);
        Assert.Equal(bin, await dl.Content.ReadAsByteArrayAsync());
        Assert.Equal(sha, dl.Headers.GetValues("X-Firmware-Sha256").Single());

        // this one device holds its firmware
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { fw_mode = "hold" })).StatusCode);
        var off = await Manifest(c, id, key);
        Assert.Equal(JsonValueKind.Null, off.GetProperty("version").ValueKind);
        Assert.Equal("hold", off.GetProperty("channel").GetString());

        // firmware a group points at cannot be deleted; non-ESP image is rejected
        Assert.Equal(HttpStatusCode.BadRequest, (await c.DeleteAsync("/api/admin/ota/firmware/2.1.0-test")).StatusCode);
        var junk = new MultipartFormDataContent { { new StringContent("9.9.9"), "version" } };
        junk.Add(new ByteArrayContent(new byte[2048]), "file", "x.bin");
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsync("/api/admin/ota/firmware", junk)).StatusCode);

        // deleting the group takes its devices out of it
        Assert.Equal(HttpStatusCode.OK, (await c.DeleteAsync($"/api/admin/fleet/groups/{g}")).StatusCode);
        Assert.Equal(JsonValueKind.Null, (await DeviceRow(c, id)).GetProperty("group").ValueKind);
        await c.DeleteAsync($"/api/admin/fleet/device/{id}");
    }

    [Fact]
    public async Task Auto_Patcher_And_Override_Never_Cross_Boards()
    {
        var c = _admin.CreateClient();
        var (a, ka) = (NewId(), NewKey());      // 1.83 board
        var (b, kb) = (NewId(), NewKey());      // MUMA board (no suffix)
        var a90 = Image("ann-9.0.0-183"); var b90 = Image("ann-9.0.0"); var a91 = Image("ann-9.0.1-183");
        foreach (var img in new[] { a90, b90, a91 })
            Assert.Equal(HttpStatusCode.OK, (await c.PostAsync("/api/admin/ota/firmware", Upload(img))).StatusCode);
        await c.SendAsync(Dev(HttpMethod.Post, $"/api/device/{a}/report", ka, new { fw = "ann-1.3.1-183" }));   // board from the label
        await c.SendAsync(Dev(HttpMethod.Post, $"/api/device/{b}/report", kb, new { fw = "ann-1.4.0", model = "" }));
        Assert.Equal("183", (await DeviceRow(c, a)).GetProperty("board").GetString());
        Assert.Equal("", (await DeviceRow(c, b)).GetProperty("board").GetString());

        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync("/api/admin/fleet/groups/auto/devices", new { devices = new[] { a, b } })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync("/api/admin/ota/release", new { version = "ann-9.0.0-183" })).StatusCode);
        Assert.Equal("ann-9.0.0-183", (await Manifest(c, a, ka)).GetProperty("version").GetString());
        Assert.Equal(JsonValueKind.Null, (await Manifest(c, b, kb)).GetProperty("version").ValueKind);      // nothing released for MUMA
        Assert.Equal("not_released", (await DeviceRow(c, b)).GetProperty("target_note").GetString());

        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync("/api/admin/ota/release", new { version = "ann-9.0.0" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync("/api/admin/ota/release", new { version = "ann-9.0.1-183" })).StatusCode);
        Assert.Equal("ann-9.0.1-183", (await Manifest(c, a, ka)).GetProperty("version").GetString());      // newest released for 183
        Assert.Equal("ann-9.0.0", (await Manifest(c, b, kb)).GetProperty("version").GetString());

        // personal override: same board only
        var bad = await c.PostAsJsonAsync($"/api/admin/fleet/device/{b}", new { fw_mode = "override", fw_override = "ann-9.0.0-183" });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Contains("fw_board_mismatch", await bad.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{a}", new { fw_mode = "override", fw_override = "ann-9.0.0-183" })).StatusCode);
        var ma = await Manifest(c, a, ka);
        Assert.Equal("override", ma.GetProperty("channel").GetString());
        Assert.Equal("ann-9.0.0-183", ma.GetProperty("version").GetString());

        // a group pointed at another board's image serves nothing to the wrong board
        var g = await NewGroup(c, "1.83 only " + a);
        await c.PutAsJsonAsync($"/api/admin/fleet/groups/{g}", new { target = "ann-9.0.1-183" });
        await c.PostAsJsonAsync($"/api/admin/fleet/groups/{g}/devices", new { devices = new[] { b } });
        Assert.Equal(JsonValueKind.Null, (await Manifest(c, b, kb)).GetProperty("version").ValueKind);
        Assert.Equal("board_mismatch", (await DeviceRow(c, b)).GetProperty("target_note").GetString());

        // released / group target / override images cannot be deleted
        Assert.Equal(HttpStatusCode.BadRequest, (await c.DeleteAsync("/api/admin/ota/firmware/ann-9.0.0")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.DeleteAsync("/api/admin/ota/firmware/ann-9.0.1-183")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.DeleteAsync("/api/admin/ota/firmware/ann-9.0.0-183")).StatusCode);

        // the auto group is built in: no target, no delete
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PutAsJsonAsync("/api/admin/fleet/groups/auto", new { target = "ann-9.0.0" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.DeleteAsync("/api/admin/fleet/groups/auto")).StatusCode);

        await c.PostAsJsonAsync("/api/admin/ota/release", new { version = "ann-9.0.1-183", released = false });
        await c.PostAsJsonAsync("/api/admin/ota/release", new { version = "ann-9.0.0", released = false });
        await c.DeleteAsync($"/api/admin/fleet/groups/{g}");
        await c.DeleteAsync($"/api/admin/fleet/device/{a}");
        await c.DeleteAsync($"/api/admin/fleet/device/{b}");
    }


    [Fact]
    public async Task Wifi_Is_Per_Device_And_None_Means_The_Built_In_Bypass()
    {
        var c = _admin.CreateClient();
        var id = NewId(); var key = NewKey();
        await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key));
        Assert.Equal(HttpStatusCode.NotFound, (await c.PutAsJsonAsync("/api/admin/fleet/wifi", new { current = "pw-fleet" })).StatusCode);   // no fleet-wide WiFi

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

        // null → no WiFi in config: the device clears its known creds and uses its built-in list (bypass)
        await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { wifi = (object?)null });
        cfg = await Json(await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{id}/config", key)));
        Assert.Equal(JsonValueKind.Null, cfg.GetProperty("wifi").ValueKind);
        await c.DeleteAsync($"/api/admin/fleet/device/{id}");
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
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { fw_mode = "nightly" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/admin/fleet/device/{id}", new { group = "nope" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/admin/fleet/groups", new { name = "" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.PostAsJsonAsync("/api/admin/fleet/device/ann-nope", new { approved = true })).StatusCode);
        var vg = await NewGroup(c, "validation " + id);
        Assert.Equal(HttpStatusCode.NotFound, (await c.PutAsJsonAsync($"/api/admin/fleet/groups/{vg}", new { target = "0.0.0-missing" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/admin/fleet/groups", new { name = "VALIDATION " + id })).StatusCode);   // name taken
        await c.DeleteAsync($"/api/admin/fleet/groups/{vg}");
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
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsJsonAsync("/api/admin/fleet/device/ann-x01", new { wifi = new { current = "x" } })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsJsonAsync("/api/admin/fleet/groups", new { name = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(Dev(HttpMethod.Get, $"/api/device/{NewId()}/config", NewKey()))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/api/ota/manifest")).StatusCode);

        var page = await _anon.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false }).GetAsync("/Admin/Fleet");
        Assert.Equal(HttpStatusCode.Redirect, page.StatusCode);
    }
}
