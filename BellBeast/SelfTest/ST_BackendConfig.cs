using System.Text.Json;

namespace BellBeast.SelfTest;

/// <summary>
/// Self-tests for the App_Data/backend-config.json contract.
///
/// Mirrors (xUnit):
///   AdminApiTests.BackendConfig_Returns200WithBackendBaseUrl
///   AdminApiTests.BackendConfig_ContainsExpectedPaths
/// </summary>
internal static class ST_BackendConfig
{
    public static IEnumerable<SelfTestCase> Run(SelfTestContext ctx)
    {
        var path = Path.Combine(ctx.Env.ContentRootPath, "App_Data", "backend-config.json");

        // ── File-level check ──────────────────────────────────────────────────

        yield return SelfTestRunner.Run(
            "BackendConfig | file exists at App_Data/backend-config.json", () =>
            SelfTestRunner.Assert(File.Exists(path), $"Not found: {path}"));

        if (!File.Exists(path)) yield break;

        // ── Parse once; share the cloned root across subsequent tests ─────────

        JsonElement root = default;
        bool        parsed = false;

        yield return SelfTestRunner.Run("BackendConfig | JSON is well-formed", () =>
        {
            var text = File.ReadAllText(path);
            using var doc = JsonDocument.Parse(text, new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling     = JsonCommentHandling.Skip
            });
            root   = doc.RootElement.Clone(); // Clone() is independent of doc lifetime
            parsed = true;
        });

        if (!parsed) yield break;

        // ── Mirrors BackendConfig_Returns200WithBackendBaseUrl ────────────────

        yield return SelfTestRunner.Run(
            "BackendConfig | backendBaseUrl is present and non-empty", () =>
        {
            SelfTestRunner.Assert(
                root.TryGetProperty("backendBaseUrl", out var el),
                "Missing key 'backendBaseUrl'");
            var url = el.GetString() ?? "";
            SelfTestRunner.Assert(
                !string.IsNullOrWhiteSpace(url),
                "backendBaseUrl must not be empty");
        });

        yield return SelfTestRunner.Run(
            "BackendConfig | backendBaseUrl is a valid absolute URI", () =>
        {
            root.TryGetProperty("backendBaseUrl", out var el);
            var url = (el.GetString() ?? "").Trim();
            SelfTestRunner.Assert(
                Uri.TryCreate(url, UriKind.Absolute, out _),
                $"Not a valid absolute URI: '{url}'");
        });

        // ── Mirrors BackendConfig_ContainsExpectedPaths ───────────────────────

        foreach (var key in new[] { "backendBaseUrl", "queryCsvPath", "wayfarerApiPath" })
        {
            var k = key; // capture loop variable
            yield return SelfTestRunner.Run(
                $"BackendConfig | key '{k}' is present", () =>
                SelfTestRunner.Assert(
                    root.TryGetProperty(k, out _),
                    $"Missing required key '{k}'"));
        }
    }
}
