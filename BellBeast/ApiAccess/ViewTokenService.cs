using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc.RazorPages;
using BellBeast.Endpoints;

namespace BellBeast.ApiAccess;

/// <summary>Endpoint metadata: the API serves our public pages, so callers need a live view token.</summary>
public sealed class RequiresViewToken { }

/// <summary>
/// View tokens for the APIs behind our public pages (MHxView, reports, WebPM, IoT room page).
///
/// - Every page render gets a short-lived token (meta tag) bound to the client IP, plus a signed
///   HttpOnly refresh cookie (path /api/view, ViewToken:RefreshHours, rolled on every renew).
/// - Each request carrying the token keeps it alive; idle longer than ViewToken:IdleSeconds
///   (default 10 s = 2 × the 5 s alarm poll) and it is dead: old or missing token → 401.
/// - The page script renews silently with the refresh cookie (after sleep / server restart / IP change)
///   and retries, so walls never reload (a reload would block alarm sound until someone taps the screen).
/// Callers that are already trusted skip the check: signed-in users/admins, and loopback when
/// ViewToken:ExemptLoopback is true (tools on the server itself, e.g. BellBeast Tester).
/// </summary>
public sealed class ViewTokenService
{
    public const string HeaderName = "X-View-Token";
    public const string RefreshCookie = "bb_vr";
    public const string RefreshCookiePath = "/api/view";
    public const string ItemKey = "bb.viewToken";
    /// <summary>The only error a rejected caller sees (page and renew); the page script renews on it.</summary>
    public const string PublicError = "unauthorized";
    public const int MaxSessions = 5000;

    public enum Verdict { Ok, Missing, Expired, WrongIp }

    private sealed class Session
    {
        public required string Ip;
        public required string Page;
        public DateTimeOffset Issued;
        public DateTimeOffset LastSeen;
        public long Count;
    }

    private sealed class Rejection
    {
        public long Count;
        public DateTimeOffset LastAt;
        public string LastPath = "";
        public string LastReason = "";
    }

    public sealed record Viewer(string Ip, IReadOnlyList<string> Pages, int Sessions, DateTimeOffset FirstSeen, DateTimeOffset LastSeen, long Requests);
    public sealed record Rejected(string Ip, long Count, DateTimeOffset LastAt, string LastPath, string LastReason);
    public sealed record Stats(int ActiveViewers, int ActiveIps, long RejectedLastMinute);

    private readonly ConcurrentDictionary<string, Session> _sessions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Rejection> _rejections = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<DateTimeOffset> _recentRejections = new();
    private readonly ITimeLimitedDataProtector _protector;
    private readonly IConfiguration _cfg;

    public ViewTokenService(IDataProtectionProvider dp, IConfiguration cfg)
    {
        _protector = dp.CreateProtector("BellBeast.ViewToken.Refresh.v1").ToTimeLimitedDataProtector();
        _cfg = cfg;
    }

    public TimeSpan IdleTimeout => TimeSpan.FromSeconds(Math.Clamp(_cfg.GetValue("ViewToken:IdleSeconds", 10), 2, 3600));
    public TimeSpan RefreshLifetime => TimeSpan.FromHours(Math.Clamp(_cfg.GetValue("ViewToken:RefreshHours", 24), 1, 24 * 30));
    public bool ExemptLoopback => _cfg.GetValue("ViewToken:ExemptLoopback", true);

    // ── tokens ───────────────────────────────────────────────────────────────

    public string Issue(string ip, string page)
    {
        var now = DateTimeOffset.UtcNow;
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).Replace('+', '-').Replace('/', '_').TrimEnd('=');
        _sessions[token] = new Session { Ip = ip, Page = Trim(page, 120), Issued = now, LastSeen = now };
        if (_sessions.Count > MaxSessions) Sweep(force: true);
        return token;
    }

    public Verdict Check(string? token, string ip)
    {
        if (string.IsNullOrEmpty(token)) return Verdict.Missing;
        if (!_sessions.TryGetValue(token, out var s)) return Verdict.Expired;   // unknown = expired / server restarted
        var now = DateTimeOffset.UtcNow;
        lock (s)
        {
            if (now - s.LastSeen > IdleTimeout) { _sessions.TryRemove(token, out _); return Verdict.Expired; }
            if (s.Ip != ip) return Verdict.WrongIp;
            s.LastSeen = now;
            s.Count++;
        }
        return Verdict.Ok;
    }

    public string NewRefreshTicket() => _protector.Protect("v1|" + DateTimeOffset.UtcNow.ToUnixTimeSeconds(), RefreshLifetime);

    public bool ValidRefreshTicket(string? ticket)
    {
        if (string.IsNullOrEmpty(ticket)) return false;
        try { return _protector.Unprotect(ticket).StartsWith("v1|", StringComparison.Ordinal); }
        catch (CryptographicException) { return false; }
    }

    public void SetRefreshCookie(HttpContext ctx) =>
        ctx.Response.Cookies.Append(RefreshCookie, NewRefreshTicket(), new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Strict,
            Secure = ctx.Request.IsHttps,
            Path = RefreshCookiePath,
            MaxAge = RefreshLifetime,
        });

    // ── visibility (admin IP tab + room summary) ─────────────────────────────

    public void RecordRejection(string ip, string path, string reason)
    {
        var now = DateTimeOffset.UtcNow;
        var r = _rejections.GetOrAdd(ip, _ => new Rejection());
        lock (r) { r.Count++; r.LastAt = now; r.LastPath = Trim(path, 120); r.LastReason = reason; }
        _recentRejections.Enqueue(now);
        while (_recentRejections.Count > 10_000 && _recentRejections.TryDequeue(out _)) { }
        if (_rejections.Count > 2000)
            foreach (var old in _rejections.OrderBy(kv => kv.Value.LastAt).Take(_rejections.Count - 2000).ToList())
                _rejections.TryRemove(old.Key, out _);
    }

    public IReadOnlyList<Viewer> ListViewers()
    {
        Sweep();
        var alive = DateTimeOffset.UtcNow - IdleTimeout;
        return _sessions.Values.Where(s => s.LastSeen >= alive)
            .GroupBy(s => s.Ip)
            .Select(g => new Viewer(g.Key, g.Select(s => s.Page).Distinct().OrderBy(p => p).ToList(), g.Count(),
                g.Min(s => s.Issued), g.Max(s => s.LastSeen), g.Sum(s => s.Count)))
            .OrderByDescending(v => v.LastSeen)
            .ToList();
    }

    public IReadOnlyList<Rejected> ListRejections() =>
        _rejections.Select(kv => { lock (kv.Value) return new Rejected(kv.Key, kv.Value.Count, kv.Value.LastAt, kv.Value.LastPath, kv.Value.LastReason); })
            .OrderByDescending(r => r.LastAt).ToList();

    public Stats Summary()
    {
        var now = DateTimeOffset.UtcNow;
        while (_recentRejections.TryPeek(out var t) && now - t > TimeSpan.FromMinutes(1)) _recentRejections.TryDequeue(out _);
        var alive = now - IdleTimeout;
        var live = _sessions.Values.Where(s => s.LastSeen >= alive).ToList();
        return new Stats(live.Count, live.Select(s => s.Ip).Distinct().Count(), _recentRejections.Count);
    }

    private void Sweep(bool force = false)
    {
        var cutoff = DateTimeOffset.UtcNow - (IdleTimeout * 6);
        foreach (var kv in _sessions)
            if (kv.Value.LastSeen < cutoff) _sessions.TryRemove(kv.Key, out _);
        if (force && _sessions.Count > MaxSessions)
            foreach (var kv in _sessions.OrderBy(kv => kv.Value.LastSeen).Take(_sessions.Count - MaxSessions).ToList())
                _sessions.TryRemove(kv.Key, out _);
    }

    private static string Trim(string s, int max) => s.Length <= max ? s : s[..max];
}

/// <summary>
/// After the API gate: hands a token to every page render, enforces it on APIs marked RequiresViewToken,
/// and treats any other /api request that carries a valid token as a heartbeat (e.g. the 5 s alarm poll).
/// </summary>
public sealed class ViewTokenMiddleware
{
    private readonly RequestDelegate _next;
    public ViewTokenMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext ctx, ViewTokenService views)
    {
        var endpoint = ctx.GetEndpoint();
        var ip = IpAccessService.ClientIp(ctx);

        if (endpoint?.Metadata.GetMetadata<PageActionDescriptor>() is not null && HttpMethods.IsGet(ctx.Request.Method))
        {
            ctx.Items[ViewTokenService.ItemKey] = views.Issue(ip, ctx.Request.Path);
            views.SetRefreshCookie(ctx);
        }
        else if (endpoint?.Metadata.GetMetadata<RequiresViewToken>() is not null)
        {
            var verdict = views.Check(ctx.Request.Headers[ViewTokenService.HeaderName].FirstOrDefault(), ip);
            if (verdict != ViewTokenService.Verdict.Ok && !await TrustedAsync(ctx, views, ip))
            {
                var reason = verdict switch
                {
                    ViewTokenService.Verdict.Missing => "view_token_missing",
                    ViewTokenService.Verdict.WrongIp => "view_token_wrong_ip",
                    _ => "view_token_expired",
                };
                views.RecordRejection(ip, ctx.Request.Path, reason);   // real reason: admin IP tab only
                const string error = ViewTokenService.PublicError;      // callers get no hint why
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                ctx.Response.Headers.CacheControl = "no-store";
                var meme = ctx.RequestServices.GetRequiredService<RejectMemes>().Pick();
                if (RejectMemes.IsBrowserNavigation(ctx.Request))
                {
                    // someone typed the API URL into a tab: a page with a meme instead of raw JSON
                    ctx.Response.ContentType = "text/html; charset=utf-8";
                    await ctx.Response.WriteAsync(RejectMemes.Page(meme));
                }
                else
                {
                    // fetch / curl / scripts keep the JSON contract (our page script renews on these codes)
                    await ctx.Response.WriteAsJsonAsync(new { ok = false, error, meme });
                }
                return;
            }
        }
        else if (ctx.Request.Headers.ContainsKey(ViewTokenService.HeaderName))
        {
            views.Check(ctx.Request.Headers[ViewTokenService.HeaderName].FirstOrDefault(), ip);   // heartbeat only
        }

        await _next(ctx);
    }

    /// <summary>Signed-in staff (user or admin cookie) and, if allowed, the server itself need no view token.</summary>
    private static async Task<bool> TrustedAsync(HttpContext ctx, ViewTokenService views, string ip)
    {
        if (views.ExemptLoopback && IPAddress.TryParse(ip, out var addr) && IPAddress.IsLoopback(addr)) return true;
        if (ctx.User.Identity?.IsAuthenticated == true && ctx.User.ClientId() is null) return true;
        var admin = await ctx.AuthenticateAsync(AuthSchemes.Admin);
        return admin.Succeeded;
    }
}

public static class ViewTokenEndpointExtensions
{
    /// <summary>Marks every endpoint in the builder as needing a live view token.</summary>
    public static TBuilder RequireViewToken<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder
        => builder.WithMetadata(new RequiresViewToken());
}
