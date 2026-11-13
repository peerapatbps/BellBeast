using System.Net;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.RateLimiting;

namespace BellBeast.ApiAccess;

/// <summary>
/// Runs after authentication, before authorization, for /api endpoints only:
///   1. API disabled in the catalog → 404 api_disabled (for everyone)
///   2. request carries an API key that did not authenticate → 401 with the reason
///   3. API-key client calling a non-public API it was not granted → 403 api_not_granted
/// Admin APIs are never reachable with a key: the AdminOnly policy only accepts the admin cookie.
/// </summary>
public sealed class ApiGateMiddleware
{
    private readonly RequestDelegate _next;
    public ApiGateMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext ctx, ApiCatalogService catalog)
    {
        var endpoint = ctx.GetEndpoint();
        var id = ApiCatalogService.IdOf(endpoint);
        if (id is null) { await _next(ctx); return; }

        if (!catalog.IsEnabled(id))
        {
            await Reject(ctx, StatusCodes.Status404NotFound, "api_disabled", id);
            return;
        }

        if (ApiKeyAuthenticationHandler.HasKey(ctx))
        {
            var clientId = ctx.User.ClientId();
            if (clientId is null)
            {
                var result = await ctx.AuthenticateAsync(ApiKeyAuthenticationHandler.SchemeName);
                await Reject(ctx, StatusCodes.Status401Unauthorized, result.Failure?.Message ?? "api_key_invalid", id);
                return;
            }

            if (ApiCatalogService.AccessOf(endpoint!) == ApiCatalogService.AccessUser &&
                !ctx.User.HasClaim(ApiKeyAuthenticationHandler.ClaimGrant, id))
            {
                await Reject(ctx, StatusCodes.Status403Forbidden, "api_not_granted", id);
                return;
            }
        }

        await _next(ctx);
    }

    private static Task Reject(HttpContext ctx, int status, string error, string api)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.Headers.CacheControl = "no-store";
        return ctx.Response.WriteAsJsonAsync(new { ok = false, error, api });
    }
}

/// <summary>
/// Fixed-window limits on /api: API-key clients by their own per-minute limit,
/// everyone else per client IP (RateLimit:PerIpPerMinute, 0 = off).
/// Behind the Cloudflare tunnel every request arrives from loopback, so CF-Connecting-IP is used there.
/// </summary>
public static class ApiRateLimiting
{
    public const int DefaultPerIpPerMinute = 1200;

    public static IServiceCollection AddApiRateLimiting(this IServiceCollection services, IConfiguration config)
    {
        services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.OnRejected = async (ctx, ct) =>
            {
                var http = ctx.HttpContext;
                if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retry))
                    http.Response.Headers.RetryAfter = ((int)Math.Ceiling(retry.TotalSeconds)).ToString();
                await http.Response.WriteAsJsonAsync(new { ok = false, error = "rate_limited" }, ct);
            };
            o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(http =>
            {
                if (!http.Request.Path.StartsWithSegments("/api"))
                    return RateLimitPartition.GetNoLimiter("_");

                if (http.User.ClientId() is { } clientId)
                {
                    var rate = int.TryParse(http.User.FindFirst(ApiKeyAuthenticationHandler.ClaimRate)?.Value, out var r) ? r : ApiClientService.DefaultRatePerMinute;
                    return Window($"c:{clientId}:{rate}", rate);
                }

                var perIp = config.GetValue("RateLimit:PerIpPerMinute", DefaultPerIpPerMinute);
                return perIp <= 0 ? RateLimitPartition.GetNoLimiter("_") : Window("ip:" + ClientIp(http), perIp);
            });
        });
        return services;
    }

    private static RateLimitPartition<string> Window(string key, int permits) =>
        RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = permits,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        });

    public static string ClientIp(HttpContext http)
    {
        var remote = http.Connection.RemoteIpAddress;
        if (remote is not null && IPAddress.IsLoopback(remote) &&
            http.Request.Headers["CF-Connecting-IP"].FirstOrDefault() is { Length: > 0 } cf)
            return cf.Trim();
        return remote?.ToString() ?? "?";
    }
}
