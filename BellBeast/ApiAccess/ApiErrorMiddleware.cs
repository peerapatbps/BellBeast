using System.Net.Sockets;

namespace BellBeast.ApiAccess;

/// <summary>
/// Unhandled exceptions on /api answer with JSON instead of falling through to the /Error page
/// (which needs a login, so callers used to get a 302 to /Login?ReturnUrl=/Error):
///   upstream unreachable or timed out (Uroboros, LabVenture, …) → 502 { ok:false, error:"upstream_unavailable" }
///   anything else                                               → 500 { ok:false, error:"internal_error" }
/// Pages keep the normal exception handler. A request the client aborted is left alone.
/// </summary>
public sealed class ApiErrorMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ApiErrorMiddleware> _log;

    public ApiErrorMiddleware(RequestDelegate next, ILogger<ApiErrorMiddleware> log)
    {
        _next = next;
        _log = log;
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        if (!ctx.Request.Path.StartsWithSegments("/api"))
        {
            await _next(ctx);
            return;
        }

        try
        {
            await _next(ctx);
        }
        catch (Exception ex) when (!ctx.Response.HasStarted && !ctx.RequestAborted.IsCancellationRequested)
        {
            var upstream = IsUpstreamFailure(ex);
            if (upstream)
                _log.LogWarning("{Method} {Path}: upstream unavailable — {Message}", ctx.Request.Method, ctx.Request.Path, ex.InnerException?.Message ?? ex.Message);
            else
                _log.LogError(ex, "{Method} {Path}: unhandled exception", ctx.Request.Method, ctx.Request.Path);

            ctx.Response.Clear();
            ctx.Response.StatusCode = upstream ? StatusCodes.Status502BadGateway : StatusCodes.Status500InternalServerError;
            ctx.Response.Headers.CacheControl = "no-store";
            await ctx.Response.WriteAsJsonAsync(new { ok = false, error = upstream ? "upstream_unavailable" : "internal_error" });
        }
    }

    internal static bool IsUpstreamFailure(Exception ex) =>
        ex is HttpRequestException or TaskCanceledException or TimeoutException or SocketException;
}
