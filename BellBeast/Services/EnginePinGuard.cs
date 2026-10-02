using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace BellBeast.Services;

/// <summary>
/// PIN check for engine control actions exposed on the anonymous MHxView page
/// (e.g. "Start all loops"). The PIN hash lives in appsettings:
///   "EngineControl": { "PinPbkdf2": "pbkdf2$&lt;iterations&gt;$&lt;saltHex&gt;$&lt;hashHex&gt;" }   (PBKDF2-SHA256, 32-byte hash)
/// Wrong PINs are rate-limited per client IP: MaxFailures within Window -> locked for the rest of the window.
/// </summary>
public sealed class EnginePinGuard
{
    public const int MaxFailures = 5;
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

    public enum Result { Ok, BadPin, Locked, NotConfigured }

    private readonly IConfiguration _cfg;
    private readonly ConcurrentDictionary<string, (int Count, DateTimeOffset WindowStart)> _fails = new();

    public EnginePinGuard(IConfiguration cfg) => _cfg = cfg;

    public Result Check(string? clientKey, string? pin)
    {
        var stored = (_cfg["EngineControl:PinPbkdf2"] ?? "").Trim();
        if (stored.Length == 0) return Result.NotConfigured;

        var key = string.IsNullOrWhiteSpace(clientKey) ? "?" : clientKey;
        var now = DateTimeOffset.UtcNow;

        if (_fails.TryGetValue(key, out var f) && now - f.WindowStart < Window && f.Count >= MaxFailures)
            return Result.Locked;

        if (Verify(pin ?? "", stored))
        {
            _fails.TryRemove(key, out _);
            return Result.Ok;
        }

        _fails.AddOrUpdate(key,
            _ => (1, now),
            (_, old) => now - old.WindowStart >= Window ? (1, now) : (old.Count + 1, old.WindowStart));
        return Result.BadPin;
    }

    public static string Hash(string pin, int iterations = 100_000)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(pin), salt, iterations, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2${iterations}${Convert.ToHexString(salt).ToLowerInvariant()}${Convert.ToHexString(hash).ToLowerInvariant()}";
    }

    public static bool Verify(string pin, string stored)
    {
        var parts = stored.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2" || !int.TryParse(parts[1], out var iter) || iter <= 0)
            return false;

        try
        {
            var salt = Convert.FromHexString(parts[2]);
            var expected = Convert.FromHexString(parts[3]);
            var actual = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(pin), salt, iter, HashAlgorithmName.SHA256, expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
