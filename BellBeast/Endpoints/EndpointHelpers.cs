using System.Text.Json;
using BellBeast.Services;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Data.Sqlite;

namespace BellBeast.Endpoints;

/// <summary>Cookie authentication scheme names.</summary>
public static class AuthSchemes
{
    public const string User = CookieAuthenticationDefaults.AuthenticationScheme; // "Cookies"
    public const string Admin = "AdminCookie";
}

/// <summary>
/// The access levels every endpoint is mapped on. All groups have an empty prefix,
/// so URLs are unchanged; only the authorization metadata differs.
/// </summary>
/// <param name="Public">anonymous</param>
/// <param name="User">signed in (user or admin cookie) via the deny-by-default fallback policy</param>
/// <param name="Admin">AdminOnly policy</param>
/// <param name="Page">anonymous, but needs a live view token from one of our pages (see ViewTokenService)</param>
public sealed record ApiGroups(RouteGroupBuilder Public, RouteGroupBuilder User, RouteGroupBuilder Admin, RouteGroupBuilder Page, RouteGroupBuilder Device);

/// <summary>Helpers shared by more than one endpoint module.</summary>
public static class EndpointHelpers
{
    public static BackendConfig Backend(WebApplication app)
        => app.Services.GetRequiredService<BackendConfigProvider>().Current;

    public static string ResolveDbPath(WebApplication app)
    {
        var relPath = app.Configuration["AqTable:DbPath"] ?? "App_Data\\aqtable.db";
        return Path.Combine(app.Environment.ContentRootPath, relPath);
    }

    public static async Task<SqliteConnection> OpenReadOnlyAsync(string dbPath)
    {
        var cs = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadOnly
        }.ToString();

        var con = new SqliteConnection(cs);
        await con.OpenAsync();
        return con;
    }

    /// <summary>String property of a JSON object body, or null.</summary>
    public static string? ConfigArg(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    // GET forward to Uroboros keeping the query string; a down engine becomes a clear 502 JSON instead of a 500 page
    public static async Task ProxyUroborosGetAsync(WebApplication app, HttpContext ctx, SummaryProxyService svc, string path)
    {
        try
        {
            var baseUrl = Backend(app).BaseUrl;
            var qs = ctx.Request.QueryString.Value ?? "";
            using var upstream = await svc.GetAsync($"{baseUrl}{path}{qs}", ctx.RequestAborted);
            ctx.Response.Headers.CacheControl = "no-store";
            await ProxySummaryAsync(ctx, upstream);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ctx.RequestAborted.IsCancellationRequested)
        {
            ctx.Response.StatusCode = StatusCodes.Status502BadGateway;
            ctx.Response.ContentType = "application/json";
            await ctx.Response.WriteAsync(
                JsonSerializer.Serialize(new { ok = false, error = "Uroboros engine unreachable", detail = ex.InnerException?.Message ?? ex.Message }),
                ctx.RequestAborted);
        }
    }

    // Shared streaming helper used by the summary proxy handlers
    public static async Task ProxySummaryAsync(HttpContext ctx, HttpResponseMessage upstream)
    {
        ctx.Response.StatusCode = (int)upstream.StatusCode;

        if (upstream.Content.Headers.ContentType != null)
            ctx.Response.ContentType = upstream.Content.Headers.ContentType.ToString();

        if (!upstream.IsSuccessStatusCode)
        {
            var err = await upstream.Content.ReadAsStringAsync(ctx.RequestAborted);
            await ctx.Response.WriteAsync(err, ctx.RequestAborted);
            return;
        }

        await using var stream = await upstream.Content.ReadAsStreamAsync(ctx.RequestAborted);
        await stream.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
        await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
    }
}
