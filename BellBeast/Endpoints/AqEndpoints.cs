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

/// <summary>AQ lookup page (/Index, login required): stations, aqtable, process proxy, template save.</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class AqEndpoints
{
    public static void MapAqEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);

        // ===============================
        // API : /api/stations
        // ===============================
        user.MapGet("/api/stations", async () =>
        {
            var dbPath = ResolveDbPath(app);
            if (!File.Exists(dbPath))
                return Results.Problem($"DB not found: {dbPath}");

            await using var con = await OpenReadOnlyAsync(dbPath);

            var rows = new List<object>();
            await using var cmd = con.CreateCommand();
            cmd.CommandText = @"
                SELECT DISTINCT station_code, station_name, plant_en
                FROM aqtable
                WHERE station_code IS NOT NULL AND station_code <> ''
                ORDER BY plant_en, station_code;
            ";

            await using var rd = await cmd.ExecuteReaderAsync();
            while (await rd.ReadAsync())
            {
                rows.Add(new
                {
                    stationCode = rd.IsDBNull(0) ? "" : rd.GetString(0),
                    stationName = rd.IsDBNull(1) ? "" : rd.GetString(1),
                    plant = rd.IsDBNull(2) ? "" : rd.GetString(2)
                });
            }

            return Results.Ok(new { total = rows.Count, rows });
        });

        // ===============================
        // API : /api/aqtable
        // ===============================
        user.MapGet("/api/aqtable", async (HttpContext http) =>
        {
            int page = 1;
            int pageSize = 50;

            if (int.TryParse(http.Request.Query["page"], out var p) && p > 0) page = p;
            if (int.TryParse(http.Request.Query["pageSize"], out var ps) && ps > 0 && ps <= 500) pageSize = ps;

            string q = (http.Request.Query["q"].ToString() ?? "").Trim();
            string plant = (http.Request.Query["plant"].ToString() ?? "").Trim();
            string stationCsv = (http.Request.Query["station"].ToString() ?? "").Trim();

            if (q.Length > 200) q = q[..200];

            var stationList = stationCsv
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(100)
                .ToList();

            var dbPath = ResolveDbPath(app);
            if (!File.Exists(dbPath))
                return Results.Problem($"DB not found: {dbPath}");

            await using var con = await OpenReadOnlyAsync(dbPath);

            var whereParts = new List<string>();

            if (!string.IsNullOrWhiteSpace(plant))
                whereParts.Add("plant_en = $plant");

            if (stationList.Count > 0)
            {
                var inParams = stationList.Select((_, i) => $"$st{i}");
                whereParts.Add($"station_code IN ({string.Join(",", inParams)})");
            }

            if (!string.IsNullOrWhiteSpace(q))
            {
                whereParts.Add(@"
                    (
                        CAST(configparam_id AS TEXT) LIKE $q OR
                        plant_en LIKE $q OR
                        station_name LIKE $q OR
                        station_code LIKE $q OR
                        Param_name LIKE $q OR
                        equipment_name LIKE $q OR
                        measure_th LIKE $q OR
                        measure_en LIKE $q
                    )
                ");
            }

            string where = whereParts.Count == 0 ? "" : "WHERE " + string.Join(" AND ", whereParts);

            static void BindCommon(SqliteCommand cmd, string plant, List<string> stationList, string q)
            {
                if (!string.IsNullOrWhiteSpace(plant))
                    cmd.Parameters.AddWithValue("$plant", plant);

                for (int i = 0; i < stationList.Count; i++)
                    cmd.Parameters.AddWithValue($"$st{i}", stationList[i]);

                if (!string.IsNullOrWhiteSpace(q))
                    cmd.Parameters.AddWithValue("$q", $"%{q}%");
            }

            long total;
            await using (var cmdCount = con.CreateCommand())
            {
                cmdCount.CommandText = $"SELECT COUNT(1) FROM aqtable {where};";
                BindCommon(cmdCount, plant, stationList, q);
                total = (long)(await cmdCount.ExecuteScalarAsync() ?? 0L);
            }

            int totalPages = (int)Math.Max(1, Math.Ceiling(total / (double)pageSize));
            if (page > totalPages) page = totalPages;

            int offset = (page - 1) * pageSize;

            var rows = new List<object>();

            await using (var cmd = con.CreateCommand())
            {
                cmd.CommandText = $@"
                    SELECT
                        configparam_id,
                        plant_en,
                        station_name,
                        station_code,
                        Param_name,
                        equipment_name,
                        measure_th,
                        measure_en
                    FROM aqtable
                    {where}
                    ORDER BY configparam_id
                    LIMIT $limit OFFSET $offset;
                ";

                cmd.Parameters.AddWithValue("$limit", pageSize);
                cmd.Parameters.AddWithValue("$offset", offset);

                BindCommon(cmd, plant, stationList, q);

                await using var rd = await cmd.ExecuteReaderAsync();
                string S(int i) => rd.IsDBNull(i) ? "" : rd.GetString(i);

                while (await rd.ReadAsync())
                {
                    rows.Add(new
                    {
                        configID = rd.IsDBNull(0) ? 0 : rd.GetInt32(0),
                        plant = S(1),
                        station = S(2),
                        stationCode = S(3),
                        param = S(4),
                        equipment = S(5),
                        measureTh = S(6),
                        measureEn = S(7)
                    });
                }
            }

            http.Response.Headers.CacheControl = "public,max-age=10";
            return Results.Ok(new { page, pageSize, total, rows });
        });

        // ===============================
        // PROXY: /api/process
        // ===============================
        user.MapPost("/api/process", async (HttpContext ctx, IHttpClientFactory factory) =>
        {
            if (ctx.Request.Cookies.TryGetValue("bb_bypass_role", out var _bypass) && !string.IsNullOrEmpty(_bypass))
            {
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsync("{\"bypass\":true,\"headers\":[],\"rows\":[]}", ctx.RequestAborted);
                return;
            }
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var queryCsvPath = backendCfg.QueryCsvPath;
            var targetUrl = $"{baseUrl}{queryCsvPath}";

            using var reader = new StreamReader(ctx.Request.Body);
            var rawBody = await reader.ReadToEndAsync();

            // aquadat2 allows ONE session per account, and Uroboros (the backend at :8888)
            // owns that session using its own media/aquadat2.ini account. BellBeast must NOT
            // forward a per-login aquadat2 token here: doing so made Uroboros call aquadat2 with
            // a token that its own login had already evicted → HTTP 401 messageCode 407
            // ("บัญชีนี้มีการเข้าสู่ระบบจากที่อื่น"). We only pass the signed-in user for logging;
            // the dashboard/report proxies already run tokenless on Uroboros's own session.
            System.Text.Json.Nodes.JsonObject? payload;
            try { payload = System.Text.Json.Nodes.JsonNode.Parse(rawBody) as System.Text.Json.Nodes.JsonObject; }
            catch (JsonException) { payload = null; }
            if (payload is null)
            {
                ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
                await ctx.Response.WriteAsJsonAsync(new { error = "bad_json" }, ctx.RequestAborted);
                return;
            }
            payload.Remove("token");
            payload["user"] = ctx.User.Identity?.Name ?? "";
            rawBody = payload.ToJsonString();

            var client = factory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(300);

            using var req = new HttpRequestMessage(HttpMethod.Post, targetUrl);
            req.Content = new StringContent(rawBody, Encoding.UTF8, "application/json");

            using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ctx.RequestAborted);

            ctx.Response.StatusCode = (int)resp.StatusCode;

            if (resp.Content.Headers.ContentType != null)
                ctx.Response.ContentType = resp.Content.Headers.ContentType.ToString();

            if (resp.Content.Headers.ContentDisposition != null)
                ctx.Response.Headers["Content-Disposition"] = resp.Content.Headers.ContentDisposition.ToString();

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

        // ===============================
        // API : /api/template/save
        // ===============================
        user.MapPost("/api/template/save", (TemplateSaveRequest req) =>
        {
            static string SanitizeFileName(string s)
            {
                foreach (var ch in Path.GetInvalidFileNameChars())
                    s = s.Replace(ch, '_');
                return s;
            }

            try
            {
                var name = (req.name ?? "").Trim();
                if (string.IsNullOrWhiteSpace(name))
                    return Results.BadRequest("Empty name");

                var items = req.items ?? new List<TemplateItem>();
                if (items.Count == 0)
                    return Results.BadRequest("Empty items");

                name = SanitizeFileName(name);
                if (!name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                    name += ".json";

                var jsonOptions = new JsonSerializerOptions
                {
                    WriteIndented = true,
                    Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
                };

                var json = JsonSerializer.Serialize(items, jsonOptions);
                var bytes = Encoding.UTF8.GetBytes(json);

                return Results.File(bytes, "application/json", name);
            }
            catch (Exception ex)
            {
                return Results.Problem(ex.Message);
            }
        });
    }
}
