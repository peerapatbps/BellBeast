using System.Text;
using BellBeast.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

/// <summary>
/// Real OpenRouter call — opt-in only, costs a few cents:
///   BB_LIVE_TTS_KEYFILE=&lt;file containing the key&gt;  BB_LIVE_TTS_OUT=&lt;folder for .wav&gt;  dotnet test --filter LiveTts
/// Without BB_LIVE_TTS_KEYFILE the test returns immediately.
/// </summary>
public sealed class LiveTtsTests
{
    private sealed class RealFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }

    [Theory]
    [InlineData("n_0", "ศูนย์")]
    [InlineData("s_rwp1_flowp1", "สถานีน้ำดิบ 1 ระบบผลิตเฟส 1")]
    [InlineData("sentence_rwp1", "สถานีน้ำดิบ 1 ระบบผลิตเฟส 1 อัตราไหลผิดปกติ ค่าล่าสุด แปดพันหกร้อยห้าสิบ ลูกบาศก์เมตรต่อชั่วโมง")]
    public async Task LiveTts_Produces_Audible_Pcm(string id, string text)
    {
        var keyFile = Environment.GetEnvironmentVariable("BB_LIVE_TTS_KEYFILE");
        if (string.IsNullOrWhiteSpace(keyFile)) return;

        var cfg = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Audio:OpenRouterApiKeyFile"] = keyFile })
            .Build();
        var tts = new TtsService(cfg, new RealFactory());
        Assert.True(tts.Configured);

        var pcm = await tts.SynthesizeAsync(text, CancellationToken.None);

        var seconds = pcm.Length / 2.0 / AudioLibraryService.SampleRate;
        var peak = 0;
        for (var i = 0; i + 1 < pcm.Length; i += 2) peak = Math.Max(peak, Math.Abs((int)BitConverter.ToInt16(pcm, i)));

        var outDir = Environment.GetEnvironmentVariable("BB_LIVE_TTS_OUT");
        if (!string.IsNullOrWhiteSpace(outDir))
        {
            Directory.CreateDirectory(outDir);
            File.WriteAllBytes(Path.Combine(outDir, id + ".wav"), AudioLibraryService.WrapWav(pcm));
            File.AppendAllText(Path.Combine(outDir, "report.txt"), $"{id}\t{seconds:0.00}s\tpeak={peak}\t{text}\n");
        }

        Assert.InRange(seconds, 0.2, AudioLibraryService.MaxClipSeconds);
        Assert.True(peak > 1000, $"audio looks silent (peak {peak})");
    }

    /// <summary>
    /// Seeds every missing vocabulary clip into a real library — opt-in tool, not a regular test:
    ///   BB_LIVE_TTS_KEYFILE=&lt;key file&gt;  BB_TTS_SEED_ROOT=&lt;BellBeast content root (folder with App_Data)&gt;
    ///   [BB_TTS_SEED_FORCE=1 to regenerate existing tts clips]  dotnet test --filter SeedVocabulary
    /// Retries when the model's transcript differs from the text; report → App_Data/audio/seed_report.tsv
    /// </summary>
    [Fact]
    public async Task SeedVocabulary()
    {
        var keyFile = Environment.GetEnvironmentVariable("BB_LIVE_TTS_KEYFILE");
        var root = Environment.GetEnvironmentVariable("BB_TTS_SEED_ROOT");
        if (string.IsNullOrWhiteSpace(keyFile) || string.IsNullOrWhiteSpace(root)) return;
        var force = Environment.GetEnvironmentVariable("BB_TTS_SEED_FORCE") == "1";

        var cfg = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Audio:OpenRouterApiKeyFile"] = keyFile })
            .Build();
        var tts = new TtsService(cfg, new RealFactory());
        var lib = new AudioLibraryService(new SeedEnv(root));

        var report = new StringBuilder("id\tresult\tattempts\tseconds\ttext\ttranscript\n");
        var failures = new List<string>();
        foreach (var v in lib.Vocabulary())
        {
            var existing = lib.Get(v.Id);
            if (existing is not null && (!force || existing.Source != "tts")) continue; // never overwrite uploaded (human) recordings

            byte[]? best = null;
            string bestTr = "";
            var attempts = 0;
            for (; attempts < 3; attempts++)
            {
                var tr = new StringBuilder();
                byte[] pcm;
                try { pcm = await tts.SynthesizeAsync(v.Text, CancellationToken.None, tr); }
                catch (Exception ex) when (ex is TtsException or HttpRequestException or TaskCanceledException)
                {
                    bestTr = "ERROR " + ex.Message;
                    continue;
                }
                if (best is null || Norm(tr.ToString()) == Norm(v.Text)) { best = pcm; bestTr = tr.ToString(); }
                if (Norm(bestTr) == Norm(v.Text)) break;
            }

            if (best is null) { failures.Add(v.Id); report.Append($"{v.Id}\tFAILED\t{attempts}\t\t{v.Text}\t{bestTr}\n"); continue; }
            var info = lib.Save(v.Id, best, "tts", v.Text);
            var match = Norm(bestTr) == Norm(v.Text) ? "ok" : "CHECK";
            report.Append($"{v.Id}\t{match}\t{Math.Min(attempts + 1, 3)}\t{info.DurationMs / 1000.0:0.00}\t{v.Text}\t{bestTr.Replace('\n', ' ')}\n");
        }

        File.WriteAllText(Path.Combine(root, "App_Data", "audio", "seed_report.tsv"), report.ToString(), new UTF8Encoding(true));
        Assert.Empty(failures);
    }

    /// <summary>Compare text vs transcript ignoring spaces/punctuation and Arabic-vs-Thai digits.</summary>
    private static string Norm(string s)
    {
        string[] th = { "ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า" };
        var sb = new StringBuilder();
        foreach (var ch in s.ToLowerInvariant())
        {
            if (ch is >= '0' and <= '9') sb.Append(th[ch - '0']);
            else if (char.IsLetterOrDigit(ch) || char.GetUnicodeCategory(ch) is System.Globalization.UnicodeCategory.NonSpacingMark) sb.Append(ch);
        }
        return sb.ToString();
    }

    private sealed class SeedEnv(string root) : Microsoft.AspNetCore.Hosting.IWebHostEnvironment
    {
        public string ContentRootPath { get; set; } = root;
        public string WebRootPath { get; set; } = root;
        public string EnvironmentName { get; set; } = "Seed";
        public string ApplicationName { get; set; } = "BellBeast";
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
        public Microsoft.Extensions.FileProviders.IFileProvider WebRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
    }
}
