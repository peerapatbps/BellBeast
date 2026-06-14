using System.Diagnostics;
using Microsoft.AspNetCore.Hosting;

namespace BellBeast.SelfTest;

// ── Result types ──────────────────────────────────────────────────────────────

public sealed record SelfTestCase(
    string  Name,
    bool    Passed,
    string? Error,
    long    DurationMs);

public sealed record SelfTestReport(
    bool               Ok,
    int                Total,
    int                Passed,
    int                Failed,
    long               DurationMs,
    DateTimeOffset     ServerTsUtc,
    List<SelfTestCase> Cases);

/// <summary>Runtime context forwarded from the live application into test suites
/// that need access to the host environment or the DI service container.</summary>
public sealed record SelfTestContext(
    IWebHostEnvironment Env,
    IServiceProvider    Services);

// ── Runner ────────────────────────────────────────────────────────────────────

internal static class SelfTestRunner
{
    /// <param name="ctx">
    /// When supplied, suites that require live host context (BackendConfig,
    /// AdminApiEndpoints, AdminAuth) are included.  Pass <c>null</c> to run
    /// only the pure-unit suites (EngineAdminService + SummaryProxy) — the
    /// behaviour before this change.
    /// </param>
    public static SelfTestReport RunAll(SelfTestContext? ctx = null)
    {
        var sw    = Stopwatch.StartNew();
        var cases = new List<SelfTestCase>();

        cases.AddRange(ST_EngineAdminService.Run());
        cases.AddRange(ST_SummaryProxy.Run());

        if (ctx is not null)
        {
            cases.AddRange(ST_BackendConfig.Run(ctx));
            cases.AddRange(ST_AdminApiEndpoints.Run(ctx));
            cases.AddRange(ST_AdminAuth.Run(ctx));
        }

        sw.Stop();
        int passed = cases.Count(c => c.Passed);
        int failed = cases.Count - passed;

        return new SelfTestReport(
            Ok:          failed == 0,
            Total:       cases.Count,
            Passed:      passed,
            Failed:      failed,
            DurationMs:  sw.ElapsedMilliseconds,
            ServerTsUtc: DateTimeOffset.UtcNow,
            Cases:       cases);
    }

    // ── Assertion helpers ─────────────────────────────────────────────────────

    internal static SelfTestCase Run(string name, Action body)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            body();
            return new SelfTestCase(name, true, null, sw.ElapsedMilliseconds);
        }
        catch (Exception ex)
        {
            return new SelfTestCase(name, false, ex.Message, sw.ElapsedMilliseconds);
        }
    }

    internal static void Assert(bool condition, string? message = null)
    {
        if (!condition)
            throw new Exception(message ?? "Assertion failed");
    }

    internal static void AssertEqual<T>(T expected, T actual, string? context = null)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new Exception(
                $"{(context is null ? "" : context + ": ")}Expected [{expected}] but got [{actual}]");
    }

    internal static void AssertNotNull(object? obj, string? context = null)
    {
        if (obj is null)
            throw new Exception(
                $"{(context is null ? "" : context + ": ")}Expected non-null value");
    }

    internal static void AssertNull(object? obj, string? context = null)
    {
        if (obj is not null)
            throw new Exception(
                $"{(context is null ? "" : context + ": ")}Expected null but got [{obj}]");
    }
}
