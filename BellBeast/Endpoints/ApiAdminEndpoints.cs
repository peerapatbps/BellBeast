using System.Text.Json;
using BellBeast.ApiAccess;

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

        // grantable = non-public, non-admin APIs (public ones need no key, admin ones only accept the admin cookie)
        static Func<string, bool> Grantable(ApiCatalogService catalog)
        {
            var ids = catalog.List().Where(a => a.Access == ApiCatalogService.AccessUser).Select(a => a.Id).ToHashSet(StringComparer.Ordinal);
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
    }
}
