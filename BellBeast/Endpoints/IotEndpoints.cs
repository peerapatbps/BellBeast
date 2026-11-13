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

/// <summary>IoT room (devices), Cloudflare tunnel control, stage + operator relays.</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class IotEndpoints
{
    public static void MapIotEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);

        // ===============================
        // API : Cloudflare Tunnel control
        // ===============================

        pub.MapGet("/api/iot/tunnel/status", (CloudflareTunnelService cf) =>
        {
            var uptimeSec = cf.StartedAt.HasValue
                ? (int)(DateTime.UtcNow - cf.StartedAt.Value).TotalSeconds
                : 0;

            return Results.Ok(new
            {
                state      = cf.State.ToString().ToLowerInvariant(),  // stopped | starting | running | error
                publicUrl  = cf.PublicUrl,
                tunnelName = cf.TunnelName,
                uptimeSec,
                error      = cf.ErrorMessage,
                logs       = cf.GetRecentLogs(40)
            });
        });

        admin.MapPost("/api/iot/tunnel/start", (CloudflareTunnelService cf) =>
        {
            var started = cf.Start();
            return Results.Ok(new { ok = started, state = cf.State.ToString().ToLowerInvariant() });
        });

        admin.MapPost("/api/iot/tunnel/stop", (CloudflareTunnelService cf) =>
        {
            cf.Stop();
            return Results.Ok(new { ok = true, state = "stopped" });
        });

        // ===============================
        // API : IoT Room
        // ===============================

        // Device → join room (first time or after reconnect)
        pub.MapPost("/api/iot/room/join", (IotRoomService iotRoom, HttpContext ctx) =>
        {
            IotJoinRequest? body;
            try { body = ctx.Request.ReadFromJsonAsync<IotJoinRequest>().GetAwaiter().GetResult(); }
            catch { return Results.BadRequest(new { ok = false, error = "Invalid JSON" }); }

            if (body is null || string.IsNullOrWhiteSpace(body.DeviceName) || string.IsNullOrWhiteSpace(body.DeviceType))
                return Results.BadRequest(new { ok = false, error = "deviceName and deviceType are required" });

            var (key, isNew) = iotRoom.JoinOrRejoin(body.DeviceName.Trim(), body.DeviceType.Trim());
            return Results.Ok(new { ok = true, key, isNew });
        });

        // Device → heartbeat / poll for pending command
        pub.MapPost("/api/iot/room/poll", (IotRoomService iotRoom, HttpContext ctx) =>
        {
            IotPollRequest? body;
            try { body = ctx.Request.ReadFromJsonAsync<IotPollRequest>().GetAwaiter().GetResult(); }
            catch { return Results.BadRequest(new { status = "error", error = "Invalid JSON" }); }

            if (body is null || string.IsNullOrWhiteSpace(body.Key))
                return Results.BadRequest(new { status = "error", error = "key is required" });

            var (status, cmd) = iotRoom.Poll(body.Key.Trim());
            if (status == "reconnect")
                return Results.Ok(new { status = "reconnect" });

            if (cmd is not null)
                return Results.Ok(new { status = "ok", command = new { type = cmd.CommandType, value = cmd.Value } });

            return Results.Ok(new { status = "ok", command = (object?)null });
        });

        // Browser → get current member list
        pub.MapGet("/api/iot/room/members", (IotRoomService iotRoom) =>
        {
            var members = iotRoom.GetMembers();
            return Results.Ok(new { members });
        });

        // Browser → get room log
        pub.MapGet("/api/iot/room/log", (IotRoomService iotRoom, HttpContext ctx) =>
        {
            int last = 50;
            if (int.TryParse(ctx.Request.Query["last"], out var q) && q > 0 && q <= 200) last = q;
            var entries = iotRoom.GetLog(last);
            return Results.Ok(new { entries });
        });

        // Host → send command to a device
        pub.MapPost("/api/iot/room/command", (IotRoomService iotRoom, HttpContext ctx) =>
        {
            IotCommandRequest? body;
            try { body = ctx.Request.ReadFromJsonAsync<IotCommandRequest>().GetAwaiter().GetResult(); }
            catch { return Results.BadRequest(new { ok = false, error = "Invalid JSON" }); }

            if (body is null || string.IsNullOrWhiteSpace(body.Raw))
                return Results.BadRequest(new { ok = false, error = "raw is required" });

            // Parse: {"Device A", "LED", "255,255,255"} — strip outer braces/quotes
            var parsed = ParseIotCommand(body.Raw);
            if (parsed is null)
                return Results.BadRequest(new { ok = false, error = "Cannot parse command. Expected: {\"DeviceName\", \"Type\", \"Value\"}" });

            var (deviceName, commandType, value) = parsed.Value;
            var ok = iotRoom.SendCommand(deviceName, commandType, value);
            if (!ok)
                return Results.Ok(new { ok = false, error = $"Device '{deviceName}' not found or offline" });

            return Results.Ok(new { ok = true, deviceName, commandType, value });
        });

        // Device → post telemetry / state
        pub.MapPost("/api/iot/room/data", async (IotRoomService iotRoom, HttpContext ctx) =>
        {
            IotDataRequest? body;
            try { body = await ctx.Request.ReadFromJsonAsync<IotDataRequest>(); }
            catch { return Results.BadRequest(new { ok = false, error = "Invalid JSON" }); }

            if (body is null || string.IsNullOrWhiteSpace(body.Key))
                return Results.BadRequest(new { ok = false, error = "key is required" });

            if (body.Data is null || body.Data.Count == 0)
                return Results.BadRequest(new { ok = false, error = "data must be a non-empty object" });

            var (ok, error) = iotRoom.PostData(body.Key.Trim(), body.Data);
            return ok ? Results.Ok(new { ok = true }) : Results.Ok(new { ok = false, error });
        });

        // Device / dashboard → get device state(s)
        pub.MapGet("/api/iot/room/data", (IotRoomService iotRoom, HttpContext ctx) =>
        {
            var key = ctx.Request.Query["key"].FirstOrDefault();
            var deviceName = ctx.Request.Query["deviceName"].FirstOrDefault();
            var devices = iotRoom.GetDeviceData(key, deviceName);
            return Results.Ok(new { devices });
        });

        // Dashboard → one-shot snapshot (members + states + log)
        pub.MapGet("/api/iot/room/snapshot", (IotRoomService iotRoom, HttpContext ctx) =>
        {
            int last = 50;
            if (int.TryParse(ctx.Request.Query["last"], out var q) && q > 0 && q <= 200) last = q;
            return Results.Ok(iotRoom.GetSnapshot(last));
        });

        // ===============================
        // Stage endpoint — returns current stage from aquadat-connector device
        // ===============================
        pub.MapGet("/api/stage", (IotRoomService iotRoom) =>
        {
            var devices = iotRoom.GetDeviceData(deviceName: "aquadat-connector");
            var device = devices.FirstOrDefault();
            if (device is null)
                return Results.Ok(new { stage = 1, aquadat_reachable = (bool?)null, pending_count = 0, source = "default" });

            // device is an anonymous object serialized; parse via JsonElement
            var json = System.Text.Json.JsonSerializer.Serialize(device);
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;

            int stage = 1;
            bool? reachable = null;
            int pending = 0;

            if (root.TryGetProperty("state", out var state))
            {
                if (state.TryGetProperty("stage", out var sv) && sv.TryGetInt32(out var si)) stage = si;
                if (state.TryGetProperty("aquadat_reachable", out var rv) && rv.ValueKind == System.Text.Json.JsonValueKind.True) reachable = true;
                else if (state.TryGetProperty("aquadat_reachable", out var rv2) && rv2.ValueKind == System.Text.Json.JsonValueKind.False) reachable = false;
                if (state.TryGetProperty("pending_count", out var pv) && pv.TryGetInt32(out var pi)) pending = pi;
            }

            return Results.Ok(new { stage, aquadat_reachable = reachable, pending_count = pending, source = "iot-room" });
        });

        // ===============================
        // PROXY: /api/operator/record (stage 0 — LabVenture → Uroboros write)
        // ===============================
        pub.MapPost("/api/operator/record", async (HttpContext ctx, IHttpClientFactory factory) =>
        {
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var targetUrl = $"{baseUrl}/api/operator/record";

            using var reader = new StreamReader(ctx.Request.Body);
            var rawBody = await reader.ReadToEndAsync();

            var client = factory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(30);

            using var req = new HttpRequestMessage(HttpMethod.Post, targetUrl);
            req.Content = new StringContent(rawBody, Encoding.UTF8, "application/json");

            using var resp = await client.SendAsync(req, ctx.RequestAborted);
            ctx.Response.StatusCode = (int)resp.StatusCode;
            ctx.Response.ContentType = "application/json";
            var body = await resp.Content.ReadAsStringAsync(ctx.RequestAborted);
            await ctx.Response.WriteAsync(body, ctx.RequestAborted);
        });

        // ===============================
        // PROXY: /api/operator/data (stage 0 — LabVenture reads from Uroboros)
        // ===============================
        pub.MapGet("/api/operator/data", async (HttpContext ctx, IHttpClientFactory factory) =>
        {
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var qs = ctx.Request.QueryString.Value ?? "";
            var targetUrl = $"{baseUrl}/api/operator/data{qs}";

            var client = factory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(30);

            using var req = new HttpRequestMessage(HttpMethod.Get, targetUrl);
            using var resp = await client.SendAsync(req, ctx.RequestAborted);
            ctx.Response.StatusCode = (int)resp.StatusCode;
            ctx.Response.ContentType = "application/json";
            var body = await resp.Content.ReadAsStringAsync(ctx.RequestAborted);
            await ctx.Response.WriteAsync(body, ctx.RequestAborted);
        });

        static (string deviceName, string commandType, string value)? ParseIotCommand(string raw)
        {
            // Accept: {"Device A", "LED", "255,255,255"} or Device A, LED, 255,255,255
            var s = raw.Trim();
            if (s.StartsWith('{')) s = s.TrimStart('{').TrimEnd('}');

            // Split by comma but only on top-level (not inside RGB values that already don't have quotes)
            // Simple approach: extract quoted tokens first, then fall back to split
            var tokens = new List<string>();
            var remaining = s;
            while (remaining.Length > 0)
            {
                remaining = remaining.TrimStart();
                if (remaining.StartsWith('"'))
                {
                    var end = remaining.IndexOf('"', 1);
                    if (end < 0) break;
                    tokens.Add(remaining.Substring(1, end - 1).Trim());
                    remaining = remaining.Substring(end + 1).TrimStart(',');
                }
                else
                {
                    // unquoted — take until next comma that is followed by a quote or end
                    var comma = remaining.IndexOf(',');
                    if (comma < 0)
                    {
                        tokens.Add(remaining.Trim());
                        break;
                    }
                    tokens.Add(remaining.Substring(0, comma).Trim());
                    remaining = remaining.Substring(comma + 1);
                }
            }

            if (tokens.Count < 3) return null;
            if (string.IsNullOrWhiteSpace(tokens[0]) || string.IsNullOrWhiteSpace(tokens[1])) return null;

            // Value may contain commas (like RGB), join remaining tokens
            var valueTokens = tokens.Skip(2).ToList();
            var value = string.Join(",", valueTokens);

            return (tokens[0], tokens[1], value);
        }
    }
}
