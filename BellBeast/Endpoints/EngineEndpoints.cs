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

/// <summary>Uroboros engine control: admin task actions, PIN-guarded sequence + config editor, self-tests.</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class EngineEndpoints
{
    public static void MapEngineEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);

        admin.MapPost("/api/admin/pause", async (EngineAdminService svc) =>
        {
            await svc.PauseAsync();
            return Results.Ok();
        });

        admin.MapPost("/api/admin/resume", async (EngineAdminService svc) =>
        {
            await svc.ResumeAsync();
            return Results.Ok();
        });

        admin.MapPost("/api/admin/cancelall", async (EngineAdminService svc) =>
        {
            await svc.CancelAllAsync();
            return Results.Ok();
        });

        admin.MapPost("/api/admin/enqueue", async (EngineAdminService svc, HttpContext ctx) =>
        {
            var dto = await ctx.Request.ReadFromJsonAsync<Dictionary<string, string>>();
            if (dto == null || !dto.TryGetValue("name", out var name))
                return Results.BadRequest();

            await svc.EnqueueAsync(name);
            return Results.Ok();
        });

        // Proxy: forward GET admin/tasks/status to Uroboros and relay the response.
        // Lets the browser call /api/admin/tasks/status (BellBeast) instead of calling
        // Uroboros directly — avoids cross-origin / firewall issues from the browser.
        admin.MapGet("/api/admin/tasks/status", async (EngineAdminService svc) =>
        {
            try
            {
                var result = await svc.GetStatusAsync();
                return result is null
                    ? Results.Problem("Engine returned null — may be offline")
                    : Results.Ok(result);
            }
            catch (Exception ex)
            {
                return Results.Problem(ex.Message);
            }
        });

        // Admin page task table: config read/write + force run, relayed to Uroboros unchanged.
        // The browser only talks to BellBeast (443); WiFi clients cannot reach Uroboros on 8888.
        admin.MapGet("/api/admin/tasks/config", (EngineAdminService svc) =>
            RelayEngineAsync(() => svc.GetTasksConfigRawAsync()));

        admin.MapPost("/api/admin/tasks/config", async (HttpContext ctx, EngineAdminService svc) =>
        {
            using var reader = new StreamReader(ctx.Request.Body);
            var body = await reader.ReadToEndAsync();
            return await RelayEngineAsync(() => svc.PostTasksConfigRawAsync(body));
        });

        admin.MapPost("/api/admin/tasks/forcerun", async (HttpContext ctx, EngineAdminService svc) =>
        {
            using var reader = new StreamReader(ctx.Request.Body);
            var body = await reader.ReadToEndAsync();
            return await RelayEngineAsync(() => svc.ForceRunRawAsync(body));
        });

        // ── Engine sequential start (MHxView ⚙️ → Engine tab) ─────────────────────────
        // MHxView is anonymous, so start/cancel require the EngineControl PIN (rate-limited per IP).
        // Status is read-only and open. Uroboros runs every enabled task one at a time, then resumes.
        static IResult EnginePinFailure(EnginePinGuard.Result r) => r switch
        {
            EnginePinGuard.Result.NotConfigured => Results.Json(new { ok = false, error = "pin_not_configured" }, statusCode: 503),
            EnginePinGuard.Result.Locked => Results.Json(new { ok = false, error = "too_many_attempts", retryAfterSec = (int)EnginePinGuard.Window.TotalSeconds }, statusCode: 429),
            _ => Results.Json(new { ok = false, error = "bad_pin" }, statusCode: 401)
        };

        static async Task<string?> ReadEnginePinAsync(HttpContext ctx)
        {
            try
            {
                var dto = await ctx.Request.ReadFromJsonAsync<Dictionary<string, string>>();
                return dto is not null && dto.TryGetValue("pin", out var pin) ? pin : null;
            }
            catch { return null; } // empty / malformed body -> treated as wrong PIN
        }

        static async Task<IResult> RelayEngineAsync(Func<Task<(int Status, string Body)>> call)
        {
            try
            {
                var (status, body) = await call();
                return Results.Content(body, "application/json", Encoding.UTF8, status);
            }
            catch (Exception ex)
            {
                return Results.Json(new { ok = false, error = "engine_offline", detail = ex.Message }, statusCode: 502);
            }
        }

        pub.MapPost("/api/engine/sequence/start", async (HttpContext ctx, EngineAdminService svc, EnginePinGuard guard) =>
        {
            var pin = await ReadEnginePinAsync(ctx);

            var check = guard.Check(ctx.Connection.RemoteIpAddress?.ToString(), pin);
            if (check != EnginePinGuard.Result.Ok) return EnginePinFailure(check);

            return await RelayEngineAsync(() => svc.StartSequenceAsync("mhxview"));
        });

        pub.MapGet("/api/engine/sequence/status", (EngineAdminService svc) =>
            RelayEngineAsync(() => svc.GetSequenceStatusAsync()));

        pub.MapPost("/api/engine/sequence/cancel", async (HttpContext ctx, EngineAdminService svc, EnginePinGuard guard) =>
        {
            var pin = await ReadEnginePinAsync(ctx);

            var check = guard.Check(ctx.Connection.RemoteIpAddress?.ToString(), pin);
            if (check != EnginePinGuard.Result.Ok) return EnginePinFailure(check);

            return await RelayEngineAsync(() => svc.CancelSequenceAsync());
        });

        // ── Config editor (MHxView ⚙️ → Config tab) ───────────────────────────────────
        // Edits the 5 deploy config files of BellBeast / Uroboros / Wayfarer in the Fullscale root.
        // File contents include secrets, so everything except the metadata list needs the EngineControl PIN.
        static async Task<IResult> ConfigCallAsync(HttpContext ctx, EnginePinGuard guard, Func<JsonElement, object> call)
        {
            JsonElement body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<JsonElement>();
            }
            catch { body = default; } // empty / malformed body -> treated as wrong PIN

            var check = guard.Check(ctx.Connection.RemoteIpAddress?.ToString(), ConfigArg(body, "pin"));
            if (check != EnginePinGuard.Result.Ok) return EnginePinFailure(check);

            try
            {
                return Results.Json(call(body));
            }
            catch (ConfigEditorException ex)
            {
                return Results.Json(new { ok = false, error = ex.Code, detail = ex.Detail, line = ex.Line }, statusCode: ex.Status);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return Results.Json(new { ok = false, error = "io_error", detail = ex.Message }, statusCode: 500);
            }
        }


        pub.MapGet("/api/config/files", (ConfigEditorService svc) => Results.Json(svc.List()));

        pub.MapPost("/api/config/read", (HttpContext ctx, EnginePinGuard guard, ConfigEditorService svc) =>
            ConfigCallAsync(ctx, guard, b =>
            {
                var (text, sha) = svc.Read(ConfigArg(b, "id"));
                return new { ok = true, text, sha };
            }));

        pub.MapPost("/api/config/save", (HttpContext ctx, EnginePinGuard guard, ConfigEditorService svc) =>
            ConfigCallAsync(ctx, guard, b =>
                new { ok = true, sha = svc.Save(ConfigArg(b, "id"), ConfigArg(b, "text"), ConfigArg(b, "baseSha")) }));

        pub.MapPost("/api/config/links", (HttpContext ctx, EnginePinGuard guard, ConfigEditorService svc) =>
            ConfigCallAsync(ctx, guard, _ => svc.Links()));

        pub.MapPost("/api/config/links/apply", (HttpContext ctx, EnginePinGuard guard, ConfigEditorService svc) =>
            ConfigCallAsync(ctx, guard, b =>
                new { ok = true, sha = svc.ApplyLink(ConfigArg(b, "id"), ConfigArg(b, "key"), ConfigArg(b, "value"), ConfigArg(b, "baseSha")) }));

        pub.MapPost("/api/config/backups", (HttpContext ctx, EnginePinGuard guard, ConfigEditorService svc) =>
            ConfigCallAsync(ctx, guard, b => svc.Backups(ConfigArg(b, "id"))));

        pub.MapPost("/api/config/restore", (HttpContext ctx, EnginePinGuard guard, ConfigEditorService svc) =>
            ConfigCallAsync(ctx, guard, b =>
                new { ok = true, sha = svc.Restore(ConfigArg(b, "id"), ConfigArg(b, "name"), ConfigArg(b, "baseSha")) }));

        admin.MapGet("/api/admin/test/run", async (EngineAdminService svc) =>
        {
            try
            {
                var result = await svc.RunTestsAsync();
                return Results.Ok(result);
            }
            catch (Exception ex)
            {
                return Results.Problem(ex.Message);
            }
        });

        // BellBeast-side self-tests (EngineAdminService + BackendConfig + AdminApi + AdminAuth)
        admin.MapGet("/api/admin/test/run-local", (HttpContext httpCtx, IWebHostEnvironment env) =>
        {
            try
            {
                var ctx    = new BellBeast.SelfTest.SelfTestContext(env, httpCtx.RequestServices);
                var report = BellBeast.SelfTest.SelfTestRunner.RunAll(ctx);
                return Results.Ok(report);
            }
            catch (Exception ex)
            {
                return Results.Problem(ex.Message);
            }
        });
    }
}
