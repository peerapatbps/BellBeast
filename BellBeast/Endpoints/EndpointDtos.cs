// Request DTOs bound by the minimal API handlers (moved from Program.cs; global namespace kept).

sealed class AdminLoginDto
{
    public string? Username { get; set; }
    public string? Password { get; set; }
}

sealed class IotJoinRequest
{
    public string? DeviceName { get; set; }
    public string? DeviceType { get; set; }
}

sealed class IotPollRequest
{
    public string? Key { get; set; }
}

sealed class IotCommandRequest
{
    public string? Raw { get; set; }
}

sealed class IotDataRequest
{
    public string? Key { get; set; }
    public Dictionary<string, System.Text.Json.JsonElement>? Data { get; set; }
}
