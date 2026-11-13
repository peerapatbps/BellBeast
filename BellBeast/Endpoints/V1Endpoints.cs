using System.Security.Claims;
using System.Text.Json;
using BellBeast.ApiAccess;

namespace BellBeast.Endpoints;

/// <summary>
/// Public API v1 for other systems: admin-defined datasets (see DatasetService).
/// Needs a signed-in user or an API key; an API key additionally needs the grant "dataset:&lt;id&gt;"
/// for each dataset (checked here, so the gate's per-route grant check is skipped for this group).
/// </summary>
public static class V1Endpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    public static void MapV1Endpoints(this WebApplication app, ApiGroups api)
    {
        var v1 = api.User.MapGroup("/api/v1").WithMetadata(new PerResourceGrants());

        v1.MapGet("/datasets", (HttpContext ctx, DatasetService sets) =>
            Results.Json(new { ok = true, datasets = Visible(ctx.User, sets).Select(Describe) }, Json));

        v1.MapGet("/datasets/{id}", async (string id, HttpContext ctx, DatasetService sets, UroborosMetricsClient uro) =>
        {
            if (Denied(ctx.User, sets, id) is { } err) return err;
            var ds = sets.Get(id)!;
            if (SelectFields(ds, ctx.Request.Query["fields"]) is not { } fields) return Fail("unknown_field", 400);

            try
            {
                var latest = await Task.WhenAll(fields.Select(f => uro.LatestAsync(f.Stream, f.Param, ctx.RequestAborted)));
                var values = fields.Select((f, i) => (f, p: latest[i]))
                    .ToDictionary(x => x.f.Name, x => new { value = x.p?.Value, ts = x.p?.Ts, unit = x.f.Unit });
                ctx.Response.Headers.CacheControl = "no-store";
                return Results.Json(new { ok = true, dataset = ds.Id, version = ds.Version, fetched_at = DateTimeOffset.UtcNow, values }, Json);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException && !ctx.RequestAborted.IsCancellationRequested)
            {
                return Fail("upstream_unavailable", 502);
            }
        });

        v1.MapGet("/datasets/{id}/history", async (string id, HttpContext ctx, DatasetService sets, UroborosMetricsClient uro) =>
        {
            if (Denied(ctx.User, sets, id) is { } err) return err;
            var ds = sets.Get(id)!;
            if (SelectFields(ds, ctx.Request.Query["fields"]) is not { } fields) return Fail("unknown_field", 400);

            var n = 60;
            if (ctx.Request.Query.TryGetValue("n", out var nq) && (!int.TryParse(nq, out n) || n < 1))
                return Fail("bad_n", 400);
            n = Math.Min(n, ds.MaxHistory);

            try
            {
                var series = await Task.WhenAll(fields.Select(f => uro.HistoryAsync(f.Stream, f.Param, n, ctx.RequestAborted)));
                var body = fields.Select((f, i) => (f, s: series[i]))
                    .ToDictionary(x => x.f.Name, x => x.s.Select(p => new { ts = p.Ts, value = p.Value }));
                return Results.Json(new { ok = true, dataset = ds.Id, version = ds.Version, interval_sec = 60, n, series = body }, Json);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException && !ctx.RequestAborted.IsCancellationRequested)
            {
                return Fail("upstream_unavailable", 502);
            }
        });

        v1.MapGet("/openapi.json", (HttpContext ctx, DatasetService sets) =>
            Results.Json(OpenApi(Visible(ctx.User, sets), $"{ctx.Request.Scheme}://{ctx.Request.Host}"), Json));
    }

    // ── access ───────────────────────────────────────────────────────────────

    private static bool CanRead(ClaimsPrincipal user, string datasetId) =>
        user.ClientId() is null   // staff signed in with a cookie: every enabled dataset
        || user.HasClaim(ApiKeyAuthenticationHandler.ClaimGrant, DatasetService.GrantId(datasetId));

    private static IEnumerable<DatasetService.Dataset> Visible(ClaimsPrincipal user, DatasetService sets) =>
        sets.List().Where(d => d.Enabled && CanRead(user, d.Id));

    /// <summary>Error result when the dataset is unknown / disabled / not granted, else null.</summary>
    private static IResult? Denied(ClaimsPrincipal user, DatasetService sets, string id)
    {
        var ds = sets.Get(id);
        if (ds is null || !ds.Enabled) return Fail("unknown_dataset", 404);
        if (!CanRead(user, id)) return Fail("dataset_not_granted", 403);
        return null;
    }

    private static List<DatasetService.DatasetField>? SelectFields(DatasetService.Dataset ds, string? query)
    {
        if (string.IsNullOrWhiteSpace(query)) return ds.Fields;
        var wanted = query.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct().ToList();
        var map = ds.Fields.ToDictionary(f => f.Name);
        return wanted.All(map.ContainsKey) ? wanted.Select(w => map[w]).ToList() : null;
    }

    private static IResult Fail(string error, int status) => Results.Json(new { ok = false, error }, Json, statusCode: status);

    private static object Describe(DatasetService.Dataset d) => new
    {
        id = d.Id, title = d.Title, description = d.Description, version = d.Version, max_history = d.MaxHistory,
        fields = d.Fields.Select(f => new { name = f.Name, unit = f.Unit, label = f.Label }),
        links = new { latest = $"/api/v1/datasets/{d.Id}", history = $"/api/v1/datasets/{d.Id}/history?n=60" },
    };

    // ── OpenAPI 3.0 (only the datasets this caller can read) ──────────────────

    private static object OpenApi(IEnumerable<DatasetService.Dataset> visible, string server)
    {
        var sets = visible.ToList();
        var idParam = new Dictionary<string, object>
        {
            ["name"] = "id", ["in"] = "path", ["required"] = true,
            ["schema"] = new Dictionary<string, object> { ["type"] = "string", ["enum"] = sets.Select(d => d.Id).ToArray() },
        };
        var fieldsParam = new Dictionary<string, object>
        {
            ["name"] = "fields", ["in"] = "query", ["required"] = false,
            ["description"] = "Comma-separated field names (default: all fields of the dataset)",
            ["schema"] = new Dictionary<string, object> { ["type"] = "string" },
        };
        var err = new Dictionary<string, object>
        {
            ["401"] = new Dictionary<string, object> { ["description"] = "Missing / invalid / disabled / expired API key" },
            ["403"] = new Dictionary<string, object> { ["description"] = "dataset_not_granted" },
            ["404"] = new Dictionary<string, object> { ["description"] = "unknown_dataset or api_disabled" },
            ["429"] = new Dictionary<string, object> { ["description"] = "rate_limited (see Retry-After)" },
            ["502"] = new Dictionary<string, object> { ["description"] = "upstream_unavailable" },
        };
        Dictionary<string, object> Op(string summary, string description, object[] parameters) => new()
        {
            ["summary"] = summary, ["description"] = description, ["parameters"] = parameters,
            ["responses"] = new Dictionary<string, object>(err) { ["200"] = new Dictionary<string, object> { ["description"] = "OK" } },
        };

        var datasetDocs = string.Join("\n", sets.Select(d =>
            $"- **{d.Id}** (v{d.Version}) — {d.Title}: " + string.Join(", ", d.Fields.Select(f => f.Unit is null ? f.Name : $"{f.Name} [{f.Unit}]"))));

        return new Dictionary<string, object>
        {
            ["openapi"] = "3.0.3",
            ["info"] = new Dictionary<string, object>
            {
                ["title"] = "BellBeast API v1", ["version"] = "1",
                ["description"] = "Plant datasets published by BellBeast. Timestamps are ISO 8601 with the plant's UTC offset; " +
                                  "values are sampled every 60 s.\n\nDatasets available to you:\n" + (datasetDocs.Length > 0 ? datasetDocs : "(none granted yet)"),
            },
            ["servers"] = new[] { new Dictionary<string, object> { ["url"] = server } },
            ["components"] = new Dictionary<string, object>
            {
                ["securitySchemes"] = new Dictionary<string, object>
                {
                    ["ApiKey"] = new Dictionary<string, object> { ["type"] = "apiKey", ["in"] = "header", ["name"] = ApiKeyAuthenticationHandler.HeaderName },
                },
            },
            ["security"] = new[] { new Dictionary<string, object> { ["ApiKey"] = Array.Empty<string>() } },
            ["paths"] = new Dictionary<string, object>
            {
                ["/api/v1/datasets"] = new Dictionary<string, object> { ["get"] = Op("List the datasets you can read", "", Array.Empty<object>()) },
                ["/api/v1/datasets/{id}"] = new Dictionary<string, object> { ["get"] = Op("Latest value of each field", "values.{field} = { value, ts, unit }", new object[] { idParam, fieldsParam }) },
                ["/api/v1/datasets/{id}/history"] = new Dictionary<string, object>
                {
                    ["get"] = Op("Recent history of each field", "series.{field} = [{ ts, value }], oldest first; n is capped by the dataset's max_history",
                        new object[] { idParam, fieldsParam, new Dictionary<string, object>
                        {
                            ["name"] = "n", ["in"] = "query", ["required"] = false,
                            ["schema"] = new Dictionary<string, object> { ["type"] = "integer", ["minimum"] = 1, ["default"] = 60 },
                        } }),
                },
            },
        };
    }
}
