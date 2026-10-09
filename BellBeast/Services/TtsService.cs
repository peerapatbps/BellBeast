using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace BellBeast.Services;

/// <summary>
/// Server-side TTS for the audio library (sentence clips / vocab drafts). Same call the device firmware
/// proved on hardware: OpenRouter chat completions, model gpt-audio-mini, audio format pcm16 =
/// PCM16 24 kHz mono LE — exactly the device codec, so the output is stored as-is.
///
/// Config (appsettings / env, never logged):
///   Audio:OpenRouterApiKey  (or env OPENROUTER_API_KEY)
///   Audio:TtsModel          default "openai/gpt-audio-mini"
///   Audio:TtsVoice          default "alloy"
/// </summary>
public sealed class TtsService
{
    private const string Endpoint = "https://openrouter.ai/api/v1/chat/completions";

    private readonly IConfiguration _cfg;
    private readonly IHttpClientFactory _http;

    public TtsService(IConfiguration cfg, IHttpClientFactory http)
    {
        _cfg = cfg;
        _http = http;
    }

    private string ApiKey => (_cfg["Audio:OpenRouterApiKey"] ?? Environment.GetEnvironmentVariable("OPENROUTER_API_KEY") ?? "").Trim();
    public string Model => (_cfg["Audio:TtsModel"] ?? "").Trim() is { Length: > 0 } m ? m : "openai/gpt-audio-mini";
    public string Voice => (_cfg["Audio:TtsVoice"] ?? "").Trim() is { Length: > 0 } v ? v : "alloy";
    public bool Configured => ApiKey.Length > 0;

    /// <returns>PCM16 24 kHz mono bytes.</returns>
    public async Task<byte[]> SynthesizeAsync(string text, CancellationToken ct)
    {
        if (!Configured) throw new TtsException("tts_not_configured", "set Audio:OpenRouterApiKey (or env OPENROUTER_API_KEY) on the BellBeast server");

        var body = new
        {
            model = Model,
            stream = true, // audio output requires stream:true
            modalities = new[] { "text", "audio" },
            audio = new { voice = Voice, format = "pcm16" },
            messages = new object[]
            {
                new { role = "system", content = "You are a text-to-speech engine for a Thai water-plant alarm. Read the user's text aloud in Thai exactly as written, clearly and calmly. Do not add, translate or omit any words." },
                new { role = "user", content = text },
            },
        };

        using var req = new HttpRequestMessage(HttpMethod.Post, Endpoint)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", ApiKey);

        var client = _http.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(90);
        using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync(ct);
            throw new TtsException("tts_upstream_error", $"HTTP {(int)resp.StatusCode}: {Truncate(err, 300)}");
        }

        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        var pcm = await ReadSseAudioAsync(stream, ct);
        if (pcm.Length < 2) throw new TtsException("tts_no_audio", "upstream returned no audio");
        return pcm.Length % 2 == 0 ? pcm : pcm[..^1];
    }

    /// <summary>Concatenates choices[0].delta.audio.data (base64) chunks from an SSE stream.</summary>
    public static async Task<byte[]> ReadSseAudioAsync(Stream stream, CancellationToken ct)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8);
        using var buf = new MemoryStream();
        string? line;
        while ((line = await reader.ReadLineAsync(ct)) is not null)
        {
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
            var payload = line[5..].Trim();
            if (payload == "[DONE]") break;
            if (payload.Length == 0) continue;

            try
            {
                using var doc = JsonDocument.Parse(payload);
                if (doc.RootElement.TryGetProperty("error", out var e))
                    throw new TtsException("tts_upstream_error", Truncate(e.ToString(), 300));
                if (!doc.RootElement.TryGetProperty("choices", out var ch) || ch.ValueKind != JsonValueKind.Array || ch.GetArrayLength() == 0) continue;
                if (ch[0].TryGetProperty("delta", out var delta) &&
                    delta.TryGetProperty("audio", out var audio) &&
                    audio.TryGetProperty("data", out var data) &&
                    data.ValueKind == JsonValueKind.String)
                {
                    var bytes = Convert.FromBase64String(data.GetString() ?? "");
                    buf.Write(bytes, 0, bytes.Length);
                }
            }
            catch (JsonException) { /* keep-alive / partial line */ }
        }
        return buf.ToArray();
    }

    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n] + "…";
}

public sealed class TtsException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
