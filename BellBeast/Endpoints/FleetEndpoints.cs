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

/// <summary>Annunciator fleet: device report/config/OTA (device key) + admin fleet management.</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class FleetEndpoints
{
    public static void MapFleetEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);

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
                : new { ok = true, channel, version = (string?)fw.Version, size = fw.Size, sha256 = (string?)fw.Sha256, url = (string?)$"/api/ota/firmware/{fw.Version}" });
        });

        pub.MapGet("/api/ota/firmware/{version}", (string version, DeviceFleetService fleet, HttpContext ctx) =>
        {
            if (!DeviceFleetService.ValidVersion(version) || fleet.GetFirmware(version) is not { } fw) return Results.NotFound(new { ok = false, error = "firmware_not_found" });
            var path = fleet.FirmwarePath(version);
            if (!File.Exists(path)) return Results.NotFound(new { ok = false, error = "firmware_file_missing" });
            ctx.Response.Headers["X-Firmware-Sha256"] = fw.Sha256;
            return Results.File(path, "application/octet-stream", $"annunciator-{version}.bin");
        });

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

        admin.MapPut("/api/admin/fleet/wifi", async (DeviceFleetService fleet, HttpContext ctx) =>
        {
            JsonElement body;
            try { body = await ctx.Request.ReadFromJsonAsync<JsonElement>(ctx.RequestAborted); }
            catch (JsonException) { return Results.BadRequest(new { ok = false, error = "bad_json" }); }
            var e = fleet.UpdateWifi(body);
            return e is null ? Results.Json(new { ok = true }) : Results.BadRequest(new { ok = false, error = e });
        });

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
            try { return Results.Json(new { ok = true, firmware = fleet.SaveFirmware(version.Length > 0 ? version : null, ms.ToArray(), form["note"]) }); }
            catch (ArgumentException ex) { return Results.BadRequest(new { ok = false, error = ex.Message }); }
        });

        admin.MapDelete("/api/admin/ota/firmware/{version}", (string version, DeviceFleetService fleet) =>
        {
            var e = fleet.DeleteFirmware(version);
            return e is null ? Results.Json(new { ok = true }) : Results.BadRequest(new { ok = false, error = e });
        });

        admin.MapPost("/api/admin/ota/channel", async (DeviceFleetService fleet, HttpContext ctx) =>
        {
            JsonElement body;
            try { body = await ctx.Request.ReadFromJsonAsync<JsonElement>(ctx.RequestAborted); }
            catch (JsonException) { return Results.BadRequest(new { ok = false, error = "bad_json" }); }
            var channel = ConfigArg(body, "channel") ?? "";
            var version = ConfigArg(body, "version");
            var e = fleet.SetChannel(channel, string.IsNullOrWhiteSpace(version) ? null : version);
            return e is null ? Results.Json(new { ok = true }) : Results.BadRequest(new { ok = false, error = e });
        });

        // device auth helper: 400 bad id/key, 403 key mismatch, null = ok (unknown devices register as pending)
        static IResult? FleetAuth(DeviceFleetService fleet, HttpContext ctx, string id)
        {
            var key = ctx.Request.Headers[DeviceFleetService.KeyHeader].FirstOrDefault()?.Trim().ToLowerInvariant();
            var (status, _) = fleet.Authenticate(id, key, ctx.Connection.RemoteIpAddress?.ToString());
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
