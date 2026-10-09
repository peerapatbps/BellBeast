using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace BellBeast.Services;

/// <summary>
/// Audio clip library for annunciator devices (Overview §3.3).
/// Every clip is stored as raw PCM16 24 kHz mono little-endian — the device codec format (ES8311),
/// so the device plays bytes as-is without resampling. Uploads (WAV) are converted on the way in.
///
/// Layout: App_Data/audio/clips/{id}.pcm + App_Data/audio/manifest.json (version + sha256 per clip).
/// Optional App_Data/audio/vocab.json [{ "id": "...", "text": "..." }] adds/overrides required vocabulary.
/// Version bumps only when the audio bytes change, so devices can cache by sha256 / version.
/// </summary>
public sealed class AudioLibraryService
{
    public const int SampleRate = 24000;
    public const int MaxClipSeconds = 30;
    public const int MaxUploadBytes = 10 * 1024 * 1024;

    private static readonly Regex IdRx = new("^[a-z0-9_]{1,64}$", RegexOptions.Compiled);
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    private readonly string _root;
    private readonly string _clipDir;
    private readonly string _manifestPath;
    private readonly object _lock = new();
    private Dictionary<string, ClipInfo> _clips;

    public sealed record ClipInfo(string Id, int Version, string Sha256, long Bytes, int DurationMs, string Source, string? Text, DateTimeOffset UpdatedAt);
    public sealed record VocabItem(string Id, string Text, string Group);

    public AudioLibraryService(IWebHostEnvironment env)
    {
        _root = Path.Combine(env.ContentRootPath, "App_Data", "audio");
        _clipDir = Path.Combine(_root, "clips");
        _manifestPath = Path.Combine(_root, "manifest.json");
        Directory.CreateDirectory(_clipDir);
        _clips = LoadManifest();
    }

    /// <summary>Lower-cases, drops an "@v3" version suffix; null when the id is not [a-z0-9_]{1,64}.</summary>
    public static string? NormalizeId(string? id)
    {
        var s = (id ?? "").Trim().ToLowerInvariant();
        var at = s.IndexOf('@');
        if (at >= 0) s = s[..at];
        return IdRx.IsMatch(s) ? s : null;
    }

    public IReadOnlyList<ClipInfo> List()
    {
        lock (_lock) return _clips.Values.OrderBy(c => c.Id, StringComparer.Ordinal).ToList();
    }

    public ClipInfo? Get(string id)
    {
        lock (_lock) return _clips.TryGetValue(id, out var c) ? c : null;
    }

    public byte[]? ReadPcm(string id)
    {
        if (Get(id) is null) return null;
        var path = ClipPath(id);
        return File.Exists(path) ? File.ReadAllBytes(path) : null;
    }

    /// <summary>Stores PCM16/24k/mono bytes under <paramref name="id"/>. Same bytes as the current version = no bump.</summary>
    public ClipInfo Save(string id, byte[] pcm, string source, string? text)
    {
        if (pcm.Length < 2 || pcm.Length % 2 != 0) throw new AudioFormatException("empty or odd-length PCM16 data");
        var durationMs = (int)(pcm.Length / 2 * 1000L / SampleRate);
        if (durationMs > MaxClipSeconds * 1000) throw new AudioFormatException($"clip is {durationMs / 1000.0:0.0}s, limit {MaxClipSeconds}s");

        var sha = Convert.ToHexString(SHA256.HashData(pcm)).ToLowerInvariant();
        lock (_lock)
        {
            _clips.TryGetValue(id, out var old);
            if (old is not null && old.Sha256 == sha && File.Exists(ClipPath(id)))
            {
                if (old.Text == text && old.Source == source) return old;
                var relabeled = old with { Text = text, Source = source };
                _clips[id] = relabeled;
                SaveManifest();
                return relabeled;
            }

            WriteAtomic(ClipPath(id), pcm);
            var info = new ClipInfo(id, (old?.Version ?? 0) + 1, sha, pcm.Length, durationMs, source, text, DateTimeOffset.UtcNow);
            _clips[id] = info;
            SaveManifest();
            return info;
        }
    }

    public bool Delete(string id)
    {
        lock (_lock)
        {
            if (!_clips.Remove(id)) return false;
            try { File.Delete(ClipPath(id)); } catch (IOException) { }
            SaveManifest();
            return true;
        }
    }

    /// <summary>Clip-ids the alarm engine expects (Uroboros_progress §2.6) + App_Data/audio/vocab.json.</summary>
    public IReadOnlyList<VocabItem> Vocabulary()
    {
        var map = new Dictionary<string, VocabItem>(StringComparer.Ordinal);
        foreach (var v in DefaultVocabulary) map[v.Id] = v;

        var path = Path.Combine(_root, "vocab.json");
        if (File.Exists(path))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(path), new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var e in doc.RootElement.EnumerateArray())
                    {
                        if (e.ValueKind != JsonValueKind.Object) continue;
                        var id = NormalizeId(e.TryGetProperty("id", out var i) ? i.GetString() : null);
                        if (id is null) continue;
                        var text = e.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                        var group = e.TryGetProperty("group", out var g) ? g.GetString() ?? "custom" : "custom";
                        map[id] = new VocabItem(id, text, group);
                    }
                }
            }
            catch (JsonException) { /* broken override file: fall back to defaults */ }
        }
        return map.Values.ToList();
    }

    // ── WAV / PCM conversion ────────────────────────────────────────────────

    /// <summary>
    /// Accepts a RIFF/WAVE file (PCM 16-bit, mono or stereo, any sample rate → downmixed + resampled to 24 kHz)
    /// or raw ".pcm" bytes that are already PCM16 24 kHz mono.
    /// </summary>
    public static byte[] ToDevicePcm(byte[] data, string? fileName)
    {
        if (data.Length >= 12 && Encoding.ASCII.GetString(data, 0, 4) == "RIFF" && Encoding.ASCII.GetString(data, 8, 4) == "WAVE")
            return FromWav(data);

        if ((fileName ?? "").EndsWith(".pcm", StringComparison.OrdinalIgnoreCase))
        {
            if (data.Length % 2 != 0) throw new AudioFormatException("raw .pcm must be PCM16 (even byte count)");
            return data;
        }

        throw new AudioFormatException("unsupported file — upload WAV (PCM 16-bit) or raw .pcm (PCM16 24 kHz mono). " +
                                       "Convert mp3/m4a with: ffmpeg -i in.mp3 -ac 1 -ar 24000 -sample_fmt s16 out.wav");
    }

    private static byte[] FromWav(byte[] d)
    {
        int pos = 12, channels = 0, rate = 0, bits = 0, format = 0;
        int dataOff = -1, dataLen = 0;
        while (pos + 8 <= d.Length)
        {
            var id = Encoding.ASCII.GetString(d, pos, 4);
            var len = BinaryPrimitives.ReadInt32LittleEndian(d.AsSpan(pos + 4));
            var body = pos + 8;
            if (len < 0 || body > d.Length) break;
            if (id == "fmt " && len >= 16 && body + 16 <= d.Length)
            {
                format = BinaryPrimitives.ReadUInt16LittleEndian(d.AsSpan(body));
                channels = BinaryPrimitives.ReadUInt16LittleEndian(d.AsSpan(body + 2));
                rate = BinaryPrimitives.ReadInt32LittleEndian(d.AsSpan(body + 4));
                bits = BinaryPrimitives.ReadUInt16LittleEndian(d.AsSpan(body + 14));
                if (format == 0xFFFE && len >= 26 && body + 26 <= d.Length)
                    format = BinaryPrimitives.ReadUInt16LittleEndian(d.AsSpan(body + 24)); // WAVE_FORMAT_EXTENSIBLE sub-format
            }
            else if (id == "data")
            {
                dataOff = body;
                dataLen = Math.Min(len, d.Length - body); // tolerate truncated / streaming headers
                break;
            }
            pos = body + len + (len & 1);
        }

        if (format != 1 || bits != 16) throw new AudioFormatException($"WAV must be PCM 16-bit (got format {format}, {bits}-bit) — re-export as 16-bit PCM");
        if (channels is < 1 or > 2) throw new AudioFormatException($"WAV must be mono or stereo (got {channels} channels)");
        if (rate is < 8000 or > 192000) throw new AudioFormatException($"unsupported sample rate {rate}");
        if (dataOff < 0 || dataLen < 2) throw new AudioFormatException("WAV has no audio data");

        var frames = dataLen / (2 * channels);
        var mono = new short[frames];
        for (var i = 0; i < frames; i++)
        {
            var o = dataOff + i * 2 * channels;
            int s = BinaryPrimitives.ReadInt16LittleEndian(d.AsSpan(o));
            if (channels == 2) s = (s + BinaryPrimitives.ReadInt16LittleEndian(d.AsSpan(o + 2))) / 2;
            mono[i] = (short)s;
        }

        var outSamples = rate == SampleRate ? mono : Resample(mono, rate, SampleRate);
        var pcm = new byte[outSamples.Length * 2];
        for (var i = 0; i < outSamples.Length; i++)
            BinaryPrimitives.WriteInt16LittleEndian(pcm.AsSpan(i * 2), outSamples[i]);
        return pcm;
    }

    /// <summary>Linear interpolation — good enough for speech prompts.</summary>
    private static short[] Resample(short[] src, int fromRate, int toRate)
    {
        if (src.Length == 0) return src;
        var n = (int)((long)src.Length * toRate / fromRate);
        var dst = new short[Math.Max(1, n)];
        var step = (double)fromRate / toRate;
        for (var i = 0; i < dst.Length; i++)
        {
            var x = i * step;
            var i0 = (int)x;
            var i1 = Math.Min(i0 + 1, src.Length - 1);
            var f = x - i0;
            dst[i] = (short)Math.Round(src[Math.Min(i0, src.Length - 1)] * (1 - f) + src[i1] * f);
        }
        return dst;
    }

    /// <summary>44-byte WAV header around device PCM — for previewing in a browser.</summary>
    public static byte[] WrapWav(byte[] pcm)
    {
        var w = new byte[44 + pcm.Length];
        var s = w.AsSpan();
        Encoding.ASCII.GetBytes("RIFF").CopyTo(s);
        BinaryPrimitives.WriteInt32LittleEndian(s[4..], 36 + pcm.Length);
        Encoding.ASCII.GetBytes("WAVEfmt ").CopyTo(s[8..]);
        BinaryPrimitives.WriteInt32LittleEndian(s[16..], 16);
        BinaryPrimitives.WriteInt16LittleEndian(s[20..], 1);             // PCM
        BinaryPrimitives.WriteInt16LittleEndian(s[22..], 1);             // mono
        BinaryPrimitives.WriteInt32LittleEndian(s[24..], SampleRate);
        BinaryPrimitives.WriteInt32LittleEndian(s[28..], SampleRate * 2);
        BinaryPrimitives.WriteInt16LittleEndian(s[32..], 2);
        BinaryPrimitives.WriteInt16LittleEndian(s[34..], 16);
        Encoding.ASCII.GetBytes("data").CopyTo(s[36..]);
        BinaryPrimitives.WriteInt32LittleEndian(s[40..], pcm.Length);
        pcm.CopyTo(s[44..]);
        return w;
    }

    /// <summary>Stable id for an on-demand sentence clip (audio_mode A): same text + voice → same clip.</summary>
    public static string SentenceId(string text, string voice)
        => "tts_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(voice + "|" + text.Trim()))).ToLowerInvariant()[..12];

    /// <summary>clip-ids referenced by playlists in the current alarm payload (to spot ones the library lacks).</summary>
    public static IReadOnlyCollection<string> PlaylistIds(Dictionary<string, JsonElement>? alarmState)
    {
        var ids = new SortedSet<string>(StringComparer.Ordinal);
        if (alarmState is null || !alarmState.TryGetValue("alarms", out var arr) || arr.ValueKind != JsonValueKind.Array) return ids;
        foreach (var a in arr.EnumerateArray())
        {
            if (a.ValueKind != JsonValueKind.Object || !a.TryGetProperty("playlist", out var pl) || pl.ValueKind != JsonValueKind.Array) continue;
            foreach (var p in pl.EnumerateArray())
                if (p.ValueKind == JsonValueKind.String && NormalizeId(p.GetString()) is { } id) ids.Add(id);
        }
        return ids;
    }

    // ── persistence ─────────────────────────────────────────────────────────

    private string ClipPath(string id) => Path.Combine(_clipDir, id + ".pcm");

    private Dictionary<string, ClipInfo> LoadManifest()
    {
        if (!File.Exists(_manifestPath)) return new(StringComparer.Ordinal);
        try
        {
            var list = JsonSerializer.Deserialize<List<ClipInfo>>(File.ReadAllText(_manifestPath), JsonOpts) ?? new();
            return list.Where(c => NormalizeId(c.Id) == c.Id).ToDictionary(c => c.Id, StringComparer.Ordinal);
        }
        catch (JsonException)
        {
            // keep the broken file for inspection instead of silently overwriting it
            File.Copy(_manifestPath, _manifestPath + ".broken-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture), overwrite: true);
            return new(StringComparer.Ordinal);
        }
    }

    private void SaveManifest()
        => WriteAtomic(_manifestPath, JsonSerializer.SerializeToUtf8Bytes(_clips.Values.OrderBy(c => c.Id, StringComparer.Ordinal), JsonOpts));

    private static void WriteAtomic(string path, byte[] bytes)
    {
        var tmp = path + ".tmp";
        File.WriteAllBytes(tmp, bytes);
        File.Move(tmp, path, overwrite: true);
    }

    // ── default vocabulary (Uroboros alarm_rules.json, 2026-10-06) ──────────
    // Point-name ids are still provisional on the Uroboros side; rename there and here together.

    private static readonly VocabItem[] DefaultVocabulary = BuildDefaults();

    private static VocabItem[] BuildDefaults()
    {
        var v = new List<VocabItem>();
        string[] digits = { "ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า" };
        for (var i = 0; i < 10; i++) v.Add(new($"n_{i}", digits[i], "number"));
        v.Add(new("dot", "จุด", "number"));
        v.Add(new("neg", "ลบ", "number"));

        v.Add(new("s_flow_abnormal", "อัตราไหลผิดปกติ", "word"));
        v.Add(new("s_latest_value", "ค่าล่าสุด", "word"));
        v.Add(new("s_low", "ต่ำกว่าเกณฑ์", "word"));
        v.Add(new("s_high", "สูงกว่าเกณฑ์", "word"));
        v.Add(new("s_m3h", "ลูกบาศก์เมตรต่อชั่วโมง", "unit"));
        v.Add(new("s_bar", "บาร์", "unit"));
        v.Add(new("s_ppm", "พีพีเอ็ม", "unit"));

        v.Add(new("s_rwp1_flowp1", "สถานีน้ำดิบ 1 ปั๊มชุด P1", "point"));
        v.Add(new("s_rwp1_flowp2", "สถานีน้ำดิบ 1 ปั๊มชุด P2", "point"));
        v.Add(new("s_rwp2_flowp3", "สถานีน้ำดิบ 2 ปั๊มชุด P3", "point"));
        v.Add(new("s_rwp2_flowp4", "สถานีน้ำดิบ 2 ปั๊มชุด P4", "point"));
        v.Add(new("s_dps_flowa", "สถานีจ่ายน้ำ สาย A", "point"));
        v.Add(new("s_dps_flowb", "สถานีจ่ายน้ำ สาย B", "point"));
        v.Add(new("s_tps_flow", "สถานีผลิต อัตราไหลรวม", "point"));
        v.Add(new("s_dps_airp1_low", "แอร์คอมเพรสเซอร์ AirP1", "point"));
        v.Add(new("s_dps_airp2_low", "แอร์คอมเพรสเซอร์ AirP2", "point"));
        v.Add(new("s_dps_svwater_flow_low", "น้ำใช้ในโรงงาน", "point"));
        foreach (var chem in new[] { 1, 2 })
            foreach (var p in new[] { "s1", "s2", "s3", "s4", "d1", "d2" })
                v.Add(new($"s_chem{chem}_cl_{p}_high", $"เครื่องตรวจจับคลอรีน เคม {chem} จุด {p.ToUpperInvariant()}", "point"));
        return v.ToArray();
    }
}

public sealed class AudioFormatException(string message) : Exception(message);
