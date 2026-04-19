namespace BellBeast.Wayfarer;

public sealed record WayfarerSummary(
    int Total,
    int Waiting,
    int Scheduled,
    int InProgress,
    int Completed
);

public sealed record WayfarerWorkOrderListItem(
    long WoNo,
    string? DetailUrl,
    string? WoCode,
    string? WoDate,
    string? WoProblem,
    string? WoStatusCode,
    string? WoStatusName,
    string? WoTypeCode,
    long? EqNo,
    long? PuNo,
    string? DeptCode,
    string? TaskName,
    string? PuName,
    string? EqName,
    string? RequestPersonName,
    string? MaintenanceDeptName,
    string? ScheduledStart,
    string? ScheduledFinish,
    int? ScheduledDuration,
    string? ActualStart,
    string? ActualFinish,
    int? ActualDuration,
    int? WorkDuration,
    int? DowntimeDuration,
    string? CompleteDate,
    string? FetchedAtUtc
);

public sealed record WayfarerListResponse(
    int Page,
    int PageSize,
    int Total,
    WayfarerSummary Summary,
    IReadOnlyList<WayfarerWorkOrderListItem> Items
);

public sealed record WayfarerStatusFilter(string? Code, string? Name);
public sealed record WayfarerDeptFilter(string? Code, string? Name);

public sealed record WayfarerFilterResponse(
    IReadOnlyList<WayfarerStatusFilter> Statuses,
    IReadOnlyList<string> Types,
    IReadOnlyList<WayfarerDeptFilter> Departments,
    string? LatestFetchedAtUtc
);

public sealed record WayfarerDetailResponse(
    WayfarerWorkOrderListItem? Overview,
    IReadOnlyList<Dictionary<string, object?>> Tasks,
    IReadOnlyList<Dictionary<string, object?>> People,
    IReadOnlyList<Dictionary<string, object?>> History,
    IReadOnlyList<Dictionary<string, object?>> DamageFailure,
    IReadOnlyList<Dictionary<string, object?>> ActualManhrs,
    Dictionary<string, object?>? Flags
);

public sealed record WayfarerExportRequest(
    IReadOnlyList<long>? WoNos
);
