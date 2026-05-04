using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Options;

namespace BellBeast.Wayfarer;

public sealed class WayfarerDb
{
    private readonly string _dbPath;
    private readonly string _metaDbPath;

    public WayfarerDb(IOptions<WayfarerOptions> options, IWebHostEnvironment env)
    {
        var configured = options.Value.DbPath;
        _dbPath = Path.IsPathRooted(configured)
            ? configured
            : Path.Combine(env.ContentRootPath, configured);

        var metaConfigured = options.Value.MetaDbPath;
        _metaDbPath = Path.IsPathRooted(metaConfigured)
            ? metaConfigured
            : Path.Combine(env.ContentRootPath, metaConfigured);
    }

    public SqliteConnection OpenReadOnlyConnection()
    {
        EnsureExists(_dbPath, "Wayfarer database");

        var conn = new SqliteConnection(BuildConnectionString(_dbPath));
        conn.Open();
        AttachMetaDatabase(conn);
        return conn;
    }

    public SqliteConnection OpenReadOnlyMetaConnection()
    {
        EnsureExists(_metaDbPath, "Wayfarer metadata database");

        var conn = new SqliteConnection(BuildConnectionString(_metaDbPath));
        conn.Open();
        return conn;
    }

    private static void EnsureExists(string path, string label)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"{label} not found: {path}", path);
    }

    private static string BuildConnectionString(string path)
    {
        var csb = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadOnly,
            Cache = SqliteCacheMode.Shared,
            Pooling = false
        };

        return csb.ToString();
    }

    private void AttachMetaDatabase(SqliteConnection conn)
    {
        if (!File.Exists(_metaDbPath)) return;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "ATTACH DATABASE @metaPath AS meta";
        cmd.Parameters.AddWithValue("@metaPath", _metaDbPath);
        cmd.ExecuteNonQuery();
    }
}
