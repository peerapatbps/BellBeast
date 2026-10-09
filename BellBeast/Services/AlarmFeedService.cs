using System.Text.Json;

namespace BellBeast.Services;

/// <summary>
/// Turns the level-based alarm payload that Uroboros posts into the IoT room
/// (device "uroboros-alarm", Data = { alarm_mode, emitted_at, alarms[] }) into a
/// zone-filtered view a device (or the monitor page) can poll.
///
/// Uroboros sends the FULL current state every ~30 s, so this is stateless:
/// whatever the last post says is the truth. Acknowledging is the device's own job;
/// nothing flows back to Uroboros.
/// </summary>
public static class AlarmFeedService
{
    /// <summary>Room device name the Uroboros alarm engine joins with (env ALARM_DEVICE_NAME on its side).</summary>
    public const string EngineDeviceName = "uroboros-alarm";

    /// <summary>No post from the engine for this long = "engine stale" (device should show a link-lost warning, not silence).</summary>
    public const int DefaultStaleSec = 120;

    public static string[] ParseZones(string? zoneQuery)
        => (zoneQuery ?? "")
            .Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(z => z.ToUpperInvariant())
            .Distinct()
            .ToArray();

    /// <param name="zones">empty = all zones. Alarms with no zone are broadcast to everyone.</param>
    public static object Build(
        Dictionary<string, JsonElement>? state,
        DateTimeOffset? updatedAt,
        bool online,
        DateTimeOffset now,
        IReadOnlyCollection<string> zones,
        int staleSec = DefaultStaleSec)
    {
        if (state is null || updatedAt is null)
        {
            // engine never joined (or expired from the room): say so explicitly
            return new
            {
                ok = true,
                engine_online = false,
                engine_stale = true,
                alarm_mode = (string?)null,
                emitted_at = (string?)null,
                age_sec = (int?)null,
                zones,
                active_count = 0,
                alarms = Array.Empty<JsonElement>(),
            };
        }

        var age = (int)Math.Max(0, (now - updatedAt.Value).TotalSeconds);
        var stale = !online || age > staleSec;

        string? mode = state.TryGetValue("alarm_mode", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
        string? emittedAt = state.TryGetValue("emitted_at", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;

        var alarms = new List<JsonElement>();
        if (state.TryGetValue("alarms", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var a in arr.EnumerateArray())
            {
                if (a.ValueKind != JsonValueKind.Object) continue;
                if (zones.Count > 0)
                {
                    var zone = a.TryGetProperty("zone", out var z) && z.ValueKind == JsonValueKind.String
                        ? (z.GetString() ?? "").Trim().ToUpperInvariant() : "";
                    if (zone.Length > 0 && !zones.Contains(zone)) continue;
                }
                alarms.Add(a.Clone());
            }
        }

        var active = alarms.Count(a => a.TryGetProperty("active", out var v) && v.ValueKind == JsonValueKind.True);

        return new
        {
            ok = true,
            engine_online = online,
            engine_stale = stale,
            alarm_mode = mode,
            emitted_at = emittedAt,
            age_sec = (int?)age,
            zones,
            active_count = active,
            alarms,
        };
    }
}
