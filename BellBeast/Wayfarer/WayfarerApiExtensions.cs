using Microsoft.Data.Sqlite;
using ClosedXML.Excel;
using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;

namespace BellBeast.Wayfarer;

public static class WayfarerApiExtensions
{
    private const int MaxPageSize = 200;

    public static IServiceCollection AddWayfarerData(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<WayfarerOptions>(configuration.GetSection("Wayfarer"));
        services.AddSingleton<WayfarerDb>();
        return services;
    }

    public static IEndpointRouteBuilder MapWayfarerApi(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/wayfarer")
            .WithTags("Wayfarer");

        api.MapGet("/health", (WayfarerDb db) =>
        {
            using var conn = db.OpenReadOnlyConnection();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT COUNT(*) FROM pm_wo_index";
            var count = Convert.ToInt32(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
            return Results.Ok(new { ok = true, workOrders = count, serverTime = DateTimeOffset.UtcNow });
        });

        api.MapGet("/filters", async (WayfarerDb db, CancellationToken ct) =>
        {
            await using var conn = db.OpenReadOnlyConnection();

            var statuses = await ReadStatusFiltersAsync(conn, ct);
            var types = await ReadTypeFiltersAsync(db, conn, ct);
            var departments = await ReadDeptFiltersAsync(db, conn, ct);

            await using var latestCmd = conn.CreateCommand();
            latestCmd.CommandText = "SELECT MAX(fetched_at_utc) FROM pm_wo_index";
            var latest = await latestCmd.ExecuteScalarAsync(ct) as string;

            return Results.Ok(new WayfarerFilterResponse(statuses, types, departments, latest));
        });

        api.MapGet("/workorders", async (HttpContext http, WayfarerDb db, CancellationToken ct) =>
        {
            var req = http.Request.Query;
            var page = Clamp(ParseInt(req["page"], 1), 1, int.MaxValue);
            var pageSize = Clamp(ParseInt(req["pageSize"], 25), 1, MaxPageSize);
            var offset = (page - 1) * pageSize;

            var where = BuildWhere(req, out var parameters);
            var orderBy = BuildOrderBy(req["sort"], req["dir"]);

            await using var conn = db.OpenReadOnlyConnection();

            var total = await CountAsync(conn, where, parameters, ct);
            var summary = await SummaryAsync(conn, where, parameters, ct);
            var items = await ListAsync(conn, where, parameters, orderBy, pageSize, offset, ct);

            return Results.Ok(new WayfarerListResponse(page, pageSize, total, summary, items));
        });

        api.MapGet("/workorders/{woNo:long}", async (long woNo, WayfarerDb db, IHttpClientFactory httpFactory, IWebHostEnvironment env, CancellationToken ct) =>
        {
            await using var conn = db.OpenReadOnlyConnection();
            var detail = await ReadDetailAsync(conn, woNo, ct);
            if (detail is null)
            {
                var remoteMissing = await TryReadRemoteDetailAsync(httpFactory, env, woNo, ct);
                if (remoteMissing is not null) return Results.Ok(remoteMissing);
                return Results.NotFound(new { message = $"Work order {woNo} not found" });
            }

            if (IsSparseDetail(detail))
            {
                var remote = await TryReadRemoteDetailAsync(httpFactory, env, woNo, ct);
                if (remote is not null) detail = MergeDetail(detail, remote);
            }

            detail = EnrichDetail(detail);
            return Results.Ok(detail);
        });

        api.MapPost("/export", async (WayfarerExportRequest request, WayfarerDb db, CancellationToken ct) =>
        {
            var woNos = (request.WoNos ?? Array.Empty<long>())
                .Where(x => x > 0)
                .Distinct()
                .Take(25)
                .ToList();

            if (woNos.Count == 0)
                return Results.BadRequest("Please select at least one work order.");

            await using var conn = db.OpenReadOnlyConnection();
            using var workbook = new XLWorkbook();

            var overviewRows = new List<WayfarerWorkOrderListItem>();
            var detailRows = new List<WayfarerDetailResponse>();

            foreach (var woNo in woNos)
            {
                var detail = await ReadDetailAsync(conn, woNo, ct);
                if (detail?.Overview is null) continue;

                overviewRows.Add(detail.Overview);
                detailRows.Add(detail);
            }

            if (overviewRows.Count == 0)
                return Results.NotFound("No selected work orders were found.");

            BuildOverviewSheet(workbook, overviewRows);

            foreach (var detail in detailRows)
                BuildDetailSheet(workbook, detail);

            using var stream = new MemoryStream();
            workbook.SaveAs(stream);
            stream.Position = 0;

            var fileName = $"wayfarer-export-{DateTime.Now:yyyyMMdd-HHmmss}.xlsx";
            return Results.File(
                stream.ToArray(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                fileName
            );
        });

        return app;
    }

    private static string BaseFrom => """
        FROM pm_wo_index i
        LEFT JOIN pm_wo_schedule_status s ON s.wo_no = i.wo_no
        LEFT JOIN (
            SELECT * FROM (
                SELECT t.*, ROW_NUMBER() OVER (PARTITION BY t.wo_no ORDER BY COALESCE(t.task_order, 999999), t.wo_task_no) AS rn
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
        LEFT JOIN meta.meta_departments dep ON dep.deptCode = i.dept_code
        LEFT JOIN meta.meta_pu_branches pu ON pu.puNo = i.pu_no
        """;

    private static string SelectList => """
        SELECT i.wo_no, i.detail_url, i.wo_code, i.wo_date, i.wo_problem,
               COALESCE(s.wo_status_code, i.wo_status_code) AS wo_status_code,
               s.wo_status_name,
               i.wo_type_code, i.eq_no, i.pu_no, i.dept_code, dep.deptName AS dept_name,
               t.task_name,
               COALESCE(t.pu_name, pu.branch1PuName, pu.rootPuName, pu.puName) AS pu_name,
               t.eq_name,
               req.request_person_name, COALESCE(md.maintenance_dept_name, dep.deptName) AS maintenance_dept_name,
               s.sch_start_d AS scheduled_start, s.sch_finish_d AS scheduled_finish, s.sch_duration AS scheduled_duration,
               s.act_start_d AS actual_start, s.act_finish_d AS actual_finish, s.act_duration AS actual_duration,
               s.work_duration, s.dt_duration AS downtime_duration, s.complete_date,
               i.fetched_at_utc
        """;

    private static string BuildWhere(IQueryCollection req, out Dictionary<string, object?> parameters)
    {
        var filters = new List<string> { "1 = 1" };
        parameters = new Dictionary<string, object?>();

        var q = req["q"].ToString().Trim();
        if (!string.IsNullOrWhiteSpace(q))
        {
            filters.Add("""
                (
                    CAST(i.wo_no AS TEXT) LIKE @q OR
                    i.wo_code LIKE @q OR
                    i.wo_problem LIKE @q OR
                    t.task_name LIKE @q OR
                    t.eq_name LIKE @q OR
                    t.pu_name LIKE @q OR
                    i.dept_code LIKE @q OR
                    dep.deptName LIKE @q OR
                    md.maintenance_dept_name LIKE @q OR
                    req.request_person_name LIKE @q
                )
                """);
            parameters["@q"] = $"%{q}%";
        }

        var from = req["from"].ToString().Trim();
        if (IsIsoDate(from))
        {
            filters.Add("date(i.wo_date) >= date(@from)");
            parameters["@from"] = from;
        }

        var to = req["to"].ToString().Trim();
        if (IsIsoDate(to))
        {
            filters.Add("date(i.wo_date) <= date(@to)");
            parameters["@to"] = to;
        }

        var status = req["status"].ToString().Trim();
        if (!string.IsNullOrWhiteSpace(status))
        {
            filters.Add("COALESCE(s.wo_status_code, i.wo_status_code) = @status");
            parameters["@status"] = status;
        }

        var type = req["type"].ToString().Trim();
        if (!string.IsNullOrWhiteSpace(type))
        {
            filters.Add("i.wo_type_code = @type");
            parameters["@type"] = type;
        }

        var dept = req["dept"].ToString().Trim();
        if (!string.IsNullOrWhiteSpace(dept))
        {
            filters.Add("i.dept_code = @dept");
            parameters["@dept"] = dept;
        }

        return "WHERE " + string.Join(" AND ", filters);
    }

    private static string BuildOrderBy(string? sort, string? dir)
    {
        var column = (sort ?? "wo_date").Trim().ToLowerInvariant() switch
        {
            "wo_no" => "i.wo_no",
            "status" => "COALESCE(s.wo_status_code, i.wo_status_code)",
            "type" => "i.wo_type_code",
            "dept" => "i.dept_code",
            "fetched" => "i.fetched_at_utc",
            _ => "i.wo_date"
        };

        var direction = string.Equals(dir, "asc", StringComparison.OrdinalIgnoreCase) ? "ASC" : "DESC";
        return $"ORDER BY {column} {direction}, i.wo_no DESC";
    }

    private static async Task<int> CountAsync(SqliteConnection conn, string where, Dictionary<string, object?> parameters, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) {BaseFrom} {where}";
        AddParameters(cmd, parameters);
        var value = await cmd.ExecuteScalarAsync(ct);
        return Convert.ToInt32(value, CultureInfo.InvariantCulture);
    }

    private static async Task<WayfarerSummary> SummaryAsync(SqliteConnection conn, string where, Dictionary<string, object?> parameters, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            WITH summary_src AS (
                SELECT
                    COALESCE(s.wo_status_code, i.wo_status_code) AS status_code,
                    s.complete_date
                {BaseFrom}
                {where}
            )
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status_code IN ('10','15','20') THEN 1 ELSE 0 END) AS waiting,
                SUM(CASE WHEN status_code = '30' THEN 1 ELSE 0 END) AS scheduled,
                SUM(CASE WHEN status_code = '50' THEN 1 ELSE 0 END) AS in_progress,
                SUM(CASE WHEN status_code IN ('70','80','99') OR complete_date IS NOT NULL THEN 1 ELSE 0 END) AS completed
            FROM summary_src
            """;
        AddParameters(cmd, parameters);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return new(0, 0, 0, 0, 0);

        return new WayfarerSummary(
            GetInt(reader, "total") ?? 0,
            GetInt(reader, "waiting") ?? 0,
            GetInt(reader, "scheduled") ?? 0,
            GetInt(reader, "in_progress") ?? 0,
            GetInt(reader, "completed") ?? 0
        );
    }

    private static async Task<IReadOnlyList<WayfarerWorkOrderListItem>> ListAsync(
        SqliteConnection conn,
        string where,
        Dictionary<string, object?> parameters,
        string orderBy,
        int pageSize,
        int offset,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            {SelectList}
            {BaseFrom}
            {where}
            {orderBy}
            LIMIT @limit OFFSET @offset
            """;
        AddParameters(cmd, parameters);
        cmd.Parameters.AddWithValue("@limit", pageSize);
        cmd.Parameters.AddWithValue("@offset", offset);

        var items = new List<WayfarerWorkOrderListItem>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            items.Add(MapListItem(reader));
        }
        return items;
    }

    private static async Task<WayfarerWorkOrderListItem?> ReadOverviewAsync(SqliteConnection conn, long woNo, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            {SelectList}
            {BaseFrom}
            WHERE i.wo_no = @woNo
            LIMIT 1
            """;
        cmd.Parameters.AddWithValue("@woNo", woNo);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? MapListItem(reader) : null;
    }

    private static async Task<WayfarerDetailResponse?> ReadDetailAsync(SqliteConnection conn, long woNo, CancellationToken ct)
    {
        var overview = await ReadOverviewAsync(conn, woNo, ct);
        if (overview is null) return null;

        var tasks = await ReadRowsAsync(conn, """
            SELECT task_order, task_name, task_procedure, task_duration, remark, wo_cause,
                   task_date, task_done, pu_code, pu_name, eq_code, eq_name,
                   failure_action_name, failure_mode_name, failure_cause_name
            FROM pm_wo_task
            WHERE wo_no = @woNo
            ORDER BY COALESCE(task_order, 999999), wo_task_no
            """, new() { ["@woNo"] = woNo }, ct);

        var people = await ReadRowsAsync(conn, """
            SELECT role_type, person_code, person_name, dept_code, dept_name,
                   costcenter_code, costcenter_name, site_code, site_name
            FROM pm_wo_people_departments
            WHERE wo_no = @woNo
            ORDER BY id
            """, new() { ["@woNo"] = woNo }, ct);

        var history = await ReadRowsAsync(conn, """
            SELECT seq_no, type, detail, timestamps, action_person_code, action_person_name
            FROM pm_wo_history
            WHERE wo_no = @woNo
            ORDER BY COALESCE(seq_no, 999999), id
            """, new() { ["@woNo"] = woNo }, ct);

        var damageFailure = await ReadRowsAsync(conn, """
            SELECT damage_code, damage_name, failure_mode_code, failure_mode_name,
                   failure_cause_code, failure_cause_name, failure_action_code, failure_action_name,
                   component, effect_desc, cause_desc, action_desc,
                   other_problem, other_cause, other_action, other_action_result
            FROM pm_wo_damage_failure
            WHERE wo_no = @woNo
            """, new() { ["@woNo"] = woNo }, ct);

        var actualManhrs = await ReadRowsAsync(conn, """
            SELECT person_code, person_name, dept_code, dept_name, hours, qty, qty_hours,
                   rate_person, unit_cost, amount, flag_act, tr_date
            FROM pm_wo_actual_manhrs
            WHERE wo_no = @woNo
            ORDER BY wo_resc_no
            """, new() { ["@woNo"] = woNo }, ct);

        var flags = (await ReadRowsAsync(conn, """
            SELECT hot_work, confine_space, work_at_height, lock_out_tag_out,
                   wait_for_shutdown, wait_for_material, wait_for_other,
                   flag_cancel, flag_his, flag_del, flag_approve_m, flag_approve_resc,
                   flag_approve, flag_not_approved, flag_wait_status, flag_pu,
                   print_flag, authorize_csv
            FROM pm_wo_meta_flags
            WHERE wo_no = @woNo
            LIMIT 1
            """, new() { ["@woNo"] = woNo }, ct)).FirstOrDefault();

        return new WayfarerDetailResponse(
            overview,
            tasks,
            people,
            history,
            damageFailure,
            actualManhrs,
            flags
        );
    }

    private static bool IsSparseDetail(WayfarerDetailResponse detail)
    {
        var overview = detail.Overview;
        if (overview is null) return true;

        var hasSchedule =
            !string.IsNullOrWhiteSpace(overview.ScheduledStart) ||
            !string.IsNullOrWhiteSpace(overview.ScheduledFinish) ||
            !string.IsNullOrWhiteSpace(overview.ActualStart) ||
            !string.IsNullOrWhiteSpace(overview.ActualFinish) ||
            overview.ScheduledDuration.HasValue ||
            overview.ActualDuration.HasValue ||
            overview.WorkDuration.HasValue ||
            overview.DowntimeDuration.HasValue ||
            !string.IsNullOrWhiteSpace(overview.CompleteDate);

        var hasRelatedRows =
            detail.Tasks.Count > 0 ||
            detail.People.Count > 0 ||
            detail.History.Count > 0 ||
            detail.DamageFailure.Count > 0 ||
            detail.ActualManhrs.Count > 0 ||
            detail.Flags is not null;

        return !hasSchedule || !hasRelatedRows;
    }

    private static async Task<WayfarerDetailResponse?> TryReadRemoteDetailAsync(
        IHttpClientFactory httpFactory,
        IWebHostEnvironment env,
        long woNo,
        CancellationToken ct)
    {
        try
        {
            var cfg = LoadBackendConfig(env);
            if (cfg is null) return null;

            var url = $"{cfg.Value.baseUrl}{cfg.Value.wayfarerApiPath.TrimEnd('/')}/workorders/{woNo}";
            var client = httpFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(60);

            using var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode) return null;

            return await response.Content.ReadFromJsonAsync<WayfarerDetailResponse>(new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            }, ct);
        }
        catch
        {
            return null;
        }
    }

    private static WayfarerDetailResponse MergeDetail(WayfarerDetailResponse local, WayfarerDetailResponse remote)
    {
        var localOverview = local.Overview;
        var remoteOverview = remote.Overview;

        if (localOverview is null) return remote;
        if (remoteOverview is null) return local;

        var mergedOverview = localOverview with
        {
            WoStatusName = Pick(remoteOverview.WoStatusName, localOverview.WoStatusName),
            DeptName = Pick(remoteOverview.DeptName, localOverview.DeptName),
            TaskName = Pick(remoteOverview.TaskName, localOverview.TaskName),
            PuName = Pick(remoteOverview.PuName, localOverview.PuName),
            EqName = Pick(remoteOverview.EqName, localOverview.EqName),
            RequestPersonName = Pick(remoteOverview.RequestPersonName, localOverview.RequestPersonName),
            MaintenanceDeptName = Pick(remoteOverview.MaintenanceDeptName, localOverview.MaintenanceDeptName),
            ScheduledStart = Pick(remoteOverview.ScheduledStart, localOverview.ScheduledStart),
            ScheduledFinish = Pick(remoteOverview.ScheduledFinish, localOverview.ScheduledFinish),
            ScheduledDuration = remoteOverview.ScheduledDuration ?? localOverview.ScheduledDuration,
            ActualStart = Pick(remoteOverview.ActualStart, localOverview.ActualStart),
            ActualFinish = Pick(remoteOverview.ActualFinish, localOverview.ActualFinish),
            ActualDuration = remoteOverview.ActualDuration ?? localOverview.ActualDuration,
            WorkDuration = remoteOverview.WorkDuration ?? localOverview.WorkDuration,
            DowntimeDuration = remoteOverview.DowntimeDuration ?? localOverview.DowntimeDuration,
            CompleteDate = Pick(remoteOverview.CompleteDate, localOverview.CompleteDate)
        };

        return new WayfarerDetailResponse(
            mergedOverview,
            local.Tasks.Count > 0 ? local.Tasks : remote.Tasks,
            local.People.Count > 0 ? local.People : remote.People,
            local.History.Count > 0 ? local.History : remote.History,
            local.DamageFailure.Count > 0 ? local.DamageFailure : remote.DamageFailure,
            local.ActualManhrs.Count > 0 ? local.ActualManhrs : remote.ActualManhrs,
            local.Flags ?? remote.Flags
        );
    }

    private static WayfarerDetailResponse EnrichDetail(WayfarerDetailResponse detail)
    {
        var overview = detail.Overview;
        if (overview is null) return detail;

        string? requestPersonName = overview.RequestPersonName;
        string? maintenanceDeptName = overview.MaintenanceDeptName;
        string? deptName = overview.DeptName;

        foreach (var row in detail.People)
        {
            var role = GetRowString(row, "role_type");
            var personName = GetRowString(row, "person_name");
            var rowDeptCode = GetRowString(row, "dept_code");
            var rowDeptName = GetRowString(row, "dept_name");

            if (string.IsNullOrWhiteSpace(deptName) && !string.IsNullOrWhiteSpace(rowDeptName) &&
                (string.IsNullOrWhiteSpace(overview.DeptCode) || string.Equals(rowDeptCode, overview.DeptCode, StringComparison.OrdinalIgnoreCase)))
            {
                deptName = rowDeptName;
            }

            if (string.IsNullOrWhiteSpace(requestPersonName) &&
                string.Equals(role, "request_person", StringComparison.OrdinalIgnoreCase) &&
                !string.IsNullOrWhiteSpace(personName))
            {
                requestPersonName = personName;
            }

            if (string.IsNullOrWhiteSpace(maintenanceDeptName) &&
                string.Equals(role, "maintenance_dept", StringComparison.OrdinalIgnoreCase) &&
                !string.IsNullOrWhiteSpace(rowDeptName))
            {
                maintenanceDeptName = rowDeptName;
            }
        }

        if (requestPersonName == overview.RequestPersonName &&
            maintenanceDeptName == overview.MaintenanceDeptName &&
            deptName == overview.DeptName)
        {
            return detail;
        }

        return new WayfarerDetailResponse(
            overview with
            {
                RequestPersonName = requestPersonName,
                MaintenanceDeptName = maintenanceDeptName,
                DeptName = deptName
            },
            detail.Tasks,
            detail.People,
            detail.History,
            detail.DamageFailure,
            detail.ActualManhrs,
            detail.Flags
        );
    }

    private static string? Pick(string? preferred, string? fallback)
        => string.IsNullOrWhiteSpace(preferred) ? fallback : preferred;

    private static string? GetRowString(IReadOnlyDictionary<string, object?> row, string key)
        => row.TryGetValue(key, out var value) ? value?.ToString() : null;

    private static (string baseUrl, string wayfarerApiPath)? LoadBackendConfig(IWebHostEnvironment env)
    {
        var path = Path.Combine(env.ContentRootPath, "App_Data", "backend-config.json");
        if (!File.Exists(path)) return null;

        using var doc = JsonDocument.Parse(File.ReadAllText(path), new JsonDocumentOptions
        {
            AllowTrailingCommas = true,
            CommentHandling = JsonCommentHandling.Skip
        });

        static string GetStr(JsonDocument doc, string name)
            => doc.RootElement.TryGetProperty(name, out var el) ? (el.GetString() ?? "").Trim() : "";

        var baseUrl = GetStr(doc, "backendBaseUrl").TrimEnd('/');
        var wayfarerApiPath = GetStr(doc, "wayfarerApiPath");

        if (string.IsNullOrWhiteSpace(baseUrl) || string.IsNullOrWhiteSpace(wayfarerApiPath))
            return null;

        if (!wayfarerApiPath.StartsWith("/"))
            wayfarerApiPath = "/" + wayfarerApiPath;

        return (baseUrl, wayfarerApiPath);
    }

    private static WayfarerWorkOrderListItem MapListItem(SqliteDataReader r) => new(
        WoNo: GetLong(r, "wo_no") ?? 0,
        DetailUrl: GetString(r, "detail_url"),
        WoCode: GetString(r, "wo_code"),
        WoDate: GetString(r, "wo_date"),
        WoProblem: GetString(r, "wo_problem"),
        WoStatusCode: GetString(r, "wo_status_code"),
        WoStatusName: GetString(r, "wo_status_name"),
        WoTypeCode: GetString(r, "wo_type_code"),
        EqNo: GetLong(r, "eq_no"),
        PuNo: GetLong(r, "pu_no"),
        DeptCode: GetString(r, "dept_code"),
        DeptName: GetString(r, "dept_name"),
        TaskName: GetString(r, "task_name"),
        PuName: GetString(r, "pu_name"),
        EqName: GetString(r, "eq_name"),
        RequestPersonName: GetString(r, "request_person_name"),
        MaintenanceDeptName: GetString(r, "maintenance_dept_name"),
        ScheduledStart: GetString(r, "scheduled_start"),
        ScheduledFinish: GetString(r, "scheduled_finish"),
        ScheduledDuration: GetInt(r, "scheduled_duration"),
        ActualStart: GetString(r, "actual_start"),
        ActualFinish: GetString(r, "actual_finish"),
        ActualDuration: GetInt(r, "actual_duration"),
        WorkDuration: GetInt(r, "work_duration"),
        DowntimeDuration: GetInt(r, "downtime_duration"),
        CompleteDate: GetString(r, "complete_date"),
        FetchedAtUtc: GetString(r, "fetched_at_utc")
    );

    private static async Task<IReadOnlyList<WayfarerStatusFilter>> ReadStatusFiltersAsync(SqliteConnection conn, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT COALESCE(s.wo_status_code, i.wo_status_code) AS code,
                   MAX(s.wo_status_name) AS name
            FROM pm_wo_index i
            LEFT JOIN pm_wo_schedule_status s ON s.wo_no = i.wo_no
            WHERE COALESCE(s.wo_status_code, i.wo_status_code) IS NOT NULL
            GROUP BY COALESCE(s.wo_status_code, i.wo_status_code)
            ORDER BY CAST(COALESCE(s.wo_status_code, i.wo_status_code) AS INTEGER)
            """;

        var list = new List<WayfarerStatusFilter>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new WayfarerStatusFilter(GetString(reader, "code"), GetString(reader, "name")));
        }
        return list;
    }

    private static async Task<IReadOnlyList<WayfarerDeptFilter>> ReadDeptFiltersAsync(WayfarerDb db, SqliteConnection mainConn, CancellationToken ct)
    {
        try
        {
            await using var metaConn = db.OpenReadOnlyMetaConnection();
            await using var cmd = metaConn.CreateCommand();
            cmd.CommandText = """
                SELECT deptCode AS code, deptName AS name
                FROM meta_departments
                WHERE deptCode IS NOT NULL
                  AND deptCode <> ''
                ORDER BY deptCode
                """;

            var metaList = new List<WayfarerDeptFilter>();
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                metaList.Add(new WayfarerDeptFilter(GetString(reader, "code"), GetString(reader, "name")));
            }

            if (metaList.Count > 0)
                return metaList;
        }
        catch (FileNotFoundException)
        {
            // Fall back to live data if metadata DB has not been deployed yet.
        }
        catch (SqliteException)
        {
            // Fall back to live data if metadata schema changes or is incomplete.
        }

        await using var fallbackCmd = mainConn.CreateCommand();
        fallbackCmd.CommandText = """
            SELECT i.dept_code AS code, MAX(p.dept_name) AS name
            FROM pm_wo_index i
            LEFT JOIN pm_wo_people_departments p ON p.wo_no = i.wo_no AND p.dept_code = i.dept_code
            WHERE i.dept_code IS NOT NULL AND i.dept_code <> ''
            GROUP BY i.dept_code
            ORDER BY i.dept_code
            """;

        var fallbackList = new List<WayfarerDeptFilter>();
        await using var fallbackReader = await fallbackCmd.ExecuteReaderAsync(ct);
        while (await fallbackReader.ReadAsync(ct))
        {
            fallbackList.Add(new WayfarerDeptFilter(GetString(fallbackReader, "code"), GetString(fallbackReader, "name")));
        }
        return fallbackList;
    }

    private static async Task<IReadOnlyList<WayfarerTypeFilter>> ReadTypeFiltersAsync(WayfarerDb db, SqliteConnection mainConn, CancellationToken ct)
    {
        try
        {
            await using var metaConn = db.OpenReadOnlyMetaConnection();
            await using var cmd = metaConn.CreateCommand();
            cmd.CommandText = """
                SELECT workClassShort AS code, workClassName AS name
                FROM meta_work_classes
                WHERE workClassShort IS NOT NULL
                  AND workClassShort <> ''
                ORDER BY workClassShort
                """;

            var metaList = new List<WayfarerTypeFilter>();
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                metaList.Add(new WayfarerTypeFilter(GetString(reader, "code"), GetString(reader, "name")));
            }

            if (metaList.Count > 0)
                return metaList;
        }
        catch (FileNotFoundException)
        {
            // Fall back to live data if metadata DB has not been deployed yet.
        }
        catch (SqliteException)
        {
            // Fall back to live data if metadata schema changes or is incomplete.
        }

        await using var fallbackCmd = mainConn.CreateCommand();
        fallbackCmd.CommandText = """
            SELECT DISTINCT wo_type_code AS code
            FROM pm_wo_index
            WHERE wo_type_code IS NOT NULL
              AND wo_type_code <> ''
            ORDER BY wo_type_code
            """;

        var fallbackList = new List<WayfarerTypeFilter>();
        await using var fallbackReader = await fallbackCmd.ExecuteReaderAsync(ct);
        while (await fallbackReader.ReadAsync(ct))
        {
            fallbackList.Add(new WayfarerTypeFilter(GetString(fallbackReader, "code"), null));
        }
        return fallbackList;
    }

    private static async Task<IReadOnlyList<T>> ReadScalarListAsync<T>(SqliteConnection conn, string sql, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        var list = new List<T>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            if (!reader.IsDBNull(0)) list.Add((T)Convert.ChangeType(reader.GetValue(0), typeof(T), CultureInfo.InvariantCulture));
        }
        return list;
    }

    private static async Task<IReadOnlyList<Dictionary<string, object?>>> ReadRowsAsync(
        SqliteConnection conn,
        string sql,
        Dictionary<string, object?> parameters,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        AddParameters(cmd, parameters);

        var rows = new List<Dictionary<string, object?>>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < reader.FieldCount; i++)
            {
                var name = reader.GetName(i);
                row[name] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            }
            rows.Add(row);
        }
        return rows;
    }

    private static void AddParameters(SqliteCommand cmd, Dictionary<string, object?> parameters)
    {
        foreach (var (key, value) in parameters)
        {
            cmd.Parameters.AddWithValue(key, value ?? DBNull.Value);
        }
    }

    private static string? GetString(SqliteDataReader r, string name)
    {
        var ordinal = r.GetOrdinal(name);
        return r.IsDBNull(ordinal) ? null : Convert.ToString(r.GetValue(ordinal), CultureInfo.InvariantCulture);
    }

    private static int? GetInt(SqliteDataReader r, string name)
    {
        var ordinal = r.GetOrdinal(name);
        return r.IsDBNull(ordinal) ? null : Convert.ToInt32(r.GetValue(ordinal), CultureInfo.InvariantCulture);
    }

    private static long? GetLong(SqliteDataReader r, string name)
    {
        var ordinal = r.GetOrdinal(name);
        return r.IsDBNull(ordinal) ? null : Convert.ToInt64(r.GetValue(ordinal), CultureInfo.InvariantCulture);
    }

    private static int ParseInt(string? value, int fallback)
        => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : fallback;

    private static int Clamp(int value, int min, int max) => Math.Min(Math.Max(value, min), max);

    private static bool IsIsoDate(string value)
        => DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    private static void BuildOverviewSheet(XLWorkbook workbook, IReadOnlyList<WayfarerWorkOrderListItem> rows)
    {
        var ws = workbook.Worksheets.Add("Overview");
        ws.Cell(1, 1).Value = "Wayfarer Export";
        ws.Cell(2, 1).Value = "Generated";
        ws.Cell(2, 2).Value = FormatThaiDateTime(DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        ws.Cell(3, 1).Value = "Selected Work Orders";
        ws.Cell(3, 2).Value = rows.Count;

        var headers = new[]
        {
            "WO No", "WO Code", "WO Date", "Type", "Status Code", "Status Name",
            "Problem", "Task Name", "PU", "EQ", "Dept", "Maintenance Dept",
            "Scheduled Start", "Scheduled Finish", "Actual Start", "Actual Finish",
            "Work Duration", "Downtime", "Fetched"
        };

        for (var i = 0; i < headers.Length; i++)
            ws.Cell(5, i + 1).Value = headers[i];

        var rowIndex = 6;
        foreach (var row in rows)
        {
            ws.Cell(rowIndex, 1).Value = row.WoNo;
            ws.Cell(rowIndex, 2).Value = row.WoCode;
            ws.Cell(rowIndex, 3).Value = NormalizeExportValue("wo_date", row.WoDate);
            ws.Cell(rowIndex, 4).Value = row.WoTypeCode;
            ws.Cell(rowIndex, 5).Value = row.WoStatusCode;
            ws.Cell(rowIndex, 6).Value = row.WoStatusName;
            ws.Cell(rowIndex, 7).Value = row.WoProblem;
            ws.Cell(rowIndex, 8).Value = row.TaskName;
            ws.Cell(rowIndex, 9).Value = row.PuName ?? row.PuNo?.ToString();
            ws.Cell(rowIndex, 10).Value = row.EqName ?? row.EqNo?.ToString();
            ws.Cell(rowIndex, 11).Value = row.DeptName ?? row.DeptCode;
            ws.Cell(rowIndex, 12).Value = row.MaintenanceDeptName;
            ws.Cell(rowIndex, 13).Value = NormalizeExportValue("scheduled_start", row.ScheduledStart);
            ws.Cell(rowIndex, 14).Value = NormalizeExportValue("scheduled_finish", row.ScheduledFinish);
            ws.Cell(rowIndex, 15).Value = NormalizeExportValue("actual_start", row.ActualStart);
            ws.Cell(rowIndex, 16).Value = NormalizeExportValue("actual_finish", row.ActualFinish);
            ws.Cell(rowIndex, 17).Value = row.WorkDuration;
            ws.Cell(rowIndex, 18).Value = row.DowntimeDuration;
            ws.Cell(rowIndex, 19).Value = NormalizeExportValue("fetched_at_utc", row.FetchedAtUtc);
            rowIndex++;
        }

        StyleSheet(ws, 5, headers.Length);
    }

    private static void BuildDetailSheet(XLWorkbook workbook, WayfarerDetailResponse detail)
    {
        var overview = detail.Overview!;
        var ws = workbook.Worksheets.Add(SafeSheetName($"WO-{overview.WoNo}-{overview.WoCode}"));
        var row = 1;

        ws.Cell(row, 1).Value = $"Work Order {overview.WoNo}";
        ws.Cell(row, 2).Value = overview.WoCode;
        ws.Range(row, 1, row, 4).Style.Font.Bold = true;
        row += 2;

        row = WriteKeyValueSection(ws, row, "Overview", new Dictionary<string, object?>
        {
            ["WO No"] = overview.WoNo,
            ["WO Code"] = overview.WoCode,
            ["WO Date"] = overview.WoDate,
            ["Type"] = overview.WoTypeCode,
            ["Status Code"] = overview.WoStatusCode,
            ["Status Name"] = overview.WoStatusName,
            ["Problem"] = overview.WoProblem,
            ["Task"] = overview.TaskName,
            ["PU"] = overview.PuName ?? overview.PuNo?.ToString(),
            ["EQ"] = overview.EqName ?? overview.EqNo?.ToString(),
            ["Dept"] = overview.DeptName ?? overview.DeptCode,
            ["Maintenance Dept"] = overview.MaintenanceDeptName,
            ["Request Person"] = overview.RequestPersonName,
            ["Scheduled Start"] = overview.ScheduledStart,
            ["Scheduled Finish"] = overview.ScheduledFinish,
            ["Actual Start"] = overview.ActualStart,
            ["Actual Finish"] = overview.ActualFinish,
            ["Complete Date"] = overview.CompleteDate,
            ["Work Duration"] = overview.WorkDuration,
            ["Downtime Duration"] = overview.DowntimeDuration,
            ["Fetched"] = overview.FetchedAtUtc,
            ["Detail URL"] = overview.DetailUrl
        });

        row = WriteTableSection(ws, row, "Tasks", detail.Tasks);
        row = WriteTableSection(ws, row, "People / Departments", detail.People);
        row = WriteTableSection(ws, row, "History", detail.History);
        row = WriteTableSection(ws, row, "Damage / Failure", detail.DamageFailure);
        row = WriteTableSection(ws, row, "Actual Manhours", detail.ActualManhrs);

        if (detail.Flags is not null)
            row = WriteTableSection(ws, row, "Meta Flags", new[] { detail.Flags });

        ws.Columns().AdjustToContents();
    }

    private static int WriteKeyValueSection(IXLWorksheet ws, int row, string title, IReadOnlyDictionary<string, object?> values)
    {
        ws.Cell(row, 1).Value = title;
        ws.Cell(row, 1).Style.Font.Bold = true;
        row++;

        foreach (var item in values)
        {
            ws.Cell(row, 1).Value = item.Key;
            ws.Cell(row, 2).Value = NormalizeExportValue(item.Key, item.Value);
            row++;
        }

        return row + 1;
    }

    private static int WriteTableSection(IXLWorksheet ws, int row, string title, IReadOnlyList<Dictionary<string, object?>> rows)
    {
        ws.Cell(row, 1).Value = title;
        ws.Cell(row, 1).Style.Font.Bold = true;
        row++;

        if (rows.Count == 0)
        {
            ws.Cell(row, 1).Value = "No data";
            return row + 2;
        }

        var columns = rows[0].Keys.ToList();
        for (var i = 0; i < columns.Count; i++)
            ws.Cell(row, i + 1).Value = columns[i];

        var headerRow = row;
        row++;

        foreach (var entry in rows)
        {
            for (var i = 0; i < columns.Count; i++)
                ws.Cell(row, i + 1).Value = entry.TryGetValue(columns[i], out var value) ? NormalizeExportValue(columns[i], value) : "";
            row++;
        }

        ws.Range(headerRow, 1, headerRow, columns.Count).Style.Font.Bold = true;
        ws.Range(headerRow, 1, row - 1, columns.Count).Style.Border.OutsideBorder = XLBorderStyleValues.Thin;
        ws.Range(headerRow, 1, row - 1, columns.Count).Style.Border.InsideBorder = XLBorderStyleValues.Thin;
        return row + 1;
    }

    private static void StyleSheet(IXLWorksheet ws, int headerRow, int columnCount)
    {
        var lastRow = ws.LastRowUsed()?.RowNumber() ?? headerRow;
        ws.Range(headerRow, 1, headerRow, columnCount).Style.Font.Bold = true;
        ws.Range(headerRow, 1, headerRow, columnCount).Style.Fill.BackgroundColor = XLColor.FromHtml("#D9EAF7");
        ws.Range(headerRow, 1, lastRow, columnCount).Style.Border.OutsideBorder = XLBorderStyleValues.Thin;
        ws.Range(headerRow, 1, lastRow, columnCount).Style.Border.InsideBorder = XLBorderStyleValues.Thin;
        ws.Columns().AdjustToContents();
    }

    private static string SafeSheetName(string? raw)
    {
        var name = string.IsNullOrWhiteSpace(raw) ? "Sheet" : raw;
        foreach (var ch in new[] { '\\', '/', '?', '*', '[', ']', ':' })
            name = name.Replace(ch, '-');

        return name.Length <= 31 ? name : name[..31];
    }

    private static string NormalizeExportValue(string? key, object? value)
    {
        if (value is null) return "";

        var text = value.ToString() ?? "";
        if (string.IsNullOrWhiteSpace(text)) return "";

        if (LooksLikeDateKey(key) || LooksLikeIsoDateTime(text))
            return FormatThaiDateTime(text);

        return text;
    }

    private static bool LooksLikeDateKey(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return false;
        var k = key.Replace(" ", "_").ToLowerInvariant();
        return k.Contains("date") || k.Contains("time") || k.Contains("timestamp") || k.Contains("fetched");
    }

    private static bool LooksLikeIsoDateTime(string text)
        => text.Contains('T') && (text.EndsWith("Z", StringComparison.OrdinalIgnoreCase) || text.Contains('+'));

    private static string FormatThaiDateTime(string text)
    {
        if (DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var dto))
            return TimeZoneInfo.ConvertTime(dto, GetBangkokTimeZone()).ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);

        if (DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var dt))
            return dt.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);

        return text;
    }

    private static TimeZoneInfo GetBangkokTimeZone()
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById("SE Asia Standard Time");
        }
        catch (TimeZoneNotFoundException)
        {
            return TimeZoneInfo.FindSystemTimeZoneById("Asia/Bangkok");
        }
    }
}
