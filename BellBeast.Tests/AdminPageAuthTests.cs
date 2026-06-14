using System.Net;
using Xunit;

/// <summary>
/// Regression tests for the AdminPage access-control layer.
/// Tests use <see cref="BellBeastBaseFactory"/> (no auto-auth) to verify that
/// unauthenticated users are redirected to the login page, and
/// <see cref="BellBeastAdminFactory"/> (auto-auth as admin) to verify that
/// authenticated admins can reach the page.
/// </summary>
public sealed class AdminPageAuthTests : IClassFixture<BellBeastBaseFactory>
{
    private readonly BellBeastBaseFactory _factory;

    public AdminPageAuthTests(BellBeastBaseFactory factory) => _factory = factory;

    // ── Unauthenticated access ────────────────────────────────────────────

    [Fact]
    public async Task AdminPage_Unauthenticated_RedirectsToAdminLogin()
    {
        // AllowAutoRedirect=false so we can inspect the 302 directly
        var client = _factory.CreateClient(new()
        {
            AllowAutoRedirect = false
        });

        var response = await client.GetAsync("/Admin/AdminPage");

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);

        var location = response.Headers.Location?.ToString() ?? "";
        Assert.Contains("/Admin/Login", location, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AdminLogin_Page_IsAccessibleWithoutAuth()
    {
        var client = _factory.CreateClient(new()
        {
            AllowAutoRedirect = false
        });

        var response = await client.GetAsync("/Admin/Login");

        // Login page must be reachable (200 or redirect to itself is OK;
        // 401/403 would be wrong)
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.NotEqual(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task AdminMe_Unauthenticated_Returns401()
    {
        // /api/admin/auth/me is decorated with [Authorize(Policy="AdminOnly")]
        var client = _factory.CreateClient(new()
        {
            AllowAutoRedirect = false
        });

        var response = await client.GetAsync("/api/admin/auth/me");

        // API path → cookie middleware returns 401 (not a redirect)
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ── Authenticated admin access ────────────────────────────────────────

    [Fact]
    public async Task AdminPage_AuthenticatedAdmin_Returns200()
    {
        await using var factory = new BellBeastAdminFactory();
        var client = factory.CreateClient();

        var response = await client.GetAsync("/Admin/AdminPage");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task AdminMe_AuthenticatedAdmin_ReturnsOk()
    {
        await using var factory = new BellBeastAdminFactory();
        var client = factory.CreateClient();

        var response = await client.GetAsync("/api/admin/auth/me");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("\"ok\"", body, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("admin", body, StringComparison.OrdinalIgnoreCase);
    }

    // ── Logout ────────────────────────────────────────────────────────────

    [Fact]
    public async Task AdminLogout_Post_Returns200()
    {
        // logout clears the cookie and returns {ok:true} — no auth needed
        var client = _factory.CreateClient();

        var response = await client.PostAsync("/api/admin/auth/logout", null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task AdminLogout_Get_Returns200()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/admin/auth/logout");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
