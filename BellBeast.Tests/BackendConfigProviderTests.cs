using BellBeast.Services;
using Microsoft.Extensions.FileProviders;
using Microsoft.AspNetCore.Hosting;
using Xunit;

public sealed class BackendConfigProviderTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "bb_cfg_" + Guid.NewGuid().ToString("N"));
    private string CfgPath => Path.Combine(_root, "App_Data", "backend-config.json");

    public BackendConfigProviderTests() => Directory.CreateDirectory(Path.Combine(_root, "App_Data"));
    public void Dispose() { try { Directory.Delete(_root, true); } catch { } }

    private BackendConfigProvider Provider() => new(new FakeEnv { ContentRootPath = _root });

    [Fact]
    public void Parse_Applies_Defaults_And_Normalises()
    {
        var c = BackendConfigProvider.Parse("""{ "backendBaseUrl": "http://host:8888/", "queryCsvPath": "custom", /* comment */ }""");

        Assert.Equal("http://host:8888", c.BaseUrl);
        Assert.Equal("/custom", c.QueryCsvPath);
        Assert.Equal("/api/dailyreport", c.DailyReportPath);
        Assert.Equal(SummaryProxyService.DefaultRwsPath, c.RwsSummaryPath);
        Assert.Equal("/api/wayfarer", c.WayfarerApiPath);
    }

    [Theory]
    [InlineData("""{ }""")]
    [InlineData("""{ "backendBaseUrl": "not a url" }""")]
    public void Parse_Rejects_Missing_Or_Invalid_BaseUrl(string json)
        => Assert.Throws<InvalidOperationException>(() => BackendConfigProvider.Parse(json));

    [Fact]
    public void Current_Throws_When_File_Missing()
        => Assert.Throws<FileNotFoundException>(() => Provider().Current);

    [Fact]
    public void Current_Picks_Up_File_Changes()
    {
        var p = Provider();
        File.WriteAllText(CfgPath, """{ "backendBaseUrl": "http://a:1" }""");
        Assert.Equal("http://a:1", p.Current.BaseUrl);
        Assert.Same(p.Current, p.Current); // cached while unchanged

        File.WriteAllText(CfgPath, """{ "backendBaseUrl": "http://bb:22" }""");
        File.SetLastWriteTimeUtc(CfgPath, DateTime.UtcNow.AddMinutes(1));
        Assert.Equal("http://bb:22", p.Current.BaseUrl);
    }

    private sealed class FakeEnv : IWebHostEnvironment
    {
        public string WebRootPath { get; set; } = "";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ApplicationName { get; set; } = "test";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = "";
        public string EnvironmentName { get; set; } = "Test";
    }
}
