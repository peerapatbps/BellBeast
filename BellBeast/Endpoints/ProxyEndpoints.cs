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

/// <summary>Wayfarer map + /api/wayfarer/* proxy and /labventure/* reverse proxy.</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class ProxyEndpoints
{
    public static void MapProxyEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);

        static IReadOnlyList<string> ReadStatusGroups(IQueryCollection query)
        {
            var values = query["statusGroup"]
                .SelectMany(x => x.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            return values.Count == 0 ? new[] { "all" } : values;
        }

        pub.MapGet("/api/wayfarer/map-summary", async (HttpContext ctx, WayfarerMapQueryService svc, CancellationToken ct) =>
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

        pub.MapGet("/api/wayfarer/map-branch-workorders", async (HttpContext ctx, WayfarerMapQueryService svc, CancellationToken ct) =>
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

        pub.MapMethods("/api/wayfarer/{**path}", new[] { "GET", "POST" }, async (HttpContext ctx, IHttpClientFactory factory, string? path) =>
        {
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var wayfarerApiPath = backendCfg.WayfarerApiPath;
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
        // Proxy: /labventure/* → http://localhost:8889/labventure/*
        // ===============================
        pub.MapGet("/labventure", ctx => { ctx.Response.Redirect("/labventure/"); return Task.CompletedTask; });

        pub.MapMethods("/labventure/{**path}", new[] { "GET", "POST", "PUT", "DELETE", "PATCH" },
            async (HttpContext ctx, IHttpClientFactory factory, string? path) =>
        {
            // API calls (/labventure/api/...) → forward to LabVenture as /api/...
            // SPA/static (/labventure/assets/..., /labventure/login, etc.) → forward as /labventure/...
            var trimmed = path?.TrimStart('/') ?? "";
            var targetPath = string.IsNullOrWhiteSpace(trimmed)
                ? "/labventure/"
                : trimmed.StartsWith("api/", StringComparison.OrdinalIgnoreCase) || trimmed.Equals("api", StringComparison.OrdinalIgnoreCase)
                    ? $"/{trimmed}"
                    : $"/labventure/{trimmed}";
            var targetUrl = $"http://localhost:8889{targetPath}{ctx.Request.QueryString}";

            var client = factory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(300);

            using var req = new HttpRequestMessage(new HttpMethod(ctx.Request.Method), targetUrl);

            // Forward request headers (Cookie, Authorization, Accept, etc.)
            var skipReqHeaders = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                { "Host", "Content-Length", "Transfer-Encoding", "Content-Type" };
            foreach (var h in ctx.Request.Headers)
            {
                if (!skipReqHeaders.Contains(h.Key))
                    req.Headers.TryAddWithoutValidation(h.Key, h.Value.ToArray());
            }

            if (ctx.Request.ContentLength > 0 || ctx.Request.Headers.ContainsKey("Transfer-Encoding"))
            {
                req.Content = new StreamContent(ctx.Request.Body);
                if (!string.IsNullOrWhiteSpace(ctx.Request.ContentType))
                    req.Content.Headers.TryAddWithoutValidation("Content-Type", ctx.Request.ContentType);
            }

            try
            {
                using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ctx.RequestAborted);
                ctx.Response.StatusCode = (int)resp.StatusCode;

                // Forward response headers (Set-Cookie, Content-Type, etc.)
                var skipRespHeaders = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                    { "Transfer-Encoding", "Content-Length" };
                foreach (var h in resp.Headers)
                {
                    if (!skipRespHeaders.Contains(h.Key))
                        foreach (var v in h.Value)
                            ctx.Response.Headers.Append(h.Key, v);
                }
                foreach (var h in resp.Content.Headers)
                {
                    if (!skipRespHeaders.Contains(h.Key))
                        foreach (var v in h.Value)
                            ctx.Response.Headers.Append(h.Key, v);
                }

                await using var stream = await resp.Content.ReadAsStreamAsync(ctx.RequestAborted);
                await stream.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
                await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
            }
            catch (HttpRequestException)
            {
                ctx.Response.StatusCode = 502;
                ctx.Response.ContentType = "text/plain";
                await ctx.Response.WriteAsync("LabVenture is not running (502 Bad Gateway)");
            }
        });
    }
}
