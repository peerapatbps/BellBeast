using System.Text.Json;
using BellBeast.ApiAccess;
using BellBeast.Services;

namespace BellBeast.Endpoints;

/// <summary>Admin → API catalog (enable/disable each API) and API client registry (keys, grants, limits).</summary>
public static class ApiAdminEndpoints
{
    public static void MapApiAdminEndpoints(this WebApplication app, ApiGroups api)
    {
        var admin = api.Admin;
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web) { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

        static string? Actor(HttpContext ctx) => ctx.User.Identity?.Name;

        static async Task<JsonElement> Body(HttpContext ctx)
        {
            try { return await ctx.Request.ReadFromJsonAsync<JsonElement>(ctx.RequestAborted); }
            catch (JsonException) { return default; }
        }

        IResult Error(string code, int status = 400) => Results.Json(new { ok = false, error = code }, json, statusCode: status);

        // grantable = login-level APIs (public ones need no key, admin ones only accept the admin cookie)
        // + one "dataset:<id>" per /api/v1 dataset (the v1 routes themselves are granted per dataset)
        Func<string, bool> Grantable(ApiCatalogService catalog)
        {
            var ids = catalog.List()
                .Where(a => a.Access == ApiCatalogService.AccessUser && !a.Route.StartsWith("/api/v1/", StringComparison.Ordinal))
                .Select(a => a.Id)
                .Concat(app.Services.GetRequiredService<DatasetService>().List().Select(d => DatasetService.GrantId(d.Id)))
                .ToHashSet(StringComparer.Ordinal);
            return ids.Contains;
        }

        admin.MapGet("/api/admin/api/catalog", (ApiCatalogService catalog) =>
            Results.Json(new { ok = true, apis = catalog.List() }, json));

        admin.MapPost("/api/admin/api/catalog", async (HttpContext ctx, ApiCatalogService catalog) =>
        {
            var b = await Body(ctx);
            if (b.ValueKind != JsonValueKind.Object || !b.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.String)
                return Error("bad_json");

            bool? enabled = b.TryGetProperty("enabled", out var en) && en.ValueKind is JsonValueKind.True or JsonValueKind.False ? en.GetBoolean() : null;
            string? note = b.TryGetProperty("note", out var no) && no.ValueKind == JsonValueKind.String ? no.GetString() : null;

            var err = catalog.Set(idEl.GetString()!, enabled, note, Actor(ctx));
            return err is null ? Results.Json(new { ok = true, api = catalog.Find(idEl.GetString()!) }, json)
                 : Error(err, err == "unknown_api" ? 404 : 400);
        });

        admin.MapGet("/api/admin/api/clients", (ApiClientService clients) =>
            Results.Json(new { ok = true, clients = clients.List() }, json));

        admin.MapPost("/api/admin/api/clients", async (HttpContext ctx, ApiClientService clients, ApiCatalogService catalog) =>
        {
            var (client, key, err) = clients.Create(await Body(ctx), Grantable(catalog), Actor(ctx));
            if (err is not null) return Error(err);
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { ok = true, client, key }, json);   // the only time the plain key is returned
        });

        admin.MapPost("/api/admin/api/clients/{id}", async (string id, HttpContext ctx, ApiClientService clients, ApiCatalogService catalog) =>
        {
            var err = clients.Update(id, await Body(ctx), Grantable(catalog), Actor(ctx));
            return err is null ? Results.Json(new { ok = true, client = clients.List().FirstOrDefault(c => c.Id == id) }, json)
                 : Error(err, err == "unknown_client" ? 404 : 400);
        });

        admin.MapPost("/api/admin/api/clients/{id}/rotate", (string id, HttpContext ctx, ApiClientService clients) =>
        {
            var (key, err) = clients.Rotate(id, Actor(ctx));
            if (err is not null) return Error(err, 404);
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { ok = true, key }, json);
        });

        admin.MapDelete("/api/admin/api/clients/{id}", (string id, HttpContext ctx, ApiClientService clients) =>
            clients.Delete(id, Actor(ctx)) ? Results.Json(new { ok = true }, json) : Error("unknown_client", 404));

        // ── Datasets for /api/v1 ────────────────────────────────────────────────

        admin.MapGet("/api/admin/datasets", (DatasetService sets) =>
            Results.Json(new { ok = true, datasets = sets.List() }, json));

        // Uroboros realtime metrics for the field picker
        admin.MapGet("/api/admin/datasets/metrics", async (HttpContext ctx, UroborosMetricsClient uro) =>
        {
            try
            {
                var (_, realtime) = await uro.SchemaAsync(ctx.RequestAborted, refresh: ctx.Request.Query.ContainsKey("refresh"));
                return Results.Json(new { ok = true, realtime }, json);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
            {
                return Error("upstream_unavailable", 502);
            }
        });

        admin.MapPost("/api/admin/datasets", async (HttpContext ctx, DatasetService sets, UroborosMetricsClient uro) =>
        {
            HashSet<string> known;
            try { (known, _) = await uro.SchemaAsync(ctx.RequestAborted); }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException) { return Error("upstream_unavailable", 502); }

            var (saved, err) = sets.Save(await Body(ctx), known, Actor(ctx));
            return err is null ? Results.Json(new { ok = true, dataset = saved }, json) : Error(err);
        });

        admin.MapDelete("/api/admin/datasets/{id}", (string id, HttpContext ctx, DatasetService sets) =>
            sets.Delete(id, Actor(ctx)) ? Results.Json(new { ok = true }, json) : Error("unknown_dataset", 404));

        // ── IP: who writes into the public IoT room + site-wide IP bans ─────────

        admin.MapGet("/api/admin/ip/activity", (HttpContext ctx, IpAccessService ips) =>
            Results.Json(new { ok = true, your_ip = IpAccessService.ClientIp(ctx), activity = ips.ListActivity() }, json));

        // live page viewers (view tokens) + callers rejected for a missing / stale token
        admin.MapGet("/api/admin/ip/viewers", (ViewTokenService views) =>
            Results.Json(new
            {
                ok = true,
                idle_sec = (int)views.IdleTimeout.TotalSeconds,
                viewers = views.ListViewers(),
                rejected = views.ListRejections(),
            }, json));

        admin.MapGet("/api/admin/ip/bans", (HttpContext ctx, IpAccessService ips) =>
            Results.Json(new { ok = true, your_ip = IpAccessService.ClientIp(ctx), bans = ips.ListBans() }, json));

        admin.MapPost("/api/admin/ip/bans", async (HttpContext ctx, IpAccessService ips) =>
        {
            var b = await Body(ctx);
            if (b.ValueKind != JsonValueKind.Object) return Error("bad_json");
            string? Str(string n) => b.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

            int? minutes = null;   // absent / null = permanent
            if (b.TryGetProperty("minutes", out var m) && m.ValueKind != JsonValueKind.Null)
            {
                if (!m.TryGetInt32(out var mm)) return Error("bad_duration");
                minutes = mm;
            }

            var err = ips.Ban(Str("ip"), Str("reason"), minutes, Actor(ctx), IpAccessService.ClientIp(ctx));
            return err is null ? Results.Json(new { ok = true, bans = ips.ListBans() }, json) : Error(err);
        });

        admin.MapDelete("/api/admin/ip/bans/{ip}", (string ip, HttpContext ctx, IpAccessService ips) =>
            ips.Unban(ip, Actor(ctx)) ? Results.Json(new { ok = true, bans = ips.ListBans() }, json) : Error("not_banned", 404));

        // ── IP passes: page APIs without a view token for the truck scale / approved fleet devices ──

        static Func<string, bool> PageRoutes(ApiCatalogService catalog)
        {
            var ids = catalog.List().Where(a => a.Access == ApiCatalogService.AccessPage).Select(a => a.Id).ToHashSet(StringComparer.Ordinal);
            return ids.Contains;
        }

        static List<string>? Routes(JsonElement b) =>
            b.ValueKind == JsonValueKind.Object && b.TryGetProperty("routes", out var r) && r.ValueKind == JsonValueKind.Array
                ? r.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList()
                : null;

        object PassView(IpPassService passes, DeviceFleetService fleet, ApiCatalogService catalog)
        {
            var usage = passes.UsageByIp();
            var since = DateTimeOffset.UtcNow - IpPassService.FleetWindow;
            return new
            {
                ok = true,
                passes = passes.List().Select(p =>
                {
                    usage.TryGetValue(p.Ip, out var u);
                    return new { p.Ip, p.Routes, p.Note, p.CreatedAt, p.CreatedBy, p.UpdatedAt, hits = u?.Hits ?? 0, last_used = u?.LastUsed, last_route = u?.LastRoute };
                }),
                fleet_routes = passes.FleetRoutes(),
                fleet_window_min = (int)IpPassService.FleetWindow.TotalMinutes,
                fleet_devices = fleet.ApprovedDevices().Select(d =>
                {
                    var u = d.SeenIp is not null && usage.TryGetValue(d.SeenIp, out var x) && x.Via == "fleet:" + d.Id ? x : null;
                    return new { id = d.Id, name = d.Name, seen_ip = d.SeenIp, seen_at = d.SeenAt, active = d.SeenIp is not null && d.SeenAt > since,
                                 hits = u?.Hits ?? 0, last_used = u?.LastUsed };
                }),
                page_routes = catalog.List().Where(a => a.Access == ApiCatalogService.AccessPage).Select(a => a.Id),
            };
        }

        admin.MapGet("/api/admin/ip/passes", (IpPassService passes, DeviceFleetService fleet, ApiCatalogService catalog) =>
            Results.Json(PassView(passes, fleet, catalog), json));

        admin.MapPost("/api/admin/ip/passes", async (HttpContext ctx, IpPassService passes, DeviceFleetService fleet, ApiCatalogService catalog) =>
        {
            var b = await Body(ctx);
            if (b.ValueKind != JsonValueKind.Object) return Error("bad_json");
            string? Str(string n) => b.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            var err = passes.Upsert(Str("ip"), Routes(b), Str("note"), PageRoutes(catalog), Actor(ctx));
            return err is null ? Results.Json(PassView(passes, fleet, catalog), json) : Error(err);
        });

        admin.MapDelete("/api/admin/ip/passes/{ip}", (string ip, HttpContext ctx, IpPassService passes, DeviceFleetService fleet, ApiCatalogService catalog) =>
            passes.Remove(ip, Actor(ctx)) ? Results.Json(PassView(passes, fleet, catalog), json) : Error("unknown_pass", 404));

        admin.MapPost("/api/admin/ip/passes/fleet", async (HttpContext ctx, IpPassService passes, DeviceFleetService fleet, ApiCatalogService catalog) =>
        {
            var err = passes.SetFleetRoutes(Routes(await Body(ctx)), PageRoutes(catalog), Actor(ctx));
            return err is null ? Results.Json(PassView(passes, fleet, catalog), json) : Error(err);
        });
    }
}
