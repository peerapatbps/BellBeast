using System.Collections.Concurrent;
using System.Text.Json;

namespace BellBeast.Services;

public sealed class IotDevice
{
    public string Key { get; init; } = "";
    public string DeviceName { get; init; } = "";
    public string DeviceType { get; init; } = "";
    public DateTimeOffset LastSeen { get; set; }
    public bool IsOnline => DateTimeOffset.UtcNow - LastSeen < TimeSpan.FromMinutes(5);
    // telemetry posted by the device itself
    public Dictionary<string, JsonElement> State { get; set; } = new();
    public DateTimeOffset? StateUpdatedAt { get; set; }
}

public sealed class IotCommand
{
    public string CommandType { get; init; } = "";
    public string Value { get; init; } = "";
    public DateTimeOffset IssuedAt { get; init; }
}

public sealed class IotRoomLogEntry
{
    public string Kind { get; init; } = ""; // "join" | "command" | "expire" | "reconnect" | "data"
    public string Message { get; init; } = "";
    public DateTimeOffset At { get; init; }
}

public sealed class IotRoomService
{
    private readonly ConcurrentDictionary<string, IotDevice> _devices = new();
    // key = device key, value = latest pending command (overwrite on new command)
    private readonly ConcurrentDictionary<string, IotCommand> _pendingCommands = new();
    private readonly object _logLock = new();
    private readonly List<IotRoomLogEntry> _log = new();
    private const int MaxLogEntries = 200;
    private const int TimeoutMinutes = 5;

    public (string key, bool isNew) JoinOrRejoin(string deviceName, string deviceType)
    {
        ExpireStale();

        // ถ้า device ชื่อเดิมยัง online อยู่ → return key เดิม
        var existing = _devices.Values
            .FirstOrDefault(d => d.DeviceName.Equals(deviceName, StringComparison.OrdinalIgnoreCase) && d.IsOnline);

        if (existing is not null)
        {
            existing.LastSeen = DateTimeOffset.UtcNow;
            return (existing.Key, false);
        }

        var key = "iot-" + Guid.NewGuid().ToString("N")[..16];
        var device = new IotDevice
        {
            Key = key,
            DeviceName = deviceName,
            DeviceType = deviceType,
            LastSeen = DateTimeOffset.UtcNow
        };
        _devices[key] = device;

        AddLog("join", $"{deviceName} ({deviceType}) joined the room");
        return (key, true);
    }

    // Returns (status, command?) — status: "ok" | "reconnect"
    public (string status, IotCommand? command) Poll(string key)
    {
        ExpireStale();

        if (!_devices.TryGetValue(key, out var device))
            return ("reconnect", null);

        device.LastSeen = DateTimeOffset.UtcNow;

        _pendingCommands.TryRemove(key, out var cmd);
        return ("ok", cmd);
    }

    public bool SendCommand(string deviceName, string commandType, string value)
    {
        ExpireStale();

        var device = _devices.Values
            .FirstOrDefault(d => d.DeviceName.Equals(deviceName, StringComparison.OrdinalIgnoreCase) && d.IsOnline);

        if (device is null)
            return false;

        _pendingCommands[device.Key] = new IotCommand
        {
            CommandType = commandType,
            Value = value,
            IssuedAt = DateTimeOffset.UtcNow
        };

        AddLog("command", $"Host → {deviceName}: {commandType} = {value}");
        return true;
    }

    public IReadOnlyList<object> GetMembers()
    {
        ExpireStale();
        return _devices.Values
            .OrderBy(d => d.DeviceName)
            .Select(d => (object)new
            {
                name = d.DeviceName,
                type = d.DeviceType,
                online = d.IsOnline,
                lastSeenAgo = (int)(DateTimeOffset.UtcNow - d.LastSeen).TotalSeconds,
                stateUpdatedAt = d.StateUpdatedAt,
                state = d.State
            })
            .ToList();
    }

    // Device posts its own telemetry; replaces state entirely
    public (bool ok, string? error) PostData(string key, Dictionary<string, JsonElement> data)
    {
        if (!_devices.TryGetValue(key, out var device))
            return (false, "Device key not found or expired — please rejoin");

        device.State = data;
        device.StateUpdatedAt = DateTimeOffset.UtcNow;
        device.LastSeen = DateTimeOffset.UtcNow;

        var summary = string.Join(", ", data.Keys.Take(5));
        if (data.Count > 5) summary += $" (+{data.Count - 5} more)";
        AddLog("data", $"{device.DeviceName} posted data: {summary}");

        return (true, null);
    }

    // Returns all devices with their state; optionally filtered by key or name
    public IReadOnlyList<object> GetDeviceData(string? key = null, string? deviceName = null)
    {
        ExpireStale();
        var query = _devices.Values.AsEnumerable();
        if (key is not null)
            query = query.Where(d => d.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
        else if (deviceName is not null)
            query = query.Where(d => d.DeviceName.Equals(deviceName, StringComparison.OrdinalIgnoreCase));

        return query
            .OrderBy(d => d.DeviceName)
            .Select(d => (object)new
            {
                name = d.DeviceName,
                type = d.DeviceType,
                online = d.IsOnline,
                stateUpdatedAt = d.StateUpdatedAt,
                state = d.State
            })
            .ToList();
    }

    // Full snapshot for dashboard: members + pending command flags + log
    public object GetSnapshot(int logLast = 50)
    {
        ExpireStale();
        var members = _devices.Values
            .OrderBy(d => d.DeviceName)
            .Select(d => (object)new
            {
                name = d.DeviceName,
                type = d.DeviceType,
                online = d.IsOnline,
                lastSeenAgo = (int)(DateTimeOffset.UtcNow - d.LastSeen).TotalSeconds,
                hasPendingCommand = _pendingCommands.ContainsKey(d.Key),
                stateUpdatedAt = d.StateUpdatedAt,
                state = d.State
            })
            .ToList();

        var log = GetLog(logLast);
        return new { at = DateTimeOffset.UtcNow, members, log };
    }

    public IReadOnlyList<IotRoomLogEntry> GetLog(int last = 50)
    {
        lock (_logLock)
        {
            var count = _log.Count;
            var skip = Math.Max(0, count - last);
            return _log.Skip(skip).ToList();
        }
    }

    private void ExpireStale()
    {
        var cutoff = DateTimeOffset.UtcNow.AddMinutes(-TimeoutMinutes);
        foreach (var kv in _devices)
        {
            if (kv.Value.LastSeen < cutoff)
            {
                if (_devices.TryRemove(kv.Key, out var removed))
                {
                    _pendingCommands.TryRemove(kv.Key, out _);
                    AddLog("expire", $"{removed.DeviceName} ({removed.DeviceType}) timed out — hand check lost");
                }
            }
        }
    }

    private void AddLog(string kind, string message)
    {
        lock (_logLock)
        {
            _log.Add(new IotRoomLogEntry { Kind = kind, Message = message, At = DateTimeOffset.UtcNow });
            if (_log.Count > MaxLogEntries)
                _log.RemoveAt(0);
        }
    }
}
