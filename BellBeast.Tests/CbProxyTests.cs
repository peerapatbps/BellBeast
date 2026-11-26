using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using BellBeast.Services;
using Xunit;

/// <summary>
/// /api/cb/* → Uroboros connector box (Endpoints/CbEndpoints.cs):
///   page reads relay status/body/query unchanged, operator actions carry the LOGIN name as `by`,
///   registry routes are admin-only, an unreachable engine answers 502 JSON.
/// </summary>
public sealed class CbProxyTests : IClassFixture<BellBeastAdminFactory>, IClassFixture<BellBeastBaseFactory>
{
    private readonly BellBeastAdminFactory _admin;
    private readonly BellBeastBaseFactory _anon;

    public CbProxyTests(BellBeastAdminFactory admin, BellBeastBaseFactory anon) { _admin = admin; _anon = anon; }

    private static List<(HttpMethod M, string Uri, string? Body)> Capture(BellBeastBaseFactory f, int status, string body, string? etag = null)
    {
        var seen = new List<(HttpMethod, string, string?)>();
        f.EngineHandler.RequestHandler = req =>
        {
            seen.Add((req.Method, req.RequestUri?.AbsoluteUri ?? "", req.Content?.ReadAsStringAsync().GetAwaiter().GetResult()));
            var resp = new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            if (etag != null) resp.Headers.TryAddWithoutValidation("ETag", etag);
            return resp;
        };
        return seen;
    }

    // ── page reads ───────────────────────────────────────────────────────────

    [Theory]
    [InlineData("/api/cb/summary", "http://localhost:8888/api/cb/summary")]
    [InlineData("/api/cb/events?state=unacked&param=RW1_flow&since=1795416960000", "http://localhost:8888/api/cb/events?state=unacked&param=RW1_flow&since=1795416960000")]
    [InlineData("/api/cb/events/12", "http://localhost:8888/api/cb/events/12")]
    [InlineData("/api/cb/cases?state=open", "http://localhost:8888/api/cb/cases?state=open")]
    [InlineData("/api/cb/cases/3", "http://localhost:8888/api/cb/cases/3")]
    [InlineData("/api/cb/monitor", "http://localhost:8888/api/cb/monitor")]
    [InlineData("/api/cb/monitor/RW1_flow?n=60", "http://localhost:8888/api/cb/monitor/RW1_flow?n=60")]
    public async Task Page_Reads_Relay_Path_And_Query_With_View_Token(string path, string upstream)
    {
        var seen = Capture(_anon, 200, """{"ok":true,"items":[]}""");
        var c = await _anon.CreateClient().WithViewTokenAsync();

        var r = await c.GetAsync(path);

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("""{"ok":true,"items":[]}""", await r.Content.ReadAsStringAsync());
        Assert.Equal(upstream, Assert.Single(seen).Uri);
        Assert.Equal("no-store", r.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task Page_Read_Without_View_Token_Is_Refused_Before_Uroboros()
    {
        var seen = Capture(_anon, 200, "{}");
        var r = await _anon.CreateClient().GetAsync("/api/cb/summary");
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.Empty(seen);
    }

    [Fact]
    public async Task Upstream_Error_Status_And_Body_Pass_Through()
    {
        Capture(_anon, 404, """{"ok":false,"error":"not_found","message":"event 99 not found"}""");
        var c = await _anon.CreateClient().WithViewTokenAsync();

        var r = await c.GetAsync("/api/cb/events/99");

        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        Assert.Contains("\"error\":\"not_found\"", await r.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Engine_Down_Is_502_Json()
    {
        _anon.EngineHandler.RequestHandler = _ => throw new HttpRequestException("connection refused");
        var c = await _anon.CreateClient().WithViewTokenAsync();

        var r = await c.GetAsync("/api/cb/summary");

        Assert.Equal(HttpStatusCode.BadGateway, r.StatusCode);
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync())!;
        Assert.Equal("engine_offline", j["error"]!.GetValue<string>());
        Assert.False(j["ok"]!.GetValue<bool>());
    }

    // ── operator actions ─────────────────────────────────────────────────────

    [Fact]
    public async Task Ack_Sends_Login_Name_As_By_Not_The_Browsers()
    {
        var seen = Capture(_admin, 200, """{"ok":true,"acked":true}""");
        var c = _admin.CreateClient();

        var r = await c.PostAsync("/api/cb/events/7/ack",
            new StringContent("""{"by":"someone-else","note":"รับทราบ"}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var call = Assert.Single(seen);
        Assert.Equal(HttpMethod.Post, call.M);
        Assert.Equal("http://localhost:8888/api/cb/events/7/ack", call.Uri);
        var sent = JsonNode.Parse(call.Body!)!;
        Assert.Equal("test-admin", sent["by"]!.GetValue<string>());
        Assert.Equal("รับทราบ", sent["note"]!.GetValue<string>());
    }

    [Fact]
    public async Task Close_With_Empty_Body_Still_Gets_By_And_Keeps_Upstream_409()
    {
        var seen = Capture(_admin, 409, """{"ok":false,"error":"already_closed"}""");

        var r = await _admin.CreateClient().PostAsync("/api/cb/cases/4/close", null);

        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("test-admin", JsonNode.Parse(Assert.Single(seen).Body!)!["by"]!.GetValue<string>());
    }

    [Fact]
    public async Task Bad_Json_Never_Reaches_Uroboros()
    {
        var seen = Capture(_admin, 200, "{}");
        var r = await _admin.CreateClient().PostAsync("/api/cb/events/7/ack", new StringContent("[1,2]", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Empty(seen);
    }

    [Theory]
    [InlineData("/api/cb/events/7/ack")]
    [InlineData("/api/cb/cases/4/close")]
    public async Task Operator_Actions_Need_Sign_In_Even_With_View_Token(string path)
    {
        var seen = Capture(_anon, 200, "{}");
        var c = await _anon.CreateClient().WithViewTokenAsync();
        var r = await c.PostAsync(path, new StringContent("""{"by":"x"}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.Empty(seen);
    }

    // ── registry (admin) ─────────────────────────────────────────────────────

    [Fact]
    public async Task Admin_Put_Relays_Body_Untouched_With_Rev_And_Dry_Run()
    {
        var seen = Capture(_admin, 409, """{"ok":false,"error":"rev_conflict"}""");
        const string item = """{"code":"RW1_flow","scope":"group","merge_sec":240}""";

        var r = await _admin.CreateClient().PutAsync("/api/cb/params/RW1_flow?rev=ab12cd34ef56ab78&dry=1",
            new StringContent(item, Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        var call = Assert.Single(seen);
        Assert.Equal(HttpMethod.Put, call.M);
        Assert.Equal("http://localhost:8888/api/cb/params/RW1_flow?rev=ab12cd34ef56ab78&dry=1", call.Uri);
        Assert.Equal(item, call.Body); // no `by` injected: registry items are schema-checked (additionalProperties false)
    }

    [Theory]
    [InlineData("GET", "/api/cb/config", "http://localhost:8888/api/cb/config")]
    [InlineData("POST", "/api/cb/config/import?dry=1", "http://localhost:8888/api/cb/config/import?dry=1")]
    [InlineData("GET", "/api/cb/schema/fifo2", "http://localhost:8888/api/cb/schema/fifo2")]
    [InlineData("GET", "/api/cb/rules?ruleset=DEFAULT", "http://localhost:8888/api/cb/rules?ruleset=DEFAULT")]
    [InlineData("DELETE", "/api/cb/rules/DEFAULT/C5", "http://localhost:8888/api/cb/rules/DEFAULT/C5")]
    [InlineData("POST", "/api/cb/rules/test", "http://localhost:8888/api/cb/rules/test")]
    [InlineData("GET", "/api/cb/signals", "http://localhost:8888/api/cb/signals")]
    [InlineData("DELETE", "/api/cb/sources/A%20B", "http://localhost:8888/api/cb/sources/A%20B")]
    public async Task Admin_Registry_Routes_Relay(string method, string path, string upstream)
    {
        var seen = Capture(_admin, 200, """{"ok":true}""", "\"0123456789abcdef\"");
        var req = new HttpRequestMessage(new HttpMethod(method), path);
        if (method is "POST") req.Content = new StringContent("{}", Encoding.UTF8, "application/json");

        var r = await _admin.CreateClient().SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var call = Assert.Single(seen);
        Assert.Equal(method, call.M.Method);
        Assert.Equal(upstream, call.Uri);
        Assert.Equal("\"0123456789abcdef\"", r.Headers.ETag?.ToString());
    }

    [Theory]
    [InlineData("GET", "/api/cb/config")]
    [InlineData("PUT", "/api/cb/params/RW1_flow")]
    [InlineData("POST", "/api/cb/rules/test")]
    [InlineData("GET", "/api/cb/schema")]
    public async Task Registry_Is_Admin_Only(string method, string path)
    {
        var seen = Capture(_anon, 200, "{}");
        var c = await _anon.CreateClient().WithViewTokenAsync();
        var req = new HttpRequestMessage(new HttpMethod(method), path);
        if (method is "POST" or "PUT") req.Content = new StringContent("{}", Encoding.UTF8, "application/json");

        var r = await c.SendAsync(req);

        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.Empty(seen);
    }

    [Fact]
    public async Task Unknown_Entity_Has_No_Route()
    {
        var seen = Capture(_admin, 200, "{}");
        var r = await _admin.CreateClient().GetAsync("/api/cb/not_an_entity");
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        Assert.Empty(seen);
    }

    // ── config ───────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("""{"backendBaseUrl":"http://localhost:8888"}""", "/api/cb")]
    [InlineData("""{"backendBaseUrl":"http://localhost:8888","cbApiPath":"x/cb/"}""", "/x/cb")]
    public void CbApiPath_Default_And_Normalised(string json, string expected)
        => Assert.Equal(expected, BackendConfigProvider.Parse(json).CbApiPath);
}
