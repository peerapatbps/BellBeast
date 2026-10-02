using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using BellBeast.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Xunit;

/// <summary>
/// ConfigEditorService (MHxView ⚙️ → Config tab) against a temp Fullscale skeleton:
///   Fullscale\BellBeast_proj\{appsettings.json, App_Data\backend-config.json, App_Data\wayfarer.db}
///   Fullscale\Uroboros_proj\{appsettings.json, config_\config.ini}
///   Fullscale\Wayfarer_proj\appsettings.json
/// </summary>
public sealed class ConfigEditorTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "bb_cfg_" + Guid.NewGuid().ToString("N"));

    public ConfigEditorTests()
    {
        Write(@"BellBeast_proj\App_Data\backend-config.json", "{\r\n  \"backendBaseUrl\": \"http://localhost:8888\",\r\n  \"queryCsvPath\": \"/api/process\"\r\n}");
        Write(@"BellBeast_proj\appsettings.json", "{\r\n  \"Wayfarer\": {\r\n    \"DbPath\": \"App_Data/wayfarer.db\"\r\n  }\r\n}");
        Write(@"BellBeast_proj\App_Data\wayfarer.db", "x");
        Write(@"Uroboros_proj\appsettings.json",
            "{\n  \"Wayfarer\": {\n    \"WorkingDirectory\": \"..\\\\Wayfarer_proj\",\n    \"DatabasePath\": \"..\\\\BellBeast_proj\\\\App_Data\\\\wayfarer.db\"\n  }\n}");
        Directory.CreateDirectory(Path.Combine(_root, @"Uroboros_proj\config_"));
        File.WriteAllBytes(Path.Combine(_root, @"Uroboros_proj\config_\config.ini"),
            [.. Encoding.UTF8.GetPreamble(), .. Encoding.UTF8.GetBytes("[Production]\r\n; ===== ปั๊ม =====\r\nP1Promin=4\r\nLab_file_location=\"C:\\nope\"\r\nmdb_file_location=\"C:\\legacy\\data.mdb\"\r\ntoken=abc\r\n")]);
        Write(@"Wayfarer_proj\appsettings.json", "{\r\n  \"WayfarerStore\": {\r\n    \"DbPath\": \"..\\\\BellBeast_proj\\\\App_Data\\\\wayfarer.db\"\r\n  }\r\n}");
        Write("START_FULLSCALE_LOCALHOST.ps1", "$env:UROBOROS_HTTP_PREFIX = \"http://+:8888/\"");
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    private void Write(string rel, string text)
    {
        var p = Path.Combine(_root, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(p)!);
        File.WriteAllText(p, text);
    }

    private string ReadDisk(string rel) => File.ReadAllText(Path.Combine(_root, rel));

    private ConfigEditorService Svc(string? configuredRoot = null, string? contentRoot = null)
    {
        var cfg = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConfigEditor:FullscaleRoot"] = configuredRoot
        }).Build();
        return new ConfigEditorService(cfg, new FakeEnv(contentRoot ?? Path.Combine(_root, "BellBeast_proj")));
    }

    private static JsonElement Json(object o) => JsonSerializer.SerializeToElement(o);

    // ── root / registry ───────────────────────────────────────────────

    [Fact]
    public void FindRoot_WalksUpFromContentRoot()
    {
        Assert.Equal(Path.GetFullPath(_root), Svc().FindRoot());
    }

    [Fact]
    public void FindRoot_ConfiguredValueWins_AndMissingIsNull()
    {
        Assert.Null(Svc(configuredRoot: Path.Combine(_root, "nope")).FindRoot());
        Assert.Null(Svc(contentRoot: Path.GetTempPath()).FindRoot());
    }

    [Fact]
    public void UnknownId_Rejected()
    {
        var ex = Assert.Throws<ConfigEditorException>(() => Svc().Read(@"..\..\Windows\win.ini"));
        Assert.Equal(404, ex.Status);
    }

    // ── save pipeline ─────────────────────────────────────────────────

    [Fact]
    public void Save_InvalidJson_RejectedWithLine_FileUntouched()
    {
        var svc = Svc();
        var (text, sha) = svc.Read("bb-backend");

        var ex = Assert.Throws<ConfigEditorException>(() => svc.Save("bb-backend", "{\n  \"a\": 1,\n  oops\n}", sha));

        Assert.Equal("invalid_json", ex.Code);
        Assert.Equal(3, ex.Line);
        Assert.Equal(text, ReadDisk(@"BellBeast_proj\App_Data\backend-config.json"));
    }

    [Fact]
    public void Save_InvalidIni_Rejected()
    {
        var svc = Svc();
        var (_, sha) = svc.Read("uro-config");
        var ex = Assert.Throws<ConfigEditorException>(() => svc.Save("uro-config", "[Production]\nno equals here\n", sha));
        Assert.Equal("invalid_ini", ex.Code);
        Assert.Equal(2, ex.Line);
    }

    [Fact]
    public void Save_StaleSha_Returns409()
    {
        var svc = Svc();
        var (text, sha) = svc.Read("uro-config");
        // Uroboros writes a new token after the editor loaded the file
        File.AppendAllText(Path.Combine(_root, @"Uroboros_proj\config_\config.ini"), "token_expiry=x\r\n");

        var ex = Assert.Throws<ConfigEditorException>(() => svc.Save("uro-config", text, sha));
        Assert.Equal(409, ex.Status);
    }

    [Fact]
    public void Save_KeepsBomAndCrlf_AndBacksUp()
    {
        var svc = Svc();
        var (text, sha) = svc.Read("uro-config");
        var edited = text.Replace("\r\n", "\n").Replace("P1Promin=4", "P1Promin=4.2");

        svc.Save("uro-config", edited, sha);

        var bytes = File.ReadAllBytes(Path.Combine(_root, @"Uroboros_proj\config_\config.ini"));
        Assert.True(bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF, "BOM kept");
        var disk = Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        Assert.Contains("P1Promin=4.2\r\n", disk);
        Assert.Contains("ปั๊ม", disk);
        Assert.False(disk.Contains("\r\r"), "line endings doubled");

        var backups = Directory.GetFiles(Path.Combine(_root, @"_backup\config\Uroboros"), "config.ini.*.bak");
        Assert.Single(backups);
        Assert.Contains("P1Promin=4\r\n", Encoding.UTF8.GetString(File.ReadAllBytes(backups[0])));
    }

    [Fact]
    public void Backups_PrunedToKeepLimit_AndRestoreWorks()
    {
        var svc = Svc();
        for (var i = 0; i < ConfigEditorService.KeepBackups + 3; i++)
        {
            var (text, sha) = svc.Read("bb-backend");
            svc.Save("bb-backend", Regex.Replace(text, @"localhost:\d+", "localhost:" + (9000 + i)), sha);
            Thread.Sleep(2); // backup names are millisecond-stamped
        }

        var dir = Path.Combine(_root, @"_backup\config\BellBeast");
        var names = Directory.GetFiles(dir, "backend-config.json.*.bak").Select(Path.GetFileName).Order().ToList();
        Assert.Equal(ConfigEditorService.KeepBackups, names.Count);

        var (_, cur) = svc.Read("bb-backend");
        svc.Restore("bb-backend", names[^1], cur);
        Assert.Contains("9021", ReadDisk(@"BellBeast_proj\App_Data\backend-config.json"));

        Assert.Throws<ConfigEditorException>(() => svc.Restore("bb-backend", @"..\..\secret.bak", cur));
    }

    // ── links ("auto search") ────────────────────────────────────────

    private static List<JsonElement> LinksOf(ConfigEditorService svc, out JsonElement root)
    {
        root = Json(svc.Links());
        return root.GetProperty("links").EnumerateArray().ToList();
    }

    private static JsonElement Link(List<JsonElement> links, string fileId, string key) =>
        links.Single(l => l.GetProperty("FileId").GetString() == fileId && l.GetProperty("Key").GetString() == key);

    [Fact]
    public void Links_ResolveAgainstEachProjectFolder()
    {
        var links = LinksOf(Svc(), out var root);

        var expected = Path.Combine(_root, @"BellBeast_proj\App_Data\wayfarer.db");
        foreach (var (file, key) in new[] { ("bb-appsettings", "Wayfarer:DbPath"), ("uro-appsettings", "Wayfarer:DatabasePath"), ("wf-appsettings", "WayfarerStore:DbPath") })
        {
            var l = Link(links, file, key);
            Assert.Equal(expected, l.GetProperty("Resolved").GetString(), ignoreCase: true);
            Assert.Equal("ok", l.GetProperty("Status").GetString());
        }

        Assert.Equal("Wayfarer_proj", Link(links, "uro-appsettings", "Wayfarer:WorkingDirectory").GetProperty("LandsIn").GetString());
        Assert.Equal("missing", Link(links, "uro-config", "Production:Lab_file_location").GetProperty("Status").GetString());
        Assert.DoesNotContain(links, l => l.GetProperty("Value").GetString() == "/api/process");
        Assert.DoesNotContain(links, l => l.GetProperty("Key").GetString() == "Production:mdb_file_location"); // legacy, ignored

        var check = root.GetProperty("checks").EnumerateArray().Single();
        Assert.True(check.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public void Links_FlagMismatchAndSuggestRelativeFix_ThenApplyEditsOnlyThatKey()
    {
        Write(@"Wayfarer_proj\appsettings.json",
            "{\r\n  \"WayfarerStore\": {\r\n    \"DbPath\": \"wayfarer.db\"\r\n  },\r\n  \"PmSite\": { \"Password\": \"p@ss\" }\r\n}");
        var svc = Svc();
        var links = LinksOf(svc, out var root);

        var wf = Link(links, "wf-appsettings", "WayfarerStore:DbPath");
        Assert.Equal("mismatch", wf.GetProperty("Status").GetString());
        Assert.Equal(@"..\BellBeast_proj\App_Data\wayfarer.db", wf.GetProperty("Suggestion").GetString());

        var sha = root.GetProperty("shas").GetProperty("wf-appsettings").GetString();
        svc.ApplyLink("wf-appsettings", "WayfarerStore:DbPath", wf.GetProperty("Suggestion").GetString(), sha);

        var disk = ReadDisk(@"Wayfarer_proj\appsettings.json");
        Assert.Contains(@"""DbPath"": ""..\\BellBeast_proj\\App_Data\\wayfarer.db""", disk);
        Assert.Contains("\"PmSite\": { \"Password\"", disk); // formatting of other keys untouched
        Assert.Contains("\"p@ss\"", disk);

        Assert.Equal("ok", Link(LinksOf(svc, out _), "wf-appsettings", "WayfarerStore:DbPath").GetProperty("Status").GetString());
    }

    [Fact]
    public void Links_MissingFile_FoundBySearch()
    {
        Write(@"BellBeast_proj\appsettings.json", "{ \"AqTable\": { \"DbPath\": \"data/aqtable.db\" } }");
        Write(@"BellBeast_proj\App_Data\aqtable.db", "x");

        var l = Link(LinksOf(Svc(), out _), "bb-appsettings", "AqTable:DbPath");

        Assert.Equal("missing", l.GetProperty("Status").GetString());
        Assert.Equal("App_Data/aqtable.db", l.GetProperty("Suggestion").GetString()); // keeps the original / style
    }

    [Fact]
    public void ApplyLink_Ini_KeepsQuotes()
    {
        var svc = Svc();
        var (_, sha) = svc.Read("uro-config");
        svc.ApplyLink("uro-config", "Production:Lab_file_location", @"C:\Lab", sha);

        var disk = ReadDisk(@"Uroboros_proj\config_\config.ini");
        Assert.Contains("Lab_file_location=\"C:\\Lab\"\r\n", disk);
        Assert.Contains("token=abc\r\n", disk);
    }

    // ── endpoints ─────────────────────────────────────────────────────

    [Fact]
    public async Task Endpoints_RequirePin()
    {
        using var factory = new BellBeastBaseFactory().WithWebHostBuilder(b =>
        {
            b.UseSetting("ConfigEditor:FullscaleRoot", _root);
            b.UseSetting("EngineControl:PinPbkdf2", EnginePinGuard.Hash("1234", 1000));
        });
        var client = factory.CreateClient();

        var files = await client.GetFromJsonAsync<JsonElement>("/api/config/files");
        Assert.Equal(5, files.GetProperty("files").GetArrayLength());

        var bad = await client.PostAsJsonAsync("/api/config/read", new { id = "wf-appsettings", pin = "0000" });
        Assert.Equal(HttpStatusCode.Unauthorized, bad.StatusCode);

        var ok = await client.PostAsJsonAsync("/api/config/read", new { id = "wf-appsettings", pin = "1234" });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var body = await ok.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains("WayfarerStore", body.GetProperty("text").GetString());

        var unknown = await client.PostAsJsonAsync("/api/config/read", new { id = "nope", pin = "1234" });
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
    }

    private sealed class FakeEnv(string contentRoot) : IWebHostEnvironment
    {
        public string WebRootPath { get; set; } = "";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ApplicationName { get; set; } = "BellBeast";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = contentRoot;
        public string EnvironmentName { get; set; } = "Test";
    }
}
