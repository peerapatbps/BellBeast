using System.IO.Compression;
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using BellBeast.ApiAccess;
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

/// <summary>Annunciator fleet: device report/config/OTA (device key) + admin fleet management.</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class FleetEndpoints
{
    public static void MapFleetEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);
        var device = api.Device;  // device APIs: page access + registered annunciators (DeviceAccessService)

        // ===============================
        // Annunciator fleet (P4): device report / config / OTA + admin (iot-device_plan.md §4)
        // Devices authenticate with X-Device-Key (random per device, trust-on-first-use, admin approves).
        // WiFi credentials only go to approved devices; never logged, never in a URL.
        // ===============================

        // device → batch of events (played/ack/fallback/boot/wifi/ota/health) + status; returns config etag so the device knows when to re-pull
        pub.MapPost("/api/device/{id}/report", async (string id, DeviceFleetService fleet, HttpContext ctx) =>
        {
            if (FleetAuth(fleet, ctx, id) is { } err) return err;
            if (ctx.Request.ContentLength is > 64 * 1024) return Results.BadRequest(new { ok = false, error = "body_too_large" });
            DeviceFleetService.ReportBody? body;
            try { body = await ctx.Request.ReadFromJsonAsync<DeviceFleetService.ReportBody>(DeviceFleetService.JsonOpts, ctx.RequestAborted); }
            catch (JsonException) { return Results.BadRequest(new { ok = false, error = "bad_json" }); }
            var d = fleet.ApplyReport(id, body ?? new DeviceFleetService.ReportBody());
            var (_, etag) = fleet.BuildConfig(id);
            return Results.Json(new { ok = true, approved = d.Approved, config_etag = etag.Trim('"') });
        });

        // device → effective config (zones/poll/remind/volume/channel + wifi for approved devices). ETag / If-None-Match → 304
        pub.MapGet("/api/device/{id}/config", (string id, DeviceFleetService fleet, HttpContext ctx) =>
        {
            if (FleetAuth(fleet, ctx, id) is { } err) return err;
            var (body, etag) = fleet.BuildConfig(id);
            ctx.Response.Headers.ETag = etag;
            ctx.Response.Headers.CacheControl = "no-store";
            if (ctx.Request.Headers.IfNoneMatch.ToString() == etag) return Results.StatusCode(StatusCodes.Status304NotModified);
            return Results.Json(body);
        });

        // device → firmware for its channel (stable/beta/none). version null = nothing to install
        pub.MapGet("/api/ota/manifest", (DeviceFleetService fleet, HttpContext ctx) =>
        {
            var id = ctx.Request.Query["device_id"].FirstOrDefault();
            if (id is not null && FleetAuth(fleet, ctx, id) is { } err) return err;
            var (channel, fw) = fleet.ManifestFor(id);
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Json(fw is null
                ? new { ok = true, channel, version = (string?)null, size = 0L, sha256 = (string?)null, url = (string?)null }
                : new { ok = true, channel, version = (string?)fw.Version, size = fw.Size, sha256 = (string?)fw.Sha256, url = (string?)DeviceFleetService.FirmwareUrl(fw) });
        });

        // firmware download by version (the board is in the label). /{model}/{version} = older manifests, model ignored
        static IResult Firmware(DeviceFleetService fleet, HttpContext ctx, string version)
        {
            if (!DeviceFleetService.ValidVersion(version) || fleet.GetFirmware(version) is not { } fw)
                return Results.NotFound(new { ok = false, error = "firmware_not_found" });
            var path = fleet.FirmwarePath(fw);
            if (!File.Exists(path)) return Results.NotFound(new { ok = false, error = "firmware_file_missing" });
            ctx.Response.Headers["X-Firmware-Sha256"] = fw.Sha256;
            return Results.File(path, "application/octet-stream", $"annunciator-{version}.bin");
        }
        device.MapGet("/api/ota/firmware/{version}", (string version, DeviceFleetService fleet, HttpContext ctx) => Firmware(fleet, ctx, version));
        device.MapGet("/api/ota/firmware/{model}/{version}", (string model, string version, DeviceFleetService fleet, HttpContext ctx) => Firmware(fleet, ctx, version));

        // admin (/Admin/Fleet)
        admin.MapGet("/api/admin/fleet", (DeviceFleetService fleet) => Results.Json(fleet.AdminView(), DeviceFleetService.JsonOpts));

        admin.MapGet("/api/admin/fleet/events", (DeviceFleetService fleet, HttpContext ctx) =>
        {
            var dev = ctx.Request.Query["device"].FirstOrDefault();
            var n = int.TryParse(ctx.Request.Query["n"], out var nn) ? nn : 200;
            return Results.Json(new { ok = true, events = fleet.RecentEvents(string.IsNullOrWhiteSpace(dev) ? null : dev, n) });
        });

        admin.MapPost("/api/admin/fleet/device/{id}", async (string id, DeviceFleetService fleet, HttpContext ctx) =>
        {
            JsonElement body;
            try { body = await ctx.Request.ReadFromJsonAsync<JsonElement>(ctx.RequestAborted); }
            catch (JsonException) { return Results.BadRequest(new { ok = false, error = "bad_json" }); }
            var e = fleet.UpdateDevice(id, body);
            return e is null ? Results.Json(new { ok = true }) : e == "device_not_found" ? Results.NotFound(new { ok = false, error = e }) : Results.BadRequest(new { ok = false, error = e });
        });

        admin.MapDelete("/api/admin/fleet/device/{id}", (string id, DeviceFleetService fleet) =>
            fleet.DeleteDevice(id) ? Results.Json(new { ok = true }) : Results.NotFound(new { ok = false, error = "device_not_found" }));

        admin.MapPut("/api/admin/fleet/defaults", async (DeviceFleetService fleet, HttpContext ctx) =>
        {
            JsonElement body;
            try { body = await ctx.Request.ReadFromJsonAsync<JsonElement>(ctx.RequestAborted); }
            catch (JsonException) { return Results.BadRequest(new { ok = false, error = "bad_json" }); }
            var e = fleet.UpdateDefaults(body);
            return e is null ? Results.Json(new { ok = true }) : Results.BadRequest(new { ok = false, error = e });
        });

        // WiFi is per device only (POST /api/admin/fleet/device/{id} { wifi }); no fleet-wide set.

        admin.MapPost("/api/admin/ota/firmware", async (DeviceFleetService fleet, HttpContext ctx) =>
        {
            if (!ctx.Request.HasFormContentType) return Results.BadRequest(new { ok = false, error = "multipart_required" });
            var form = await ctx.Request.ReadFormAsync(ctx.RequestAborted);
            var version = form["version"].ToString().Trim();
            var file = form.Files.GetFile("file");
            if (version.Length > 0 && !DeviceFleetService.ValidVersion(version)) return Results.BadRequest(new { ok = false, error = "bad_version" });
            if (file is null || file.Length == 0 || file.Length > DeviceFleetService.MaxFirmwareBytes) return Results.BadRequest(new { ok = false, error = "bad_size" });
            using var ms = new MemoryStream();
            await file.CopyToAsync(ms, ctx.RequestAborted);
            try
            {
                var fw = fleet.SaveFirmware(version.Length > 0 ? version : null, ms.ToArray(), form["note"]);
                return Results.Json(new { ok = true, firmware = new { fw.Version, board = fw.Board, fw.Sha256, fw.Size, fw.UploadedAt, fw.Note } });
            }
            catch (ArgumentException ex) { return Results.BadRequest(new { ok = false, error = ex.Message }); }
        });

        admin.MapDelete("/api/admin/ota/firmware/{version}", (string version, DeviceFleetService fleet) =>
        {
            var e = fleet.DeleteFirmware(version);
            return e is null ? Results.Json(new { ok = true }) : Results.BadRequest(new { ok = false, error = e });
        });

        // Auto patcher: { version, released: true|false } — newest released image per board
        admin.MapPost("/api/admin/ota/release", async (DeviceFleetService fleet, HttpContext ctx) =>
        {
            JsonElement body;
            try { body = await ctx.Request.ReadFromJsonAsync<JsonElement>(ctx.RequestAborted); }
            catch (JsonException) { return Results.BadRequest(new { ok = false, error = "bad_json" }); }
            var released = !(body.ValueKind == JsonValueKind.Object && body.TryGetProperty("released", out var r) && r.ValueKind == JsonValueKind.False);
            var e = fleet.Release(ConfigArg(body, "version") ?? "", released);
            return e is null ? Results.Json(new { ok = true }) : Results.BadRequest(new { ok = false, error = e });
        });

        // ── firmware groups ──
        static async Task<JsonElement?> Body(HttpContext ctx)
        {
            try { return await ctx.Request.ReadFromJsonAsync<JsonElement>(ctx.RequestAborted); }
            catch (JsonException) { return null; }
        }
        static IResult Done(string? e) => e is null ? Results.Json(new { ok = true })
            : e.EndsWith("not_found") ? Results.NotFound(new { ok = false, error = e }) : Results.BadRequest(new { ok = false, error = e });

        admin.MapPost("/api/admin/fleet/groups", async (DeviceFleetService fleet, HttpContext ctx) =>
        {
            if (await Body(ctx) is not { } b) return Results.BadRequest(new { ok = false, error = "bad_json" });
            var (id, e) = fleet.CreateGroup(ConfigArg(b, "name"), ctx.User.Identity?.Name);
            return e is null ? Results.Json(new { ok = true, id }) : Results.BadRequest(new { ok = false, error = e });
        });

        // { name?, target? } — target = version (null/"" = no update); applies to every member at once
        admin.MapPut("/api/admin/fleet/groups/{id}", async (string id, DeviceFleetService fleet, HttpContext ctx) =>
            await Body(ctx) is { } b ? Done(fleet.UpdateGroup(id, b, ctx.User.Identity?.Name)) : Results.BadRequest(new { ok = false, error = "bad_json" }));

        admin.MapDelete("/api/admin/fleet/groups/{id}", (string id, DeviceFleetService fleet) => Done(fleet.DeleteGroup(id)));

        // { devices: [...] } into group {id}; id "none" = take them out of any group
        admin.MapPost("/api/admin/fleet/groups/{id}/devices", async (string id, DeviceFleetService fleet, HttpContext ctx) =>
        {
            if (await Body(ctx) is not { } b || b.ValueKind != JsonValueKind.Object || !b.TryGetProperty("devices", out var arr) || arr.ValueKind != JsonValueKind.Array)
                return Results.BadRequest(new { ok = false, error = "bad_json" });
            var ids = arr.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList();
            return Done(fleet.AssignGroup(id == "none" ? null : id, ids));
        });

        // ── device API access (DeviceAccessService): shadow/enforce, IP-pass bridge, who gets in how ──
        object AccessView(DeviceAccessService access)
        {
            var s = access.Current;
            return new
            {
                ok = true,
                mode = s.Mode, allow_ip_pass = s.AllowIpPass, updated_at = s.UpdatedAt, updated_by = s.UpdatedBy,
                window_min = (int)IpPassService.FleetWindow.TotalMinutes,
                callers = access.Callers(),
                misses = access.Misses(),
            };
        }

        admin.MapGet("/api/admin/fleet/access", (DeviceAccessService access) => Results.Json(AccessView(access), DeviceFleetService.JsonOpts));

        admin.MapPut("/api/admin/fleet/access", async (DeviceAccessService access, HttpContext ctx) =>
        {
            JsonElement body;
            try { body = await ctx.Request.ReadFromJsonAsync<JsonElement>(ctx.RequestAborted); }
            catch (JsonException) { return Results.BadRequest(new { ok = false, error = "bad_json" }); }
            bool? ipPass = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("allow_ip_pass", out var ap)
                && ap.ValueKind is JsonValueKind.True or JsonValueKind.False ? ap.GetBoolean() : null;
            var e = access.Update(ConfigArg(body, "mode"), ipPass, ctx.User.Identity?.Name);
            return e is null ? Results.Json(AccessView(access), DeviceFleetService.JsonOpts) : Results.BadRequest(new { ok = false, error = e });
        });

        admin.MapDelete("/api/admin/fleet/access/miss/{ip}", (string ip, DeviceAccessService access) =>
            IpAccessService.Parse(ip) is { } canon && access.ClearMiss(canon)
                ? Results.Json(AccessView(access), DeviceFleetService.JsonOpts)
                : Results.NotFound(new { ok = false, error = "unknown_miss" }));

        // device auth helper: 400 bad id/key, 403 key mismatch, null = ok (unknown devices register as pending)
        static IResult? FleetAuth(DeviceFleetService fleet, HttpContext ctx, string id)
        {
            var key = ctx.Request.Headers[DeviceFleetService.KeyHeader].FirstOrDefault()?.Trim().ToLowerInvariant();
            var (status, _) = fleet.Authenticate(id, key, IpAccessService.ClientIp(ctx));
            return status switch
            {
                DeviceFleetService.AuthStatus.BadId => Results.BadRequest(new { ok = false, error = "bad_device_id", detail = "id must be [a-z0-9-]{3,32}" }),
                DeviceFleetService.AuthStatus.BadKey => Results.BadRequest(new { ok = false, error = "bad_device_key", detail = $"{DeviceFleetService.KeyHeader}: 64 hex chars" }),
                DeviceFleetService.AuthStatus.KeyMismatch => Results.Json(new { ok = false, error = "device_key_mismatch" }, statusCode: StatusCodes.Status403Forbidden),
                _ => null,
            };
        }
    }
}
