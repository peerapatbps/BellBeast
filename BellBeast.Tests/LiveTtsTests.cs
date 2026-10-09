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
}
