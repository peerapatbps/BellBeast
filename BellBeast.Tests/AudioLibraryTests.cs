using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using BellBeast.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.FileProviders;
using Xunit;

/// <summary>
/// Audio clip library: PCM16 24 kHz mono storage with version/sha256, WAV conversion,
/// anonymous device download, admin-only writes, TTS via OpenRouter SSE.
/// </summary>
public sealed class AudioLibraryServiceTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "bb_audio_" + Guid.NewGuid().ToString("N"));

    private sealed class Env(string root) : IWebHostEnvironment
    {
        public string ContentRootPath { get; set; } = root;
        public string WebRootPath { get; set; } = root;
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "BellBeast";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
    }

    private AudioLibraryService NewLib() => new(new Env(_root));

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    internal static byte[] Wav(short[] samples, int rate, int channels, int bits = 16, int format = 1)
    {
        var data = new byte[samples.Length * 2];
        for (var i = 0; i < samples.Length; i++) BinaryPrimitives.WriteInt16LittleEndian(data.AsSpan(i * 2), samples[i]);
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + 8 + 4 + data.Length); w.Write(Encoding.ASCII.GetBytes("WAVE"));
        w.Write(Encoding.ASCII.GetBytes("fmt ")); w.Write(16); w.Write((short)format); w.Write((short)channels);
        w.Write(rate); w.Write(rate * channels * bits / 8); w.Write((short)(channels * bits / 8)); w.Write((short)bits);
        w.Write(Encoding.ASCII.GetBytes("LIST")); w.Write(4); w.Write(Encoding.ASCII.GetBytes("INFO")); // extra chunk before data
        w.Write(Encoding.ASCII.GetBytes("data")); w.Write(data.Length); w.Write(data);
        return ms.ToArray();
    }

    internal static short[] Tone(int n) => Enumerable.Range(0, n).Select(i => (short)(i * 37 % 20000 - 10000)).ToArray();

    [Theory]
    [InlineData("n_4", "n_4")]
    [InlineData(" N_4@v2 ", "n_4")]
    [InlineData("s_rwp1_flowp1", "s_rwp1_flowp1")]
    [InlineData("../etc", null)]
    [InlineData("a-b", null)]
    [InlineData("", null)]
    public void NormalizeId_Accepts_Only_Safe_Ids(string input, string? expected)
        => Assert.Equal(expected, AudioLibraryService.NormalizeId(input));

    [Fact]
    public void Wav_24k_Mono_Passes_Through_Unchanged()
    {
        var s = Tone(2400);
        var pcm = AudioLibraryService.ToDevicePcm(Wav(s, 24000, 1), "a.wav");
        Assert.Equal(4800, pcm.Length);
        Assert.Equal(s[123], BinaryPrimitives.ReadInt16LittleEndian(pcm.AsSpan(246)));
    }

    [Fact]
    public void Wav_48k_Stereo_Is_Downmixed_And_Resampled_To_24k()
    {
        // 1 s of 48 kHz stereo, L=1000 R=3000 → mono 2000
        var frames = 48000;
        var s = new short[frames * 2];
        for (var i = 0; i < frames; i++) { s[i * 2] = 1000; s[i * 2 + 1] = 3000; }
        var pcm = AudioLibraryService.ToDevicePcm(Wav(s, 48000, 2), "rec.wav");

        Assert.Equal(24000 * 2, pcm.Length);
        Assert.Equal(2000, BinaryPrimitives.ReadInt16LittleEndian(pcm.AsSpan(1000)));
    }

    [Fact]
    public void Unsupported_Audio_Is_Rejected_With_A_Clear_Reason()
    {
        Assert.Throws<AudioFormatException>(() => AudioLibraryService.ToDevicePcm(Encoding.ASCII.GetBytes("ID3\u0004mp3data"), "a.mp3"));
        var ex = Assert.Throws<AudioFormatException>(() => AudioLibraryService.ToDevicePcm(Wav(Tone(100), 24000, 1, format: 3), "float.wav"));
        Assert.Contains("16-bit", ex.Message);
    }

    [Fact]
    public void WrapWav_Roundtrips_Through_The_Parser()
    {
        var pcm = AudioLibraryService.ToDevicePcm(Wav(Tone(500), 24000, 1), "a.wav");
        Assert.Equal(pcm, AudioLibraryService.ToDevicePcm(AudioLibraryService.WrapWav(pcm), "x.wav"));
    }

    [Fact]
    public void Version_Bumps_Only_When_Audio_Changes_And_Survives_Restart()
    {
        var lib = NewLib();
        var a = AudioLibraryService.ToDevicePcm(Wav(Tone(2400), 24000, 1), "a.wav");
        var b = AudioLibraryService.ToDevicePcm(Wav(Tone(4800), 24000, 1), "b.wav");

        Assert.Equal(1, lib.Save("n_1", a, "tts", "หนึ่ง").Version);
        Assert.Equal(1, lib.Save("n_1", a, "tts", "หนึ่ง").Version);           // same bytes
        var v2 = lib.Save("n_1", b, "upload", "หนึ่ง");
        Assert.Equal(2, v2.Version);
        Assert.Equal(200, v2.DurationMs);

        var reloaded = NewLib();                                                  // fresh instance reads manifest.json
        var c = reloaded.Get("n_1")!;
        Assert.Equal(2, c.Version);
        Assert.Equal(v2.Sha256, c.Sha256);
        Assert.Equal("upload", c.Source);
        Assert.Equal(b, reloaded.ReadPcm("n_1"));

        Assert.True(reloaded.Delete("n_1"));
        Assert.Null(reloaded.ReadPcm("n_1"));
    }

    [Fact]
    public void Clip_Longer_Than_Limit_Is_Rejected()
    {
        var lib = NewLib();
        var tooLong = new byte[(AudioLibraryService.MaxClipSeconds + 1) * AudioLibraryService.SampleRate * 2];
        Assert.Throws<AudioFormatException>(() => lib.Save("s_x", tooLong, "upload", null));
    }

    [Fact]
    public void Vocabulary_Has_Engine_Defaults_And_Accepts_Override_File()
    {
        Directory.CreateDirectory(Path.Combine(_root, "App_Data", "audio"));
        File.WriteAllText(Path.Combine(_root, "App_Data", "audio", "vocab.json"),
            """[{"id":"s_pump_trip","text":"ปั๊มทริป","group":"word"},{"id":"n_1","text":"เอ็ด"},{"id":"bad id!"}]""");
        var vocab = NewLib().Vocabulary().ToDictionary(v => v.Id);

        Assert.Contains("n_0", vocab.Keys);
        Assert.Contains("dot", vocab.Keys);
        Assert.Contains("s_chem2_cl_d2_high", vocab.Keys);
        Assert.Equal("ปั๊มทริป", vocab["s_pump_trip"].Text);
        Assert.Equal("เอ็ด", vocab["n_1"].Text);
        Assert.DoesNotContain("bad id!", vocab.Keys);
    }

    [Fact]
    public void PlaylistIds_Collects_Ids_From_Alarm_Payload()
    {
        var state = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(
            """{"alarms":[{"playlist":["s_a","n_8","N_8"]},{"playlist":["../x"]},{"no":"playlist"},"junk"]}""");
        Assert.Equal(new[] { "n_8", "s_a" }, AudioLibraryService.PlaylistIds(state));
    }

    [Fact]
    public async Task Sse_Audio_Chunks_Are_Concatenated()
    {
        var c1 = Convert.ToBase64String(new byte[] { 1, 2, 3, 4 });
        var c2 = Convert.ToBase64String(new byte[] { 5, 6 });
        var sse = $"data: {{\"choices\":[{{\"delta\":{{\"audio\":{{\"data\":\"{c1}\"}}}}}}]}}\n\n" +
                  ": keep-alive\n\n" +
                  "data: {\"choices\":[{\"delta\":{\"audio\":{\"transcript\":\"หนึ่ง\"}}}]}\n\n" +
                  $"data: {{\"choices\":[{{\"delta\":{{\"audio\":{{\"data\":\"{c2}\"}}}}}}]}}\n\n" +
                  "data: [DONE]\n\n";
        var pcm = await TtsService.ReadSseAudioAsync(new MemoryStream(Encoding.UTF8.GetBytes(sse)), CancellationToken.None);
        Assert.Equal(new byte[] { 1, 2, 3, 4, 5, 6 }, pcm);
    }
}

public sealed class AudioEndpointTests : IClassFixture<BellBeastAdminFactory>, IClassFixture<BellBeastBaseFactory>
{
    private readonly BellBeastAdminFactory _admin;
    private readonly BellBeastBaseFactory _anon;

    public AudioEndpointTests(BellBeastAdminFactory admin, BellBeastBaseFactory anon)
    {
        _admin = admin;
        _anon = anon;
    }

    private static MultipartFormDataContent Form(string id, byte[] file, string name, string? text = null)
    {
        var f = new MultipartFormDataContent { { new StringContent(id), "id" } };
        if (text is not null) f.Add(new StringContent(text), "text");
        var fc = new ByteArrayContent(file);
        fc.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        f.Add(fc, "file", name);
        return f;
    }

    [Fact]
    public async Task Upload_Then_Device_Downloads_Raw_Pcm_With_Etag_And_Version()
    {
        var c = _admin.CreateClient();
        var wav = AudioLibraryServiceTests.Wav(AudioLibraryServiceTests.Tone(2400), 24000, 1);

        var up = await c.PostAsync("/api/audio/clip", Form("N_7", wav, "seven.wav", "เจ็ด"));
        Assert.Equal(HttpStatusCode.OK, up.StatusCode);

        var raw = await c.GetAsync("/api/audio/clip/n_7");
        Assert.Equal(HttpStatusCode.OK, raw.StatusCode);
        var bytes = await raw.Content.ReadAsByteArrayAsync();
        Assert.Equal(4800, bytes.Length);
        Assert.Equal("v1", raw.Headers.GetValues("X-Clip-Version").Single());
        var etag = raw.Headers.ETag!;

        var again = new HttpRequestMessage(HttpMethod.Get, "/api/audio/clip/n_7@v1");
        again.Headers.IfNoneMatch.Add(etag);
        Assert.Equal(HttpStatusCode.NotModified, (await c.SendAsync(again)).StatusCode);

        var asWav = await c.GetByteArrayAsync("/api/audio/clip/n_7?format=wav");
        Assert.Equal("RIFF", Encoding.ASCII.GetString(asWav, 0, 4));
        Assert.Equal(44 + 4800, asWav.Length);

        var list = await c.GetFromJsonAsync<JsonElement>("/api/audio/clips");
        var clip = list.GetProperty("clips").EnumerateArray().Single(x => x.GetProperty("id").GetString() == "n_7");
        Assert.Equal("เจ็ด", clip.GetProperty("text").GetString());
        Assert.DoesNotContain("n_7", list.GetProperty("missing").EnumerateArray().Select(x => x.GetString()));
        Assert.Contains("n_8", list.GetProperty("missing").EnumerateArray().Select(x => x.GetString()));

        Assert.Equal(HttpStatusCode.OK, (await c.DeleteAsync("/api/audio/clip/n_7")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.GetAsync("/api/audio/clip/n_7")).StatusCode);
    }

    [Fact]
    public async Task Bad_Upload_Returns_400_With_Reason()
    {
        var c = _admin.CreateClient();
        var resp = await c.PostAsync("/api/audio/clip", Form("s_x", Encoding.ASCII.GetBytes("ID3notawav"), "x.mp3"));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Contains("ffmpeg", await resp.Content.ReadAsStringAsync());

        var badId = await c.PostAsync("/api/audio/clip", Form("../evil", AudioLibraryServiceTests.Wav(new short[10], 24000, 1), "a.wav"));
        Assert.Equal(HttpStatusCode.BadRequest, badId.StatusCode);
    }

    [Fact]
    public async Task Writes_Need_Admin_But_Reads_Are_Anonymous()
    {
        var c = _anon.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/api/audio/clips")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.GetAsync("/api/audio/clip/n_0")).StatusCode);

        var wav = AudioLibraryServiceTests.Wav(new short[10], 24000, 1);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsync("/api/audio/clip", Form("n_0", wav, "a.wav"))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.DeleteAsync("/api/audio/clip/n_0")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsJsonAsync("/api/audio/tts", new { text = "x" })).StatusCode);

        var page = await _anon.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false }).GetAsync("/Admin/AudioLibrary");
        Assert.Equal(HttpStatusCode.Redirect, page.StatusCode);
        Assert.Contains("/Admin/Login", page.Headers.Location!.ToString());
    }

    [Fact]
    public async Task Tts_Without_Api_Key_Is_503_Not_Configured()
    {
        var resp = await _admin.CreateClient().PostAsJsonAsync("/api/audio/tts", new { text = "ทดสอบ" });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, resp.StatusCode);
        Assert.Contains("tts_not_configured", await resp.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Tts_Saves_Clip_And_Caches_Sentence_By_Text()
    {
        var calls = 0;
        _admin.EngineHandler.RequestHandler = req =>
        {
            calls++;
            Assert.Equal("openrouter.ai", req.RequestUri!.Host);
            Assert.Equal("Bearer", req.Headers.Authorization!.Scheme);
            var b64 = Convert.ToBase64String(new byte[480]);   // 10 ms of silence
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent($"data: {{\"choices\":[{{\"delta\":{{\"audio\":{{\"data\":\"{b64}\"}}}}}}]}}\n\ndata: [DONE]\n\n",
                    Encoding.UTF8, "text/event-stream")
            };
        };
        try
        {
            var c = _admin.WithWebHostBuilder(b => b.UseSetting("Audio:OpenRouterApiKey", "test-key")).CreateClient();

            var named = await c.PostAsJsonAsync("/api/audio/tts", new { id = "s_low", text = "ต่ำกว่าเกณฑ์" });
            Assert.Equal(HttpStatusCode.OK, named.StatusCode);
            var nj = await named.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("s_low", nj.GetProperty("clip").GetProperty("id").GetString());
            Assert.Equal("tts", nj.GetProperty("clip").GetProperty("source").GetString());

            var s1 = await (await c.PostAsJsonAsync("/api/audio/tts", new { text = "ปั๊มทริป โรงสูบ 1" })).Content.ReadFromJsonAsync<JsonElement>();
            var s2 = await (await c.PostAsJsonAsync("/api/audio/tts", new { text = "ปั๊มทริป โรงสูบ 1" })).Content.ReadFromJsonAsync<JsonElement>();
            var id = s1.GetProperty("clip").GetProperty("id").GetString()!;
            Assert.StartsWith("tts_", id);
            Assert.Equal(id, s2.GetProperty("clip").GetProperty("id").GetString());
            Assert.True(s2.GetProperty("cached").GetBoolean());
            Assert.Equal(2, calls);                                  // second sentence request served from the library

            Assert.Equal(480, (await c.GetByteArrayAsync("/api/audio/clip/" + id)).Length);
        }
        finally { _admin.EngineHandler.RequestHandler = null; }
    }

    [Fact]
    public async Task Ids_In_The_Live_Alarm_Playlist_Show_Up_As_Missing()
    {
        var c = _anon.CreateClient();
        var join = await c.PostAsync("/api/iot/room/join", new StringContent("""{"DeviceName":"uroboros-alarm","DeviceType":"alarm-engine"}""", Encoding.UTF8, "application/json"));
        var key = (await join.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("key").GetString();
        var body = "{\"Key\":\"" + key + "\",\"Data\":{\"alarm_mode\":\"SYNC\",\"alarms\":[{\"alarm_id\":\"x\",\"active\":true,\"playlist\":[\"s_brand_new_point\",\"n_1\"]}]}}";
        await c.PostAsync("/api/iot/room/data", new StringContent(body, Encoding.UTF8, "application/json"));

        var list = await c.GetFromJsonAsync<JsonElement>("/api/audio/clips");
        Assert.Contains("s_brand_new_point", list.GetProperty("referenced_by_engine").EnumerateArray().Select(x => x.GetString()));
        Assert.Contains("s_brand_new_point", list.GetProperty("missing").EnumerateArray().Select(x => x.GetString()));
    }
}
