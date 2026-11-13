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

/// <summary>Report pages (public): daily report, chem report + export proxies.</summary>
/// <remarks>Access level comes from the group an endpoint is mapped on:
/// pub = anonymous, user = signed-in (fallback policy), admin = AdminOnly.</remarks>
public static class ReportEndpoints
{
    public static void MapReportEndpoints(this WebApplication app, ApiGroups api)
    {
        var (pub, user, admin) = (api.Public, api.User, api.Admin);

        // ===============================
        // PROXY: /api/dailyreport
        // ===============================
        pub.MapPost("/api/dailyreport", async (HttpContext ctx, IHttpClientFactory factory) =>
        {
            if (ctx.Request.Cookies.TryGetValue("bb_bypass_role", out var _bypass) && !string.IsNullOrEmpty(_bypass))
            {
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsync("{\"bypass\":true,\"rows\":[]}", ctx.RequestAborted);
                return;
            }
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var dailyReportPath = backendCfg.DailyReportPath;
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
        pub.MapPost("/api/chem_report", async (HttpContext ctx, IHttpClientFactory factory) =>
        {
            if (ctx.Request.Cookies.TryGetValue("bb_bypass_role", out var _bypass) && !string.IsNullOrEmpty(_bypass))
            {
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsync("{\"bypass\":true,\"total\":0,\"rows\":[]}", ctx.RequestAborted);
                return;
            }
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var chemReportPath = backendCfg.ChemReportPath;
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
        pub.MapPost("/api/chem_report/export", async (HttpContext ctx, IHttpClientFactory factory) =>
        {
            if (ctx.Request.Cookies.TryGetValue("bb_bypass_role", out var _bypass) && !string.IsNullOrEmpty(_bypass))
            {
                ctx.Response.StatusCode = 403;
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsync("{\"bypass\":true,\"error\":\"Export disabled in bypass mode\"}", ctx.RequestAborted);
                return;
            }
            var backendCfg = Backend(app);
            var baseUrl = backendCfg.BaseUrl;
            var chemExportPath = backendCfg.ChemExportPath;
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
    }
}
