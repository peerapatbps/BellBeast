using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace BellBeast.Services;

/// <summary>
/// Annunciator fleet (iot-device_plan.md §4 / P4): device registry, per-device config, device reports (audit log)
/// and firmware OTA (manifest + binary, per-channel staged rollout).
///
/// Device identity: each device generates a random 32-byte key on first boot and sends it as <c>X-Device-Key</c>.
/// First contact registers the device as <b>pending</b> (trust on first use); an admin approves it in /Admin/Fleet.
/// Later calls must present the same key (only its sha256 is stored). WiFi credentials are served to approved
/// devices only — over plain HTTP on the plant LAN (BellBeast has no TLS), never logged, never in a URL.
///
/// Layout: App_Data/fleet/fleet.json (state) · fleet/events.jsonl (report log, trimmed) · fleet/ota/{version}.bin
/// </summary>
public sealed class DeviceFleetService
{
    public const string KeyHeader = "X-Device-Key";
    public const int MaxEventsPerReport = 64;
    public const long MaxFirmwareBytes = 0x3f0000;          // app partition size on the device (partitions/v2/16m.csv)
    public const long EventsFileCap = 4 * 1024 * 1024;

    private static readonly Regex IdRx = new("^[a-z0-9][a-z0-9-]{2,31}$", RegexOptions.Compiled);
    private static readonly Regex KeyRx = new("^[0-9a-f]{64}$", RegexOptions.Compiled);
    private static readonly Regex VersionRx = new("^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$", RegexOptions.Compiled);
    private static readonly Regex ZonesRx = new("^[A-Z0-9_]{1,16}(,[A-Z0-9_]{1,16}){0,15}$", RegexOptions.Compiled);
    private static readonly string[] Channels = ["stable", "beta", "none"];
    internal static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
    private static readonly JsonSerializerOptions LineOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    private readonly string _root;
    private readonly string _statePath;
    private readonly string _eventsPath;
    private readonly string _fwDir;
    private readonly object _lock = new();
    private FleetState _state;

    // ── persisted model ──
    public sealed class FleetState
    {
        public Dictionary<string, DeviceRecord> Devices { get; set; } = new(StringComparer.Ordinal);
        public FleetDefaults Defaults { get; set; } = new();
        public WifiCreds? Wifi { get; set; }
        public OtaState Ota { get; set; } = new();
    }

    public sealed class DeviceRecord
    {
        public string Id { get; set; } = "";
        public string? Name { get; set; }
        public string? KeySha256 { get; set; }
        public bool Approved { get; set; }
        public string? Zones { get; set; }            // null = fleet default
        public string? Channel { get; set; }          // null = fleet default
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
    }

    public sealed class FleetDefaults
    {
        public string Zones { get; set; } = "";
        public int PollSec { get; set; } = 5;
        public int RemindSec { get; set; } = 60;
        public int LabSec { get; set; } = 300;
        public int ScnSec { get; set; } = 30;
        public int? Volume { get; set; }
        public string Channel { get; set; } = "stable";
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
        public Dictionary<string, string?> Channels { get; set; } = new(StringComparer.Ordinal);
        public List<FirmwareInfo> Firmware { get; set; } = new();
    }

    public sealed record FirmwareInfo(string Version, string Sha256, long Size, DateTimeOffset UploadedAt, string? Note);

    // ── device-facing DTOs ──
    public sealed class ReportBody
    {
        public string? Fw { get; set; }
        public string? Ip { get; set; }
        public string? Partition { get; set; }
        public string? WifiTier { get; set; }
        public int? Rssi { get; set; }
        public long? UptimeSec { get; set; }
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
        _eventsPath = Path.Combine(_root, "events.jsonl");
        _fwDir = Path.Combine(_root, "ota");
        Directory.CreateDirectory(_fwDir);
        _state = Load();
    }

    public static bool ValidId(string? id) => id is not null && IdRx.IsMatch(id);
    public static bool ValidVersion(string? v) => v is not null && VersionRx.IsMatch(v);

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
            object? wifi = d.Approved && _state.Wifi is { } w && w.Current.Length > 0
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
                ["channel"] = d.Channel ?? def.Channel,
                ["wifi"] = wifi,
            };
            var etag = "\"" + Sha(JsonSerializer.Serialize(body))[..16] + "\"";
            body["etag"] = etag.Trim('"');
            return (body, etag);
        }
    }

    public (string Channel, FirmwareInfo? Firmware) ManifestFor(string? id)
    {
        lock (_lock)
        {
            var ch = id is not null && _state.Devices.TryGetValue(id, out var d) && d.Channel is not null ? d.Channel : _state.Defaults.Channel;
            if (ch == "none" || !_state.Ota.Channels.TryGetValue(ch, out var v) || v is null) return (ch, null);
            return (ch, _state.Ota.Firmware.FirstOrDefault(f => f.Version == v));
        }
    }

    public string FirmwarePath(string version) => Path.Combine(_fwDir, version + ".bin");

    public FirmwareInfo? GetFirmware(string version)
    {
        lock (_lock) return _state.Ota.Firmware.FirstOrDefault(f => f.Version == version);
    }

    // ── admin ──
    public object AdminView()
    {
        lock (_lock)
        {
            return new
            {
                ok = true,
                defaults = _state.Defaults,
                wifi = _state.Wifi is { } w ? new
                {
                    ssid = w.Ssid, identity = w.Identity, current = Mask(w.Current), next = Mask(w.Next),
                    next_valid_from = w.NextValidFrom, updated_at = w.UpdatedAt,
                } : null,
                ota = new { channels = _state.Ota.Channels, firmware = _state.Ota.Firmware.OrderByDescending(f => f.UploadedAt) },
                devices = _state.Devices.Values.OrderBy(d => d.Id, StringComparer.Ordinal).Select(d => new
                {
                    d.Id, d.Name, has_key = d.KeySha256 is not null, d.Approved, d.Zones, d.Channel, d.PollSec, d.RemindSec, d.LabSec, d.ScnSec, d.Volume,
                    d.CreatedAt, d.LastSeen, d.Fw, d.Ip, d.SeenIp, d.SeenAt, d.Partition, d.WifiTier, d.Rssi, d.UptimeSec,
                    d.LastPlayedAt, d.LastPlayedAlarm, d.LastAckAt, d.LastAckAlarm, d.LastFallbackAt, d.LastOta, d.Reports,
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
            if (Str(patch, "name", out var name)) d.Name = string.IsNullOrWhiteSpace(name) ? null : Trunc(name.Trim(), 60);
            if (patch.TryGetProperty("approved", out var ap) && ap.ValueKind is JsonValueKind.True or JsonValueKind.False) d.Approved = ap.GetBoolean();
            if (Str(patch, "zones", out var z))
            {
                if (z is null) d.Zones = null;
                else { var nz = NormalizeZones(z); if (nz is null) return "bad_zones"; d.Zones = nz; }
            }
            if (Str(patch, "channel", out var ch))
            {
                if (ch is not null && !Channels.Contains(ch)) return "bad_channel";
                d.Channel = ch;
            }
            if (!OptInt(patch, "poll_sec", 1, 60, v => d.PollSec = v)) return "bad_poll_sec";
            if (!OptInt(patch, "remind_sec", 0, 3600, v => d.RemindSec = v)) return "bad_remind_sec";
            if (!OptInt(patch, "lab_sec", 60, 3600, v => d.LabSec = v)) return "bad_lab_sec";
            if (!OptInt(patch, "scn_sec", 10, 600, v => d.ScnSec = v)) return "bad_scn_sec";
            if (!OptInt(patch, "volume", 0, 100, v => d.Volume = v)) return "bad_volume";
            if (patch.TryGetProperty("reset_key", out var rk) && rk.ValueKind == JsonValueKind.True) { d.KeySha256 = null; d.Approved = false; }
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
            return true;
        }
    }

    public string? UpdateDefaults(JsonElement patch)
    {
        lock (_lock)
        {
            var def = _state.Defaults;
            if (Str(patch, "zones", out var z)) { var nz = NormalizeZones(z); if (nz is null) return "bad_zones"; def.Zones = nz; }
            if (Str(patch, "channel", out var ch)) { if (ch is null || !Channels.Contains(ch)) return "bad_channel"; def.Channel = ch; }
            if (patch.TryGetProperty("poll_sec", out var p)) { if (!p.TryGetInt32(out var v) || v is < 1 or > 60) return "bad_poll_sec"; def.PollSec = v; }
            if (patch.TryGetProperty("remind_sec", out var r)) { if (!r.TryGetInt32(out var v) || v is < 0 or > 3600) return "bad_remind_sec"; def.RemindSec = v; }
            if (patch.TryGetProperty("lab_sec", out var lb)) { if (!lb.TryGetInt32(out var v) || v is < 60 or > 3600) return "bad_lab_sec"; def.LabSec = v; }
            if (patch.TryGetProperty("scn_sec", out var sn)) { if (!sn.TryGetInt32(out var v) || v is < 10 or > 600) return "bad_scn_sec"; def.ScnSec = v; }
            if (!OptInt(patch, "volume", 0, 100, v => def.Volume = v)) return "bad_volume";
            Save();
            return null;
        }
    }

    public string? UpdateWifi(JsonElement body)
    {
        lock (_lock)
        {
            if (body.TryGetProperty("clear", out var c) && c.ValueKind == JsonValueKind.True) { _state.Wifi = null; Save(); return null; }
            var w = _state.Wifi ?? new WifiCreds();
            if (Str(body, "ssid", out var ssid)) { if (string.IsNullOrWhiteSpace(ssid) || ssid.Length > 32) return "bad_ssid"; w.Ssid = ssid; }
            if (Str(body, "identity", out var ident)) w.Identity = Trunc(ident ?? "", 64)!;
            if (Str(body, "current", out var cur)) { if (string.IsNullOrEmpty(cur) || cur.Length > 63) return "bad_current"; w.Current = cur; }
            if (Str(body, "next", out var next)) { if (next is { Length: > 63 }) return "bad_next"; w.Next = string.IsNullOrEmpty(next) ? null : next; }
            if (body.TryGetProperty("next_valid_from", out var nvf))
            {
                if (nvf.ValueKind == JsonValueKind.Null) w.NextValidFrom = null;
                else if (nvf.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(nvf.GetString(), out var t)) w.NextValidFrom = t;
                else return "bad_next_valid_from";
            }
            if (w.Current.Length == 0) return "bad_current";
            w.UpdatedAt = DateTimeOffset.UtcNow;
            _state.Wifi = w;
            Save();
            return null;
        }
    }

    public string? SetChannel(string channel, string? version)
    {
        if (channel is not ("stable" or "beta")) return "bad_channel";
        lock (_lock)
        {
            if (version is not null && _state.Ota.Firmware.All(f => f.Version != version)) return "firmware_not_found";
            _state.Ota.Channels[channel] = version;
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
    /// what it runs, so a mismatch would make it reinstall the same image forever.
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
            File.WriteAllBytes(FirmwarePath(version), bin);
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
            if (_state.Ota.Channels.Values.Contains(version)) return "firmware_in_use";
            if (_state.Ota.Firmware.RemoveAll(f => f.Version == version) == 0) return "firmware_not_found";
            try { File.Delete(FirmwarePath(version)); } catch (IOException) { }
            Save();
            return null;
        }
    }

    /// <summary>Newest-first events (optionally for one device).</summary>
    public List<JsonElement> RecentEvents(string? device, int n)
    {
        n = Math.Clamp(n, 1, 1000);
        lock (_lock)
        {
            if (!File.Exists(_eventsPath)) return [];
            var result = new List<JsonElement>();
            foreach (var line in File.ReadLines(_eventsPath).Reverse())
            {
                if (result.Count >= n) break;
                try
                {
                    var e = JsonDocument.Parse(line).RootElement.Clone();
                    if (device is null || (e.TryGetProperty("device", out var dv) && dv.GetString() == device)) result.Add(e);
                }
                catch (JsonException) { }
            }
            return result;
        }
    }

    // ── internals ──
    private void AppendEvents(string id, IEnumerable<ReportEvent> events)
    {
        var rx = DateTimeOffset.UtcNow;
        var sb = new StringBuilder();
        foreach (var e in events)
        {
            sb.Append(JsonSerializer.Serialize(new
            {
                rx,
                device = id,
                ts = e.Ts is > 1_600_000_000 ? DateTimeOffset.FromUnixTimeSeconds(e.Ts.Value) : (DateTimeOffset?)null,
                type = Trunc(e.Type, 16) ?? "unknown",
                alarm_id = Trunc(e.AlarmId, 64),
                detail = Trunc(e.Detail, 200),
            }, LineOpts)).Append('\n');
        }
        if (sb.Length == 0) return;
        File.AppendAllText(_eventsPath, sb.ToString());
        var fi = new FileInfo(_eventsPath);
        if (fi.Length > EventsFileCap)
        {
            var lines = File.ReadAllLines(_eventsPath);
            File.WriteAllLines(_eventsPath, lines.Skip(lines.Length / 2));      // keep the newer half
        }
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
                    return s;
                }
            }
        }
        catch (JsonException) { }
        return new FleetState();
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
