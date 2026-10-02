using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace BellBeast.Services;

/// <summary>
/// MHxView ⚙️ → Config tab: edits the deploy config files of BellBeast / Uroboros / Wayfarer
/// in the Fullscale root (the folder holding BellBeast_proj, Uroboros_proj, Wayfarer_proj).
///
/// Root: appsettings "ConfigEditor:FullscaleRoot" if set, otherwise found by walking up from ContentRootPath.
/// Only the files in <see cref="Registry"/> can be read or written (no client-supplied paths).
/// Every save: stale check (sha256) → validate → backup to _backup\config\&lt;project&gt;\ → atomic write
/// keeping the file's BOM and line endings. Uroboros/Wayfarer rewrite config.ini / appsettings at runtime,
/// so the stale check is what stops a save from clobbering a token/password they just wrote.
///
/// <see cref="Links"/> is the "auto search": it pulls every path/URL value out of the 5 files, resolves
/// relative paths the way each app does (against its own *_proj folder), and flags missing targets and
/// files that point at different copies of the same file (e.g. wayfarer.db), with a suggested fix.
/// </summary>
public sealed class ConfigEditorService
{
    public sealed record ConfigFile(
        string Id, string Project, string RelPath, string Format, string BaseDir, string Restart, bool RuntimeWrites);

    // BaseDir = folder each app resolves its relative paths against
    // (BellBeast: ContentRoot, Uroboros: AppContext.BaseDirectory, Wayfarer.Worker: AppContext.BaseDirectory).
    public static readonly IReadOnlyList<ConfigFile> Registry =
    [
        new("bb-backend",      "BellBeast", @"BellBeast_proj\App_Data\backend-config.json", "json", "BellBeast_proj", "live", false),
        new("bb-appsettings",  "BellBeast", @"BellBeast_proj\appsettings.json",             "json", "BellBeast_proj", "restart BellBeast", false),
        new("uro-config",      "Uroboros",  @"Uroboros_proj\config_\config.ini",            "ini",  "Uroboros_proj",  "live", true),
        new("uro-appsettings", "Uroboros",  @"Uroboros_proj\appsettings.json",              "json", "Uroboros_proj",  "next Wayfarer run", false),
        new("wf-appsettings",  "Wayfarer",  @"Wayfarer_proj\appsettings.json",              "json", "Wayfarer_proj",  "next Wayfarer run", true),
    ];

    public const int KeepBackups = 20;
    private const int SearchDepth = 4;
    private static readonly string[] ProjectDirs = ["BellBeast_proj", "Uroboros_proj", "Wayfarer_proj"];
    private static readonly HashSet<string> SearchSkip = new(StringComparer.OrdinalIgnoreCase)
        { "_backup", ".playwright", "node_modules", "logs", ".git", "runtimes", "wwwroot" };
    private static readonly Regex BackupName = new(@"^[\w.\-]+\.\d{8}_\d{6}_\d{3}\.bak$", RegexOptions.Compiled);
    private static readonly JsonSerializerOptions JsonValueOut = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    // legacy keys still present in the files but no longer used — left out of the Links scan ("fileId|key")
    private static readonly HashSet<string> IgnoredLinks = new(StringComparer.OrdinalIgnoreCase)
    {
        "uro-config|Production:mdb_file_location",
    };

    private readonly IConfiguration _cfg;
    private readonly IWebHostEnvironment _env;
    private readonly object _writeLock = new();

    public ConfigEditorService(IConfiguration cfg, IWebHostEnvironment env)
    {
        _cfg = cfg;
        _env = env;
    }

    // ── root + registry ────────────────────────────────────────────────────

    public string? FindRoot()
    {
        var configured = (_cfg["ConfigEditor:FullscaleRoot"] ?? "").Trim();
        if (configured.Length > 0)
            return Directory.Exists(configured) ? Path.GetFullPath(configured) : null;

        for (var dir = new DirectoryInfo(_env.ContentRootPath); dir is not null; dir = dir.Parent)
        {
            if (ProjectDirs.All(p => Directory.Exists(Path.Combine(dir.FullName, p))))
                return dir.FullName;
        }
        return null;
    }

    private string Root() => FindRoot() ?? throw new ConfigEditorException("root_not_found", 503,
        "Fullscale root not found — set ConfigEditor:FullscaleRoot in appsettings");

    private static ConfigFile Entry(string? id) =>
        Registry.FirstOrDefault(e => e.Id == id) ?? throw new ConfigEditorException("unknown_file", 404);

    private static string FullPath(string root, ConfigFile e) => Path.Combine(root, e.RelPath);

    // ── list / read ────────────────────────────────────────────────────────

    public object List()
    {
        var root = FindRoot();
        return new
        {
            root,
            files = Registry.Select(e =>
            {
                var fi = root is null ? null : new FileInfo(FullPath(root, e));
                var exists = fi?.Exists == true;
                return new
                {
                    e.Id, e.Project, e.RelPath, e.Format, e.Restart, e.RuntimeWrites,
                    exists,
                    size = exists ? fi!.Length : 0,
                    lastWriteUtc = exists ? fi!.LastWriteTimeUtc : (DateTime?)null
                };
            })
        };
    }

    public (string Text, string Sha) Read(string? id)
    {
        var e = Entry(id);
        var path = FullPath(Root(), e);
        if (!File.Exists(path)) throw new ConfigEditorException("file_missing", 404, path);
        var bytes = File.ReadAllBytes(path);
        return (Decode(bytes, out _), Sha(bytes));
    }

    // ── save ───────────────────────────────────────────────────────────────

    public string Save(string? id, string? text, string? baseSha)
    {
        var e = Entry(id);
        var root = Root();
        var path = FullPath(root, e);
        text ??= "";

        lock (_writeLock)
        {
            byte[]? current = File.Exists(path) ? File.ReadAllBytes(path) : null;
            if (current is not null && !string.Equals(Sha(current), baseSha, StringComparison.OrdinalIgnoreCase))
                throw new ConfigEditorException("file_changed", 409, "file changed on disk since it was loaded — reload and re-apply");

            var normalized = text.Replace("\r\n", "\n");
            Validate(e.Format, normalized);

            // keep the file's own BOM + line endings (config.ini is UTF-8 BOM + CRLF)
            var bom = current is not null && HasBom(current);
            var crlf = current is null || Decode(current, out _).Contains("\r\n");
            var body = crlf ? normalized.Replace("\n", "\r\n") : normalized;
            var bytes = Encoding.UTF8.GetBytes(body);
            if (bom) bytes = [.. Encoding.UTF8.GetPreamble(), .. bytes];

            if (current is not null) Backup(root, e, current);
            WriteAtomic(path, bytes);
            return Sha(bytes);
        }
    }

    private static void WriteAtomic(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllBytes(tmp, bytes);
        try
        {
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }
        catch (IOException)
        {
            // File.Replace can fail on some synced folders (OneDrive) — fall back to overwrite
            File.Copy(tmp, path, overwrite: true);
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
    }

    // ── backups ────────────────────────────────────────────────────────────

    private static string BackupDir(string root, ConfigFile e) => Path.Combine(root, "_backup", "config", e.Project);

    private static void Backup(string root, ConfigFile e, byte[] current)
    {
        var dir = BackupDir(root, e);
        Directory.CreateDirectory(dir);
        var name = Path.GetFileName(e.RelPath);
        File.WriteAllBytes(Path.Combine(dir, $"{name}.{DateTime.Now:yyyyMMdd_HHmmss_fff}.bak"), current);

        foreach (var old in Directory.GetFiles(dir, name + ".*.bak").OrderByDescending(f => f, StringComparer.Ordinal).Skip(KeepBackups))
        {
            try { File.Delete(old); } catch { }
        }
    }

    public object Backups(string? id)
    {
        var e = Entry(id);
        var dir = BackupDir(Root(), e);
        var name = Path.GetFileName(e.RelPath);
        var files = Directory.Exists(dir) ? Directory.GetFiles(dir, name + ".*.bak") : Array.Empty<string>();
        var items = files
            .OrderByDescending(f => f, StringComparer.Ordinal)
            .Select(f => new FileInfo(f))
            .Select(fi => new { name = fi.Name, size = fi.Length, lastWriteUtc = fi.LastWriteTimeUtc })
            .ToArray();
        return new { items };
    }

    public string Restore(string? id, string? backupName, string? baseSha)
    {
        var e = Entry(id);
        var name = backupName ?? "";
        if (!BackupName.IsMatch(name) || !name.StartsWith(Path.GetFileName(e.RelPath) + ".", StringComparison.Ordinal))
            throw new ConfigEditorException("bad_backup_name", 400);

        var path = Path.Combine(BackupDir(Root(), e), name);
        if (!File.Exists(path)) throw new ConfigEditorException("backup_missing", 404);
        return Save(id, Decode(File.ReadAllBytes(path), out _), baseSha);
    }

    // ── validation ─────────────────────────────────────────────────────────

    public static void Validate(string format, string text)
    {
        if (format == "json")
        {
            try
            {
                // strict: Uroboros parses its appsettings with plain JsonDocument.Parse (no comments)
                using var _ = JsonDocument.Parse(text);
            }
            catch (JsonException ex)
            {
                throw new ConfigEditorException("invalid_json", 400, ex.Message, (int?)(ex.LineNumber + 1));
            }
            return;
        }

        var lines = text.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var t = lines[i].Trim();
            if (t.Length == 0 || t[0] == ';' || t[0] == '#') continue;
            if (t[0] == '[')
            {
                if (!t.EndsWith(']') || t.Length < 3)
                    throw new ConfigEditorException("invalid_ini", 400, "section header must look like [Name]", i + 1);
                continue;
            }
            var eq = t.IndexOf('=');
            if (eq <= 0)
                throw new ConfigEditorException("invalid_ini", 400, "expected key=value", i + 1);
        }
    }

    // ── value extraction (shared by Links and ApplyLink) ───────────────────

    private sealed record Value(string Key, string Text, int Start, int Length, bool Quoted);

    /// <summary>Every string value with its key path ("Wayfarer:DbPath"); Start/Length are UTF-8 byte offsets of the JSON token.</summary>
    private static List<Value> JsonStrings(byte[] utf8)
    {
        var list = new List<Value>();
        var reader = new Utf8JsonReader(utf8, new JsonReaderOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
        var stack = new List<string?>();
        string? prop = null;

        while (reader.Read())
        {
            switch (reader.TokenType)
            {
                case JsonTokenType.PropertyName:
                    prop = reader.GetString();
                    break;
                case JsonTokenType.StartObject:
                case JsonTokenType.StartArray:
                    stack.Add(prop);
                    prop = null;
                    break;
                case JsonTokenType.EndObject:
                case JsonTokenType.EndArray:
                    stack.RemoveAt(stack.Count - 1);
                    prop = null;
                    break;
                case JsonTokenType.String:
                    if (prop is not null && !stack.Skip(1).Any(s => s is null))
                    {
                        var key = string.Join(":", stack.Skip(1).Append(prop));
                        list.Add(new Value(key, reader.GetString() ?? "", (int)reader.TokenStartIndex, reader.ValueSpan.Length + 2, true));
                    }
                    prop = null;
                    break;
                default:
                    prop = null;
                    break;
            }
        }
        return list;
    }

    /// <summary>INI values as "Section:key"; Start = line index.</summary>
    private static List<Value> IniValues(string text)
    {
        var list = new List<Value>();
        var section = "";
        var lines = text.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var t = lines[i].Trim();
            if (t.Length == 0 || t[0] == ';' || t[0] == '#') continue;
            if (t[0] == '[') { section = t.Trim('[', ']'); continue; }
            var eq = t.IndexOf('=');
            if (eq <= 0) continue;
            var raw = t[(eq + 1)..].Trim();
            var quoted = raw.Length >= 2 && raw[0] == '"' && raw[^1] == '"';
            var key = (section.Length > 0 ? section + ":" : "") + t[..eq].Trim();
            list.Add(new Value(key, quoted ? raw[1..^1] : raw, i, 0, quoted));
        }
        return list;
    }

    private static List<Value> Values(ConfigFile e, string text) =>
        e.Format == "json" ? JsonStrings(Encoding.UTF8.GetBytes(text)) : IniValues(text);

    // ── links ("auto search") ──────────────────────────────────────────────

    public sealed record Link(
        string FileId, string Project, string Key, string Value, string Kind,
        string? Resolved, bool Exists, bool IsDir, string? LandsIn, string Status, string? Suggestion, string? Note);

    public object Links()
    {
        var root = Root();
        var raw = new List<(ConfigFile E, Value V, string Kind)>();
        var shas = new Dictionary<string, string>();

        foreach (var e in Registry)
        {
            var path = FullPath(root, e);
            if (!File.Exists(path)) continue;
            string text;
            try
            {
                var bytes = File.ReadAllBytes(path);
                shas[e.Id] = Sha(bytes);
                text = Decode(bytes, out _);
            }
            catch { continue; }

            List<Value> values;
            try { values = Values(e, text); } catch (JsonException) { continue; }

            foreach (var v in values)
            {
                if (IgnoredLinks.Contains(e.Id + "|" + v.Key)) continue;
                var kind = Classify(v.Text);
                if (kind is not null) raw.Add((e, v, kind));
            }
        }

        // resolve paths the way the owning app does
        var resolved = raw.Select(r =>
        {
            if (r.Kind != "path") return (r.E, r.V, r.Kind, Full: (string?)null, Exists: false, IsDir: false);
            var baseDir = Path.Combine(root, r.E.BaseDir);
            string full;
            try { full = Path.IsPathRooted(r.V.Text) ? Path.GetFullPath(r.V.Text) : Path.GetFullPath(Path.Combine(baseDir, r.V.Text)); }
            catch { return (r.E, r.V, r.Kind, Full: (string?)null, Exists: false, IsDir: false); }
            var isDir = Directory.Exists(full);
            return (r.E, r.V, r.Kind, Full: (string?)full, Exists: isDir || File.Exists(full), IsDir: isDir);
        }).ToList();

        // same file name referenced from several places (wayfarer.db, wayfarer_meta.db, …) must be one file
        var groups = resolved
            .Where(r => r.Full is not null && Path.HasExtension(r.Full))
            .GroupBy(r => Path.GetFileName(r.Full!), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);

        var searchCache = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        List<string> Search(string name, bool dir)
        {
            var k = (dir ? "d:" : "f:") + name;
            if (!searchCache.TryGetValue(k, out var hits))
                searchCache[k] = hits = SearchByName(root, name, dir);
            return hits;
        }

        var links = new List<Link>();
        foreach (var r in resolved)
        {
            if (r.Kind == "url")
            {
                links.Add(new Link(r.E.Id, r.E.Project, r.V.Key, r.V.Text, "url", null, true, false, null, "info", null, null));
                continue;
            }

            string status = r.Exists ? "ok" : "missing";
            string? suggestion = null, note = null;

            var name = r.Full is null ? null : Path.GetFileName(r.Full.TrimEnd('\\', '/'));
            if (r.Full is not null && name is { Length: > 0 } && groups.TryGetValue(name, out var group))
            {
                var targets = group.Select(g => g.Full!).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                if (targets.Count > 1)
                {
                    // majority target (existing ones win ties) is the suggested fix for the odd one out
                    var best = group.GroupBy(g => g.Full!, StringComparer.OrdinalIgnoreCase)
                        .OrderByDescending(g => g.Count()).ThenByDescending(g => g.First().Exists)
                        .First();
                    var tie = group.GroupBy(g => g.Full!, StringComparer.OrdinalIgnoreCase).Count(g => g.Count() == best.Count()) > 1;
                    if (!string.Equals(best.Key, r.Full, StringComparison.OrdinalIgnoreCase) || tie)
                    {
                        status = "mismatch";
                        note = $"{name} is referenced as {targets.Count} different files";
                        if (!tie && best.First().Exists)
                            suggestion = Express(root, r.E, r.V.Text, best.Key);
                    }
                }
            }

            if (!r.Exists && suggestion is null && name is { Length: > 0 })
            {
                var hits = Search(name, dir: !Path.HasExtension(name));
                if (hits.Count > 0)
                {
                    suggestion = Express(root, r.E, r.V.Text, hits[0]);
                    note = hits.Count > 1 ? $"found {hits.Count} copies under the Fullscale root — using the shallowest" : null;
                }
                else note = "not found anywhere under the Fullscale root";
            }

            links.Add(new Link(r.E.Id, r.E.Project, r.V.Key, r.V.Text, "path", r.Full, r.Exists, r.IsDir,
                LandsIn(root, r.Full), status, suggestion, note));
        }

        return new { root, shas, links, checks = Checks(root, raw) };
    }

    private static string? Classify(string v)
    {
        if (string.IsNullOrWhiteSpace(v)) return null;
        if (Regex.IsMatch(v, @"^https?://", RegexOptions.IgnoreCase)) return "url";
        if (v.StartsWith('/') && !v.StartsWith("//")) return null;                // API route like /api/process
        if (Regex.IsMatch(v, @"^[A-Za-z]:[\\/]") || v.Contains('\\') || v.Contains('/')) return "path";
        if (Regex.IsMatch(v, @"\.(db|dll|exe|json|ini|mdb|accdb|yml|yaml)$", RegexOptions.IgnoreCase)) return "path";
        return null;
    }

    private static string? LandsIn(string root, string? full)
    {
        if (full is null) return null;
        var rel = Path.GetRelativePath(root, full);
        if (rel.StartsWith("..") || Path.IsPathRooted(rel)) return "outside Fullscale";
        var first = rel.Split('\\', '/')[0];
        return ProjectDirs.Contains(first, StringComparer.OrdinalIgnoreCase) ? first : "Fullscale";
    }

    /// <summary>Re-express <paramref name="target"/> in the same style as the original value (relative vs absolute, \ vs /).</summary>
    private static string Express(string root, ConfigFile e, string original, string target)
    {
        if (Path.IsPathRooted(original)) return target;
        var rel = Path.GetRelativePath(Path.Combine(root, e.BaseDir), target);
        return original.Contains('/') && !original.Contains('\\') ? rel.Replace('\\', '/') : rel;
    }

    private static List<string> SearchByName(string root, string name, bool dir)
    {
        var hits = new List<(string Path, int Depth)>();
        void Walk(string d, int depth)
        {
            if (depth > SearchDepth) return;
            IEnumerable<string> subs;
            try
            {
                var match = dir ? Directory.EnumerateDirectories(d, name) : Directory.EnumerateFiles(d, name);
                hits.AddRange(match.Select(m => (m, depth)));
                subs = Directory.EnumerateDirectories(d);
            }
            catch { return; }
            foreach (var s in subs)
                if (!SearchSkip.Contains(Path.GetFileName(s))) Walk(s, depth + 1);
        }
        Walk(root, 0);
        return hits.OrderBy(h => h.Depth).ThenBy(h => h.Path, StringComparer.OrdinalIgnoreCase).Select(h => h.Path).ToList();
    }

    private static List<object> Checks(string root, List<(ConfigFile E, Value V, string Kind)> raw)
    {
        var checks = new List<object>();

        // BellBeast → Uroboros: backendBaseUrl port must match UROBOROS_HTTP_PREFIX in the start script
        var backend = raw.FirstOrDefault(r => r.E.Id == "bb-backend" && r.V.Key == "backendBaseUrl");
        var ps1 = Path.Combine(root, "START_FULLSCALE_LOCALHOST.ps1");
        if (backend.V is not null && File.Exists(ps1))
        {
            var m = Regex.Match(File.ReadAllText(ps1), @"UROBOROS_HTTP_PREFIX\s*=\s*""([^""]+)""");
            var urlPort = Regex.Match(backend.V.Text, @":(\d+)").Groups[1].Value;
            var prefixPort = m.Success ? Regex.Match(m.Groups[1].Value, @":(\d+)").Groups[1].Value : "";
            checks.Add(new
            {
                name = "BellBeast backendBaseUrl ↔ Uroboros listen port",
                ok = m.Success && urlPort == prefixPort,
                detail = m.Success
                    ? $"backend-config.json backendBaseUrl = {backend.V.Text} · START_FULLSCALE_LOCALHOST.ps1 UROBOROS_HTTP_PREFIX = {m.Groups[1].Value}"
                    : "UROBOROS_HTTP_PREFIX not found in START_FULLSCALE_LOCALHOST.ps1"
            });
        }
        return checks;
    }

    /// <summary>Replace one value in place (formatting, comments and other keys untouched), then Save.</summary>
    public string ApplyLink(string? id, string? key, string? newValue, string? baseSha)
    {
        var e = Entry(id);
        if (string.IsNullOrEmpty(key) || newValue is null) throw new ConfigEditorException("bad_request", 400);

        var (text, _) = Read(id);
        var v = Values(e, text).FirstOrDefault(x => x.Key == key)
                ?? throw new ConfigEditorException("unknown_key", 404, key);

        string updated;
        if (e.Format == "json")
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            var token = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(newValue, JsonValueOut));
            updated = Encoding.UTF8.GetString([.. bytes[..v.Start], .. token, .. bytes[(v.Start + v.Length)..]]);
        }
        else
        {
            var lines = text.Split('\n');
            var line = lines[v.Start];
            var eq = line.IndexOf('=');
            var cr = line.EndsWith('\r') ? "\r" : "";
            lines[v.Start] = line[..(eq + 1)] + (v.Quoted ? $"\"{newValue}\"" : newValue) + cr;
            updated = string.Join('\n', lines);
        }
        return Save(id, updated, baseSha);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static bool HasBom(byte[] b) => b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF;

    private static string Decode(byte[] bytes, out bool bom)
    {
        bom = HasBom(bytes);
        return bom ? Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3) : Encoding.UTF8.GetString(bytes);
    }

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

public sealed class ConfigEditorException : Exception
{
    public string Code { get; }
    public int Status { get; }
    public string? Detail { get; }
    public int? Line { get; }

    public ConfigEditorException(string code, int status, string? detail = null, int? line = null) : base(detail ?? code)
    {
        Code = code;
        Status = status;
        Detail = detail;
        Line = line;
    }
}
