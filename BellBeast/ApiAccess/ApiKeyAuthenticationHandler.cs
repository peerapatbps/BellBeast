using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace BellBeast.ApiAccess;

/// <summary>
/// "ApiKey" scheme: <c>X-Api-Key: bbk_…</c> or <c>Authorization: Bearer bbk_…</c>.
/// No key → NoResult (cookie auth carries on); a bad key fails the request's authentication.
/// </summary>
public sealed class ApiKeyAuthenticationHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public const string SchemeName = "ApiKey";
    public const string HeaderName = "X-Api-Key";
    public const string ClaimClientId = "api_client";
    public const string ClaimGrant = "api_grant";
    public const string ClaimRate = "api_rate";

    private readonly ApiClientService _clients;

    public ApiKeyAuthenticationHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger,
        UrlEncoder encoder, ApiClientService clients) : base(options, logger, encoder) => _clients = clients;

    /// <summary>The API key on the request, if any.</summary>
    public static string? KeyFrom(HttpRequest req)
    {
        var h = req.Headers[HeaderName].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(h)) return h.Trim();
        var auth = req.Headers.Authorization.FirstOrDefault();
        if (auth is not null && auth.StartsWith("Bearer " + ApiClientService.KeyPrefix, StringComparison.Ordinal))
            return auth["Bearer ".Length..].Trim();
        return null;
    }

    public static bool HasKey(HttpContext ctx) => KeyFrom(ctx.Request) is not null;

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var key = KeyFrom(Request);
        if (key is null) return Task.FromResult(AuthenticateResult.NoResult());

        var (status, c) = _clients.Authenticate(key);
        if (status != ApiClientService.AuthStatus.Ok || c is null)
            return Task.FromResult(AuthenticateResult.Fail("api_key_" + status.ToString().ToLowerInvariant()));

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, c.Id),
            new(ClaimTypes.Name, c.Name),
            new(ClaimClientId, c.Id),
            new(ClaimRate, c.RatePerMinute.ToString()),
        };
        claims.AddRange(c.Grants.Select(g => new Claim(ClaimGrant, g)));

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName)));
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        if (Response.HasStarted) return;
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        var failure = (await HandleAuthenticateOnceSafeAsync()).Failure?.Message;
        if (failure is not null)
            await Response.WriteAsJsonAsync(new { ok = false, error = failure });
    }
}

public static class ApiClientPrincipal
{
    public static string? ClientId(this ClaimsPrincipal user) =>
        user.Identity?.AuthenticationType == ApiKeyAuthenticationHandler.SchemeName
            ? user.FindFirst(ApiKeyAuthenticationHandler.ClaimClientId)?.Value : null;
}
