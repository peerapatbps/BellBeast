using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using BellBeast.Services;
using Xunit;

/// <summary>
/// Alarm feed: Uroboros posts a level-based payload into the IoT room as device "uroboros-alarm";
/// /api/alarm/active returns it zone-filtered. /api/alarm/monitor and /api/metrics/history are
/// forwarded to Uroboros for the Alarm Monitor page.
/// </summary>
public sealed class AlarmFeedServiceTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 7, 9, 0, 0, TimeSpan.FromHours(7));

    private static Dictionary<string, JsonElement> State(string json)
        => JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    private const string Payload = """
    {
      "alarm_mode": "SYNC",
      "emitted_at": "2026-10-07T09:00:00+07:00",
      "alarms": [
        { "alarm_id": "a1", "active": true,  "zone": "RWS",  "value": 8650 },
        { "alarm_id": "a2", "active": true,  "zone": "CHEM", "value": 1.4 },
        { "alarm_id": "a3", "active": false, "zone": "RWS",  "value": 15000 },
        { "alarm_id": "a4", "active": true,  "zone": "",     "value": 1 },
        "garbage"
      ]
    }
    """;

    private static JsonElement Run(object result) => JsonSerializer.SerializeToElement(result);

    [Fact]
    public void ParseZones_Handles_Separators_Case_And_Duplicates()
    {
        Assert.Equal(new[] { "RWS", "DPS" }, AlarmFeedService.ParseZones("rws, dps;RWS"));
        Assert.Empty(AlarmFeedService.ParseZones(null));
        Assert.Empty(AlarmFeedService.ParseZones("  "));
    }

    [Fact]
    public void No_Zone_Filter_Returns_Every_Alarm_And_Counts_Only_Active()
    {
        var r = Run(AlarmFeedService.Build(State(Payload), Now.AddSeconds(-10), true, Now, Array.Empty<string>()));

        Assert.Equal("SYNC", r.GetProperty("alarm_mode").GetString());
        Assert.False(r.GetProperty("engine_stale").GetBoolean());
        Assert.Equal(10, r.GetProperty("age_sec").GetInt32());
        Assert.Equal(4, r.GetProperty("alarms").GetArrayLength());      // the "garbage" entry is skipped
        Assert.Equal(3, r.GetProperty("active_count").GetInt32());      // a3 has active:false
    }

    [Fact]
    public void Zone_Filter_Keeps_Matching_And_Broadcast_Alarms()
    {
        var r = Run(AlarmFeedService.Build(State(Payload), Now, true, Now, new[] { "RWS" }));

        var ids = r.GetProperty("alarms").EnumerateArray().Select(a => a.GetProperty("alarm_id").GetString()).ToArray();
        Assert.Equal(new[] { "a1", "a3", "a4" }, ids);                  // a2 (CHEM) dropped, a4 (no zone) broadcast
    }

    [Fact]
    public void Engine_Is_Marked_Stale_When_Posts_Stop_Even_If_Room_Still_Lists_It()
    {
        var r = Run(AlarmFeedService.Build(State(Payload), Now.AddSeconds(-300), true, Now, Array.Empty<string>()));
        Assert.True(r.GetProperty("engine_stale").GetBoolean());
        Assert.True(r.GetProperty("engine_online").GetBoolean());
    }

    [Fact]
    public void Missing_Engine_Is_Reported_Explicitly_Not_As_An_Empty_All_Clear()
    {
        var r = Run(AlarmFeedService.Build(null, null, false, Now, Array.Empty<string>()));
        Assert.False(r.GetProperty("engine_online").GetBoolean());
        Assert.True(r.GetProperty("engine_stale").GetBoolean());
        Assert.Equal(JsonValueKind.Null, r.GetProperty("alarm_mode").ValueKind);
    }

    [Fact]
    public void Empty_Alarm_List_Is_A_Valid_All_Clear()
    {
        var r = Run(AlarmFeedService.Build(State("""{"alarm_mode":"FSNL","alarms":[]}"""), Now, true, Now, Array.Empty<string>()));
        Assert.Equal("FSNL", r.GetProperty("alarm_mode").GetString());
        Assert.Equal(0, r.GetProperty("active_count").GetInt32());
        Assert.False(r.GetProperty("engine_stale").GetBoolean());
    }
}

public sealed class AlarmEndpointTests : IClassFixture<BellBeastBaseFactory>, IClassFixture<BellBeastAdminFactory>
{
    private readonly BellBeastBaseFactory _factory;
    private readonly BellBeastAdminFactory _admin;

    public AlarmEndpointTests(BellBeastBaseFactory factory, BellBeastAdminFactory admin) { _factory = factory; _admin = admin; }

    private static StringContent Json(string s) => new(s, Encoding.UTF8, "application/json");

    private async Task<string> JoinAsync(HttpClient c, string name, string type)
    {
        var resp = await c.PostAsync("/api/iot/room/join", Json($$"""{"DeviceName":"{{name}}","DeviceType":"{{type}}"}"""));
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        return doc.RootElement.GetProperty("key").GetString()!;
    }

    [Fact]
    public async Task Active_Endpoint_Returns_Posted_Alarm_State_Filtered_By_Zone()
    {
        var c = _factory.CreateClient();
        var key = await JoinAsync(c, "uroboros-alarm", "alarm-engine");

        // exactly what Uroboros' BellBeastAlarmSink sends: { Key, Data = payload }
        var data = """
        {
          "alarm_mode":"SYNC","emitted_at":"2026-10-07T09:00:00+07:00",
          "alarms":[
            {"alarm_id":"rwp1_flowp1_anomaly","active":true,"zone":"RWS","value":8650,"playlist":["s_a","n_8"]},
            {"alarm_id":"dps_airp1_low","active":true,"zone":"DPS","value":4.2}
          ]
        }
        """;
        var body = "{\"Key\":\"" + key + "\",\"Data\":" + data + "}";
        var post = await c.PostAsync("/api/iot/room/data", Json(body));
        Assert.Equal(HttpStatusCode.OK, post.StatusCode);

        var all = await c.GetFromJsonAsync<JsonElement>("/api/alarm/active");
        Assert.True(all.GetProperty("engine_online").GetBoolean());
        Assert.False(all.GetProperty("engine_stale").GetBoolean());
        Assert.Equal("SYNC", all.GetProperty("alarm_mode").GetString());
        Assert.Equal(2, all.GetProperty("alarms").GetArrayLength());

        var rws = await c.GetFromJsonAsync<JsonElement>("/api/alarm/active?zone=rws");
        var only = Assert.Single(rws.GetProperty("alarms").EnumerateArray().ToList());
        Assert.Equal("rwp1_flowp1_anomaly", only.GetProperty("alarm_id").GetString());
        Assert.Equal("s_a", only.GetProperty("playlist")[0].GetString());    // nested arrays survive the room
    }

    [Fact]
    public async Task Active_Endpoint_Is_Anonymous_And_Not_Cached()
    {
        var c = _factory.CreateClient();
        var resp = await c.GetAsync("/api/alarm/active");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Contains("no-store", resp.Headers.CacheControl?.ToString() ?? "");
    }

    [Fact]
    public async Task Monitor_And_History_Are_Forwarded_To_Uroboros_With_Query_String()
    {
        var seen = new List<string>();
        _admin.EngineHandler.RequestHandler = req =>
        {
            seen.Add(req.RequestUri!.ToString());
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"ok":true,"rules":[]}""", Encoding.UTF8, "application/json")
            };
        };
        try
        {
            var c = _admin.CreateClient();

            var m = await c.GetAsync("/api/alarm/monitor");
            Assert.Equal(HttpStatusCode.OK, m.StatusCode);

            var h = await c.GetAsync("/api/metrics/history?stream=RWP1&param=rwp1_flowp1&n=60");
            Assert.Equal(HttpStatusCode.OK, h.StatusCode);
            Assert.Contains("\"ok\":true", await h.Content.ReadAsStringAsync());

            Assert.Contains("http://localhost:8888/api/alarm/monitor", seen);
            Assert.Contains("http://localhost:8888/api/metrics/history?stream=RWP1&param=rwp1_flowp1&n=60", seen);
        }
        finally { _admin.EngineHandler.RequestHandler = null; }
    }

    [Fact]
    public async Task Monitor_Returns_502_Json_When_Uroboros_Is_Down()
    {
        _admin.EngineHandler.RequestHandler = _ => throw new HttpRequestException("connection refused");
        try
        {
            var c = _admin.CreateClient();
            var resp = await c.GetAsync("/api/alarm/monitor");

            Assert.Equal(HttpStatusCode.BadGateway, resp.StatusCode);
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
            Assert.False(doc.RootElement.GetProperty("ok").GetBoolean());
            Assert.Contains("unreachable", doc.RootElement.GetProperty("error").GetString());
        }
        finally { _admin.EngineHandler.RequestHandler = null; }
    }

    [Fact]
    public async Task Alarm_Monitor_Page_Needs_Admin_Login()
    {
        var anon = _factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        var r = await anon.GetAsync("/AlarmMonitor");
        Assert.Equal(HttpStatusCode.Redirect, r.StatusCode);
        Assert.Contains("/Admin/Login", r.Headers.Location?.ToString() ?? "", StringComparison.OrdinalIgnoreCase);

        var resp = await _admin.CreateClient().GetAsync("/AlarmMonitor");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var html = await resp.Content.ReadAsStringAsync();
        Assert.Contains("Alarm Monitor", html);
        Assert.Contains("alarmmonitor.js", html);
    }

    [Theory]
    [InlineData("/api/alarm/monitor")]
    [InlineData("/api/metrics/history")]
    public async Task Monitor_Apis_Need_Admin(string path)
        => Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync(path)).StatusCode);
}
