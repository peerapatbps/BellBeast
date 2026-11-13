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

/// <summary>Audio clip library + TTS (writes are admin-only).</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class AudioEndpoints
{
    public static void MapAudioEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);

        // ===============================
        // Audio clip library (Overview §3.3) — PCM16 24 kHz mono, the device codec format
        // Devices/LabVenture read anonymously; writes need the admin cookie (/Admin/AudioLibrary)
        // ===============================

        // list: clips + required vocabulary + ids the live alarm payload references → shows what is missing
        pub.MapGet("/api/audio/clips", (AudioLibraryService lib, TtsService tts, IotRoomService iotRoom, HttpContext ctx) =>
        {
            var clips = lib.List();
            var have = clips.Select(c => c.Id).ToHashSet(StringComparer.Ordinal);
            var vocab = lib.Vocabulary();
            var (alarmState, _, _) = iotRoom.GetDeviceState(AlarmFeedService.EngineDeviceName);
            var referenced = AudioLibraryService.PlaylistIds(alarmState);

            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Json(new
            {
                ok = true,
                tts_configured = tts.Configured,
                format = new { encoding = "pcm_s16le", sample_rate = AudioLibraryService.SampleRate, channels = 1 },
                clips = clips.Select(c => new { id = c.Id, version = c.Version, sha256 = c.Sha256, bytes = c.Bytes, duration_ms = c.DurationMs, source = c.Source, text = c.Text, updated_at = c.UpdatedAt }),
                vocabulary = vocab.Select(v => new { id = v.Id, text = v.Text, group = v.Group, present = have.Contains(v.Id) }),
                missing = vocab.Select(v => v.Id).Concat(referenced).Where(id => !have.Contains(id)).Distinct().OrderBy(id => id, StringComparer.Ordinal),
                referenced_by_engine = referenced,
            });
        });

        // device download: raw PCM (default) or ?format=wav for browser preview. ETag = sha256; "n_4@v2" accepted (current version served)
        pub.MapGet("/api/audio/clip/{id}", (string id, AudioLibraryService lib, HttpContext ctx) =>
        {
            var norm = AudioLibraryService.NormalizeId(id);
            var info = norm is null ? null : lib.Get(norm);
            if (info is null) return Results.NotFound(new { ok = false, error = "clip_not_found", id });

            var etag = $"\"{info.Sha256}\"";
            ctx.Response.Headers.ETag = etag;
            ctx.Response.Headers["X-Clip-Version"] = $"v{info.Version}";
            ctx.Response.Headers["X-Clip-Sha256"] = info.Sha256;
            ctx.Response.Headers.CacheControl = "no-cache"; // revalidate with If-None-Match
            if (ctx.Request.Headers.IfNoneMatch.ToString() == etag) return Results.StatusCode(StatusCodes.Status304NotModified);

            var pcm = lib.ReadPcm(info.Id);
            if (pcm is null) return Results.NotFound(new { ok = false, error = "clip_file_missing", id = info.Id });

            var wav = string.Equals(ctx.Request.Query["format"], "wav", StringComparison.OrdinalIgnoreCase);
            return wav
                ? Results.File(AudioLibraryService.WrapWav(pcm), "audio/wav", $"{info.Id}.wav")
                : Results.File(pcm, "application/octet-stream", $"{info.Id}.pcm");
        });

        // upload a recorded / prepared clip (multipart: id, file, text?) — WAV PCM16 any rate, or raw .pcm
        admin.MapPost("/api/audio/clip", async (AudioLibraryService lib, HttpContext ctx) =>
        {
            if (!ctx.Request.HasFormContentType) return Results.BadRequest(new { ok = false, error = "multipart_required" });
            var form = await ctx.Request.ReadFormAsync(ctx.RequestAborted);
            var id = AudioLibraryService.NormalizeId(form["id"]);
            if (id is null) return Results.BadRequest(new { ok = false, error = "bad_id", detail = "id must be [a-z0-9_]{1,64}" });
            var file = form.Files.GetFile("file");
            if (file is null || file.Length == 0) return Results.BadRequest(new { ok = false, error = "file_required" });
            if (file.Length > AudioLibraryService.MaxUploadBytes) return Results.BadRequest(new { ok = false, error = "file_too_large" });

            using var ms = new MemoryStream();
            await file.CopyToAsync(ms, ctx.RequestAborted);
            try
            {
                var pcm = AudioLibraryService.ToDevicePcm(ms.ToArray(), file.FileName);
                var text = form["text"].ToString().Trim();
                var info = lib.Save(id, pcm, "upload", text.Length > 0 ? text : null);
                return Results.Json(new { ok = true, clip = info });
            }
            catch (AudioFormatException ex)
            {
                return Results.BadRequest(new { ok = false, error = "bad_audio", detail = ex.Message });
            }
        });

        admin.MapDelete("/api/audio/clip/{id}", (string id, AudioLibraryService lib) =>
        {
            var norm = AudioLibraryService.NormalizeId(id);
            return norm is not null && lib.Delete(norm) ? Results.Json(new { ok = true }) : Results.NotFound(new { ok = false, error = "clip_not_found" });
        });

        // TTS: { text, id? } — with id = (re)generate that vocab clip; without = sentence clip tts_<hash>, cached
        admin.MapPost("/api/audio/tts", async (AudioLibraryService lib, TtsService tts, HttpContext ctx) =>
        {
            JsonElement body;
            try { body = await ctx.Request.ReadFromJsonAsync<JsonElement>(ctx.RequestAborted); }
            catch (JsonException) { return Results.BadRequest(new { ok = false, error = "bad_json" }); }

            var text = (ConfigArg(body, "text") ?? "").Trim();
            if (text.Length is 0 or > 500) return Results.BadRequest(new { ok = false, error = "bad_text", detail = "text required, max 500 chars" });

            var rawId = ConfigArg(body, "id");
            var id = string.IsNullOrWhiteSpace(rawId) ? AudioLibraryService.SentenceId(text, tts.Voice) : AudioLibraryService.NormalizeId(rawId);
            if (id is null) return Results.BadRequest(new { ok = false, error = "bad_id", detail = "id must be [a-z0-9_]{1,64}" });

            if (string.IsNullOrWhiteSpace(rawId) && lib.Get(id) is { } cached)
                return Results.Json(new { ok = true, cached = true, clip = cached });

            // force=true saves the best attempt even when it fails the check (admin listened and accepts it)
            var force = body.TryGetProperty("force", out var fEl) && fEl.ValueKind == JsonValueKind.True;
            try
            {
                var r = await tts.SynthesizeVerifiedAsync(text, ctx.RequestAborted);
                if (!r.Verified && !force)
                    return Results.Json(new
                    {
                        ok = false, error = "tts_unverified",
                        detail = $"เสียงที่ได้ไม่ตรงข้อความหลังลอง {r.Attempts} ครั้ง: {r.Problem} — ไม่ได้บันทึก (ลองใหม่ หรืออัปโหลดเสียงที่อัดเอง)",
                        transcript = r.Transcript, attempts = r.Attempts,
                    }, statusCode: StatusCodes.Status502BadGateway);
                return Results.Json(new { ok = true, cached = false, verified = r.Verified, attempts = r.Attempts, transcript = r.Transcript, clip = lib.Save(id, r.Pcm, "tts", text) });
            }
            catch (TtsException ex)
            {
                var status = ex.Code == "tts_not_configured" ? StatusCodes.Status503ServiceUnavailable : StatusCodes.Status502BadGateway;
                return Results.Json(new { ok = false, error = ex.Code, detail = ex.Message }, statusCode: status);
            }
            catch (AudioFormatException ex)
            {
                return Results.Json(new { ok = false, error = "bad_audio", detail = ex.Message }, statusCode: StatusCodes.Status502BadGateway);
            }
            catch (HttpRequestException ex)
            {
                return Results.Json(new { ok = false, error = "tts_unreachable", detail = ex.Message }, statusCode: StatusCodes.Status502BadGateway);
            }
        });
    }
}
