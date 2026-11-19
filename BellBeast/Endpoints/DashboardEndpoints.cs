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

/// <summary>MHxView cards (public): PTC series, online lab, smartmap, Uroboros summary proxies.</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class DashboardEndpoints
{
    public static void MapDashboardEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);
        var page = api.Page;   // public pages' APIs: anonymous + live view token

        page.MapGet("/api/ptc/series", async (HttpContext ctx, IHttpClientFactory factory) =>
        {
            if (ctx.Request.Cookies.TryGetValue("bb_bypass_role", out var _bypass) && !string.IsNullOrEmpty(_bypass))
            {
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsync("{\"bypass\":true,\"series\":[]}", ctx.RequestAborted);
                return;
            }
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var key = ctx.Request.Query["key"].ToString().Trim();
            var targetUrl = $"{baseUrl}/api/ptc/series?key={Uri.EscapeDataString(key)}";

            if (ctx.Request.Query.TryGetValue("_ts", out var ts) && !string.IsNullOrWhiteSpace(ts))
                targetUrl += $"&_ts={Uri.EscapeDataString(ts!)}";

            var client = factory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(30);

            using var req = new HttpRequestMessage(HttpMethod.Get, targetUrl);
            using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ctx.RequestAborted);

            ctx.Response.StatusCode = (int)resp.StatusCode;

            if (resp.Content.Headers.ContentType != null)
                ctx.Response.ContentType = resp.Content.Headers.ContentType.ToString();

            if (!resp.IsSuccessStatusCode)
            {
                var err = await resp.Content.ReadAsStringAsync(ctx.RequestAborted);
                await ctx.Response.WriteAsync(err, ctx.RequestAborted);
                return;
            }

            await using var stream = await resp.Content.ReadAsStreamAsync(ctx.RequestAborted);
            await stream.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
            await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
        });

        page.MapPost("/api/online_lab", async (HttpContext ctx, IHttpClientFactory factory) =>
        {
            if (ctx.Request.Cookies.TryGetValue("bb_bypass_role", out var _bypass) && !string.IsNullOrEmpty(_bypass))
            {
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsync("{\"bypass\":true,\"rows\":[]}", ctx.RequestAborted);
                return;
            }
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var targetUrl = $"{baseUrl}/api/online_lab";

            using var reader = new StreamReader(ctx.Request.Body);
            var rawBody = await reader.ReadToEndAsync();

            var client = factory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(120);

            using var req = new HttpRequestMessage(HttpMethod.Post, targetUrl);
            req.Content = new StringContent(rawBody, Encoding.UTF8, "text/plain");

            using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ctx.RequestAborted);

            ctx.Response.StatusCode = (int)resp.StatusCode;

            if (resp.Content.Headers.ContentType != null)
                ctx.Response.ContentType = resp.Content.Headers.ContentType.ToString();

            if (!resp.IsSuccessStatusCode)
            {
                var err = await resp.Content.ReadAsStringAsync(ctx.RequestAborted);
                await ctx.Response.WriteAsync(err, ctx.RequestAborted);
                return;
            }

            await using var stream = await resp.Content.ReadAsStreamAsync(ctx.RequestAborted);
            await stream.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
            await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
        });

        page.MapGet("/api/smartmap", async (HttpContext hc) =>
        {
            // รับ keys เป็น optional (ถ้าส่งมาก็ filter ให้)
            // รูปแบบที่รับ: P019,P021 (base key)
            var keysRaw = (hc.Request.Query["keys"].ToString() ?? "").Trim();

            // validate base keys (A-Z0-9,_ และ comma)
            if (!string.IsNullOrWhiteSpace(keysRaw))
            {
                foreach (var ch in keysRaw)
                {
                    var ok = (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == ',' || ch == '_';
                    if (!ok) return Results.BadRequest("bad keys");
                }
            }

            // ✅ URL ที่ถูกต้อง (ไม่มี keys=)
            var url = "http://172.16.193.162/smartmap/rtu_query2.php?";

            using var http = new HttpClient(new HttpClientHandler { UseProxy = false })
            {
                Timeout = TimeSpan.FromSeconds(10)
            };

            var txt = await http.GetStringAsync(url);

            // smartmap ตอบเป็น text/html ที่มี payload ลักษณะ:
            // [{'P019_P':'3.74', ...}]  (เดิม)  หรือ  [{"P019_P":"3.74", ...}]  (ปัจจุบัน: JSON ปกติ)
            // เราจะ extract คู่ 'KEY':'VALUE' / "KEY":"VALUE" ออกมาเป็น Dictionary<string,string>
            var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            foreach (Match m in Regex.Matches(txt, @"['""]([^'""]+)['""]\s*:\s*['""]([^'""]*)['""]"))
            {
                var k = m.Groups[1].Value;
                var v = m.Groups[2].Value;
                if (!string.IsNullOrWhiteSpace(k))
                    dict[k] = v;
            }

            // ถ้ามี keys ส่งมา -> filter ให้เหลือเฉพาะ {base}_P เท่านั้น
            if (!string.IsNullOrWhiteSpace(keysRaw))
            {
                var bases = keysRaw
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(x => x.ToUpperInvariant())
                    .ToHashSet(StringComparer.OrdinalIgnoreCase);

                var filtered = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

                foreach (var b in bases)
                {
                    var kP = b + "_P";
                    if (dict.TryGetValue(kP, out var vP))
                        filtered[kP] = vP;
                }

                hc.Response.Headers.CacheControl = "no-store";
                return Results.Json(filtered);
            }

            // default: ส่งทั้งก้อนที่ parse แล้ว (เผื่อ debug)
            hc.Response.Headers.CacheControl = "no-store";
            return Results.Json(dict);
        });

        // PTC + DPS: smartmap newgraph/qry.php (1-min series ต่อ RTU) -> ส่งกลับเฉพาะจุดล่าสุดต่อ key
        // ก้อน series เต็มวันถูก parse และทิ้งฝั่ง server ทันที browser ได้แค่ { "UZ5411": { t, y } }
        var smartmapHttp = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(10)
        };

        page.MapGet("/api/smartmap/latest", async (HttpContext hc) =>
        {
            var keysRaw = (hc.Request.Query["keys"].ToString() ?? "").Trim().ToUpperInvariant();
            if (string.IsNullOrWhiteSpace(keysRaw)) return Results.BadRequest("keys required");

            foreach (var ch in keysRaw)
            {
                var ok = (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == ',' || ch == '_';
                if (!ok) return Results.BadRequest("bad keys");
            }

            var keys = keysRaw
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Distinct()
                .Take(10)
                .ToArray();

            // วันที่จริงของข้อมูล = วันนี้ (Asia/Bangkok, UTC+7 ไม่มี DST)
            var bkk = TimeSpan.FromHours(7);
            var today = DateTimeOffset.UtcNow.ToOffset(bkk).Date;
            // InvariantCulture: เครื่อง th-TH จะได้ปี พ.ศ. (2569) ถ้าไม่ระบุ -> smartmap คืน series ว่าง
            var d1 = today.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);

            var tasks = keys.Select(async Task<(string key, object? point)> (string key) =>
            {
                try
                {
                    var form = new Dictionary<string, string> { ["rtu"] = key, ["rtu_f"] = "p", ["d1"] = d1 };
                    var url = "http://172.16.193.162/smartmap/newgraph/qry.php?" +
                              string.Join("&", form.Select(kv => $"{kv.Key}={Uri.EscapeDataString(kv.Value)}"));

                    using var req = new HttpRequestMessage(HttpMethod.Get, url);
                    req.Headers.TryAddWithoutValidation("X-Requested-With", "XMLHttpRequest");

                    using var resp = await smartmapHttp.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, hc.RequestAborted);
                    if (!resp.IsSuccessStatusCode)
                    {
                        app.Logger.LogWarning("smartmap latest {Key}: HTTP {Status}", key, (int)resp.StatusCode);
                        return (key, (object?)null);
                    }

                    await using var stream = await resp.Content.ReadAsStreamAsync(hc.RequestAborted);
                    using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: hc.RequestAborted);

                    if (!doc.RootElement.TryGetProperty("jason_data", out var rows) || rows.ValueKind != JsonValueKind.Array)
                    {
                        app.Logger.LogWarning("smartmap latest {Key}: no jason_data array", key);
                        return (key, (object?)null);
                    }

                    // x: เวลาถูก แต่วันที่ผิด -> เก็บเฉพาะ time-of-day แล้วต่อกับวันนี้ เลือกจุดที่เวลาล่าสุด
                    TimeSpan? bestTod = null;
                    double bestY = 0;
                    foreach (var row in rows.EnumerateArray())
                    {
                        if (row.ValueKind != JsonValueKind.Object) continue;
                        if (!row.TryGetProperty("x", out var xe) || !row.TryGetProperty("y", out var ye)) continue;

                        var tod = SmartmapTimeOfDay(xe, bkk);
                        var y = SmartmapNumber(ye);
                        if (tod is null || y is null) continue;

                        if (bestTod is null || tod.Value >= bestTod.Value)
                        {
                            bestTod = tod;
                            bestY = y.Value;
                        }
                    }

                    if (bestTod is null)
                    {
                        app.Logger.LogWarning("smartmap latest {Key}: no valid x/y rows ({Count})", key, rows.GetArrayLength());
                        return (key, (object?)null);
                    }

                    var t = new DateTimeOffset(today + bestTod.Value, bkk).ToUnixTimeMilliseconds();
                    return (key, (object?)new { t, y = bestY });
                }
                catch (Exception ex) when (!hc.RequestAborted.IsCancellationRequested)
                {
                    app.Logger.LogWarning(ex, "smartmap latest fetch failed for {Key}", key);
                    return (key, (object?)null);
                }
            });

            var results = await Task.WhenAll(tasks);

            var outMap = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (var (key, point) in results)
                if (point is not null) outMap[key] = point;

            hc.Response.Headers.CacheControl = "no-store";
            return Results.Json(outMap);
        });

        static TimeSpan? SmartmapTimeOfDay(JsonElement xe, TimeSpan offset)
        {
            // epoch (ms หรือ s) -> แปลงเป็นเวลาไทยแล้วเอาแค่ time-of-day
            static TimeSpan FromEpoch(double v, TimeSpan off)
            {
                var ms = v > 1e11 ? (long)v : (long)(v * 1000);
                return DateTimeOffset.FromUnixTimeMilliseconds(ms).ToOffset(off).TimeOfDay;
            }

            if (xe.ValueKind == JsonValueKind.Number && xe.TryGetDouble(out var num))
                return FromEpoch(num, offset);

            if (xe.ValueKind != JsonValueKind.String) return null;

            var s = (xe.GetString() ?? "").Trim();
            if (s.Length == 0) return null;

            if (double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var n) && n > 1e8)
                return FromEpoch(n, offset);

            if (DateTime.TryParse(s, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AllowWhiteSpaces, out var dt))
                return dt.TimeOfDay;

            return null;
        }

        static double? SmartmapNumber(JsonElement e)
        {
            if (e.ValueKind == JsonValueKind.Number && e.TryGetDouble(out var d)) return d;
            if (e.ValueKind == JsonValueKind.String &&
                double.TryParse(e.GetString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var s))
                return s;
            return null;
        }

        page.MapGet("/api/dps/summary", async (HttpContext ctx, SummaryProxyService svc) =>
        {
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var dpsSummaryPath = backendCfg.DpsSummaryPath;
            await ProxySummaryAsync(ctx, await svc.GetDpsSummaryAsync($"{baseUrl}{dpsSummaryPath}", ctx.RequestAborted));
        });

        page.MapGet("/api/tps/summary", async (HttpContext ctx, SummaryProxyService svc) =>
        {
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var tpsSummaryPath = backendCfg.TpsSummaryPath;
            await ProxySummaryAsync(ctx, await svc.GetTpsSummaryAsync($"{baseUrl}{tpsSummaryPath}", ctx.RequestAborted));
        });

        page.MapGet("/api/rws/summary", async (HttpContext ctx, SummaryProxyService svc) =>
        {
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var rwsSummaryPath = backendCfg.RwsSummaryPath;
            await ProxySummaryAsync(ctx, await svc.GetRwsSummaryAsync($"{baseUrl}{rwsSummaryPath}", ctx.RequestAborted));
        });

        page.MapGet("/api/chem/summary", async (HttpContext ctx, SummaryProxyService svc) =>
        {
            if (ctx.Request.Cookies.TryGetValue("bb_bypass_role", out var _bypass) && !string.IsNullOrEmpty(_bypass))
            {
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsync("{\"bypass\":true,\"items\":[]}", ctx.RequestAborted);
                return;
            }
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var chemSummaryPath = backendCfg.ChemSummaryPath;
            await ProxySummaryAsync(ctx, await svc.GetChemSummaryAsync($"{baseUrl}{chemSummaryPath}", ctx.RequestAborted));
        });

        page.MapGet("/api/event/summary", async (HttpContext ctx, SummaryProxyService svc) =>
        {
            if (ctx.Request.Cookies.TryGetValue("bb_bypass_role", out var _bypass) && !string.IsNullOrEmpty(_bypass))
            {
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsync("{\"bypass\":true,\"items\":[]}", ctx.RequestAborted);
                return;
            }
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var eventSummaryPath = backendCfg.EventSummaryPath;
            await ProxySummaryAsync(ctx, await svc.GetEventSummaryAsync($"{baseUrl}{eventSummaryPath}", ctx.RequestAborted));
        });

        api.Device.MapGet("/api/cldetector/summary", async (HttpContext ctx, SummaryProxyService svc) =>
        {
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var cldetectorPath = backendCfg.ClDetectorPath;
            await ProxySummaryAsync(ctx, await svc.GetClDetectorSummaryAsync($"{baseUrl}{cldetectorPath}", ctx.RequestAborted));
        });

        page.MapPost("/api/lab/summary", async (HttpContext ctx, SummaryProxyService svc) =>
        {
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var labSummaryPath = backendCfg.LabSummaryPath;
            using var reader = new StreamReader(ctx.Request.Body);
            var rawBody = await reader.ReadToEndAsync();
            var body = new StringContent(rawBody, Encoding.UTF8, "application/json");
            await ProxySummaryAsync(ctx, await svc.PostLabSummaryAsync($"{baseUrl}{labSummaryPath}", body, ctx.RequestAborted));
        });

        // Clarifier card (MHxViewer) — CW A/B, pH/Alk, jar curve, daily dosage per phase.
        // 502 while Uroboros does not serve it yet → the card falls back to its MOCK payload.
        page.MapGet("/api/clarifier/summary", async (HttpContext ctx, SummaryProxyService svc) =>
            await ProxyUroborosGetAsync(app, ctx, svc, SummaryProxyService.DefaultClarifierPath));
    }
}
