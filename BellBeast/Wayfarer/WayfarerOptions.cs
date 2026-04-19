namespace BellBeast.Wayfarer;

public sealed class WayfarerOptions
{
    /// <summary>
    /// Relative path from ContentRootPath or absolute path to wayfarer SQLite DB.
    /// Example: Data/wayfarer.db
    /// </summary>
    public string DbPath { get; set; } = "Data/wayfarer.db";

    /// <summary>
    /// Relative path from ContentRootPath or absolute path to wayfarer metadata SQLite DB.
    /// Example: App_Data/wayfarer_meta.db
    /// </summary>
    public string MetaDbPath { get; set; } = "App_Data/wayfarer_meta.db";
}
