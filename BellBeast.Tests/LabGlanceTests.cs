using System.Net;
using System.Text;
using System.Text.Json;
using BellBeast.Services;
using Xunit;

/// <summary>
/// /api/device/lab/glance — the annunciator's LAB screen. Statuses must match the MHxView LAB card
/// (LABview.js streakOf / classifyZone4 / classifyStatusItem) so the device and the web never disagree.
/// </summary>
public sealed class LabGlanceTests : IClassFixture<BellBeastBaseFactory>
{
    private readonly BellBeastBaseFactory _factory;
    public LabGlanceTests(BellBeastBaseFactory factory) => _factory = factory;

    private static readonly DateTimeOffset Now = new(2026, 11, 4, 10, 30, 0, TimeSpan.FromHours(7));

    private static JsonElement J(string json) => JsonDocument.Parse(json).RootElement.Clone();
    private static JsonElement Run(object o) => JsonSerializer.SerializeToElement(o);

    // 4 units, 6 points each; unit values given oldest → newest
    private static JsonElement Zone4(int baseCfg, params double?[][] units)
    {
        var series = units.Select((vals, i) => new
        {
            configparam_id = baseCfg + i,
            points = vals.Select((v, k) => new object?[] { $"2026-11-04 {(k * 2 + 1):00}:00", v }).ToArray(),
        });
        return JsonSerializer.SerializeToElement(new { series });
    }

    [Fact]
    public void StreakOf_Matches_LabView_Skips_Empty_Rounds()
    {
        var r = new LabGlance.Rule(1.0, 1.4);
        Assert.Equal(0, LabGlance.StreakOf(new double?[] { 1.5, 1.2 }, r));
        Assert.Equal(1, LabGlance.StreakOf(new double?[] { 1.2, 1.5 }, r));
        Assert.Equal(2, LabGlance.StreakOf(new double?[] { 1.5, null, 0.9 }, r));   // null does not break the run
        Assert.Equal('b', LabGlance.StreakLetter(3));
        Assert.Equal('f', LabGlance.StreakLetter(1));
        Assert.Equal('o', LabGlance.StreakLetter(0));
    }

    [Fact]
    public void Build_Uses_Scenario_Limits_And_Reports_Each_Unit()
    {
        var z4 = new Dictionary<string, JsonElement>
        {
            ["tw_postcl"] = Zone4(1046,
                new double?[] { 1.2, 1.2, 1.2, 1.2, 1.2, 1.2 },     // ok
                new double?[] { 1.2, 1.2, 1.2, 1.2, 1.2, 1.6 },     // first
                new double?[] { 1.2, 1.2, 1.2, 1.2, 0.8, 0.7 },     // bad
                new double?[] { null, null, null, null, null, null }), // no value
        };
        var limits = J("""
        { "scenario": { "id": 1, "name": "ปกติ" }, "epidemic": false,
          "items": [ { "configparam_id": 1046, "lcl": 1.0, "ucl": 1.4 }, { "configparam_id": 1047, "lcl": 1.0, "ucl": 1.4 },
                     { "configparam_id": 1048, "lcl": 1.0, "ucl": 1.4 }, { "configparam_id": 1049, "lcl": 1.0, "ucl": 1.4 } ] }
        """);
        var g = Run(LabGlance.Build(z4, null, limits, Now));

        Assert.True(g.GetProperty("ok").GetBoolean());
        Assert.Equal("scenario", g.GetProperty("limits").GetString());
        Assert.Equal("ปกติ", g.GetProperty("scenario").GetString());
        Assert.Equal("11:00", g.GetProperty("hm").GetString());

        var groups = g.GetProperty("groups").EnumerateArray().ToList();
        Assert.Equal(new[] { "CW Turbid", "CW Pre CL", "FW Turbid", "TW Turbid", "TW Post CL" },
            groups.Select(x => x.GetProperty("name").GetString()));
        var tw = groups[4];
        Assert.True(tw.GetProperty("ok").GetBoolean());
        Assert.False(groups[0].GetProperty("ok").GetBoolean());   // its call failed
        var units = tw.GetProperty("units").EnumerateArray().ToList();
        Assert.Equal(new[] { "o", "f", "b", "n" }, units.Select(u => u.GetProperty("s").GetString()));
        Assert.Equal(1.6, units[1].GetProperty("last").GetDouble());
        Assert.Equal(1.4, units[1].GetProperty("ucl").GetDouble());
        Assert.Equal("01", units[0].GetProperty("t")[0].GetString());
        Assert.Equal(6, units[0].GetProperty("v").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, units[3].GetProperty("last").ValueKind);
    }

    [Fact]
    public void Build_Falls_Back_To_Card_Rules_When_LabVenture_Is_Down()
    {
        var z4 = new Dictionary<string, JsonElement>
        {
            ["cw_turbid"] = Zone4(1002, new double?[] { 1, 6 }, new double?[] { 6, 6 }, new double?[] { 1, 1 }, new double?[] { 1, 1 }),
        };
        var g = Run(LabGlance.Build(z4, null, null, Now));
        Assert.Equal("fallback", g.GetProperty("limits").GetString());
        var units = g.GetProperty("groups")[0].GetProperty("units").EnumerateArray().Select(u => u.GetProperty("s").GetString());
        Assert.Equal(new[] { "f", "b", "o", "o" }, units);   // CW T fallback = max 5
    }

    [Fact]
    public void Status_Dots_Follow_Zone3_With_Zone4_History()
    {
        var z4 = new Dictionary<string, JsonElement>
        {
            ["tw_postcl"] = Zone4(1046, new double?[] { 1.5, 1.6 }, new double?[] { 1.2, 1.5 }, new double?[] { 1.2, 1.2 }, new double?[] { 1.2, 1.2 }),
        };
        var zone3 = J("""
        [ { "key": "TW1 CL", "configparam_id": 1046, "active": true, "value_real": 1.6 },
          { "key": "TW2 CL", "configparam_id": 1055, "active": true, "value_real": 1.5 },
          { "key": "TW3 CL", "configparam_id": 1064, "active": true, "value_text": "1.2" },
          { "key": "TW4 CL", "configparam_id": 1067, "active": false },
          { "key": "CW1 T",  "configparam_id": 1002, "active": true, "value_real": 9 } ]
        """);
        var g = Run(LabGlance.Build(z4, zone3, null, Now));
        var st = g.GetProperty("status").GetString()!;
        Assert.Equal(16, st.Length);
        Assert.Equal('f', st[0]);       // CW1 T: no history (group call missing) → latest only, 9 > 5
        Assert.Equal('n', st[1]);       // CW2 T: not in zone3
        Assert.Equal("bfon", st.Substring(12));   // TW1..4 CL
    }

    [Fact]
    public void Dots_Carry_Zone3_Value_Limits_And_Epidemic_Mark()
    {
        var z4 = new Dictionary<string, JsonElement>
        {
            ["tw_postcl"] = Zone4(1046, new double?[] { 1.2, 1.2 }, new double?[] { 1.2 }, new double?[] { 1.2 }, new double?[] { 1.2 }),
        };
        var zone3 = J("""
        [ { "key": "TW1 CL", "configparam_id": 1046, "active": true, "value_real": 1.2, "ts_local": "2026-11-05 09:00" },
          { "key": "CW1 T",  "configparam_id": 1002, "active": true, "value_real": 6 } ]
        """);
        var limits = J("""
        { "scenario": { "id": 1, "name": "ปกติ" }, "epidemic": true,
          "items": [ { "param_key": "TW1.ResCl2", "configparam_id": 1046, "lcl": 1.4, "ucl": 1.8 },
                     { "param_key": "CW1.turb",   "configparam_id": 1002, "lcl": null, "ucl": 5 } ] }
        """);
        var epi = J("""{ "thresholds": [ { "param_key": "TW1.ResCl2", "min": 1.4, "max": 1.8 } ] }""");
        var log = J("""[ { "id": 9, "scenario_id": 1, "started_at": "2026-11-05T08:00:00+07:00", "is_test": 1 } ]""");
        var g = Run(LabGlance.Build(z4, zone3, limits, Now, epi, log));

        Assert.Equal(9, g.GetProperty("scenario_rev").GetInt32());
        Assert.Equal(1, g.GetProperty("scenario_id").GetInt32());
        Assert.True(g.GetProperty("scenario_test").GetBoolean());
        var dots = g.GetProperty("dots").EnumerateArray().ToList();
        Assert.Equal(16, dots.Count);
        var cw1 = dots[0];
        Assert.Equal("CW1 T", cw1.GetProperty("k").GetString());
        Assert.Equal(6, cw1.GetProperty("v").GetDouble());
        Assert.Equal("f", cw1.GetProperty("s").GetString());
        Assert.Equal(5, cw1.GetProperty("ucl").GetDouble());
        Assert.False(cw1.GetProperty("epi").GetBoolean());
        var tw1 = dots[12];
        Assert.Equal("TW1 CL", tw1.GetProperty("k").GetString());
        Assert.Equal("b", tw1.GetProperty("s").GetString());      // 1.2 below the epidemic 1.4 twice
        Assert.Equal(1.4, tw1.GetProperty("lcl").GetDouble());
        Assert.True(tw1.GetProperty("epi").GetBoolean());
        Assert.Equal("2026-11-05 09:00", tw1.GetProperty("ts").GetString());
        Assert.Equal(JsonValueKind.Null, dots[1].GetProperty("v").ValueKind);   // CW2 T not in zone3
        Assert.Equal("n", dots[1].GetProperty("s").GetString());
        // the 16-letter status string and the dots always agree
        Assert.Equal(g.GetProperty("status").GetString(), string.Concat(dots.Select(d => d.GetProperty("s").GetString())));
    }

    [Fact]
    public async Task Scenario_Endpoint_Reports_Rev_And_A_New_Rev_Drops_The_Glance_Cache()
    {
        var rev = 8;
        var summaryCalls = 0;
        _factory.EngineHandler.RequestHandler = req =>
        {
            var url = req.RequestUri!.ToString();
            if (url.EndsWith("/api/scenarios/limits"))
                return Ok("""{ "scenario": { "id": 2, "name": "น้ำดิบความขุ่นสูง" }, "epidemic": false, "items": [] }""");
            if (url.Contains("/api/scenarios/log"))
                return Ok($$"""[ { "id": {{rev}}, "started_at": "2026-11-05T08:00:00+07:00", "is_test": 0 } ]""");
            if (url.EndsWith("/api/lab/summary"))
            {
                Interlocked.Increment(ref summaryCalls);
                return Ok("""{ "data": { "zone3": { "items": [] }, "zone4": { "series": [] } } }""");
            }
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        };
        try
        {
            var svc = (LabGlanceService)_factory.Services.GetService(typeof(LabGlanceService))!;
            svc.ResetCache();
            var c = _factory.CreateClient();
            await c.GetAsync("/api/device/lab/glance");                       // cache built with rev 8 (or cached from another test)
            var s1 = JsonDocument.Parse(await c.GetStringAsync("/api/device/lab/scenario")).RootElement;
            Assert.True(s1.GetProperty("ok").GetBoolean());
            Assert.Equal("น้ำดิบความขุ่นสูง", s1.GetProperty("name").GetString());
            Assert.Equal(2, s1.GetProperty("id").GetInt32());

            // fresh glance with rev 8, then LabVenture opens period 9 -> scenario endpoint drops the glance cache
            var before = summaryCalls;
            await Task.Delay(LabGlanceService.ScenarioCacheFor + TimeSpan.FromMilliseconds(200));
            rev = 9;
            var s2 = JsonDocument.Parse(await c.GetStringAsync("/api/device/lab/scenario")).RootElement;
            Assert.Equal(9, s2.GetProperty("rev").GetInt32());
            await c.GetAsync("/api/device/lab/glance");
            Assert.True(summaryCalls > before, "glance should be recomputed after a new scenario revision");
        }
        finally { _factory.EngineHandler.RequestHandler = null; }
    }

    [Fact]
    public void No_Limit_In_Scenario_Shows_Dash()
    {
        var z4 = new Dictionary<string, JsonElement>
        {
            ["fw_turbid"] = Zone4(1005, new double?[] { 0.2 }, new double?[] { 0.2 }, new double?[] { 0.2 }, new double?[] { 0.2 }),
        };
        var limits = J("""{ "scenario": { "name": "x" }, "items": [] }""");
        var units = Run(LabGlance.Build(z4, null, limits, Now)).GetProperty("groups")[2].GetProperty("units");
        Assert.All(units.EnumerateArray(), u => Assert.Equal("-", u.GetProperty("s").GetString()));
    }

    [Fact]
    public async Task Endpoint_Calls_Uroboros_Per_Group_Reads_Limits_And_Keeps_Thai()
    {
        ((LabGlanceService)_factory.Services.GetService(typeof(LabGlanceService))!).ResetCache();
        var filters = new List<string>();
        _factory.EngineHandler.RequestHandler = req =>
        {
            var url = req.RequestUri!.ToString();
            if (url.EndsWith("/api/scenarios/limits"))
                return Ok("""{ "scenario": { "name": "ภาวะปกติ" }, "epidemic": true, "items": [ { "configparam_id": 1046, "lcl": 1.0, "ucl": 1.4 } ] }""");
            if (url.EndsWith("/api/lab/summary"))
            {
                var body = req.Content!.ReadAsStringAsync().Result;
                var f = JsonDocument.Parse(body).RootElement.GetProperty("zone4").GetProperty("filter").GetString()!;
                lock (filters) filters.Add(f);
                return Ok("""{ "data": { "zone3": { "items": [] }, "zone4": { "series": [ { "configparam_id": 1046, "points": [ ["2026-11-04 09:00", 1.2] ] } ] } } }""");
            }
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        };
        try
        {
            var c = _factory.CreateClient();
            var r = await c.GetAsync("/api/device/lab/glance");
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            Assert.Equal("no-store", r.Headers.CacheControl?.ToString());
            var text = await r.Content.ReadAsStringAsync();
            Assert.Contains("ภาวะปกติ", text);                 // UTF-8, not \u escapes (device parser)
            var g = JsonDocument.Parse(text).RootElement;
            Assert.True(g.GetProperty("ok").GetBoolean());
            Assert.True(g.GetProperty("epidemic").GetBoolean());
            Assert.Equal(new[] { "CW Pre CL", "CW Turbid", "FW Turbid", "TW Pos CL", "TW Turbid" }, filters.OrderBy(x => x));

            // second call within 60 s is served from cache — no new upstream calls
            await c.GetAsync("/api/device/lab/glance");
            Assert.Equal(5, filters.Count);
        }
        finally { _factory.EngineHandler.RequestHandler = null; }
    }

    private static HttpResponseMessage Ok(string json)
        => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}
