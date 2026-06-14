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

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddJsonFile(
    Path.Combine(builder.Environment.ContentRootPath, "App_Data", "backend-config.json"),
    optional: true,
    reloadOnChange: true);
builder.Configuration.AddJsonFile(
    Path.Combine(builder.Environment.ContentRootPath, "App_Data", "backend-config.chat2.json"),
    optional: true,
    reloadOnChange: true);

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
    options.Conventions.AllowAnonymousToPage("/Index");
    options.Conventions.AllowAnonymousToPage("/Privacy");
    options.Conventions.AllowAnonymousToPage("/MH_report");
    options.Conventions.AllowAnonymousToPage("/MHxViewer/MHxView");
    options.Conventions.AllowAnonymousToPage("/CHEM_report");
    options.Conventions.AllowAnonymousToPage("/Chat");
    options.Conventions.AllowAnonymousToPage("/Chat2");
    options.Conventions.AllowAnonymousToPage("/IotRoom");
    options.Conventions.AllowAnonymousToPage("/LedDemo");

    // ✅ Admin: ให้ /Admin/Login เข้าได้โดยไม่ต้อง auth
    options.Conventions.AllowAnonymousToPage("/Admin/Login");
    options.Conventions.AllowAnonymousToPage("/WebPM");

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
builder.Services.AddScoped<SummaryProxyService>();
builder.Services.AddOptions<OpenClawOptions>()
    .Bind(builder.Configuration.GetSection("OpenClaw"));
builder.Services.AddOptions<OpenClawChat2Options>()
    .Bind(builder.Configuration.GetSection("OpenClawChat2"));
builder.Services.AddHttpClient<OpenClawChatService>()
    .AddTypedClient((http, sp) => new OpenClawChatService(
        http,
        sp.GetRequiredService<IOptions<OpenClawOptions>>().Value));
builder.Services.AddHttpClient<OpenClawChat2Service>()
    .AddTypedClient((http, sp) => new OpenClawChat2Service(
        http,
        sp.GetRequiredService<IOptions<OpenClawChat2Options>>().Value));
builder.Services.AddSingleton<WayfarerMapQueryService>();
builder.Services.AddSingleton<IotRoomService>();
builder.Services.AddSingleton<CloudflareTunnelService>();
builder.Services.AddWayfarerData(builder.Configuration);

var app = builder.Build();

// ===============================
// Middleware
// ===============================
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    app.UseHsts();
}

app.UseWhen(
    static ctx =>
        !ctx.Request.Path.Equals("/api/ai/chat/send", StringComparison.OrdinalIgnoreCase)
        && !ctx.Request.Path.Equals("/api/ai/chat2/send", StringComparison.OrdinalIgnoreCase),
    static branch => branch.UseResponseCompression());

if (app.Environment.IsDevelopment())
{
    app.UseHttpsRedirection();
}

app.UseStaticFiles();
app.UseRouting();
app.UseCors("LAN");

app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path == "/")
    {
        ctx.Response.Redirect("/MHxViewer/MHxView");
        return;
    }

    await next();
});

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

static (string baseUrl, string queryCsvPath, string dailyReportPath, string chemReportPath, string chemExportPath, string dpsSummaryPath, string tpsSummaryPath, string rwsSummaryPath, string chemSummaryPath, string eventSummaryPath, string labSummaryPath, string cldetectorPath, string wayfarerApiPath)
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
    var dpsSummaryPath = NormPath(GetStr("dpsSummaryPath"), SummaryProxyService.DefaultDpsPath);
    var tpsSummaryPath = NormPath(GetStr("tpsSummaryPath"), SummaryProxyService.DefaultTpsPath);
    var rwsSummaryPath = NormPath(GetStr("rwsSummaryPath"), SummaryProxyService.DefaultRwsPath);
    var chemSummaryPath = NormPath(GetStr("chemSummaryPath"), SummaryProxyService.DefaultChemPath);
    var eventSummaryPath = NormPath(GetStr("eventSummaryPath"), SummaryProxyService.DefaultEventPath);
    var labSummaryPath = NormPath(GetStr("labSummaryPath"), SummaryProxyService.DefaultLabPath);
    var cldetectorPath = NormPath(GetStr("cldetectorPath"), SummaryProxyService.DefaultClDetectorPath);
    var wayfarerApiPath = NormPath(GetStr("wayfarerApiPath"), "/api/wayfarer");
    return (baseUrl, queryCsvPath, dailyReportPath, chemReportPath, chemExportPath, dpsSummaryPath, tpsSummaryPath, rwsSummaryPath, chemSummaryPath, eventSummaryPath, labSummaryPath, cldetectorPath, wayfarerApiPath);
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
    var (baseUrl, queryCsvPath, dailyReportPath, chemReportPath, chemExportPath, _, _, _, _, _, _, _, wayfarerApiPath) = ReadBackendConfig(app);
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

app.MapGet("/api/ai/chat/health", [AllowAnonymous] async (OpenClawChatService svc, HttpContext ctx) =>
{
    var profileId = ctx.Request.Query["agent"].ToString();
    var result = await svc.GetHealthAsync(profileId, ctx.RequestAborted);
    return Results.Ok(result);
});

app.MapGet("/api/ai/chat/profiles", [AllowAnonymous] (OpenClawChatService svc) =>
{
    return Results.Ok(svc.GetProfilesSummary());
});

app.MapGet("/api/ai/chat2/health", [AllowAnonymous] async (OpenClawChat2Service svc, HttpContext ctx) =>
{
    var profileId = ctx.Request.Query["agent"].ToString();
    var result = await svc.GetHealthAsync(profileId, ctx.RequestAborted);
    return Results.Ok(result);
});

app.MapGet("/api/ai/chat2/profiles", [AllowAnonymous] (OpenClawChat2Service svc) =>
{
    return Results.Ok(svc.GetProfilesSummary());
});

app.MapPost("/api/ai/chat/send", [AllowAnonymous] async Task<IResult> (
    OpenClawChatRequest request,
    OpenClawChatService svc,
    HttpContext ctx) =>
{
    if (request.Messages is null || request.Messages.Count == 0)
    {
        return Results.BadRequest(new
        {
            success = false,
            statusCode = StatusCodes.Status400BadRequest,
            answer = "At least one message is required.",
            raw = ""
        });
    }

    try
    {
        var requestContext = svc.BuildRequestContext(ResolveOpenClawUserKey(ctx), request.AgentProfileId);

        if (request.Stream)
        {
            var streamState = new StringBuilder();
            ctx.Response.StatusCode = StatusCodes.Status200OK;
            ctx.Response.Headers.CacheControl = "no-cache, no-transform";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";
            ctx.Response.Headers["Connection"] = "keep-alive";
            ctx.Response.ContentType = "text/event-stream";
            ctx.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            await ctx.Response.StartAsync(ctx.RequestAborted);
            await ctx.Response.WriteAsync(": bellbeast-stream-open\n\n", ctx.RequestAborted);
            await ctx.Response.Body.FlushAsync(ctx.RequestAborted);

            var streamResult = await svc.SendStreamAsync(
                request,
                requestContext,
                async (delta, state) =>
                {
                    if (string.IsNullOrEmpty(delta))
                        return;

                    state.Append(delta);
                    var payload = JsonSerializer.Serialize(new
                    {
                        choices = new[]
                        {
                            new
                            {
                                delta = new
                                {
                                    content = delta
                                }
                            }
                        }
                    });

                    await ctx.Response.WriteAsync($"data: {payload}\n\n", ctx.RequestAborted);
                    await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
                },
                streamState,
                ctx.RequestAborted);

            if (!streamResult.Success)
            {
                ctx.Response.StatusCode = streamResult.StatusCode;
                var safeError = JsonSerializer.Serialize(new
                {
                    error = new
                    {
                        message = streamResult.Answer
                    }
                });
                await ctx.Response.WriteAsync($"data: {safeError}\n\n", ctx.RequestAborted);
                await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
                return Results.Empty;
            }

            await ctx.Response.WriteAsync("data: [DONE]\n\n", ctx.RequestAborted);
            await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
            return Results.Empty;
        }

        var result = await svc.SendAsync(request, requestContext, ctx.RequestAborted);
        return Results.Json(result, statusCode: result.StatusCode);
    }
    catch
    {
        return Results.Problem("Chat request failed.", statusCode: StatusCodes.Status500InternalServerError);
    }
});

app.MapPost("/api/ai/chat2/send", [AllowAnonymous] async Task<IResult> (
    OpenClawChatRequest request,
    OpenClawChat2Service svc,
    HttpContext ctx) =>
{
    if (request.Messages is null || request.Messages.Count == 0)
    {
        return Results.BadRequest(new
        {
            success = false,
            statusCode = StatusCodes.Status400BadRequest,
            answer = "At least one message is required.",
            raw = ""
        });
    }

    try
    {
        var requestContext = svc.BuildRequestContext(ResolveOpenClawUserKey(ctx), request.AgentProfileId);

        if (request.Stream)
        {
            var streamState = new StringBuilder();
            ctx.Response.StatusCode = StatusCodes.Status200OK;
            ctx.Response.Headers.CacheControl = "no-cache, no-transform";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";
            ctx.Response.Headers["Connection"] = "keep-alive";
            ctx.Response.ContentType = "text/event-stream";
            ctx.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            await ctx.Response.StartAsync(ctx.RequestAborted);
            await ctx.Response.WriteAsync(": bellbeast-stream-open\n\n", ctx.RequestAborted);
            await ctx.Response.Body.FlushAsync(ctx.RequestAborted);

            var streamResult = await svc.SendStreamAsync(
                request,
                requestContext,
                async (delta, state) =>
                {
                    if (string.IsNullOrEmpty(delta))
                        return;

                    state.Append(delta);
                    var payload = JsonSerializer.Serialize(new
                    {
                        choices = new[]
                        {
                            new
                            {
                                delta = new
                                {
                                    content = delta
                                }
                            }
                        }
                    });

                    await ctx.Response.WriteAsync($"data: {payload}\n\n", ctx.RequestAborted);
                    await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
                },
                streamState,
                ctx.RequestAborted);

            if (!streamResult.Success)
            {
                ctx.Response.StatusCode = streamResult.StatusCode;
                var safeError = JsonSerializer.Serialize(new
                {
                    error = new
                    {
                        message = streamResult.Answer
                    }
                });
                await ctx.Response.WriteAsync($"data: {safeError}\n\n", ctx.RequestAborted);
                await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
                return Results.Empty;
            }

            await ctx.Response.WriteAsync("data: [DONE]\n\n", ctx.RequestAborted);
            await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
            return Results.Empty;
        }

        var result = await svc.SendAsync(request, requestContext, ctx.RequestAborted);
        return Results.Json(result, statusCode: result.StatusCode);
    }
    catch
    {
        return Results.Problem("Chat2 request failed.", statusCode: StatusCodes.Status500InternalServerError);
    }
});

static IReadOnlyList<string> ReadStatusGroups(IQueryCollection query)
{
    var values = query["statusGroup"]
        .SelectMany(x => x.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToList();

    return values.Count == 0 ? new[] { "all" } : values;
}

app.MapGet("/api/wayfarer/map-summary", async (HttpContext ctx, WayfarerMapQueryService svc, CancellationToken ct) =>
{
    var req = ctx.Request.Query;
    var from = req["from"].ToString().Trim();
    var to = req["to"].ToString().Trim();
    var statusGroups = ReadStatusGroups(req);

    var items = await svc.GetMapSummaryAsync(from, to, statusGroups, ct);
    return Results.Ok(new
    {
        from,
        to,
        statusGroups,
        items
    });
});

app.MapGet("/api/wayfarer/map-branch-workorders", async (HttpContext ctx, WayfarerMapQueryService svc, CancellationToken ct) =>
{
    var req = ctx.Request.Query;
    var puCode = req["puCode"].ToString().Trim();
    if (string.IsNullOrWhiteSpace(puCode))
        return Results.BadRequest(new { message = "puCode is required" });

    var from = req["from"].ToString().Trim();
    var to = req["to"].ToString().Trim();
    var statusGroups = ReadStatusGroups(req);

    var response = await svc.GetBranchWorkOrdersAsync(puCode, from, to, statusGroups, ct);
    return Results.Ok(response);
});

app.MapWayfarerApi();

app.MapMethods("/api/wayfarer/{**path}", new[] { "GET", "POST" }, async (HttpContext ctx, IHttpClientFactory factory, string? path) =>
{
    var (baseUrl, _, _, _, _, _, _, _, _, _, _, _, wayfarerApiPath) = ReadBackendConfig(app);
    var targetPath = string.IsNullOrWhiteSpace(path)
        ? wayfarerApiPath
        : $"{wayfarerApiPath.TrimEnd('/')}/{path.TrimStart('/')}";
    var targetUrl = $"{baseUrl}{targetPath}{ctx.Request.QueryString}";

    var client = factory.CreateClient();
    client.Timeout = TimeSpan.FromSeconds(300);

    using var req = new HttpRequestMessage(new HttpMethod(ctx.Request.Method), targetUrl);

    if (ctx.Request.ContentLength > 0 || ctx.Request.Headers.ContainsKey("Transfer-Encoding"))
    {
        req.Content = new StreamContent(ctx.Request.Body);
        if (!string.IsNullOrWhiteSpace(ctx.Request.ContentType))
            req.Content.Headers.TryAddWithoutValidation("Content-Type", ctx.Request.ContentType);
    }

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

// ===============================
// API : /api/auth/me (user mode เดิม)
// ===============================
app.MapGet("/api/auth/me", (HttpContext ctx) =>
{
    var isAuthenticated = ctx.User?.Identity?.IsAuthenticated ?? false;
    var username = isAuthenticated ? (ctx.User?.Identity?.Name ?? "") : "bypass";
    var token = isAuthenticated
        ? (ctx.User?.FindFirst("AquadatToken")?.Value ?? "")
        : "bypass";

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
    var (baseUrl, queryCsvPath, _, _, _, _, _, _, _, _, _, _, _) = ReadBackendConfig(app);
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

app.MapGet("/api/ptc/series", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, _, _, _, _, _, _, _, _, _, _, _, _) = ReadBackendConfig(app);
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

app.MapPost("/api/online_lab", async (HttpContext ctx, IHttpClientFactory factory) =>
{
    var (baseUrl, _, _, _, _, _, _, _, _, _, _, _, _) = ReadBackendConfig(app);
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
    var (baseUrl, _, dailyReportPath, _, _, _, _, _, _, _, _, _, _) = ReadBackendConfig(app);
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
    var (baseUrl, _, _, chemReportPath, _, _, _, _, _, _, _, _, _) = ReadBackendConfig(app);
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
    var (baseUrl, _, _, _, chemExportPath, _, _, _, _, _, _, _, _) = ReadBackendConfig(app);
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

// Proxy: forward GET admin/tasks/status to Uroboros and relay the response.
// Lets the browser call /api/admin/tasks/status (BellBeast) instead of calling
// Uroboros directly — avoids cross-origin / firewall issues from the browser.
app.MapGet("/api/admin/tasks/status", async (EngineAdminService svc) =>
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

app.MapGet("/api/dps/summary", async (HttpContext ctx, SummaryProxyService svc) =>
{
    var (baseUrl, _, _, _, _, dpsSummaryPath, _, _, _, _, _, _, _) = ReadBackendConfig(app);
    await ProxySummaryAsync(ctx, await svc.GetDpsSummaryAsync($"{baseUrl}{dpsSummaryPath}", ctx.RequestAborted));
});

app.MapGet("/api/tps/summary", async (HttpContext ctx, SummaryProxyService svc) =>
{
    var (baseUrl, _, _, _, _, _, tpsSummaryPath, _, _, _, _, _, _) = ReadBackendConfig(app);
    await ProxySummaryAsync(ctx, await svc.GetTpsSummaryAsync($"{baseUrl}{tpsSummaryPath}", ctx.RequestAborted));
});

app.MapGet("/api/rws/summary", async (HttpContext ctx, SummaryProxyService svc) =>
{
    var (baseUrl, _, _, _, _, _, _, rwsSummaryPath, _, _, _, _, _) = ReadBackendConfig(app);
    await ProxySummaryAsync(ctx, await svc.GetRwsSummaryAsync($"{baseUrl}{rwsSummaryPath}", ctx.RequestAborted));
});

app.MapGet("/api/chem/summary", async (HttpContext ctx, SummaryProxyService svc) =>
{
    var (baseUrl, _, _, _, _, _, _, _, chemSummaryPath, _, _, _, _) = ReadBackendConfig(app);
    await ProxySummaryAsync(ctx, await svc.GetChemSummaryAsync($"{baseUrl}{chemSummaryPath}", ctx.RequestAborted));
});

app.MapGet("/api/event/summary", async (HttpContext ctx, SummaryProxyService svc) =>
{
    var (baseUrl, _, _, _, _, _, _, _, _, eventSummaryPath, _, _, _) = ReadBackendConfig(app);
    await ProxySummaryAsync(ctx, await svc.GetEventSummaryAsync($"{baseUrl}{eventSummaryPath}", ctx.RequestAborted));
});

app.MapGet("/api/cldetector/summary", async (HttpContext ctx, SummaryProxyService svc) =>
{
    var (baseUrl, _, _, _, _, _, _, _, _, _, _, cldetectorPath, _) = ReadBackendConfig(app);
    await ProxySummaryAsync(ctx, await svc.GetClDetectorSummaryAsync($"{baseUrl}{cldetectorPath}", ctx.RequestAborted));
});

app.MapPost("/api/lab/summary", async (HttpContext ctx, SummaryProxyService svc) =>
{
    var (baseUrl, _, _, _, _, _, _, _, _, _, labSummaryPath, _, _) = ReadBackendConfig(app);
    using var reader = new StreamReader(ctx.Request.Body);
    var rawBody = await reader.ReadToEndAsync();
    var body = new StringContent(rawBody, Encoding.UTF8, "application/json");
    await ProxySummaryAsync(ctx, await svc.PostLabSummaryAsync($"{baseUrl}{labSummaryPath}", body, ctx.RequestAborted));
});

app.MapGet("/api/admin/test/run", async (EngineAdminService svc) =>
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
app.MapGet("/api/admin/test/run-local", (HttpContext httpCtx, IWebHostEnvironment env) =>
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

// ===============================
// API : Cloudflare Tunnel control
// ===============================

app.MapGet("/api/iot/tunnel/status", [AllowAnonymous] (CloudflareTunnelService cf) =>
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

app.MapPost("/api/iot/tunnel/start", [AllowAnonymous] (CloudflareTunnelService cf) =>
{
    var started = cf.Start();
    return Results.Ok(new { ok = started, state = cf.State.ToString().ToLowerInvariant() });
});

app.MapPost("/api/iot/tunnel/stop", [AllowAnonymous] (CloudflareTunnelService cf) =>
{
    cf.Stop();
    return Results.Ok(new { ok = true, state = "stopped" });
});

// ===============================
// API : IoT Room
// ===============================

// Device → join room (first time or after reconnect)
app.MapPost("/api/iot/room/join", [AllowAnonymous] (IotRoomService iotRoom, HttpContext ctx) =>
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
app.MapPost("/api/iot/room/poll", [AllowAnonymous] (IotRoomService iotRoom, HttpContext ctx) =>
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
app.MapGet("/api/iot/room/members", [AllowAnonymous] (IotRoomService iotRoom) =>
{
    var members = iotRoom.GetMembers();
    return Results.Ok(new { members });
});

// Browser → get room log
app.MapGet("/api/iot/room/log", [AllowAnonymous] (IotRoomService iotRoom, HttpContext ctx) =>
{
    int last = 50;
    if (int.TryParse(ctx.Request.Query["last"], out var q) && q > 0 && q <= 200) last = q;
    var entries = iotRoom.GetLog(last);
    return Results.Ok(new { entries });
});

// Host → send command to a device
app.MapPost("/api/iot/room/command", [AllowAnonymous] (IotRoomService iotRoom, HttpContext ctx) =>
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
app.MapPost("/api/iot/room/data", [AllowAnonymous] async (IotRoomService iotRoom, HttpContext ctx) =>
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
app.MapGet("/api/iot/room/data", [AllowAnonymous] (IotRoomService iotRoom, HttpContext ctx) =>
{
    var key = ctx.Request.Query["key"].FirstOrDefault();
    var deviceName = ctx.Request.Query["deviceName"].FirstOrDefault();
    var devices = iotRoom.GetDeviceData(key, deviceName);
    return Results.Ok(new { devices });
});

// Dashboard → one-shot snapshot (members + states + log)
app.MapGet("/api/iot/room/snapshot", [AllowAnonymous] (IotRoomService iotRoom, HttpContext ctx) =>
{
    int last = 50;
    if (int.TryParse(ctx.Request.Query["last"], out var q) && q > 0 && q <= 200) last = q;
    return Results.Ok(iotRoom.GetSnapshot(last));
});

app.Run();

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

// ── Shared streaming helper used by all 7 summary proxy handlers ──────────────
static async Task ProxySummaryAsync(HttpContext ctx, HttpResponseMessage upstream)
{
    ctx.Response.StatusCode = (int)upstream.StatusCode;

    if (upstream.Content.Headers.ContentType != null)
        ctx.Response.ContentType = upstream.Content.Headers.ContentType.ToString();

    if (!upstream.IsSuccessStatusCode)
    {
        var err = await upstream.Content.ReadAsStringAsync(ctx.RequestAborted);
        await ctx.Response.WriteAsync(err, ctx.RequestAborted);
        return;
    }

    await using var stream = await upstream.Content.ReadAsStreamAsync(ctx.RequestAborted);
    await stream.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
    await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
}


static string ResolveOpenClawUserKey(HttpContext ctx)
{
    var user = ctx.User;

    static string? ReadClaim(ClaimsPrincipal principal, string claimType)
    {
        var value = principal.FindFirst(claimType)?.Value?.Trim();
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    static string? ReadHeader(HttpContext context, string headerName)
    {
        var value = context.Request.Headers[headerName].ToString().Trim();
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    static string? NormalizeClientKey(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;

        var builder = new StringBuilder(value.Length);
        foreach (var ch in value.Trim().ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(ch) || ch is '-' or '_')
            {
                builder.Append(ch);
            }
            else if (builder.Length == 0 || builder[^1] != '-')
            {
                builder.Append('-');
            }
        }

        var normalized = builder.ToString().Trim('-');
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    var authenticatedKey = ReadClaim(user, ClaimTypes.NameIdentifier)
        ?? ReadClaim(user, "sub")
        ?? user.Identity?.Name?.Trim();

    if (!string.IsNullOrWhiteSpace(authenticatedKey))
        return authenticatedKey;

    return NormalizeClientKey(ReadHeader(ctx, "X-BellBeast-Chat-Client"))
        ?? "bellbeast-user";
}

sealed class AdminLoginDto
{
    public string? Username { get; set; }
    public string? Password { get; set; }
}

sealed class IotJoinRequest
{
    public string? DeviceName { get; set; }
    public string? DeviceType { get; set; }
}

sealed class IotPollRequest
{
    public string? Key { get; set; }
}

sealed class IotCommandRequest
{
    public string? Raw { get; set; }
}

sealed class IotDataRequest
{
    public string? Key { get; set; }
    public Dictionary<string, System.Text.Json.JsonElement>? Data { get; set; }
}

// ====== types ที่คุณมีอยู่แล้วในโปรเจกต์ ======
// sealed record TemplateSaveRequest(string? name, List<TemplateItem>? items);
// sealed record TemplateItem(...);

// Required for WebApplicationFactory<Program> in integration tests
public partial class Program { }
