using System.Net;
using System.Text;
using System.Text.Json;
using BellBeast.ApiAccess;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

/// <summary>Phase 3: admin-defined datasets published on /api/v1 (per-dataset grants, field selection, history cap, OpenAPI).</summary>
public sealed class V1DatasetTests : IClassFixture<BellBeastBaseFactory>, IClassFixture<BellBeastAdminFactory>
{
    private readonly BellBeastBaseFactory _f;
    private readonly BellBeastAdminFactory _admin;
    private readonly List<string> _seen = new();

    private const string Schema = """
        {"ok":true,"realtime":[
          {"source_kind":"realtime","stream":"TPS","param":"TR_flow","unit":"m3/h"},
          {"source_kind":"realtime","stream":"TPS","param":"TR_pressure","unit":"bar"}],
         "lab":[]}
        """;

    public V1DatasetTests(BellBeastBaseFactory f, BellBeastAdminFactory admin)
    {
        _f = f;
        _admin = admin;
        _f.EngineHandler.RequestHandler = _admin.EngineHandler.RequestHandler = Uroboros;
    }

    private HttpResponseMessage Uroboros(HttpRequestMessage req)
    {
        var url = req.RequestUri!.ToString();
        lock (_seen) _seen.Add(url);
        string body;
        if (url.Contains("/api/metrics/schema")) body = Schema;
        else if (url.Contains("param=TR_pressure") && url.EndsWith("&n=1")) throw new HttpRequestException("down");
        else if (url.Contains("/api/metrics/history"))
        {
            var value = url.Contains("TR_flow") ? 45570 : 20.6;
            body = $$"""{"ok":true,"interval_sec":60,"points":[{"ts":"2026-11-05 13:15:22","value":{{value - 1}}},{"ts":"2026-11-05 13:16:22","value":{{value}}}]}""";
        }
        else body = "{}";
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }

    private static JsonElement J(string s) => JsonDocument.Parse(s).RootElement;

    private void Dataset(string id, bool enabled = true, int maxHistory = 60)
    {
        var (_, err) = _f.Services.GetRequiredService<DatasetService>().Save(J($$"""
            {"id":"{{id}}","title":"Treated water","enabled":{{(enabled ? "true" : "false")}},"max_history":{{maxHistory}},
             "fields":[{"name":"flow","stream":"TPS","param":"TR_flow","unit":"m3/h"},{"name":"pressure","stream":"TPS","param":"TR_pressure","unit":"bar"}]}
            """), new HashSet<string> { "TPS.TR_flow", "TPS.TR_pressure" }, "test");
        Assert.Null(err);
    }

    private string Key(params string[] grants)
    {
        var svc = _f.Services.GetRequiredService<ApiClientService>();
        var (_, key, err) = svc.Create(J(JsonSerializer.Serialize(new { name = "partner", grants })), _ => true, "test");
        Assert.Null(err);
        return key!;
    }

    private async Task<HttpResponseMessage> Get(string path, string? key)
    {
        var r = new HttpRequestMessage(HttpMethod.Get, path);
        if (key is not null) r.Headers.Add("X-Api-Key", key);
        return await _f.CreateClient().SendAsync(r);
    }

    [Fact]
    public async Task Granted_Key_Reads_Latest_With_Published_Field_Names()
    {
        Dataset("tw-latest");
        var r = await Get("/api/v1/datasets/tw-latest?fields=flow", Key("dataset:tw-latest"));
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);

        var doc = J(await r.Content.ReadAsStringAsync());
        var flow = doc.GetProperty("values").GetProperty("flow");
        Assert.Equal(45570, flow.GetProperty("value").GetDouble());
        Assert.Equal("2026-11-05T13:16:22+07:00", flow.GetProperty("ts").GetString());
        Assert.Equal("m3/h", flow.GetProperty("unit").GetString());
        Assert.False(doc.GetProperty("values").TryGetProperty("pressure", out _));   // only the requested field
        Assert.DoesNotContain("TR_flow", await r.Content.ReadAsStringAsync());       // plant tag names never leak
    }

    [Fact]
    public async Task Access_Rules()
    {
        Dataset("tw-access");
        Dataset("tw-off", enabled: false);

        Assert.Equal(HttpStatusCode.Unauthorized, (await Get("/api/v1/datasets/tw-access", null)).StatusCode);

        var other = Key("dataset:something-else");
        var denied = await Get("/api/v1/datasets/tw-access", other);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Contains("dataset_not_granted", await denied.Content.ReadAsStringAsync());

        var key = Key("dataset:tw-access", "dataset:tw-off");
        Assert.Equal(HttpStatusCode.NotFound, (await Get("/api/v1/datasets/tw-off", key)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Get("/api/v1/datasets/nope", key)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Get("/api/v1/datasets/tw-access?fields=nope", key)).StatusCode);

        var list = J(await (await Get("/api/v1/datasets", key)).Content.ReadAsStringAsync()).GetProperty("datasets");
        Assert.Equal(new[] { "tw-access" }, list.EnumerateArray().Select(d => d.GetProperty("id").GetString()).ToArray());
    }

    [Fact]
    public async Task History_Is_Capped_By_Max_History()
    {
        Dataset("tw-hist", maxHistory: 5);
        var r = await Get("/api/v1/datasets/tw-hist/history?n=999&fields=flow", Key("dataset:tw-hist"));
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);

        var doc = J(await r.Content.ReadAsStringAsync());
        Assert.Equal(5, doc.GetProperty("n").GetInt32());
        Assert.Equal(2, doc.GetProperty("series").GetProperty("flow").GetArrayLength());
        lock (_seen) Assert.Contains(_seen, u => u.Contains("param=TR_flow") && u.EndsWith("&n=5"));
    }

    [Fact]
    public async Task Upstream_Failure_Is_502()
    {
        Dataset("tw-down");
        var r = await Get("/api/v1/datasets/tw-down?fields=pressure", Key("dataset:tw-down"));
        Assert.Equal(HttpStatusCode.BadGateway, r.StatusCode);
        Assert.Contains("upstream_unavailable", await r.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task OpenApi_Lists_Only_Granted_Datasets()
    {
        Dataset("tw-doc-a");
        Dataset("tw-doc-b");
        var doc = await (await Get("/api/v1/openapi.json", Key("dataset:tw-doc-a"))).Content.ReadAsStringAsync();
        Assert.Contains("\"openapi\":\"3.0.3\"", doc);
        Assert.Contains("tw-doc-a", doc);
        Assert.DoesNotContain("tw-doc-b", doc);
    }

    [Fact]
    public async Task Admin_Saves_Dataset_Against_Uroboros_Schema_And_Versions_It()
    {
        var c = _admin.CreateClient();
        StringContent Body(string fields) => new($$"""{"id":"adm-ds","title":"t","fields":[{{fields}}]}""", Encoding.UTF8, "application/json");

        var bad = await c.PostAsync("/api/admin/datasets", Body("""{"name":"x","stream":"TPS","param":"nope"}"""));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Contains("unknown_metric", await bad.Content.ReadAsStringAsync());

        var v1 = J(await (await c.PostAsync("/api/admin/datasets", Body("""{"name":"flow","stream":"TPS","param":"TR_flow"}"""))).Content.ReadAsStringAsync());
        Assert.Equal(1, v1.GetProperty("dataset").GetProperty("version").GetInt32());
        var same = J(await (await c.PostAsync("/api/admin/datasets", Body("""{"name":"flow","stream":"TPS","param":"TR_flow"}"""))).Content.ReadAsStringAsync());
        Assert.Equal(1, same.GetProperty("dataset").GetProperty("version").GetInt32());
        var v2 = J(await (await c.PostAsync("/api/admin/datasets", Body("""{"name":"flow","stream":"TPS","param":"TR_pressure"}"""))).Content.ReadAsStringAsync());
        Assert.Equal(2, v2.GetProperty("dataset").GetProperty("version").GetInt32());

        // dataset grants are offered to API clients; unknown datasets are not
        var ok = await c.PostAsync("/api/admin/api/clients", new StringContent("""{"name":"p","grants":["dataset:adm-ds"]}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var no = await c.PostAsync("/api/admin/api/clients", new StringContent("""{"name":"p","grants":["dataset:missing"]}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, no.StatusCode);
    }
}
