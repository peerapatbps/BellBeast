using System.IO.Compression;
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Data.Sqlite;
using System.Text.RegularExpressions;

var builder = WebApplication.CreateBuilder(args);

// ===============================
// Services
// ===============================
builder.Services.AddHttpClient();

// RazorPages + Conventions
builder.Services.AddRazorPages(options =>
{
    // บังคับ auth ทั้งเว็บ (user mode เดิม)
    options.Conventions.AuthorizeFolder("/");

    // ยกเว้นหน้า public เดิม
    options.Conventions.AllowAnonymousToPage("/Login");
    options.Conventions.AllowAnonymousToPage("/Privacy");
    options.Conventions.AllowAnonymousToPage("/MH_report");
    options.Conventions.AllowAnonymousToPage("/MHxViewer/MHxView");
    options.Conventions.AllowAnonymousToPage("/CHEM_report");

    // ✅ Admin: ให้ /Admin/Login เข้าได้โดยไม่ต้อง auth
    options.Conventions.AllowAnonymousToPage("/Admin/Login");

    // ✅ Admin: บังคับทั้งโฟลเดอร์ /Admin ด้วย policy แยก
    options.Conventions.AuthorizeFolder("/Admin", "AdminOnly");
});

builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.Providers.Add<GzipCompressionProvider>();
});
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);

builder.Services.AddCors(options =>
{
    options.AddPolicy("LAN", policy =>
    {
        policy.AllowAnyHeader()
              .AllowAnyMethod()
              .SetIsOriginAllowed(_ => true)
              .AllowCredentials();
    });
});

// ===============================
// Authentication: 2 cookie schemes
// ===============================
const string UserScheme = CookieAuthenticationDefaults.AuthenticationScheme; // "Cookies"
const string AdminScheme = "AdminCookie";

builder.Services
    .AddAuthentication(options =>
    {
        // default เป็น user scheme
        options.DefaultScheme = UserScheme;
        options.DefaultChallengeScheme = UserScheme;
    })
    .AddCookie(UserScheme, o =>
    {
        o.LoginPath = "/Login";
        o.AccessDeniedPath = "/Login";

        o.ExpireTimeSpan = TimeSpan.FromMinutes(15);
        o.SlidingExpiration = true;

        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Lax;
        o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;

        // ✅ สำคัญ: ถ้าเป็น /api/* อย่า redirect เป็น HTML
        o.Events = new CookieAuthenticationEvents
        {
            OnRedirectToLogin = ctx =>
            {
                if (ctx.Request.Path.StartsWithSegments("/api"))
                {
                    ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    return Task.CompletedTask;
                }
                ctx.Response.Redirect(ctx.RedirectUri);
                return Task.CompletedTask;
            },
            OnRedirectToAccessDenied = ctx =>
            {
                if (ctx.Request.Path.StartsWithSegments("/api"))
                {
                    ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return Task.CompletedTask;
                }
                ctx.Response.Redirect(ctx.RedirectUri);
                return Task.CompletedTask;
            }
        };
    })
    .AddCookie(AdminScheme, o =>
    {
        o.LoginPath = "/Admin/Login";
        o.AccessDeniedPath = "/Admin/Login";

        o.ExpireTimeSpan = TimeSpan.FromMinutes(15);
        o.SlidingExpiration = true;

        // ✅ cookie admin แยก + Path "/" เพื่อให้ล้างได้จากทุกหน้า
        o.Cookie.Name = "bb_admin";
        o.Cookie.Path = "/";
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Lax;
        o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;

        o.Events = new CookieAuthenticationEvents
        {
            OnRedirectToLogin = ctx =>
            {
                if (ctx.Request.Path.StartsWithSegments("/api"))
                {
                    ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    return Task.CompletedTask;
                }
                ctx.Response.Redirect(ctx.RedirectUri);
                return Task.CompletedTask;
            },
            OnRedirectToAccessDenied = ctx =>
            {
                if (ctx.Request.Path.StartsWithSegments("/api"))
                {
                    ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return Task.CompletedTask;
                }
                ctx.Response.Redirect(ctx.RedirectUri);
                return Task.CompletedTask;
            }
        };
    });

// ===============================
// Authorization
// ===============================
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("AdminOnly", policy =>
    {
        policy.AddAuthenticationSchemes(AdminScheme);
        policy.RequireAuthenticatedUser();

        // ✅ ต้อง match กับ claim ที่ใส่ตอน SignIn
        // ให้ Login.cshtml.cs ใส่ new Claim("role","admin")
        policy.RequireClaim("role", "admin");
    });
});
builder.Services.AddHttpClient();
builder.Services.AddScoped<EngineAdminService>();

var app = builder.Build();

// ===============================
// Middleware
// ===============================
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    app.UseHsts();
}

app.UseResponseCompression();

if (app.Environment.IsDevelopment())
{
    app.UseHttpsRedirection();
}

app.UseStaticFiles();
app.UseRouting();
app.UseCors("LAN");

app.UseAuthentication();
app.UseAuthorization();

// Razor pages
app.MapRazorPages();

// ===============================
// Helpers
// ===============================
static string ResolveDbPath(WebApplication app)
{
    var relPath = app.Configuration["AqTable:DbPath"] ?? "App_Data\\aqtable.db";
    return Path.Combine(app.Environment.ContentRootPath, relPath);
}

static async Task<SqliteConnection> OpenReadOnlyAsync(string dbPath)
{
    var cs = new SqliteConnectionStringBuilder
    {
        DataSource = dbPath,
        Mode = SqliteOpenMode.ReadOnly
    }.ToString();

    var con = new SqliteConnection(cs);
    await con.OpenAsync();
    return con;
}

static (string baseUrl, string queryCsvPath, string dailyReportPath, string chemReportPath, string chemExportPath, string dpsSummaryPath, string tpsSummaryPath, string rwsSummaryPath, string chemSummaryPath, string eventSummaryPath)
ReadBackendConfig(WebApplication app)
{
    var path = Path.Combine(app.Environment.ContentRootPath, "App_Data", "backend-config.json");
    if (!File.Exists(path))
        throw new FileNotFoundException($"backend-config.json not found: {path}");

    var jsonText = File.ReadAllText(path);

    using var doc = JsonDocument.Parse(jsonText, new JsonDocumentOptions
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip
    });

    string GetStr(string name)
        => doc.RootElement.TryGetProperty(name, out var el) ? (el.GetString() ?? "").Trim() : "";

    var baseUrl = GetStr("backendBaseUrl").TrimEnd('/');
    if (string.IsNullOrWhiteSpace(baseUrl))
        throw new InvalidOperationException("backendBaseUrl is empty");
    if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out _))
        throw new InvalidOperationException($"backendBaseUrl invalid: {baseUrl}");

    string NormPath(string? p, string fallback)
    {
        p = (p ?? "").Trim();
        if (string.IsNullOrWhiteSpace(p)) p = fallback;
        if (!p.StartsWith("/")) p = "/" + p;
        return p;
    }

    var queryCsvPath = NormPath(GetStr("queryCsvPath"), "/api/process");
    var dailyReportPath = NormPath(GetStr("dailyReportPath"), "/api/dailyreport");
    var chemReportPath = NormPath(GetStr("chemReportPath"), "/api/chem_report");
    var chemExportPath = NormPath(GetStr("chemExportPath"), "/api/chem_report/export");
    var dpsSummaryPath = NormPath(GetStr("dpsSummaryPath"), "/api/dps/summary");
    var tpsSummaryPath = NormPath(GetStr("tpsSummaryPath"), "/api/tps/summary");
    var rwsSummaryPath = NormPath(GetStr("rwsSummaryPath"), "/api/rps/summary");
    var chemSummaryPath = NormPath(GetStr("chemSummaryPath"), "/api/chem/summary");
    var eventSummaryPath = NormPath(GetStr("eventSummaryPath"), "/api/event/summary");

    return (baseUrl, queryCsvPath, dailyReportPath, chemReportPath, chemExportPath, dpsSummaryPath, tpsSummaryPath, rwsSummaryPath, chemSummaryPath, eventSummaryPath);
}

// =======================================================
// ✅ ADMIN debug/logout endpoint (กัน 404 + ล้าง cookie ได้จริง)
// =======================================================

// logout: รองรับทั้ง POST/GET กันคนเรียกผิด method แล้ว 404
app.MapPost("/api/admin/auth/logout", async (HttpContext ctx) =>
{
    await ctx.SignOutAsync(AdminScheme);
    return Results.Ok(new { ok = true, redirect = "/Admin/Login" });
});
app.MapGet("/api/admin/auth/logout", async (HttpContext ctx) =>
{
    await ctx.SignOutAsync(AdminScheme);
    return Results.Ok(new { ok = true, redirect = "/Admin/Login" });
});

// me: เอาไว้ debug ว่าติด admin cookie แล้วจริงไหม
app.MapGet("/api/admin/auth/me", [Authorize(Policy = "AdminOnly")] (HttpContext ctx) =>
{
    var u = ctx.User?.Identity?.Name ?? "";
    return Results.Ok(new { ok = true, username = u, role = "admin" });
});

// ===============================
// API: expose backend config to JS (optional)
// ===============================
app.MapGet("/api/backend-config", () =>
{
    var (baseUrl, queryCsvPath, dailyReportPath, chemReportPath, chemExportPath, _, _, _, _, _) = ReadBackendConfig(app);
    return Results.Ok(new
    {
        backendBaseUrl = baseUrl,
        queryCsvPath,
        dailyReportPath,
        chemReportPath,
        chemExportPath
    });
});

// ===============================
// API : /api/auth/me (user mode เดิม)
// ===============================
app.MapGet("/api/auth/me", (HttpContext ctx) =>
{
    if (!(ctx.User?.Identity?.IsAuthenticated ?? false))
        return Results.Unauthorized();

    var username = ctx.User.Identity?.Name ?? "";
    var token = ctx.User.FindFirst("AquadatToken")?.Value ?? "";

    return Results.Ok(new { username, token });
});

// ===============================
// API : Logout (user mode เดิม)
// ===============================
app.MapPost("/api/auth/logout", async (HttpContext ctx) =>
{
    await ctx.SignOutAsync(UserScheme);
    return Results.Ok(new { ok = true, redirect = "/Login" });
});

// ===============================
// API : /api/stations
// ===============================
app.MapGet("/api/stations", async () =>
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
app.MapGet("/api/aqtable", async (HttpContext http) =>
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
app.MapPost("/api/process", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, queryCsvPath, _, _, _, _, _, _, _, _) = ReadBackendConfig(app);
    var targetUrl = $"{baseUrl}{queryCsvPath}";

    using var reader = new StreamReader(ctx.Request.Body);
    var rawBody = await reader.ReadToEndAsync();

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
app.MapPost("/api/template/save", async (TemplateSaveRequest req) =>
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

        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        var outPath = Path.Combine(desktop, name);

        if (File.Exists(outPath))
        {
            var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");
            outPath = Path.Combine(desktop, Path.GetFileNameWithoutExtension(name) + "_" + stamp + ".json");
        }

        var jsonOptions = new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        };

        var json = JsonSerializer.Serialize(items, jsonOptions);
        await File.WriteAllTextAsync(outPath, json, Encoding.UTF8);

        return Results.Ok(new { ok = true, path = outPath, count = items.Count });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

// ===============================
// PROXY: /api/dailyreport
// ===============================
app.MapPost("/api/dailyreport", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, _, dailyReportPath, _, _, _, _, _, _, _) = ReadBackendConfig(app);
    var targetUrl = $"{baseUrl}{dailyReportPath}";

    using var reader = new StreamReader(ctx.Request.Body);
    var rawBody = await reader.ReadToEndAsync();

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
// PROXY: /api/chem_report
// ===============================
app.MapPost("/api/chem_report", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, _, _, chemReportPath, _, _, _, _, _, _) = ReadBackendConfig(app);
    var targetUrl = $"{baseUrl}{chemReportPath}";

    using var reader = new StreamReader(ctx.Request.Body);
    var rawBody = await reader.ReadToEndAsync();

    var client = factory.CreateClient();
    client.Timeout = TimeSpan.FromSeconds(300);

    using var req = new HttpRequestMessage(HttpMethod.Post, targetUrl);
    req.Content = new StringContent(rawBody, Encoding.UTF8, "application/json");

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

// ===============================
// PROXY: /api/chem_report/export
// ===============================
app.MapPost("/api/chem_report/export", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, _, _, _, chemExportPath, _, _, _, _, _) = ReadBackendConfig(app);
    var targetUrl = $"{baseUrl}{chemExportPath}";

    using var reader = new StreamReader(ctx.Request.Body);
    var rawBody = await reader.ReadToEndAsync();

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

    ctx.Response.Headers["Access-Control-Expose-Headers"] = "Content-Disposition";

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

app.MapPost("/api/admin/pause", async (EngineAdminService svc) =>
{
    await svc.PauseAsync();
    return Results.Ok();
});

app.MapPost("/api/admin/resume", async (EngineAdminService svc) =>
{
    await svc.ResumeAsync();
    return Results.Ok();
});

app.MapPost("/api/admin/cancelall", async (EngineAdminService svc) =>
{
    await svc.CancelAllAsync();
    return Results.Ok();
});

app.MapPost("/api/admin/enqueue", async (EngineAdminService svc, HttpContext ctx) =>
{
    var dto = await ctx.Request.ReadFromJsonAsync<Dictionary<string, string>>();
    if (dto == null || !dto.TryGetValue("name", out var name))
        return Results.BadRequest();

    await svc.EnqueueAsync(name);
    return Results.Ok();
});

app.MapGet("/api/smartmap", async (HttpContext hc) =>
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
    // [{'P019_P':'3.74', ...}]
    // เราจะ extract คู่ 'KEY':'VALUE' ออกมาเป็น Dictionary<string,string>
    var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    foreach (Match m in Regex.Matches(txt, "'([^']+)'\\s*:\\s*'([^']*)'"))
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

app.MapGet("/api/dps/summary", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, _, _, _, _, dpsSummaryPath, _, _, _, _) = ReadBackendConfig(app);
    var targetUrl = $"{baseUrl}{dpsSummaryPath}";

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

app.MapGet("/api/tps/summary", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, _, _, _, _, _, tpsSummaryPath, _, _, _) = ReadBackendConfig(app); // <- ปรับ tuple ให้ตรงของคุณ
    var targetUrl = $"{baseUrl}{tpsSummaryPath}";

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

app.MapGet("/api/rws/summary", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, _, _, _, _, _, _, rwsSummaryPath, _, _) = ReadBackendConfig(app); // <- ปรับ tuple ให้ตรงของคุณ
    var targetUrl = $"{baseUrl}{rwsSummaryPath}";

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

app.MapGet("/api/chem/summary", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, _, _, _, _, _, _, _, chemSummaryPath, _) = ReadBackendConfig(app);

    var path = string.IsNullOrWhiteSpace(chemSummaryPath) ? "/api/chem/summary" : chemSummaryPath;

    // กัน double slash
    var targetUrl = $"{baseUrl}{path}";

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

app.MapGet("/api/event/summary", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, _, _, _, _, _, _, _, _, eventSummaryPath) = ReadBackendConfig(app);

    var path = string.IsNullOrWhiteSpace(eventSummaryPath)
        ? "/api/event/summary"
        : eventSummaryPath;

    var targetUrl = $"{baseUrl}{path}";

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

app.Run();

sealed class AdminLoginDto
{
    public string? Username { get; set; }
    public string? Password { get; set; }
}

// ====== types ที่คุณมีอยู่แล้วในโปรเจกต์ ======
// sealed record TemplateSaveRequest(string? name, List<TemplateItem>? items);
// sealed record TemplateItem(...);
