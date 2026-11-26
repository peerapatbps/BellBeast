using System.Text;
using System.Text.Json.Nodes;
using static BellBeast.Endpoints.EndpointHelpers;

namespace BellBeast.Endpoints;

/// <summary>
/// Uroboros connector box (trigger → event log → case) proxied same-origin under /api/cb/*.
/// Contract: Uroboros/handoff/Aquadat2/08_cb_api_contract_bellbeast.md.
/// </summary>
/// <remarks>
/// Access level comes from the group an endpoint is mapped on:
///   page  = dashboard reads (summary, events, cases, monitor) — view token, like the other MHxView cards
///   user  = operator actions (ack, close case) — signed in; <c>by</c> is ALWAYS overwritten with the login name
///   admin = registry: config import/export, per-item edit, schemas, rule tester
/// Uroboros has no login of its own and trusts BellBeast, so the browser never sets <c>by</c>.
/// Query strings (filters, <c>?rev=</c>, <c>?dry=1</c>) and Uroboros' status + JSON body pass through unchanged;
/// an unreachable engine answers 502 <c>{ ok:false, error:"engine_offline" }</c> like the task-table relay.
/// </remarks>
public static class CbEndpoints
{
    /// <summary>Registry lists that have per-item routes on Uroboros (same names as in cb_config.json).</summary>
    public const string EntityPattern = "^(slot_types|sources|equipment|signals|groups|detectors|rulesets|sinks|params)$";

    public static void MapCbEndpoints(this WebApplication app, ApiGroups api)
    {
        var (page, user, admin) = (api.Page, api.User, api.Admin);

        // ── dashboard reads ────────────────────────────────────────────────────
        page.MapGet("/api/cb/summary", (HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", "/summary"));
        page.MapGet("/api/cb/events", (HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", "/events"));
        page.MapGet("/api/cb/events/{id:long}", (long id, HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", $"/events/{id}"));
        page.MapGet("/api/cb/cases", (HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", "/cases"));
        page.MapGet("/api/cb/cases/{id:long}", (long id, HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", $"/cases/{id}"));
        page.MapGet("/api/cb/monitor", (HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", "/monitor"));
        page.MapGet("/api/cb/monitor/{param}", (string param, HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", $"/monitor/{Seg(param)}"));

        // ── operator actions: who did it = the signed-in user, never the browser ──
        user.MapPost("/api/cb/events/{id:long}/ack", (long id, HttpContext ctx, IHttpClientFactory f) => RelayAsActorAsync(app, ctx, f, $"/events/{id}/ack"));
        user.MapPost("/api/cb/cases/{id:long}/close", (long id, HttpContext ctx, IHttpClientFactory f) => RelayAsActorAsync(app, ctx, f, $"/cases/{id}/close"));

        // ── registry (admin) ───────────────────────────────────────────────────
        admin.MapGet("/api/cb/config", (HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", "/config"));
        admin.MapPost("/api/cb/config/import", (HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "POST", "/config/import"));
        admin.MapGet("/api/cb/schema", (HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", "/schema"));
        admin.MapGet("/api/cb/schema/{slotType}", (string slotType, HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", $"/schema/{Seg(slotType)}"));
        admin.MapGet("/api/cb/rules", (HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", "/rules"));
        admin.MapPost("/api/cb/rules/test", (HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "POST", "/rules/test"));
        admin.MapMethods("/api/cb/rules/{ruleset}/{code}", new[] { "GET", "PUT", "DELETE" },
            (string ruleset, string code, HttpContext ctx, IHttpClientFactory f) =>
                RelayAsync(app, ctx, f, ctx.Request.Method, $"/rules/{Seg(ruleset)}/{Seg(code)}"));
        admin.MapGet($"/api/cb/{{entity:regex({EntityPattern})}}",
            (string entity, HttpContext ctx, IHttpClientFactory f) => RelayAsync(app, ctx, f, "GET", $"/{entity}"));
        admin.MapMethods($"/api/cb/{{entity:regex({EntityPattern})}}/{{code}}", new[] { "GET", "PUT", "DELETE" },
            (string entity, string code, HttpContext ctx, IHttpClientFactory f) =>
                RelayAsync(app, ctx, f, ctx.Request.Method, $"/{entity}/{Seg(code)}"));
    }

    private static string Seg(string s) => Uri.EscapeDataString(s);

    /// <summary>Forward one call to Uroboros {base}{cbApiPath}{path}{query} with the request body (if any).</summary>
    private static async Task<IResult> RelayAsync(WebApplication app, HttpContext ctx, IHttpClientFactory factory,
        string method, string path, string? bodyOverride = null)
    {
        var cfg = Backend(app);
        var url = $"{cfg.BaseUrl}{cfg.CbApiPath}{path}{ctx.Request.QueryString}";
        try
        {
            var body = bodyOverride;
            if (body is null && method is "POST" or "PUT" && (ctx.Request.ContentLength > 0 || ctx.Request.Headers.ContainsKey("Transfer-Encoding")))
            {
                using var reader = new StreamReader(ctx.Request.Body, Encoding.UTF8);
                body = await reader.ReadToEndAsync(ctx.RequestAborted);
            }

            var client = factory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(30);
            using var req = new HttpRequestMessage(new HttpMethod(method), url);
            if (body is not null) req.Content = new StringContent(body, Encoding.UTF8, "application/json");
            using var resp = await client.SendAsync(req, ctx.RequestAborted);
            var text = await resp.Content.ReadAsStringAsync(ctx.RequestAborted);

            ctx.Response.Headers.CacheControl = "no-store";
            if (resp.Headers.ETag is { } etag) ctx.Response.Headers.ETag = etag.ToString();
            return Results.Content(text, "application/json", Encoding.UTF8, (int)resp.StatusCode);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ctx.RequestAborted.IsCancellationRequested)
        {
            return Results.Json(new { ok = false, error = "engine_offline", message = "Uroboros engine unreachable", detail = ex.InnerException?.Message ?? ex.Message },
                statusCode: StatusCodes.Status502BadGateway);
        }
    }

    /// <summary>Operator action: keep the browser's note, replace <c>by</c> with the login name.</summary>
    private static async Task<IResult> RelayAsActorAsync(WebApplication app, HttpContext ctx, IHttpClientFactory factory, string path)
    {
        var actor = ctx.User.Identity?.Name;
        if (string.IsNullOrWhiteSpace(actor))
            return Results.Json(new { ok = false, error = "no_actor", message = "signed-in user has no name" }, statusCode: StatusCodes.Status403Forbidden);

        JsonObject body;
        try
        {
            using var reader = new StreamReader(ctx.Request.Body, Encoding.UTF8);
            var raw = await reader.ReadToEndAsync(ctx.RequestAborted);
            body = string.IsNullOrWhiteSpace(raw) ? new JsonObject() : JsonNode.Parse(raw) as JsonObject ?? throw new FormatException();
        }
        catch (Exception ex) when (ex is FormatException or System.Text.Json.JsonException)
        {
            return Results.Json(new { ok = false, error = "bad_json", message = "body must be a JSON object" }, statusCode: StatusCodes.Status400BadRequest);
        }

        body["by"] = actor;
        return await RelayAsync(app, ctx, factory, "POST", path, body.ToJsonString());
    }
}
