using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

// ── Fake HTTP message handler ───────────────────────────────────────────────

/// <summary>Intercepts all outbound HTTP calls that EngineAdminService would make
/// to http://localhost:8888 and returns pre-configured responses.</summary>
public sealed class FakeEngineHandler : HttpMessageHandler
{
    /// <summary>Optional per-request handler. When set, it is called for every request
    /// and its return value is used as the response.</summary>
    public Func<HttpRequestMessage, HttpResponseMessage>? RequestHandler { get; set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        if (RequestHandler != null)
            return Task.FromResult(RequestHandler(request));

        // Default: always return a fresh 200 OK with an empty JSON object
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json")
        });
    }
}

/// <summary>IHttpClientFactory implementation that always returns a client backed by
/// the provided <see cref="FakeEngineHandler"/>.</summary>
public sealed class FakeHttpClientFactory : IHttpClientFactory
{
    private readonly FakeEngineHandler _handler;

    public FakeHttpClientFactory(FakeEngineHandler handler) => _handler = handler;

    public HttpClient CreateClient(string name) => new(_handler) { Timeout = TimeSpan.FromSeconds(5) };
}

// ── Test auth handler (injects admin identity without password) ─────────────

public sealed class TestAdminAuthHandlerOptions : AuthenticationSchemeOptions { }

/// <summary>Fake authentication handler that always authenticates the request as an admin.
/// Register it under the AdminCookie scheme name to bypass real cookie validation in tests.</summary>
public sealed class TestAdminAuthHandler
    : AuthenticationHandler<TestAdminAuthHandlerOptions>
{
    public TestAdminAuthHandler(
        IOptionsMonitor<TestAdminAuthHandlerOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder)
        : base(options, logger, encoder) { }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var claims = new[]
        {
            new Claim(ClaimTypes.Name, "test-admin"),
            new Claim("role", "admin")
        };
        var identity = new ClaimsIdentity(claims, Scheme.Name);
        var principal = new ClaimsPrincipal(identity);
        var ticket = new AuthenticationTicket(principal, Scheme.Name);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

// ── Web factories ───────────────────────────────────────────────────────────

/// <summary>Base factory: provides a fake IHttpClientFactory (no real network calls),
/// and writes a minimal App_Data/backend-config.json into a temp content root so the
/// /api/backend-config endpoint works.</summary>
public class BellBeastBaseFactory : WebApplicationFactory<Program>
{
    private string? _tempRoot;

    public FakeEngineHandler EngineHandler { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Create a temporary content root with the required App_Data directory
        _tempRoot = Path.Combine(Path.GetTempPath(), "bb_test_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(_tempRoot, "App_Data"));
        File.WriteAllText(
            Path.Combine(_tempRoot, "App_Data", "backend-config.json"),
            """{"backendBaseUrl":"http://localhost:8888","queryCsvPath":"/api/process","wayfarerApiPath":"/api/wayfarer"}""");

        // Point wwwroot to a dummy folder so static-files middleware doesn't error
        var wwwroot = Path.Combine(_tempRoot, "wwwroot");
        Directory.CreateDirectory(wwwroot);

        builder.UseContentRoot(_tempRoot);
        builder.UseWebRoot(wwwroot);

        builder.ConfigureTestServices(services =>
        {
            // Replace the real IHttpClientFactory so no actual TCP connections are made
            services.RemoveAll<IHttpClientFactory>();
            services.AddSingleton<IHttpClientFactory>(new FakeHttpClientFactory(EngineHandler));
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && _tempRoot is not null)
        {
            try { Directory.Delete(_tempRoot, recursive: true); } catch { }
        }
    }
}

/// <summary>Factory that also replaces the AdminCookie authentication scheme with
/// <see cref="TestAdminAuthHandler"/>, so every request is automatically authenticated
/// as admin. Use this for tests that exercise protected endpoints.</summary>
public sealed class BellBeastAdminFactory : BellBeastBaseFactory
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);

        builder.ConfigureTestServices(services =>
        {
            // "AdminCookie" is already registered by Program.cs — we must NOT call
            // AddScheme() again (it throws "Scheme already exists").
            // Instead, swap the handler type on the existing scheme builder and
            // register the replacement handler in DI.
            services.PostConfigureAll<AuthenticationOptions>(o =>
            {
                foreach (var scheme in o.Schemes.Where(s => s.Name == "AdminCookie"))
                    scheme.HandlerType = typeof(TestAdminAuthHandler);
            });

            // Provide the options that TestAdminAuthHandler (AuthenticationHandler<TOptions>) needs
            services.Configure<TestAdminAuthHandlerOptions>("AdminCookie", _ => { });

            // Register the handler itself so DI can construct it
            services.AddTransient<TestAdminAuthHandler>();
        });
    }
}
