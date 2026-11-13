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

/// <summary>Login session helpers: admin/user logout, /api/auth/me, bypass role, backend-config.</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class SessionEndpoints
{
    public static void MapSessionEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);
        const string UserScheme = AuthSchemes.User;
        const string AdminScheme = AuthSchemes.Admin;

        // =======================================================
        // ✅ ADMIN debug/logout endpoint (กัน 404 + ล้าง cookie ได้จริง)
        // =======================================================

        // logout: รองรับทั้ง POST/GET กันคนเรียกผิด method แล้ว 404
        pub.MapPost("/api/admin/auth/logout", async (HttpContext ctx) =>
        {
            await ctx.SignOutAsync(AdminScheme);
            return Results.Ok(new { ok = true, redirect = "/Admin/Login" });
        });
        pub.MapGet("/api/admin/auth/logout", async (HttpContext ctx) =>
        {
            await ctx.SignOutAsync(AdminScheme);
            return Results.Ok(new { ok = true, redirect = "/Admin/Login" });
        });

        // me: เอาไว้ debug ว่าติด admin cookie แล้วจริงไหม
        admin.MapGet("/api/admin/auth/me", (HttpContext ctx) =>
        {
            var u = ctx.User?.Identity?.Name ?? "";
            return Results.Ok(new { ok = true, username = u, role = "admin" });
        });

        // ===============================
        // API: expose backend config to JS (optional)
        // ===============================
        user.MapGet("/api/backend-config", () =>
        {
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var queryCsvPath = backendCfg.QueryCsvPath;
            var dailyReportPath = backendCfg.DailyReportPath;
            var chemReportPath = backendCfg.ChemReportPath;
            var chemExportPath = backendCfg.ChemExportPath;
            var wayfarerApiPath = backendCfg.WayfarerApiPath;
            return Results.Ok(new
            {
                backendBaseUrl = baseUrl,
                queryCsvPath,
                dailyReportPath,
                chemReportPath,
                chemExportPath,
                wayfarerApiPath
            });
        });

        // ===============================
        // API : /api/bypass/set  /api/bypass/clear
        // ===============================
        pub.MapPost("/api/bypass/set", (HttpContext ctx) =>
        {
            var role = ctx.Request.Query["role"].ToString().Trim().ToLowerInvariant();
            var allowed = new[] { "scientist", "operator", "executive-3a", "executive-3b", "observer", "superadmin" };
            if (!allowed.Contains(role))
                return Results.BadRequest(new { error = "Invalid role" });

            ctx.Response.Cookies.Append("bb_bypass_role", role, new CookieOptions
            {
                HttpOnly = false,
                SameSite = SameSiteMode.Lax,
                Secure = false,
                Path = "/",
                MaxAge = TimeSpan.FromHours(8)
            });
            return Results.Ok(new { ok = true, role });
        });

        pub.MapPost("/api/bypass/clear", (HttpContext ctx) =>
        {
            ctx.Response.Cookies.Delete("bb_bypass_role");
            return Results.Ok(new { ok = true });
        });

        // ===============================
        // API : /api/auth/me (user mode เดิม)
        // ===============================
        pub.MapGet("/api/auth/me", (HttpContext ctx) =>
        {
            var isAuthenticated = ctx.User?.Identity?.IsAuthenticated ?? false;
            var username = isAuthenticated ? (ctx.User?.Identity?.Name ?? "") : "bypass";
            // The Aquadat token is never sent to the browser; /api/process injects it server-side.
            ctx.Request.Cookies.TryGetValue("bb_bypass_role", out var bypassRole);

            return Results.Ok(new { username, authenticated = isAuthenticated, bypassRole = bypassRole ?? "" });
        });

        // ===============================
        // API : Logout (user mode เดิม)
        // ===============================
        pub.MapPost("/api/auth/logout", async (HttpContext ctx) =>
        {
            await ctx.SignOutAsync(UserScheme);
            return Results.Ok(new { ok = true, redirect = "/Login" });
        });
    }
}
