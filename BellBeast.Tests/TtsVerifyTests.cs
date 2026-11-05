using System.Net;
using System.Text;
using BellBeast.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

/// <summary>TTS output check (transcript + length) and retry — the s_mgl "จะพูดชัดเจน เข้าใจแล้วนะ" case.</summary>
public sealed class TtsVerifyTests
{
    private static byte[] Pcm(int ms) => new byte[ms * 48];

    [Fact]
    public void Check_Accepts_Exact_Transcript_Ignoring_Spaces_And_Digits()
    {
        Assert.Null(TtsService.Check("มิลลิกรัมต่อลิตร", Pcm(1600), "มิลลิกรัม ต่อ ลิตร"));
        Assert.Null(TtsService.Check("น้ำประปา 1 ความขุ่น", Pcm(2250), "น้ำประปา หนึ่ง ความขุ่น"));
    }

    [Fact]
    public void Check_Rejects_Added_Words()
    {
        var p = TtsService.Check("มิลลิกรัมต่อลิตร", Pcm(4750), "มิลลิกรัมต่อลิตร จะพูดชัดเจน เข้าใจแล้วนะ");
        Assert.NotNull(p);
        Assert.Contains("จะพูดชัดเจน", p);
    }

    [Fact]
    public void Check_Rejects_Audio_Far_Longer_Than_Text_Even_With_Clean_Transcript()
    {
        Assert.Contains("too long", TtsService.Check("มิลลิกรัมต่อลิตร", Pcm(9000), "มิลลิกรัมต่อลิตร"));
    }

    [Fact]
    public void Check_Rejects_Missing_Transcript()
    {
        Assert.NotNull(TtsService.Check("เอ็นทียู", Pcm(1800), "  "));
    }

    // ---- retry loop with a fake OpenRouter ----

    private sealed class SeqHandler(Queue<string> transcripts, int ms) : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            var tr = transcripts.Count > 0 ? transcripts.Dequeue() : "";
            var audio = Convert.ToBase64String(new byte[ms * 48]);
            var trJson = System.Text.Json.JsonSerializer.Serialize(tr);
            var sse = $"data: {{\"choices\":[{{\"delta\":{{\"audio\":{{\"data\":\"{audio}\"}}}}}}]}}\n\n" +
                      $"data: {{\"choices\":[{{\"delta\":{{\"audio\":{{\"transcript\":{trJson}}}}}}}]}}\n\n" +
                      "data: [DONE]\n\n";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(sse, Encoding.UTF8, "text/event-stream") });
        }
    }

    private sealed class Factory(HttpMessageHandler h) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(h, disposeHandler: false);
    }

    private static TtsService Tts(HttpMessageHandler h) => new(
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Audio:OpenRouterApiKey"] = "test-key" }).Build(),
        new Factory(h));

    [Fact]
    public async Task Retries_Until_Transcript_Matches()
    {
        var h = new SeqHandler(new Queue<string>(new[] { "มิลลิกรัมต่อลิตร จะพูดชัดเจน เข้าใจแล้วนะ", "มิลลิกรัมต่อลิตร" }), 1600);
        var r = await Tts(h).SynthesizeVerifiedAsync("มิลลิกรัมต่อลิตร", CancellationToken.None);
        Assert.True(r.Verified);
        Assert.Equal(2, r.Attempts);
        Assert.Equal(2, h.Calls);
    }

    [Fact]
    public async Task Gives_Up_After_Max_Attempts_Unverified()
    {
        var bad = "มิลลิกรัมต่อลิตร เข้าใจแล้วนะ";
        var h = new SeqHandler(new Queue<string>(new[] { bad, bad, bad, bad }), 1600);
        var r = await Tts(h).SynthesizeVerifiedAsync("มิลลิกรัมต่อลิตร", CancellationToken.None);
        Assert.False(r.Verified);
        Assert.Equal(3, r.Attempts);
        Assert.Equal(3, h.Calls);
        Assert.NotNull(r.Problem);
    }
}
