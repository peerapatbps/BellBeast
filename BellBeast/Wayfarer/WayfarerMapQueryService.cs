using System.Globalization;
using Microsoft.Data.Sqlite;

namespace BellBeast.Wayfarer;

public sealed class WayfarerMapQueryService
{
    private readonly string _dbPath;
    private readonly string _metaDbPath;

    public WayfarerMapQueryService(IConfiguration configuration, IWebHostEnvironment env)
    {
        _dbPath = ResolveDbPath(configuration, env);
        _metaDbPath = ResolveMetaDbPath(configuration, env);
    }

    public async Task<IReadOnlyList<WayfarerMapBranchSummary>> GetMapSummaryAsync(
        string? from,
        string? to,
        IReadOnlyCollection<string> statusGroups,
        CancellationToken ct)
    {
        await using var conn = await OpenReadOnlyAsync(ct);
        await using var cmd = conn.CreateCommand();

        var filters = new List<string>
        {
            "b.branch_pu_code IS NOT NULL",
            "b.branch_pu_code <> ''",
            "b.branch_pu_code LIKE 'WPS-MH01-%'"
        };

        if (IsIsoDate(from))
        {
            filters.Add("date(i.wo_date) >= date(@from)");
            cmd.Parameters.AddWithValue("@from", from);
        }

        if (IsIsoDate(to))
        {
            filters.Add("date(i.wo_date) <= date(@to)");
            cmd.Parameters.AddWithValue("@to", to);
        }

        var statusPredicate = BuildStatusGroupPredicate(statusGroups, "COALESCE(s.wo_status_code, i.wo_status_code)", "s.complete_date");
        if (!string.IsNullOrWhiteSpace(statusPredicate))
            filters.Add(statusPredicate);

        var where = "WHERE " + string.Join(" AND ", filters);

        cmd.CommandText = $"""
            WITH branch_lookup AS (
                SELECT
                    puNo,
                    COALESCE(branch1PuCode, rootPuCode, puCode) AS branch_pu_code
                FROM meta.meta_pu_branches
            )
            SELECT
                b.branch_pu_code AS puCode,
                COUNT(*) AS total,
                SUM(CASE WHEN COALESCE(s.wo_status_code, i.wo_status_code) IN ('10','15','20') THEN 1 ELSE 0 END) AS waiting,
                SUM(CASE WHEN COALESCE(s.wo_status_code, i.wo_status_code) = '30' THEN 1 ELSE 0 END) AS scheduled,
                SUM(CASE WHEN COALESCE(s.wo_status_code, i.wo_status_code) = '50' THEN 1 ELSE 0 END) AS inProgress,
                SUM(CASE WHEN COALESCE(s.wo_status_code, i.wo_status_code) IN ('70','80','99') OR s.complete_date IS NOT NULL THEN 1 ELSE 0 END) AS completed
            FROM pm_wo_index i
            INNER JOIN branch_lookup b ON b.puNo = i.pu_no
            LEFT JOIN pm_wo_schedule_status s ON s.wo_no = i.wo_no
            {where}
            GROUP BY b.branch_pu_code
            ORDER BY b.branch_pu_code
            """;

        var items = new List<WayfarerMapBranchSummary>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            items.Add(new WayfarerMapBranchSummary(
                PuCode: GetString(reader, "puCode") ?? "",
                Total: GetInt(reader, "total") ?? 0,
                Waiting: GetInt(reader, "waiting") ?? 0,
                Scheduled: GetInt(reader, "scheduled") ?? 0,
                InProgress: GetInt(reader, "inProgress") ?? 0,
                Completed: GetInt(reader, "completed") ?? 0
            ));
        }

        return items;
    }

    public async Task<WayfarerListResponse> GetBranchWorkOrdersAsync(
        string puCode,
        string? from,
        string? to,
        IReadOnlyCollection<string> statusGroups,
        CancellationToken ct)
    {
        await using var conn = await OpenReadOnlyAsync(ct);
        var parameters = new Dictionary<string, object?>
        {
            ["@puCode"] = puCode
        };

        var filters = new List<string>
        {
            "1 = 1",
            "b.branch_pu_code = @puCode"
        };

        if (IsIsoDate(from))
        {
            filters.Add("date(i.wo_date) >= date(@from)");
            parameters["@from"] = from;
        }

        if (IsIsoDate(to))
        {
            filters.Add("date(i.wo_date) <= date(@to)");
            parameters["@to"] = to;
        }

        var statusPredicate = BuildStatusGroupPredicate(statusGroups, "COALESCE(s.wo_status_code, i.wo_status_code)", "s.complete_date");
        if (!string.IsNullOrWhiteSpace(statusPredicate))
            filters.Add(statusPredicate);

        var where = "WHERE " + string.Join(" AND ", filters);
        const string branchFrom = """
            FROM pm_wo_index i
            INNER JOIN (
                SELECT
                    puNo,
                    COALESCE(branch1PuCode, rootPuCode, puCode) AS branch_pu_code,
                    COALESCE(branch1PuName, rootPuName, puName) AS branch_pu_name
                FROM meta.meta_pu_branches
            ) b ON b.puNo = i.pu_no
            LEFT JOIN meta.meta_departments dep ON dep.deptCode = i.dept_code
            LEFT JOIN pm_wo_schedule_status s ON s.wo_no = i.wo_no
            LEFT JOIN (
                SELECT * FROM (
                    SELECT
                        t.*,
                        ROW_NUMBER() OVER (PARTITION BY t.wo_no ORDER BY COALESCE(t.task_order, 999999), t.wo_task_no) AS rn
                    FROM pm_wo_task t
                ) tx WHERE tx.rn = 1
            ) t ON t.wo_no = i.wo_no
            LEFT JOIN (
                SELECT wo_no, MAX(person_name) AS request_person_name
                FROM pm_wo_people_departments
                WHERE role_type = 'request_person'
                GROUP BY wo_no
            ) req ON req.wo_no = i.wo_no
            LEFT JOIN (
                SELECT wo_no, MAX(dept_name) AS maintenance_dept_name
                FROM pm_wo_people_departments
                WHERE role_type = 'maintenance_dept'
                GROUP BY wo_no
            ) md ON md.wo_no = i.wo_no
            """;

        var total = await ExecuteScalarIntAsync(conn, $"SELECT COUNT(*) {branchFrom} {where}", parameters, ct);
        var summary = await ReadSummaryAsync(conn, branchFrom, where, parameters, ct);
        var items = await ReadBranchItemsAsync(conn, branchFrom, where, parameters, ct);

        return new WayfarerListResponse(1, items.Count, total, summary, items);
    }

    private static async Task<WayfarerSummary> ReadSummaryAsync(
        SqliteConnection conn,
        string fromClause,
        string whereClause,
        Dictionary<string, object?> parameters,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            WITH summary_src AS (
                SELECT
                    COALESCE(s.wo_status_code, i.wo_status_code) AS status_code,
                    s.complete_date
                {fromClause}
                {whereClause}
            )
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status_code IN ('10','15','20') THEN 1 ELSE 0 END) AS waiting,
                SUM(CASE WHEN status_code = '30' THEN 1 ELSE 0 END) AS scheduled,
                SUM(CASE WHEN status_code = '50' THEN 1 ELSE 0 END) AS inProgress,
                SUM(CASE WHEN status_code IN ('70','80','99') OR complete_date IS NOT NULL THEN 1 ELSE 0 END) AS completed
            FROM summary_src
            """;
        AddParameters(cmd, parameters);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return new WayfarerSummary(0, 0, 0, 0, 0);

        return new WayfarerSummary(
            Total: GetInt(reader, "total") ?? 0,
            Waiting: GetInt(reader, "waiting") ?? 0,
            Scheduled: GetInt(reader, "scheduled") ?? 0,
            InProgress: GetInt(reader, "inProgress") ?? 0,
            Completed: GetInt(reader, "completed") ?? 0
        );
    }

    private static async Task<IReadOnlyList<WayfarerWorkOrderListItem>> ReadBranchItemsAsync(
        SqliteConnection conn,
        string fromClause,
        string whereClause,
        Dictionary<string, object?> parameters,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            SELECT
                i.wo_no,
                i.detail_url,
                i.wo_code,
                i.wo_date,
                i.wo_problem,
                COALESCE(s.wo_status_code, i.wo_status_code) AS wo_status_code,
                s.wo_status_name,
                i.wo_type_code,
                i.eq_no,
                i.pu_no,
                i.dept_code,
                dep.deptName AS dept_name,
                t.task_name,
                COALESCE(t.pu_name, b.branch_pu_name) AS pu_name,
                t.eq_name,
                req.request_person_name,
                md.maintenance_dept_name,
                s.sch_start_d AS scheduled_start,
                s.sch_finish_d AS scheduled_finish,
                s.sch_duration AS scheduled_duration,
                s.act_start_d AS actual_start,
                s.act_finish_d AS actual_finish,
                s.act_duration AS actual_duration,
                s.work_duration,
                s.dt_duration AS downtime_duration,
                s.complete_date,
                i.fetched_at_utc
            {fromClause}
            {whereClause}
            ORDER BY i.wo_date DESC, i.wo_no DESC
            """;
        AddParameters(cmd, parameters);

        var items = new List<WayfarerWorkOrderListItem>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            items.Add(new WayfarerWorkOrderListItem(
                WoNo: GetLong(reader, "wo_no") ?? 0,
                DetailUrl: GetString(reader, "detail_url"),
                WoCode: GetString(reader, "wo_code"),
                WoDate: GetString(reader, "wo_date"),
                WoProblem: GetString(reader, "wo_problem"),
                WoStatusCode: GetString(reader, "wo_status_code"),
                WoStatusName: GetString(reader, "wo_status_name"),
                WoTypeCode: GetString(reader, "wo_type_code"),
                EqNo: GetLong(reader, "eq_no"),
                PuNo: GetLong(reader, "pu_no"),
                DeptCode: GetString(reader, "dept_code"),
                DeptName: GetString(reader, "dept_name"),
                TaskName: GetString(reader, "task_name"),
                PuName: GetString(reader, "pu_name"),
                EqName: GetString(reader, "eq_name"),
                RequestPersonName: GetString(reader, "request_person_name"),
                MaintenanceDeptName: GetString(reader, "maintenance_dept_name"),
                ScheduledStart: GetString(reader, "scheduled_start"),
                ScheduledFinish: GetString(reader, "scheduled_finish"),
                ScheduledDuration: GetInt(reader, "scheduled_duration"),
                ActualStart: GetString(reader, "actual_start"),
                ActualFinish: GetString(reader, "actual_finish"),
                ActualDuration: GetInt(reader, "actual_duration"),
                WorkDuration: GetInt(reader, "work_duration"),
                DowntimeDuration: GetInt(reader, "downtime_duration"),
                CompleteDate: GetString(reader, "complete_date"),
                FetchedAtUtc: GetString(reader, "fetched_at_utc")
            ));
        }

        return items;
    }

    private async Task<SqliteConnection> OpenReadOnlyAsync(CancellationToken ct)
    {
        if (!File.Exists(_dbPath))
            throw new FileNotFoundException($"Wayfarer database not found: {_dbPath}", _dbPath);
        if (!File.Exists(_metaDbPath))
            throw new FileNotFoundException($"Wayfarer meta database not found: {_metaDbPath}", _metaDbPath);

        var cs = new SqliteConnectionStringBuilder
        {
            DataSource = _dbPath,
            Mode = SqliteOpenMode.ReadOnly,
            Cache = SqliteCacheMode.Shared,
            Pooling = false
        }.ToString();

        var conn = new SqliteConnection(cs);
        await conn.OpenAsync(ct);

        await using var attach = conn.CreateCommand();
        attach.CommandText = "ATTACH DATABASE @metaPath AS meta";
        attach.Parameters.AddWithValue("@metaPath", _metaDbPath);
        await attach.ExecuteNonQueryAsync(ct);

        return conn;
    }

    private static async Task<int> ExecuteScalarIntAsync(
        SqliteConnection conn,
        string sql,
        Dictionary<string, object?> parameters,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        AddParameters(cmd, parameters);
        var value = await cmd.ExecuteScalarAsync(ct);
        return Convert.ToInt32(value, CultureInfo.InvariantCulture);
    }

    private static string ResolveDbPath(IConfiguration configuration, IWebHostEnvironment env)
    {
        var configured = configuration["Wayfarer:DbPath"] ?? "App_Data/wayfarer.db";
        var primary = Path.IsPathRooted(configured)
            ? configured
            : Path.Combine(env.ContentRootPath, configured);

        if (HasUsableDb(primary))
            return primary;

        var fallbacks = new[]
        {
            Path.Combine(env.ContentRootPath, "bin", "Release", "net9.0", "publish", "App_Data", "wayfarer.db"),
            Path.Combine(env.ContentRootPath, "bin", "Release", "net9.0", "win-x64", "publish", "App_Data", "wayfarer.db"),
            Path.Combine(env.ContentRootPath, "bin", "Debug", "net9.0", "publish", "App_Data", "wayfarer.db")
        };

        var fallback = fallbacks.FirstOrDefault(HasUsableDb);
        return fallback ?? primary;
    }

    private static string ResolveMetaDbPath(IConfiguration configuration, IWebHostEnvironment env)
    {
        var configured = configuration["Wayfarer:MetaDbPath"] ?? "App_Data/wayfarer_meta.db";
        var primary = Path.IsPathRooted(configured)
            ? configured
            : Path.Combine(env.ContentRootPath, configured);

        if (HasUsableDb(primary))
            return primary;

        var fallbacks = new[]
        {
            Path.Combine(env.ContentRootPath, "bin", "Release", "net9.0", "publish", "App_Data", "wayfarer_meta.db"),
            Path.Combine(env.ContentRootPath, "bin", "Release", "net9.0", "win-x64", "publish", "App_Data", "wayfarer_meta.db"),
            Path.Combine(env.ContentRootPath, "bin", "Debug", "net9.0", "publish", "App_Data", "wayfarer_meta.db")
        };

        var fallback = fallbacks.FirstOrDefault(HasUsableDb);
        return fallback ?? primary;
    }

    private static bool HasUsableDb(string path)
        => File.Exists(path) && new FileInfo(path).Length > 0;

    private static string BuildStatusGroupPredicate(
        IReadOnlyCollection<string> statusGroups,
        string statusCodeExpr,
        string completeDateExpr)
    {
        var groups = statusGroups
            .Select(x => x?.Trim().ToLowerInvariant())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        if (groups.Count == 0 || groups.Contains("all"))
            return "";

        var clauses = new List<string>();

        if (groups.Contains("open"))
            clauses.Add($"{statusCodeExpr} IN ('10','15','20')");
        if (groups.Contains("scheduled"))
            clauses.Add($"{statusCodeExpr} = '30'");
        if (groups.Contains("progress"))
            clauses.Add($"{statusCodeExpr} = '50'");
        if (groups.Contains("completed"))
            clauses.Add($"({statusCodeExpr} IN ('70','80','99') OR {completeDateExpr} IS NOT NULL)");

        return clauses.Count == 0 ? "" : "(" + string.Join(" OR ", clauses) + ")";
    }

    private static bool IsIsoDate(string? value)
        => !string.IsNullOrWhiteSpace(value)
           && DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    private static void AddParameters(SqliteCommand cmd, Dictionary<string, object?> parameters)
    {
        foreach (var (key, value) in parameters)
            cmd.Parameters.AddWithValue(key, value ?? DBNull.Value);
    }

    private static string? GetString(SqliteDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : Convert.ToString(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
    }

    private static int? GetInt(SqliteDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : Convert.ToInt32(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
    }

    private static long? GetLong(SqliteDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : Convert.ToInt64(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
    }
}

public sealed record WayfarerMapBranchSummary(
    string PuCode,
    int Total,
    int Waiting,
    int Scheduled,
    int InProgress,
    int Completed
);
