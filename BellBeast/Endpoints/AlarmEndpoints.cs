using System.IO.Compression;
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using BellBeast.Services;
using BellBeast.Wayfarer;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Options;
using System.Text.RegularExpressions;
using static BellBeast.Endpoints.EndpointHelpers;

namespace BellBeast.Endpoints;

/// <summary>Alarm feed for devices, LAB glance, alarm monitor + metrics history proxies.</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class AlarmEndpoints
{
    public static void MapAlarmEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);

        // ===============================
        // Alarm feed (Uroboros alarm engine → devices) + monitor proxies
        // ===============================

        // Device / dashboard → current alarm state, optionally for given zone(s): /api/alarm/active?zone=RWS,DPS
        // Level-based: Uroboros posts the FULL state every ~30 s into the room; this just filters it.
        // ack is the device's own job — nothing is sent back to Uroboros.
        pub.MapGet("/api/alarm/active", (IotRoomService iotRoom, HttpContext ctx) =>
        {
            var zones = AlarmFeedService.ParseZones(ctx.Request.Query["zone"].FirstOrDefault());
            var (state, updatedAt, online) = iotRoom.GetDeviceState(AlarmFeedService.EngineDeviceName);
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Json(AlarmFeedService.Build(state, updatedAt, online, DateTimeOffset.UtcNow, zones));
        });

        // Device touch screen → compact LAB view (5 groups × 4 units + 16 status dots), statuses worked out here
        // with the same rules as the MHxView LAB card (LABview.js) — see Services/LabGlanceService.cs
        pub.MapGet("/api/device/lab/glance", async (HttpContext ctx, LabGlanceService svc) =>
        {
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var labSummaryPath = backendCfg.LabSummaryPath;
            var lvBase = (app.Configuration["LabVenture:BaseUrl"] ?? "http://localhost:8889").TrimEnd('/');
            var json = await svc.GetJsonAsync($"{baseUrl}{labSummaryPath}", $"{lvBase}/api/scenarios/limits", ctx.RequestAborted);
            ctx.Response.Headers.CacheControl = "no-store";
            ctx.Response.ContentType = "application/json; charset=utf-8";
            await ctx.Response.WriteAsync(json, ctx.RequestAborted);
        });

        // Device 30 s loop → active scenario / epidemic + threshold revision (LabVenture /api/scenarios/log).
        // A new revision drops the glance cache so the device's next glance carries the new limits.
        pub.MapGet("/api/device/lab/scenario", async (HttpContext ctx, LabGlanceService svc) =>
        {
            var lvBase = (app.Configuration["LabVenture:BaseUrl"] ?? "http://localhost:8889").TrimEnd('/');
            var json = await svc.GetScenarioJsonAsync(lvBase, ctx.RequestAborted);
            ctx.Response.Headers.CacheControl = "no-store";
            ctx.Response.ContentType = "application/json; charset=utf-8";
            await ctx.Response.WriteAsync(json, ctx.RequestAborted);
        });

        // Monitor page (admin tab) → z-score table / chart data, forwarded to Uroboros (same-origin for the browser)
        admin.MapGet("/api/alarm/monitor", async (HttpContext ctx, SummaryProxyService svc) =>
            await ProxyUroborosGetAsync(app, ctx, svc, "/api/alarm/monitor"));

        admin.MapGet("/api/metrics/history", async (HttpContext ctx, SummaryProxyService svc) =>
            await ProxyUroborosGetAsync(app, ctx, svc, "/api/metrics/history"));
    }
}
