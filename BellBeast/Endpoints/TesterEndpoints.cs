using System.Net;

namespace BellBeast.Endpoints;

/// <summary>
/// /tester/* → BellBeast Tester (Next.js, BellBeast_Tester\start.bat) on Tester:BaseUrl (default http://127.0.0.1:8890),
/// shown inside the admin tab /Admin/Tester. Admin only: the tester listens on 127.0.0.1 and can fire
/// test requests and append results to files, so this proxy is the only way in from the network.
/// The admin cookie is never forwarded — the tester sends its test requests without any login.
/// </summary>
public static class TesterEndpoints
{
    public const string ClientName = "tester";
    public const string DefaultBaseUrl = "http://127.0.0.1:8890";

    private static readonly HashSet<string> SkipRequestHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Host", "Cookie", "Authorization", "X-Api-Key", "Connection", "Keep-Alive",
        "Content-Length", "Content-Type", "Transfer-Encoding", "Upgrade",
    };

    private static readonly HashSet<string> SkipResponseHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Transfer-Encoding", "Content-Length", "Connection", "Keep-Alive", "Set-Cookie", "X-Powered-By",
    };

    public static void MapTesterEndpoints(this WebApplication app, ApiGroups api)
    {
        var baseUrl = (app.Configuration["Tester:BaseUrl"] ?? DefaultBaseUrl).TrimEnd('/');
        string[] methods = ["GET", "HEAD", "POST"];

        api.Admin.MapMethods("/tester", methods, (HttpContext ctx, IHttpClientFactory f) => ForwardAsync(ctx, f, baseUrl, ""));
        api.Admin.MapMethods("/tester/{**path}", methods, (HttpContext ctx, IHttpClientFactory f, string? path) => ForwardAsync(ctx, f, baseUrl, path ?? ""));
    }

    private static async Task ForwardAsync(HttpContext ctx, IHttpClientFactory factory, string baseUrl, string path)
    {
        // Next.js serves everything under its basePath /tester, so the path is forwarded unchanged.
        var target = $"{baseUrl}/tester{(path.Length > 0 ? "/" + path : "")}{ctx.Request.QueryString}";
        using var req = new HttpRequestMessage(new HttpMethod(ctx.Request.Method), target);

        foreach (var h in ctx.Request.Headers)
            if (!SkipRequestHeaders.Contains(h.Key))
                req.Headers.TryAddWithoutValidation(h.Key, h.Value.ToArray());

        if (ctx.Request.ContentLength > 0 || ctx.Request.Headers.ContainsKey("Transfer-Encoding"))
        {
            req.Content = new StreamContent(ctx.Request.Body);
            if (!string.IsNullOrWhiteSpace(ctx.Request.ContentType))
                req.Content.Headers.TryAddWithoutValidation("Content-Type", ctx.Request.ContentType);
        }

        var client = factory.CreateClient(ClientName);
        client.Timeout = TimeSpan.FromSeconds(120); // a test run can wait on a slow upstream

        HttpResponseMessage resp;
        try
        {
            resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ctx.RequestAborted);
        }
        catch (Exception ex) when ((ex is HttpRequestException or TaskCanceledException) && !ctx.RequestAborted.IsCancellationRequested)
        {
            ctx.Response.StatusCode = StatusCodes.Status502BadGateway;
            ctx.Response.ContentType = "text/html; charset=utf-8";
            ctx.Response.Headers.CacheControl = "no-store";
            await ctx.Response.WriteAsync(NotRunningHtml, ctx.RequestAborted);
            return;
        }

        using (resp)
        {
            ctx.Response.StatusCode = (int)resp.StatusCode;
            foreach (var h in resp.Headers.Concat(resp.Content.Headers))
            {
                if (SkipResponseHeaders.Contains(h.Key)) continue;
                if (h.Key.Equals("Location", StringComparison.OrdinalIgnoreCase))
                {
                    ctx.Response.Headers.Location = RewriteLocation(h.Value.FirstOrDefault() ?? "", baseUrl);
                    continue;
                }
                ctx.Response.Headers.Append(h.Key, h.Value.ToArray());
            }
            ctx.Response.Headers["X-Frame-Options"] = "SAMEORIGIN";

            if (HttpMethods.IsHead(ctx.Request.Method)) return;
            await using var body = await resp.Content.ReadAsStreamAsync(ctx.RequestAborted);
            await body.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
        }
    }

    /// <summary>Next.js may answer with an absolute http://127.0.0.1:8890/... Location; keep the browser on BellBeast.</summary>
    internal static string RewriteLocation(string location, string baseUrl)
    {
        if (!location.StartsWith(baseUrl, StringComparison.OrdinalIgnoreCase)) return location;
        var rest = location[baseUrl.Length..];
        return rest.Length > 0 ? rest : "/";
    }

    private const string NotRunningHtml = """
        <!doctype html><html lang="th"><head><meta charset="utf-8"><title>BellBeast Tester</title>
        <style>body{margin:0;font:15px/1.6 system-ui,sans-serif;background:#0d1117;color:#dbe4f0;display:grid;place-items:center;min-height:100vh}
        div{max-width:520px;padding:24px 28px;border:1px solid #33415a;border-radius:12px;background:#141a22}
        h1{margin:0 0 8px;font-size:18px;color:#ffb547}code{background:#0d1117;padding:2px 6px;border-radius:4px}</style></head>
        <body><div><h1>BellBeast Tester ไม่ได้รันอยู่ (502)</h1>
        <p>ดับเบิลคลิก <code>BellBeast_Tester\start.bat</code> บนเครื่อง server แล้วกด refresh หน้านี้</p>
        <p>ดูสาเหตุได้ที่ <code>BellBeast_Tester\logs\launcher.log</code></p></div></body></html>
        """;
}
