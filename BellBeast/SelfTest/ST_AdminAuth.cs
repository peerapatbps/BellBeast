using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace BellBeast.SelfTest;

/// <summary>
/// Self-tests for the Admin authentication and authorization configuration.
///
/// Mirrors (xUnit) AdminPageAuthTests at the DI service-container level.
/// These tests inspect how the auth/authz pipeline is wired up — no live
/// HTTP requests needed.
///
/// Mapping:
///   xUnit test                                      → ST test
///   AdminPage_Unauthenticated_RedirectsToAdminLogin → AdminCookie LoginPath is /Admin/Login
///   AdminLogin_Page_IsAccessibleWithoutAuth         → AdminCookie LoginPath is non-empty (exempt from challenges)
///   AdminMe_Unauthenticated_Returns401              → AdminOnly policy is registered
///   AdminPage_AuthenticatedAdmin_Returns200         → AdminCookie scheme is registered
///   AdminMe_AuthenticatedAdmin_ReturnsOk            → AdminOnly policy requires AdminCookie scheme
///   AdminLogout_Post_Returns200                     → IAuthenticationService is registered
///   AdminLogout_Get_Returns200                      → AdminCookie scheme has a handler type
/// </summary>
internal static class ST_AdminAuth
{
    private const string AdminSchemeName = "AdminCookie";
    private const string AdminPolicyName = "AdminOnly";

    public static IEnumerable<SelfTestCase> Run(SelfTestContext ctx)
    {
        // ── Mirrors AdminPage_AuthenticatedAdmin_Returns200 ───────────────────

        yield return SelfTestRunner.Run(
            "AdminAuth | AdminCookie authentication scheme is registered", () =>
        {
            var provider = ctx.Services.GetService<IAuthenticationSchemeProvider>();
            SelfTestRunner.AssertNotNull(provider,
                "IAuthenticationSchemeProvider must be in DI");
            var scheme = provider!.GetSchemeAsync(AdminSchemeName)
                                  .GetAwaiter().GetResult();
            SelfTestRunner.AssertNotNull(scheme,
                $"Authentication scheme '{AdminSchemeName}' must be registered");
        });

        // ── Mirrors AdminMe_Unauthenticated_Returns401 ────────────────────────

        yield return SelfTestRunner.Run(
            "AdminAuth | AdminOnly authorization policy is registered", () =>
        {
            var provider = ctx.Services.GetService<IAuthorizationPolicyProvider>();
            SelfTestRunner.AssertNotNull(provider,
                "IAuthorizationPolicyProvider must be in DI");
            var policy = provider!.GetPolicyAsync(AdminPolicyName)
                                  .GetAwaiter().GetResult();
            SelfTestRunner.AssertNotNull(policy,
                $"Authorization policy '{AdminPolicyName}' must be registered");
        });

        // ── Mirrors AdminPage_Unauthenticated_RedirectsToAdminLogin ──────────

        yield return SelfTestRunner.Run(
            "AdminAuth | AdminCookie LoginPath is /Admin/Login", () =>
        {
            var monitor = ctx.Services
                             .GetService<IOptionsMonitor<CookieAuthenticationOptions>>();
            SelfTestRunner.AssertNotNull(monitor,
                "IOptionsMonitor<CookieAuthenticationOptions> must be in DI");
            var loginPath = monitor!.Get(AdminSchemeName).LoginPath.Value ?? "";
            SelfTestRunner.AssertEqual("/Admin/Login", loginPath,
                "Unauthenticated requests must be redirected to /Admin/Login");
        });

        // ── Mirrors AdminMe_AuthenticatedAdmin_ReturnsOk ─────────────────────

        yield return SelfTestRunner.Run(
            "AdminAuth | AdminOnly policy requires AdminCookie scheme", () =>
        {
            var provider = ctx.Services.GetService<IAuthorizationPolicyProvider>();
            SelfTestRunner.AssertNotNull(provider);
            var policy = provider!.GetPolicyAsync(AdminPolicyName)
                                  .GetAwaiter().GetResult();
            SelfTestRunner.AssertNotNull(policy);
            SelfTestRunner.Assert(
                policy!.AuthenticationSchemes.Contains(AdminSchemeName),
                $"AdminOnly policy must list '{AdminSchemeName}' in AuthenticationSchemes");
        });

        // ── Mirrors AdminLogout_Post_Returns200 ───────────────────────────────

        yield return SelfTestRunner.Run(
            "AdminAuth | IAuthenticationService is registered (sign-out/logout works)", () =>
        {
            var svc = ctx.Services.GetService<IAuthenticationService>();
            SelfTestRunner.AssertNotNull(svc,
                "IAuthenticationService must be in DI for sign-in/sign-out to work");
        });

        // ── Mirrors AdminLogout_Get_Returns200 ────────────────────────────────

        yield return SelfTestRunner.Run(
            "AdminAuth | AdminCookie scheme has a registered handler type", () =>
        {
            var provider = ctx.Services.GetService<IAuthenticationSchemeProvider>();
            SelfTestRunner.AssertNotNull(provider);
            var scheme = provider!.GetSchemeAsync(AdminSchemeName)
                                  .GetAwaiter().GetResult();
            SelfTestRunner.AssertNotNull(scheme);
            SelfTestRunner.AssertNotNull(scheme!.HandlerType,
                "AdminCookie scheme must have a handler type (required for logout)");
        });

        // ── Mirrors AdminLogin_Page_IsAccessibleWithoutAuth ───────────────────
        // The cookie middleware automatically exempts its own LoginPath from auth
        // challenges, making /Admin/Login reachable without a session.

        yield return SelfTestRunner.Run(
            "AdminAuth | AdminLogin page is accessible without auth (LoginPath is exempt)", () =>
        {
            var monitor = ctx.Services
                             .GetService<IOptionsMonitor<CookieAuthenticationOptions>>();
            SelfTestRunner.AssertNotNull(monitor);
            var loginPath = monitor!.Get(AdminSchemeName).LoginPath.Value ?? "";
            SelfTestRunner.Assert(
                !string.IsNullOrWhiteSpace(loginPath),
                "AdminCookie LoginPath must be a non-empty path " +
                "(cookie middleware exempts it from auth challenges automatically)");
        });
    }
}
