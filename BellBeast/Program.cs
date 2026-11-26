using System.IO.Compression;
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using BellBeast.ApiAccess;
using BellBeast.Endpoints;
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
    options.Conventions.AllowAnonymousToPage("/DailyReport");
    options.Conventions.AllowAnonymousToPage("/KpiQuery");   // สืบค้น KPI ของระบบ CAR (ข้อมูลจาก LabVenture /api/kpi)
    options.Conventions.AllowAnonymousToPage("/IotRoom");
    options.Conventions.AllowAnonymousToPage("/LedDemo");

    // ✅ Admin: ให้ /Admin/Login เข้าได้โดยไม่ต้อง auth
    options.Conventions.AllowAnonymousToPage("/Admin/Login");
    options.Conventions.AllowAnonymousToPage("/WebPM");

    // ✅ Admin: บังคับทั้งโฟลเดอร์ /Admin ด้วย policy แยก
    options.Conventions.AuthorizeFolder("/Admin", "AdminOnly");
    // AlarmMonitor lives at /AlarmMonitor (old links keep working) but is an admin tab
    options.Conventions.AuthorizePage("/AlarmMonitor", "AdminOnly");
});

builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.Providers.Add<GzipCompressionProvider>();
});
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);

builder.Services.AddCors(options =>
{
    // Cross-origin access only for origins listed in Cors:AllowedOrigins (empty = same-origin only).
    // The web UI, devices and the LabVenture proxy are all same-origin and need no entry here.
    var corsOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];
    options.AddPolicy("LAN", policy =>
    {
        policy.WithOrigins(corsOrigins)
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
});

// ===============================
// Authentication: 2 cookie schemes + API key (other systems)
// ===============================
const string UserScheme = AuthSchemes.User;   // "Cookies"
const string AdminScheme = AuthSchemes.Admin; // "AdminCookie"

builder.Services
    .AddAuthentication(options =>
    {
        // default เป็น user scheme; requests carrying an API key authenticate as that API client instead
        options.DefaultScheme = UserScheme;
        options.DefaultChallengeScheme = UserScheme;
        options.DefaultAuthenticateScheme = "CookieOrApiKey";
    })
    .AddPolicyScheme("CookieOrApiKey", "User cookie or API key", o =>
        o.ForwardDefaultSelector = ctx => ApiKeyAuthenticationHandler.HasKey(ctx) ? ApiKeyAuthenticationHandler.SchemeName : UserScheme)
    .AddScheme<AuthenticationSchemeOptions, ApiKeyAuthenticationHandler>(ApiKeyAuthenticationHandler.SchemeName, null)
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
    // Deny by default: any endpoint without [Authorize]/[AllowAnonymous] needs a signed-in
    // user (user/admin cookie, or an API key — the API gate then checks that key's grants).
    // Public endpoints must opt out explicitly with AllowAnonymous.
    options.FallbackPolicy = new AuthorizationPolicyBuilder(UserScheme, AdminScheme, ApiKeyAuthenticationHandler.SchemeName)
        .RequireAuthenticatedUser()
        .Build();

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
builder.Services.AddSingleton<BackendConfigProvider>();
builder.Services.AddSingleton<ApiCatalogService>();
builder.Services.AddSingleton<ApiClientService>();
builder.Services.AddSingleton<IpAccessService>();
builder.Services.AddSingleton<IpPassService>();
builder.Services.AddSingleton<DeviceAccessService>();
builder.Services.AddSingleton<ViewTokenService>();
builder.Services.AddSingleton<RejectMemes>();
builder.Services.AddHostedService<ViewTrafficPublisher>();
builder.Services.AddSingleton<DatasetService>();
builder.Services.AddSingleton<UroborosMetricsClient>();
builder.Services.AddApiRateLimiting(builder.Configuration);
builder.Services.AddScoped<EngineAdminService>();
builder.Services.AddSingleton<EnginePinGuard>();
builder.Services.AddSingleton<ConfigEditorService>();
builder.Services.AddScoped<SummaryProxyService>();
builder.Services.AddSingleton<WayfarerMapQueryService>();
builder.Services.AddSingleton<IotRoomService>();
builder.Services.AddSingleton<AudioLibraryService>();
builder.Services.AddSingleton<DeviceFleetService>();
builder.Services.AddSingleton<LabGlanceService>();
builder.Services.AddSingleton<TtsService>();
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

app.UseMiddleware<ApiErrorMiddleware>(); // /api exceptions → JSON 502/500, never a redirect to /Error → /Login

app.UseMiddleware<IpBanMiddleware>();  // banned IPs get 403 for everything

app.UseResponseCompression();

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
app.UseRateLimiter();                   // /api only: per API client, else per IP
app.UseMiddleware<ApiGateMiddleware>(); // /api only: disabled APIs, bad keys, ungranted APIs
app.UseMiddleware<ViewTokenMiddleware>(); // pages get a view token; page APIs require a live one
app.UseAuthorization();

// Razor pages
app.MapRazorPages();

// ===============================
// API endpoints: one file per area under Endpoints/, access level chosen by group
// ===============================
var api = new ApiGroups(
    Public: app.MapGroup("").AllowAnonymous(),
    User: app.MapGroup(""),                                // deny-by-default fallback policy
    Admin: app.MapGroup("").RequireAuthorization("AdminOnly"),
    Page: app.MapGroup("").AllowAnonymous().RequireViewToken(),   // APIs behind our public pages
    Device: app.MapGroup("").AllowAnonymous().RequireViewToken().WithMetadata(new DeviceApi()));  // + registered annunciators

app.MapSessionEndpoints(api);
app.MapProxyEndpoints(api);
app.MapAqEndpoints(api);
app.MapDashboardEndpoints(api);
app.MapReportEndpoints(api);
app.MapEngineEndpoints(api);
app.MapIotEndpoints(api);
app.MapAlarmEndpoints(api);
app.MapCbEndpoints(api);
app.MapAudioEndpoints(api);
app.MapFleetEndpoints(api);
app.MapApiAdminEndpoints(api);
app.MapV1Endpoints(api);
app.MapViewEndpoints(api);

app.Run();

// Required for WebApplicationFactory<Program> in integration tests
public partial class Program { }
