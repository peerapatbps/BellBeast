using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace BellBeast.Services;

/// <summary>
/// Annunciator fleet (iot-device_plan.md §4 / P4): device registry, per-device config, device reports (audit log)
/// and firmware OTA (manifest + binary).
///
/// Device identity: each device generates a random 32-byte key on first boot and sends it as <c>X-Device-Key</c>.
/// First contact registers the device as <b>pending</b> (trust on first use); an admin approves it in /Admin/Fleet.
/// Later calls must present the same key (only its sha256 is stored). WiFi credentials are served to approved
/// devices only — over plain HTTP on the plant LAN (BellBeast has no TLS), never logged, never in a URL.
///
/// WiFi is per device (no fleet-wide set: a device without its own uses the password list built into the firmware,
/// "bypass").
///
/// Firmware: the admin puts devices into <b>groups</b>; a group points at one uploaded image. The built-in group
/// <see cref="AutoGroupId"/> ("Auto patcher") follows the newest image the admin <i>released</i> for each board.
/// Per device: follow the group, override with one image, or hold (no update). The <b>board</b> comes from the
/// firmware label suffix (<c>ann-1.4.0-183</c> → <c>183</c>, <c>ann-1.4.0</c> → MUMA ""); an image of another board
/// is never served (the device has the same guard). A device in no group gets nothing.
///
/// Layout: App_Data/fleet/fleet.json (state) · fleet/events/{device}.jsonl (rolling: newest
/// <see cref="MaxEventsPerDevice"/> per device) · fleet/ota/{version}.bin (older uploads may sit in fleet/ota/{model}/)
/// </summary>
public sealed class DeviceFleetService
{
    public const string KeyHeader = "X-Device-Key";
    public const int MaxEventsPerReport = 64;
    public const int MaxEventsPerDevice = 100;
    public const long MaxFirmwareBytes = 0x3f0000;          // app partition size on the device (partitions/v2/16m.csv)
    public const string AutoGroupId = "auto";
    public const int MaxGroups = 50;
    public const string ModeGroup = "group", ModeOverride = "override", ModeHold = "hold";

    private static readonly Regex IdRx = new("^[a-z0-9][a-z0-9-]{2,31}$", RegexOptions.Compiled);
    private static readonly Regex KeyRx = new("^[0-9a-f]{64}$", RegexOptions.Compiled);
    private static readonly Regex ModelRx = new("^[a-z0-9][a-z0-9._-]{0,31}$", RegexOptions.Compiled);
    private static readonly Regex VersionRx = new("^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$", RegexOptions.Compiled);
    private static readonly Regex ZonesRx = new("^[A-Z0-9_]{1,16}(,[A-Z0-9_]{1,16}){0,15}$", RegexOptions.Compiled);
    private static readonly Regex GroupIdRx = new("^[a-z0-9]{1,16}$", RegexOptions.Compiled);
    internal static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
    private static readonly JsonSerializerOptions LineOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    private readonly string _root;
    private readonly string _statePath;
    private readonly string _eventsDir;
    private readonly string _fwDir;
    private readonly object _lock = new();
    private FleetState _state;

    // ── persisted model ──
    public sealed class FleetState
    {
        public Dictionary<string, DeviceRecord> Devices { get; set; } = new(StringComparer.Ordinal);
        public FleetDefaults Defaults { get; set; } = new();
        /// <summary>Legacy fleet-wide WiFi — no longer served (WiFi is per device only); dropped on load.</summary>
        public WifiCreds? Wifi { get; set; }
        public Dictionary<string, FirmwareGroup> Groups { get; set; } = new(StringComparer.Ordinal);
        public OtaState Ota { get; set; } = new();
    }

    public sealed class FirmwareGroup
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string? Target { get; set; }           // firmware version; null = no update. Ignored for the auto group
        public DateTimeOffset CreatedAt { get; set; }
        public DateTimeOffset? UpdatedAt { get; set; }
        public string? UpdatedBy { get; set; }
    }

    public sealed class DeviceRecord
    {
        public string Id { get; set; } = "";
        public string? Name { get; set; }
        public string? KeySha256 { get; set; }
        public bool Approved { get; set; }
        public string? Group { get; set; }            // firmware group id; null = not grouped (no update)
        public string? FwMode { get; set; }           // group (default) | override | hold
        public string? FwOverride { get; set; }       // version when FwMode = override
        public string? ReportedModel { get; set; }    // "model" in the report (ann-1.4.0+): the board suffix
        public WifiCreds? Wifi { get; set; }          // null = none: the device uses its built-in bootstrap list (bypass)
        public string? Zones { get; set; }            // null = fleet default
        public int? PollSec { get; set; }
        public int? RemindSec { get; set; }
        public int? LabSec { get; set; }              // lab glance loop (device default 300)
        public int? ScnSec { get; set; }              // scenario check loop (device default 30)
        public int? Volume { get; set; }
        public DateTimeOffset CreatedAt { get; set; }
        public DateTimeOffset? LastSeen { get; set; }
        public string? Fw { get; set; }
        public string? Ip { get; set; }               // as the device reports it (display only)
        public string? SeenIp { get; set; }           // connection IP of the last request whose key checked out
        public DateTimeOffset? SeenAt { get; set; }
        public string? Partition { get; set; }
        public string? WifiTier { get; set; }         // known | bootstrap
        public int? Rssi { get; set; }
        public long? UptimeSec { get; set; }
        public DateTimeOffset? LastPlayedAt { get; set; }
        public string? LastPlayedAlarm { get; set; }
        public DateTimeOffset? LastAckAt { get; set; }
        public string? LastAckAlarm { get; set; }
        public DateTimeOffset? LastFallbackAt { get; set; }
        public string? LastOta { get; set; }
        public long Reports { get; set; }
        // ── legacy (read once on load, then cleared) ──
        public string? Model { get; set; }
        public string? FwPin { get; set; }
        public string? Channel { get; set; }
    }

    public sealed class FleetDefaults
    {
        public string Zones { get; set; } = "";
        public int PollSec { get; set; } = 5;
        public int RemindSec { get; set; } = 60;
        public int LabSec { get; set; } = 300;
        public int ScnSec { get; set; } = 30;
        public int? Volume { get; set; }
    }

    public sealed class WifiCreds
    {
        public string Ssid { get; set; } = ".@MWA WiFi";
        public string Identity { get; set; } = "";
        public string Current { get; set; } = "";
        public string? Next { get; set; }
        public DateTimeOffset? NextValidFrom { get; set; }
        public DateTimeOffset UpdatedAt { get; set; }
    }

    public sealed class OtaState
    {
        /// <summary>Auto patcher: board → newest released version for that board.</summary>
        public Dictionary<string, string> Released { get; set; } = new(StringComparer.Ordinal);
        public List<FirmwareInfo> Firmware { get; set; } = new();
        // legacy (cleared on load)
        public Dictionary<string, string?>? Channels { get; set; }
        public Dictionary<string, Dictionary<string, string?>>? Tracks { get; set; }
    }

    /// <summary>One uploaded image. <see cref="Model"/> only says which folder an older upload sits in.</summary>
    public sealed record FirmwareInfo(string Version, string Sha256, long Size, DateTimeOffset UploadedAt, string? Note, string? Model = null)
    {
        [JsonIgnore] public string Board => BoardOf(Version) ?? "";
    }

    /// <summary>Board from a firmware label: "ann-1.4.0-183" → "183", "ann-1.4.0" → "" (MUMA), null → null (unknown).</summary>
    public static string? BoardOf(string? fw)
    {
        if (string.IsNullOrWhiteSpace(fw)) return null;
        var v = fw.Trim();
        if (v.StartsWith("ann-", StringComparison.OrdinalIgnoreCase)) v = v[4..];
        var i = 0;
        while (i < v.Length && (char.IsDigit(v[i]) || v[i] == '.')) i++;
        v = v[i..];
        if (v.StartsWith('-')) v = v[1..];
        return v.ToLowerInvariant();
    }

    // ── device-facing DTOs ──
    public sealed class ReportBody
    {
        public string? Fw { get; set; }
        public string? Ip { get; set; }
        public string? Partition { get; set; }
        public string? WifiTier { get; set; }
        public int? Rssi { get; set; }
        public long? UptimeSec { get; set; }
        public string? Model { get; set; }            // optional: board the firmware was built for
        public List<ReportEvent>? Events { get; set; }
    }

    public sealed class ReportEvent
    {
        public long? Ts { get; set; }                 // unix seconds (device clock; 0/null = unknown)
        public string? Type { get; set; }             // boot | played | fallback | ack | clear | wifi | ota | health
        public string? AlarmId { get; set; }
        public string? Detail { get; set; }
    }

    public enum AuthStatus { Ok, Registered, BadId, BadKey, KeyMismatch }

    public DeviceFleetService(IWebHostEnvironment env)
    {
        _root = Path.Combine(env.ContentRootPath, "App_Data", "fleet");
        _statePath = Path.Combine(_root, "fleet.json");
        _eventsDir = Path.Combine(_root, "events");
        _fwDir = Path.Combine(_root, "ota");
        Directory.CreateDirectory(_fwDir);
        Directory.CreateDirectory(_eventsDir);
        _state = Load();
        MigrateLegacyEvents();
    }

    public static bool ValidId(string? id) => id is not null && IdRx.IsMatch(id);
    public static bool ValidVersion(string? v) => v is not null && VersionRx.IsMatch(v);
    public static bool ValidModel(string? m) => m is not null && ModelRx.IsMatch(m);

    /// <summary>"" or a valid lower-case model; null = invalid.</summary>
    public static string? NormalizeModel(string? m)
    {
        m = (m ?? "").Trim().ToLowerInvariant();
        return m.Length == 0 || ValidModel(m) ? m : null;
    }


    /// <summary>"rws, dps" -> "RWS,DPS"; "" -> ""; invalid -> null.</summary>
    public static string? NormalizeZones(string? zones)
    {
        var parts = (zones ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(z => z.ToUpperInvariant()).Distinct().ToArray();
        if (parts.Length == 0) return "";
        var s = string.Join(',', parts);
        return ZonesRx.IsMatch(s) ? s : null;
    }

    private static string Sha(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();

    /// <summary>Checks the device key; unknown device (or key reset by admin) is registered as pending.</summary>
    public (AuthStatus Status, DeviceRecord? Device) Authenticate(string id, string? key, string? ip)
    {
        if (!ValidId(id)) return (AuthStatus.BadId, null);
        if (key is null || !KeyRx.IsMatch(key)) return (AuthStatus.BadKey, null);
        var keySha = Sha(key);
        lock (_lock)
        {
            var now = DateTimeOffset.UtcNow;
            if (!_state.Devices.TryGetValue(id, out var d))
            {
                d = new DeviceRecord { Id = id, KeySha256 = keySha, CreatedAt = now, LastSeen = now, Ip = ip, SeenIp = ip, SeenAt = ip is null ? null : now };
                _state.Devices[id] = d;
                Save();
                AppendEvents(id, [new ReportEvent { Type = "registered", Detail = "pending approval" }]);
                return (AuthStatus.Registered, Clone(d));
            }
            if (d.KeySha256 is null) { d.KeySha256 = keySha; d.Approved = false; }       // admin reset: re-bind, re-approve
            else if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(d.KeySha256), Encoding.ASCII.GetBytes(keySha)))
                return (AuthStatus.KeyMismatch, null);
            d.LastSeen = now;
            if (ip is not null) { d.Ip = ip; d.SeenIp = ip; d.SeenAt = now; }
            Save();
            return (AuthStatus.Ok, Clone(d));
        }
    }

    /// <summary>
    /// Device APIs (alarm feed, clips, ...): true when <paramref name="id"/> is an approved device and the key is
    /// its key. Never registers a device (only report/config/manifest do). Refreshes the seen IP in memory only —
    /// a 5 s alarm poll must not rewrite fleet.json; the next report persists it.
    /// </summary>
    public bool VerifyApproved(string id, string key, string? ip)
    {
        if (!ValidId(id) || !KeyRx.IsMatch(key)) return false;
        var keySha = Encoding.ASCII.GetBytes(Sha(key));
        lock (_lock)
        {
            if (!_state.Devices.TryGetValue(id, out var d) || !d.Approved || d.KeySha256 is null) return false;
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(d.KeySha256), keySha)) return false;
            if (ip is not null) { d.SeenIp = ip; d.SeenAt = DateTimeOffset.UtcNow; }
            return true;
        }
    }

    /// <summary>
    /// The approved device whose key last checked out from this connection IP within <paramref name="window"/>,
    /// or null. Used for IP passes: the IP comes from the connection, never from what the device reports.
    /// </summary>
    public string? ApprovedDeviceAt(string ip, TimeSpan window)
    {
        var since = DateTimeOffset.UtcNow - window;
        lock (_lock)
            return _state.Devices.Values.FirstOrDefault(d =>
                d.Approved && d.KeySha256 is not null && d.SeenIp == ip && d.SeenAt is { } t && t > since)?.Id;
    }

    /// <summary>Approved devices with the connection IP they were last seen from (admin IP tab).</summary>
    public IReadOnlyList<(string Id, string? Name, string? SeenIp, DateTimeOffset? SeenAt)> ApprovedDevices()
    {
        lock (_lock)
            return _state.Devices.Values.Where(d => d.Approved && d.KeySha256 is not null)
                .OrderBy(d => d.Id, StringComparer.Ordinal)
                .Select(d => (d.Id, d.Name, d.SeenIp, d.SeenAt)).ToList();
    }

    public DeviceRecord ApplyReport(string id, ReportBody body)
    {
        var events = (body.Events ?? []).Take(MaxEventsPerReport).ToList();
        lock (_lock)
        {
            var d = _state.Devices[id];
            var now = DateTimeOffset.UtcNow;
            d.LastSeen = now;
            d.Reports++;
            if (!string.IsNullOrWhiteSpace(body.Fw)) d.Fw = Trunc(body.Fw, 40);
            if (!string.IsNullOrWhiteSpace(body.Ip)) d.Ip = Trunc(body.Ip, 40);
            if (!string.IsNullOrWhiteSpace(body.Partition)) d.Partition = Trunc(body.Partition, 16);
            if (!string.IsNullOrWhiteSpace(body.WifiTier)) d.WifiTier = Trunc(body.WifiTier, 16);
            if (body.Rssi is not null) d.Rssi = body.Rssi;
            if (body.UptimeSec is not null) d.UptimeSec = body.UptimeSec;
            if (NormalizeModel(body.Model) is { Length: > 0 } rm) d.ReportedModel = rm;
            foreach (var e in events)
            {
                var at = e.Ts is > 1_600_000_000 ? DateTimeOffset.FromUnixTimeSeconds(e.Ts.Value) : now;
                switch (e.Type)
                {
                    case "played": d.LastPlayedAt = at; d.LastPlayedAlarm = Trunc(e.AlarmId, 64); break;
                    case "ack": d.LastAckAt = at; d.LastAckAlarm = Trunc(e.AlarmId, 64); break;
                    case "fallback": d.LastFallbackAt = at; break;
                    case "ota": d.LastOta = Trunc(e.Detail, 120); break;
                }
            }
            Save();
            AppendEvents(id, events);
            return Clone(d);
        }
    }

    /// <summary>Effective config for a device. ETag covers every field (device sends If-None-Match).</summary>
    public (Dictionary<string, object?> Body, string ETag) BuildConfig(string id)
    {
        lock (_lock)
        {
            var d = _state.Devices[id];
            var def = _state.Defaults;
            object? wifi = d.Approved && d.Wifi is { } w && w.Current.Length > 0
                ? new Dictionary<string, object?>
                {
                    ["ssid"] = w.Ssid, ["identity"] = w.Identity, ["current"] = w.Current,
                    ["next"] = w.Next, ["next_valid_from"] = w.NextValidFrom?.ToUnixTimeSeconds(),
                }
                : null;
            var body = new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["approved"] = d.Approved,
                ["zones"] = d.Zones ?? def.Zones,
                ["poll_sec"] = d.PollSec ?? def.PollSec,
                ["remind_sec"] = d.RemindSec ?? def.RemindSec,
                ["lab_sec"] = d.LabSec ?? def.LabSec,
                ["scn_sec"] = d.ScnSec ?? def.ScnSec,
                ["volume"] = d.Volume ?? def.Volume,
                ["wifi"] = wifi,
            };
            var etag = "\"" + Sha(JsonSerializer.Serialize(body))[..16] + "\"";
            body["etag"] = etag.Trim('"');
            return (body, etag);
        }
    }

    /// <summary>Board of a device: what it reports (ann-1.4.0+), else the suffix of the label it runs; null = unknown.</summary>
    private static string? DeviceBoard(DeviceRecord d) => !string.IsNullOrEmpty(d.ReportedModel) ? d.ReportedModel : BoardOf(d.Fw);

    private static string ModeOf(DeviceRecord d) => d.FwMode is ModeOverride or ModeHold ? d.FwMode : ModeGroup;

    private FirmwareInfo? Fw(string? version) => version is null ? null : _state.Ota.Firmware.FirstOrDefault(f => f.Version == version);

    /// <summary>
    /// What a device should run and why. Source: hold | override | group | auto | ungrouped.
    /// Note (why nothing is served): board_mismatch | not_released | no_target | unknown_board | missing.
    /// </summary>
    private (string Source, FirmwareInfo? Firmware, string? Note) Target(DeviceRecord? d)
    {
        if (d is null) return ("ungrouped", null, null);
        var board = DeviceBoard(d);
        (string, FirmwareInfo?, string?) Check(string source, string? version, string empty)
        {
            if (version is null) return (source, null, empty);
            var fw = Fw(version);
            if (fw is null) return (source, null, "missing");
            if (board is not null && fw.Board != board) return (source, null, "board_mismatch");
            return (source, fw, null);
        }
        switch (ModeOf(d))
        {
            case ModeHold: return (ModeHold, null, null);
            case ModeOverride: return Check(ModeOverride, d.FwOverride, "no_target");
        }
        if (d.Group is null || !_state.Groups.TryGetValue(d.Group, out var g)) return ("ungrouped", null, null);
        if (g.Id == AutoGroupId)
        {
            if (board is null) return ("auto", null, "unknown_board");
            return Check("auto", _state.Ota.Released.TryGetValue(board, out var v) ? v : null, "not_released");
        }
        return Check(ModeGroup, g.Target, "no_target");
    }

    public (string Channel, FirmwareInfo? Firmware) ManifestFor(string? id)
    {
        lock (_lock)
        {
            var (source, fw, _) = Target(id is not null && _state.Devices.TryGetValue(id, out var d) ? d : null);
            return (source, fw);
        }
    }

    public string FirmwarePath(FirmwareInfo fw) =>
        string.IsNullOrEmpty(fw.Model) ? Path.Combine(_fwDir, fw.Version + ".bin") : Path.Combine(_fwDir, fw.Model, fw.Version + ".bin");

    public FirmwareInfo? GetFirmware(string version)
    {
        lock (_lock) return Fw(version);
    }

    /// <summary>Download path the manifest points at.</summary>
    public static string FirmwareUrl(FirmwareInfo fw) => $"/api/ota/firmware/{fw.Version}";

    // ── admin ──
    private static object? WifiView(WifiCreds? w) => w is null ? null : new
    {
        ssid = w.Ssid, identity = w.Identity, current = Mask(w.Current), next = Mask(w.Next),
        next_valid_from = w.NextValidFrom, updated_at = w.UpdatedAt,
    };

    public object AdminView()
    {
        lock (_lock)
        {
            var released = _state.Ota.Released;
            return new
            {
                ok = true,
                defaults = _state.Defaults,
                groups = _state.Groups.Values
                    .OrderBy(g => g.Id == AutoGroupId ? 0 : 1).ThenBy(g => g.Name, StringComparer.CurrentCultureIgnoreCase)
                    .Select(g => new
                    {
                        g.Id, g.Name, auto = g.Id == AutoGroupId, target = g.Id == AutoGroupId ? null : g.Target,
                        g.CreatedAt, g.UpdatedAt, g.UpdatedBy,
                        members = _state.Devices.Values.Where(d => d.Group == g.Id).Select(d => d.Id).OrderBy(x => x, StringComparer.Ordinal),
                    }),
                ota = new
                {
                    released,
                    firmware = _state.Ota.Firmware.OrderByDescending(f => f.UploadedAt).Select(f => new
                    {
                        f.Version, board = f.Board, f.Sha256, f.Size, f.UploadedAt, f.Note,
                        released = released.TryGetValue(f.Board, out var rv) && rv == f.Version,
                    }),
                },
                devices = _state.Devices.Values.OrderBy(d => d.Id, StringComparer.Ordinal).Select(d =>
                {
                    var (src, tfw, note) = Target(d);
                    return new
                    {
                        d.Id, d.Name, has_key = d.KeySha256 is not null, d.Approved,
                        d.Group, fw_mode = ModeOf(d), d.FwOverride, board = DeviceBoard(d),
                        target_source = src, target_fw = tfw?.Version, target_note = note,
                        wifi = WifiView(d.Wifi),
                        d.Zones, d.PollSec, d.RemindSec, d.LabSec, d.ScnSec, d.Volume,
                        d.CreatedAt, d.LastSeen, d.Fw, d.Ip, d.SeenIp, d.SeenAt, d.Partition, d.WifiTier, d.Rssi, d.UptimeSec,
                        d.LastPlayedAt, d.LastPlayedAlarm, d.LastAckAt, d.LastAckAlarm, d.LastFallbackAt, d.LastOta, d.Reports,
                    };
                }),
            };
        }
    }

    /// <summary>Partial update from the admin page. Returns an error string or null.</summary>
    public string? UpdateDevice(string id, JsonElement patch)
    {
        lock (_lock)
        {
            if (!_state.Devices.TryGetValue(id, out var d)) return "device_not_found";
            // validate everything on a copy first, so a bad field leaves the device untouched
            var n = Clone(d);
            if (Str(patch, "name", out var name)) n.Name = string.IsNullOrWhiteSpace(name) ? null : Trunc(name.Trim(), 60);
            if (patch.TryGetProperty("approved", out var ap) && ap.ValueKind is JsonValueKind.True or JsonValueKind.False) n.Approved = ap.GetBoolean();
            if (Str(patch, "zones", out var z))
            {
                if (z is null) n.Zones = null;
                else { var nz = NormalizeZones(z); if (nz is null) return "bad_zones"; n.Zones = nz; }
            }
            if (Str(patch, "group", out var grp))
            {
                if (string.IsNullOrEmpty(grp)) n.Group = null;
                else if (!_state.Groups.ContainsKey(grp)) return "group_not_found";
                else n.Group = grp;
            }
            if (Str(patch, "fw_mode", out var mode))
            {
                if (mode is not (ModeGroup or ModeOverride or ModeHold)) return "bad_fw_mode";
                n.FwMode = mode;
            }
            if (Str(patch, "fw_override", out var ov)) n.FwOverride = string.IsNullOrEmpty(ov) ? null : ov;
            if (ModeOf(n) == ModeOverride)
            {
                var fw = Fw(n.FwOverride);
                if (fw is null) return "firmware_not_found";
                if (DeviceBoard(n) is { } b && fw.Board != b) return "fw_board_mismatch";
            }
            if (patch.TryGetProperty("wifi", out var wj))
            {
                if (wj.ValueKind == JsonValueKind.Null) n.Wifi = null;
                else if (wj.ValueKind != JsonValueKind.Object) return "bad_wifi";
                else
                {
                    var (w, err) = ApplyWifi(n.Wifi, wj);
                    if (err is not null) return err;
                    n.Wifi = w;
                }
            }
            if (!OptInt(patch, "poll_sec", 1, 60, v => n.PollSec = v)) return "bad_poll_sec";
            if (!OptInt(patch, "remind_sec", 0, 3600, v => n.RemindSec = v)) return "bad_remind_sec";
            if (!OptInt(patch, "lab_sec", 60, 3600, v => n.LabSec = v)) return "bad_lab_sec";
            if (!OptInt(patch, "scn_sec", 10, 600, v => n.ScnSec = v)) return "bad_scn_sec";
            if (!OptInt(patch, "volume", 0, 100, v => n.Volume = v)) return "bad_volume";
            if (patch.TryGetProperty("reset_key", out var rk) && rk.ValueKind == JsonValueKind.True) { n.KeySha256 = null; n.Approved = false; }
            _state.Devices[id] = n;
            Save();
            return null;
        }
    }

    public bool DeleteDevice(string id)
    {
        lock (_lock)
        {
            if (!_state.Devices.Remove(id)) return false;
            Save();
            try { File.Delete(EventsPath(id)); } catch (IOException) { }
            return true;
        }
    }

    public string? UpdateDefaults(JsonElement patch)
    {
        lock (_lock)
        {
            var def = _state.Defaults;
            if (Str(patch, "zones", out var z)) { var nz = NormalizeZones(z); if (nz is null) return "bad_zones"; def.Zones = nz; }
            if (patch.TryGetProperty("poll_sec", out var p)) { if (!p.TryGetInt32(out var v) || v is < 1 or > 60) return "bad_poll_sec"; def.PollSec = v; }
            if (patch.TryGetProperty("remind_sec", out var r)) { if (!r.TryGetInt32(out var v) || v is < 0 or > 3600) return "bad_remind_sec"; def.RemindSec = v; }
            if (patch.TryGetProperty("lab_sec", out var lb)) { if (!lb.TryGetInt32(out var v) || v is < 60 or > 3600) return "bad_lab_sec"; def.LabSec = v; }
            if (patch.TryGetProperty("scn_sec", out var sn)) { if (!sn.TryGetInt32(out var v) || v is < 10 or > 600) return "bad_scn_sec"; def.ScnSec = v; }
            if (!OptInt(patch, "volume", 0, 100, v => def.Volume = v)) return "bad_volume";
            Save();
            return null;
        }
    }

    /// <summary>Merges a WiFi patch into a copy of <paramref name="existing"/> (fields left out keep their value).</summary>
    private static (WifiCreds? Wifi, string? Error) ApplyWifi(WifiCreds? existing, JsonElement body)
    {
        var w = existing is null ? new WifiCreds() : new WifiCreds
        {
            Ssid = existing.Ssid, Identity = existing.Identity, Current = existing.Current,
            Next = existing.Next, NextValidFrom = existing.NextValidFrom, UpdatedAt = existing.UpdatedAt,
        };
        if (Str(body, "ssid", out var ssid)) { if (string.IsNullOrWhiteSpace(ssid) || ssid.Length > 32) return (null, "bad_ssid"); w.Ssid = ssid; }
        if (Str(body, "identity", out var ident)) w.Identity = Trunc(ident ?? "", 64)!;
        if (Str(body, "current", out var cur)) { if (string.IsNullOrEmpty(cur) || cur.Length > 63) return (null, "bad_current"); w.Current = cur; }
        if (Str(body, "next", out var next)) { if (next is { Length: > 63 }) return (null, "bad_next"); w.Next = string.IsNullOrEmpty(next) ? null : next; }
        if (body.TryGetProperty("next_valid_from", out var nvf))
        {
            if (nvf.ValueKind == JsonValueKind.Null) w.NextValidFrom = null;
            else if (nvf.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(nvf.GetString(), out var t)) w.NextValidFrom = t;
            else return (null, "bad_next_valid_from");
        }
        if (w.Current.Length == 0) return (null, "bad_current");
        w.UpdatedAt = DateTimeOffset.UtcNow;
        return (w, null);
    }

    // ── firmware groups ──
    /// <summary>Creates a group; returns (id, null) or (null, error).</summary>
    public (string? Id, string? Error) CreateGroup(string? name, string? actor)
    {
        name = (name ?? "").Trim();
        if (name.Length is 0 or > 40) return (null, "bad_group_name");
        lock (_lock)
        {
            if (_state.Groups.Count >= MaxGroups) return (null, "too_many_groups");
            if (_state.Groups.Values.Any(g => string.Equals(g.Name, name, StringComparison.CurrentCultureIgnoreCase))) return (null, "group_name_taken");
            string id;
            do id = "g" + Convert.ToHexString(RandomNumberGenerator.GetBytes(3)).ToLowerInvariant(); while (_state.Groups.ContainsKey(id));
            _state.Groups[id] = new FirmwareGroup { Id = id, Name = name, CreatedAt = DateTimeOffset.UtcNow, UpdatedBy = actor };
            Save();
            return (id, null);
        }
    }

    /// <summary>Rename and/or point a group at an image ("target": version or null = no update). Takes effect at once.</summary>
    public string? UpdateGroup(string id, JsonElement patch, string? actor)
    {
        lock (_lock)
        {
            if (!_state.Groups.TryGetValue(id, out var g)) return "group_not_found";
            string? newName = null;
            if (Str(patch, "name", out var name))
            {
                newName = (name ?? "").Trim();
                if (newName.Length is 0 or > 40) return "bad_group_name";
                if (_state.Groups.Values.Any(o => o.Id != id && string.Equals(o.Name, newName, StringComparison.CurrentCultureIgnoreCase))) return "group_name_taken";
            }
            var setTarget = Str(patch, "target", out var target);
            if (setTarget)
            {
                if (id == AutoGroupId) return "auto_group_has_no_target";
                if (!string.IsNullOrEmpty(target) && Fw(target) is null) return "firmware_not_found";
            }
            if (newName is not null) g.Name = newName;
            if (setTarget) g.Target = string.IsNullOrEmpty(target) ? null : target;
            g.UpdatedAt = DateTimeOffset.UtcNow;
            g.UpdatedBy = actor;
            Save();
            return null;
        }
    }

    public string? DeleteGroup(string id)
    {
        if (id == AutoGroupId) return "auto_group_is_built_in";
        lock (_lock)
        {
            if (!_state.Groups.Remove(id)) return "group_not_found";
            foreach (var d in _state.Devices.Values.Where(d => d.Group == id)) d.Group = null;
            Save();
            return null;
        }
    }

    /// <summary>Moves devices into a group (groupId null = take them out of any group).</summary>
    public string? AssignGroup(string? groupId, IEnumerable<string> deviceIds)
    {
        lock (_lock)
        {
            if (groupId is not null && !_state.Groups.ContainsKey(groupId)) return "group_not_found";
            var ids = deviceIds.Distinct(StringComparer.Ordinal).ToList();
            if (ids.Count == 0) return "no_devices";
            if (ids.FirstOrDefault(x => !_state.Devices.ContainsKey(x)) is { } missing) return "device_not_found:" + missing;
            foreach (var x in ids) _state.Devices[x].Group = groupId;
            Save();
            return null;
        }
    }

    /// <summary>Auto patcher: make this image the newest released one for its board (released=false clears that board).</summary>
    public string? Release(string version, bool released)
    {
        lock (_lock)
        {
            var fw = Fw(version);
            if (fw is null) return "firmware_not_found";
            if (released) _state.Ota.Released[fw.Board] = fw.Version;
            else if (_state.Ota.Released.TryGetValue(fw.Board, out var cur) && cur == fw.Version) _state.Ota.Released.Remove(fw.Board);
            Save();
            return null;
        }
    }

    /// <summary>Version string embedded in an ESP-IDF app image (esp_app_desc_t right after the first segment header), or null.</summary>
    public static string? EmbeddedVersion(byte[] bin)
    {
        const int desc = 0x18 + 8;                                                  // image header + segment header
        if (bin.Length < desc + 48 || bin[0] != 0xE9) return null;
        if (BitConverter.ToUInt32(bin, desc) != 0xABCD5432) return null;           // ESP_APP_DESC_MAGIC_WORD
        var raw = bin.AsSpan(desc + 16, 32);
        var end = raw.IndexOf((byte)0);
        return Encoding.ASCII.GetString(end < 0 ? raw : raw[..end]);
    }

    /// <summary>
    /// Stores a firmware image. <paramref name="version"/> may be null = take the version embedded in the image.
    /// A label that differs from the embedded version is rejected — the device compares the manifest version with
    /// what it runs, so a mismatch would reinstall the same image forever. Its board comes from the label suffix.
    /// </summary>
    public FirmwareInfo SaveFirmware(string? version, byte[] bin, string? note)
    {
        if (bin.Length < 1024 || bin.Length > MaxFirmwareBytes) throw new ArgumentException("bad_size");
        if (bin[0] != 0xE9) throw new ArgumentException("not_esp_image");          // ESP app image magic
        var embedded = EmbeddedVersion(bin) ?? throw new ArgumentException("no_app_descriptor");
        version = string.IsNullOrWhiteSpace(version) ? embedded : version.Trim();
        if (version != embedded) throw new ArgumentException($"version_mismatch: image is {embedded}");
        if (!ValidVersion(version)) throw new ArgumentException("bad_version");
        var sha = Convert.ToHexString(SHA256.HashData(bin)).ToLowerInvariant();
        var info = new FirmwareInfo(version, sha, bin.Length, DateTimeOffset.UtcNow, string.IsNullOrWhiteSpace(note) ? null : Trunc(note.Trim(), 120));
        lock (_lock)
        {
            if (Fw(version) is { } old && old.Model is not null) try { File.Delete(FirmwarePath(old)); } catch (IOException) { }
            File.WriteAllBytes(FirmwarePath(info), bin);
            _state.Ota.Firmware.RemoveAll(f => f.Version == version);
            _state.Ota.Firmware.Add(info);
            Save();
        }
        return info;
    }

    public string? DeleteFirmware(string version)
    {
        lock (_lock)
        {
            var fw = Fw(version);
            if (fw is null) return "firmware_not_found";
            if (_state.Ota.Released.Values.Contains(version)) return "firmware_released";
            if (_state.Groups.Values.Any(g => g.Target == version)) return "firmware_in_use";
            if (_state.Devices.Values.Any(d => ModeOf(d) == ModeOverride && d.FwOverride == version)) return "firmware_pinned";
            _state.Ota.Firmware.Remove(fw);
            try { File.Delete(FirmwarePath(fw)); } catch (IOException) { }
            Save();
            return null;
        }
    }

    /// <summary>Newest-first events (optionally for one device). Each device keeps only its newest <see cref="MaxEventsPerDevice"/>.</summary>
    public List<JsonElement> RecentEvents(string? device, int n)
    {
        n = Math.Clamp(n, 1, 1000);
        lock (_lock)
        {
            IEnumerable<string> files = device is null
                ? Directory.EnumerateFiles(_eventsDir, "*.jsonl")
                : ValidId(device) && File.Exists(EventsPath(device)) ? [EventsPath(device)] : [];
            var all = new List<(DateTimeOffset Rx, JsonElement E)>();
            foreach (var f in files)
                foreach (var line in File.ReadLines(f).Reverse())                 // newest first within a device
                {
                    try
                    {
                        var e = JsonDocument.Parse(line).RootElement.Clone();
                        var rx = e.TryGetProperty("rx", out var r) && r.TryGetDateTimeOffset(out var t) ? t : DateTimeOffset.MinValue;
                        all.Add((rx, e));
                    }
                    catch (JsonException) { }
                }
            return all.OrderByDescending(x => x.Rx).Take(n).Select(x => x.E).ToList();   // stable sort keeps same-batch order
        }
    }

    // ── internals ──
    private string EventsPath(string id) => Path.Combine(_eventsDir, id + ".jsonl");

    /// <summary>Rolling per-device log: append, then keep only the newest <see cref="MaxEventsPerDevice"/> lines.</summary>
    private void AppendEvents(string id, IEnumerable<ReportEvent> events)
    {
        var rx = DateTimeOffset.UtcNow;
        var lines = events.Select(e => JsonSerializer.Serialize(new
        {
            rx,
            device = id,
            ts = e.Ts is > 1_600_000_000 ? DateTimeOffset.FromUnixTimeSeconds(e.Ts.Value) : (DateTimeOffset?)null,
            type = Trunc(e.Type, 16) ?? "unknown",
            alarm_id = Trunc(e.AlarmId, 64),
            detail = Trunc(e.Detail, 200),
        }, LineOpts)).ToList();
        if (lines.Count > 0) WriteEvents(id, lines);
    }

    private void WriteEvents(string id, List<string> newLines)
    {
        var path = EventsPath(id);
        var old = File.Exists(path) ? File.ReadAllLines(path) : [];
        if (old.Length + newLines.Count <= MaxEventsPerDevice) { File.AppendAllLines(path, newLines); return; }
        var tmp = path + ".tmp";
        File.WriteAllLines(tmp, old.Concat(newLines).TakeLast(MaxEventsPerDevice));
        File.Move(tmp, path, overwrite: true);
    }

    /// <summary>Old single fleet/events.jsonl → per-device files (newest 100 each); the old file is kept as .migrated.</summary>
    private void MigrateLegacyEvents()
    {
        var legacy = Path.Combine(_root, "events.jsonl");
        if (!File.Exists(legacy)) return;
        try
        {
            var byDev = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var line in File.ReadLines(legacy))
            {
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    if (doc.RootElement.TryGetProperty("device", out var dv) && dv.GetString() is { } id && ValidId(id))
                    {
                        if (!byDev.TryGetValue(id, out var l)) byDev[id] = l = [];
                        l.Add(line);
                    }
                }
                catch (JsonException) { }
            }
            foreach (var (id, l) in byDev) WriteEvents(id, l.TakeLast(MaxEventsPerDevice).ToList());
            File.Move(legacy, legacy + ".migrated", overwrite: true);
        }
        catch (IOException) { }
    }

    private FleetState Load()
    {
        try
        {
            if (File.Exists(_statePath))
            {
                var s = JsonSerializer.Deserialize<FleetState>(File.ReadAllText(_statePath), JsonOpts);
                if (s is not null)
                {
                    s.Devices = new Dictionary<string, DeviceRecord>(s.Devices, StringComparer.Ordinal);
                    s.Groups = new Dictionary<string, FirmwareGroup>(s.Groups ?? new(), StringComparer.Ordinal);
                    s.Ota.Released = new Dictionary<string, string>(s.Ota.Released ?? new(), StringComparer.Ordinal);
                    // stable/beta channels and model tracks are gone: the admin groups devices instead.
                    // A pinned image becomes a personal override, channel "none" becomes hold.
                    foreach (var d in s.Devices.Values)
                    {
                        if (d.FwPin is { } pin) { d.FwMode = ModeOverride; d.FwOverride = pin[(pin.LastIndexOf('/') + 1)..]; }
                        else if (d.Channel == "none") d.FwMode = ModeHold;
                        if (string.IsNullOrEmpty(d.ReportedModel) && !string.IsNullOrEmpty(d.Model)) d.ReportedModel = d.Model;
                        d.FwPin = null; d.Channel = null; d.Model = null;
                    }
                    // images are identified by version now (the board is in the label): keep the newest per version
                    s.Ota.Firmware = (s.Ota.Firmware ?? new()).GroupBy(f => f.Version).Select(g => g.OrderByDescending(f => f.UploadedAt).First()).ToList();
                    s.Ota.Channels = null;
                    s.Ota.Tracks = null;
                    s.Wifi = null;                              // fleet-wide WiFi is gone: never served again
                    return EnsureAutoGroup(s);
                }
            }
        }
        catch (JsonException) { }
        return EnsureAutoGroup(new FleetState());
    }

    private static FleetState EnsureAutoGroup(FleetState s)
    {
        if (!s.Groups.ContainsKey(AutoGroupId))
            s.Groups[AutoGroupId] = new FirmwareGroup { Id = AutoGroupId, Name = "Auto patcher", CreatedAt = DateTimeOffset.UtcNow };
        return s;
    }

    private void Save()
    {
        var tmp = _statePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_state, JsonOpts));
        File.Move(tmp, _statePath, overwrite: true);
    }

    private static DeviceRecord Clone(DeviceRecord d) =>
        JsonSerializer.Deserialize<DeviceRecord>(JsonSerializer.Serialize(d, JsonOpts), JsonOpts)!;

    private static string? Trunc(string? s, int n) => s is null ? null : (s.Length <= n ? s : s[..n]);

    private static string? Mask(string? s) => string.IsNullOrEmpty(s) ? null : new string('•', Math.Max(0, s.Length - 2)) + s[^Math.Min(2, s.Length)..];

    // property present: value = string or null (explicit null clears)
    private static bool Str(JsonElement o, string name, out string? value)
    {
        value = null;
        if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty(name, out var v)) return false;
        if (v.ValueKind == JsonValueKind.String) { value = v.GetString(); return true; }
        return v.ValueKind == JsonValueKind.Null;
    }

    // optional int: absent = keep, null = clear, number in range = set; false = invalid
    private static bool OptInt(JsonElement o, string name, int min, int max, Action<int?> set)
    {
        if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty(name, out var v)) return true;
        if (v.ValueKind == JsonValueKind.Null) { set(null); return true; }
        if (v.TryGetInt32(out var i) && i >= min && i <= max) { set(i); return true; }
        return false;
    }
}
