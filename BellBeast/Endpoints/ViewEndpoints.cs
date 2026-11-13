using System.Text.Json;
using BellBeast.ApiAccess;
using BellBeast.Services;

namespace BellBeast.Endpoints;

/// <summary>View-token renewal for public pages (see ViewTokenService).</summary>
public static class ViewEndpoints
{
    public static void MapViewEndpoints(this WebApplication app, ApiGroups api)
    {
        // Page script → new view token after sleep / server restart / IP change, using the HttpOnly refresh cookie.
        // Also called every few hours by an open page to roll the refresh cookie forward.
        api.Public.MapPost("/api/view/renew", async (HttpContext ctx, ViewTokenService views) =>
        {
            var ip = IpAccessService.ClientIp(ctx);
            if (!views.ValidRefreshTicket(ctx.Request.Cookies[ViewTokenService.RefreshCookie]))
            {
                views.RecordRejection(ip, ctx.Request.Path, "view_refresh_expired");
                return Results.Json(new { ok = false, error = ViewTokenService.PublicError }, statusCode: StatusCodes.Status401Unauthorized);
            }

            var page = "(renew)";
            try
            {
                var b = await ctx.Request.ReadFromJsonAsync<JsonElement>(ctx.RequestAborted);
                if (b.ValueKind == JsonValueKind.Object && b.TryGetProperty("page", out var p) && p.ValueKind == JsonValueKind.String)
                    page = p.GetString()!;
            }
            catch (JsonException) { }

            views.SetRefreshCookie(ctx);
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Json(new
            {
                ok = true,
                token = views.Issue(ip, page),
                idle_sec = (int)views.IdleTimeout.TotalSeconds,
                refresh_sec = (int)views.RefreshLifetime.TotalSeconds,
            });
        });
    }
}

/// <summary>
/// Every 30 s, publishes an aggregate of page traffic into the IoT room as device "bellbeast-traffic"
/// (counts only — the room is public, so no IP addresses). Off with ViewToken:PublishTrafficToRoom=false.
/// </summary>
public sealed class ViewTrafficPublisher : BackgroundService
{
    public const string DeviceName = "bellbeast-traffic";

    private readonly ViewTokenService _views;
    private readonly IotRoomService _room;
    private readonly IConfiguration _cfg;

    public ViewTrafficPublisher(ViewTokenService views, IotRoomService room, IConfiguration cfg)
    {
        _views = views;
        _room = room;
        _cfg = cfg;
    }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        do
        {
            if (!_cfg.GetValue("ViewToken:PublishTrafficToRoom", true)) continue;
            var s = _views.Summary();
            _room.PublishSystemState(DeviceName, "monitor", new Dictionary<string, JsonElement>
            {
                ["active_viewers"] = JsonSerializer.SerializeToElement(s.ActiveViewers),
                ["active_ips"] = JsonSerializer.SerializeToElement(s.ActiveIps),
                ["rejected_last_min"] = JsonSerializer.SerializeToElement(s.RejectedLastMinute),
                ["at"] = JsonSerializer.SerializeToElement(DateTimeOffset.UtcNow),
            });
        }
        while (await timer.WaitForNextTickAsync(stop));
    }
}
