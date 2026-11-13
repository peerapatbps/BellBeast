using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BellBeast.ApiAccess;

/// <summary>
/// Registry of API clients (other systems that call BellBeast with an API key).
/// Persisted in App_Data/api-clients.json; only the SHA-256 of each key is stored,
/// the plain key is shown once when created or rotated.
/// </summary>
public sealed class ApiClientService
{
    public const string KeyPrefix = "bbk_";
    public const int DefaultRatePerMinute = 120;
    public const int MaxRatePerMinute = 6000;

    public enum AuthStatus { Ok, Unknown, Disabled, Expired }

    public sealed class ApiClient
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string KeyHint { get; set; } = "";          // "bbk_ab12cd…" — enough to recognise a key, useless to use it
        public string KeySha256 { get; set; } = "";
        public bool Enabled { get; set; } = true;
        public DateTimeOffset CreatedAt { get; set; }
        public DateTimeOffset? ExpiresAt { get; set; }
        public DateTimeOffset? LastUsedAt { get; set; }
        public DateTimeOffset? KeyRotatedAt { get; set; }
        public List<string> Grants { get; set; } = new();  // catalog ids of non-public APIs this client may call
        public int RatePerMinute { get; set; } = DefaultRatePerMinute;
        public string? Note { get; set; }
    }

    /// <summary>What the admin UI gets — never the key hash.</summary>
    public sealed record ApiClientView(string Id, string Name, string KeyHint, bool Enabled, DateTimeOffset CreatedAt,
        DateTimeOffset? ExpiresAt, DateTimeOffset? LastUsedAt, DateTimeOffset? KeyRotatedAt,
        IReadOnlyList<string> Grants, int RatePerMinute, string? Note);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly TimeSpan TouchPersistEvery = TimeSpan.FromMinutes(5);

    private readonly string _path;
    private readonly ILogger<ApiClientService> _log;
    private readonly object _lock = new();
    private List<ApiClient> _clients;
    private DateTimeOffset _lastTouchSave = DateTimeOffset.MinValue;

    public ApiClientService(IWebHostEnvironment env, ILogger<ApiClientService> log)
    {
        _log = log;
        _path = Path.Combine(env.ContentRootPath, "App_Data", "api-clients.json");
        _clients = Load();
    }

    // ── auth ─────────────────────────────────────────────────────────────────

    public (AuthStatus Status, ApiClient? Client) Authenticate(string key)
    {
        var sha = Sha(key);
        lock (_lock)
        {
            var c = _clients.FirstOrDefault(x => CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(x.KeySha256), Encoding.ASCII.GetBytes(sha)));
            if (c is null) return (AuthStatus.Unknown, null);
            if (!c.Enabled) return (AuthStatus.Disabled, null);
            if (c.ExpiresAt is { } exp && exp <= DateTimeOffset.UtcNow) return (AuthStatus.Expired, null);

            var now = DateTimeOffset.UtcNow;
            c.LastUsedAt = now;
            if (now - _lastTouchSave > TouchPersistEvery) { _lastTouchSave = now; TrySave(); }
            return (AuthStatus.Ok, Clone(c));
        }
    }

    // ── admin ────────────────────────────────────────────────────────────────

    public IReadOnlyList<ApiClientView> List()
    {
        lock (_lock) return _clients.OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase).Select(View).ToList();
    }

    /// <summary>Creates a client; returns (view, plain key) or an error code.</summary>
    public (ApiClientView? Client, string? Key, string? Error) Create(JsonElement body, Func<string, bool> isGrantable, string? actor)
    {
        var c = new ApiClient { Id = "c_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant(), CreatedAt = DateTimeOffset.UtcNow };
        if (Apply(c, body, isGrantable, requireName: true) is { } err) return (null, null, err);

        var key = NewKey();
        c.KeySha256 = Sha(key);
        c.KeyHint = Hint(key);
        lock (_lock)
        {
            _clients.Add(c);
            Save();
        }
        _log.LogInformation("API client created: {Id} ({Name}) by {Actor}", c.Id, c.Name, actor);
        return (View(c), key, null);
    }

    public string? Update(string id, JsonElement patch, Func<string, bool> isGrantable, string? actor)
    {
        lock (_lock)
        {
            var c = _clients.FirstOrDefault(x => x.Id == id);
            if (c is null) return "unknown_client";
            var copy = Clone(c);
            if (Apply(copy, patch, isGrantable, requireName: false) is { } err) return err;
            _clients[_clients.IndexOf(c)] = copy;
            Save();
        }
        _log.LogInformation("API client updated: {Id} by {Actor}", id, actor);
        return null;
    }

    public (string? Key, string? Error) Rotate(string id, string? actor)
    {
        var key = NewKey();
        lock (_lock)
        {
            var c = _clients.FirstOrDefault(x => x.Id == id);
            if (c is null) return (null, "unknown_client");
            c.KeySha256 = Sha(key);
            c.KeyHint = Hint(key);
            c.KeyRotatedAt = DateTimeOffset.UtcNow;
            Save();
        }
        _log.LogInformation("API client key rotated: {Id} by {Actor}", id, actor);
        return (key, null);
    }

    public bool Delete(string id, string? actor)
    {
        lock (_lock)
        {
            if (_clients.RemoveAll(x => x.Id == id) == 0) return false;
            Save();
        }
        _log.LogInformation("API client deleted: {Id} by {Actor}", id, actor);
        return true;
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private static string? Apply(ApiClient c, JsonElement b, Func<string, bool> isGrantable, bool requireName)
    {
        if (b.ValueKind != JsonValueKind.Object) return "bad_json";

        if (b.TryGetProperty("name", out var n))
        {
            var name = n.ValueKind == JsonValueKind.String ? n.GetString()!.Trim() : "";
            if (name.Length is 0 or > 60) return "bad_name";
            c.Name = name;
        }
        else if (requireName) return "bad_name";

        if (b.TryGetProperty("enabled", out var en))
        {
            if (en.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return "bad_enabled";
            c.Enabled = en.GetBoolean();
        }

        if (b.TryGetProperty("rate_per_minute", out var r))
        {
            if (!r.TryGetInt32(out var rate) || rate < 1 || rate > MaxRatePerMinute) return "bad_rate";
            c.RatePerMinute = rate;
        }

        if (b.TryGetProperty("expires_at", out var ex))
        {
            if (ex.ValueKind == JsonValueKind.Null || (ex.ValueKind == JsonValueKind.String && ex.GetString() == "")) c.ExpiresAt = null;
            else if (ex.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(ex.GetString(), out var t)) c.ExpiresAt = t;
            else return "bad_expires_at";
        }

        if (b.TryGetProperty("note", out var no))
        {
            var note = no.ValueKind == JsonValueKind.String ? no.GetString()!.Trim() : "";
            if (note.Length > 200) return "note_too_long";
            c.Note = note.Length == 0 ? null : note;
        }

        if (b.TryGetProperty("grants", out var g))
        {
            if (StringList(g) is not { } grants) return "bad_grants";
            if (grants.FirstOrDefault(x => !isGrantable(x)) is { } bad) return "not_grantable:" + bad;
            c.Grants = grants;
        }

        return null;
    }

    private static List<string>? StringList(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Array) return null;
        var list = new List<string>();
        foreach (var x in e.EnumerateArray())
        {
            if (x.ValueKind != JsonValueKind.String) return null;
            var v = x.GetString()!.Trim();
            if (v.Length > 0 && !list.Contains(v)) list.Add(v);
        }
        return list;
    }

    private static string NewKey() =>
        KeyPrefix + Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    private static string Hint(string key) => key[..(KeyPrefix.Length + 6)] + "…";

    public static string Sha(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();

    private static ApiClient Clone(ApiClient c) => new()
    {
        Id = c.Id, Name = c.Name, KeyHint = c.KeyHint, KeySha256 = c.KeySha256, Enabled = c.Enabled,
        CreatedAt = c.CreatedAt, ExpiresAt = c.ExpiresAt, LastUsedAt = c.LastUsedAt, KeyRotatedAt = c.KeyRotatedAt,
        Grants = new(c.Grants), RatePerMinute = c.RatePerMinute, Note = c.Note,
    };

    private static ApiClientView View(ApiClient c) => new(c.Id, c.Name, c.KeyHint, c.Enabled, c.CreatedAt, c.ExpiresAt,
        c.LastUsedAt, c.KeyRotatedAt, c.Grants.ToList(), c.RatePerMinute, c.Note);

    private List<ApiClient> Load()
    {
        try
        {
            if (File.Exists(_path) && JsonSerializer.Deserialize<List<ApiClient>>(File.ReadAllText(_path), JsonOpts) is { } list)
                return list;
        }
        catch (JsonException ex) { _log.LogError(ex, "api-clients.json is invalid — no API clients loaded"); }
        return new List<ApiClient>();
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_clients, JsonOpts));
        File.Move(tmp, _path, overwrite: true);
    }

    private void TrySave()
    {
        try { Save(); }
        catch (IOException ex) { _log.LogWarning(ex, "could not persist API client last-used times"); }
    }
}
