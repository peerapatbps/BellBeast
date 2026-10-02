using System.Net.Http.Json;

public class EngineAdminService
{
    private readonly HttpClient _http;

    public EngineAdminService(IHttpClientFactory factory)
    {
        _http = factory.CreateClient();
        _http.BaseAddress = new Uri("http://localhost:8888/");
    }

    public async Task<object?> GetStatusAsync()
    {
        return await _http.GetFromJsonAsync<object>("admin/tasks/status");
    }

    public async Task<object?> GetConfigAsync()
    {
        return await _http.GetFromJsonAsync<object>("admin/tasks/config");
    }

    public async Task PauseAsync()
    {
        await _http.PostAsync("admin/pause", null);
    }

    public async Task ResumeAsync()
    {
        await _http.PostAsync("admin/resume", null);
    }

    public async Task CancelAllAsync()
    {
        await _http.PostAsync("admin/cancelall", null);
    }

    public async Task EnqueueAsync(string name)
    {
        await _http.PostAsJsonAsync("tasks/enqueue", new { name });
    }

    // ── Sequential "start all loops" (Uroboros StartupSequencer) ──────────────
    // Return raw status + JSON so the proxy can relay 202/409 etc. unchanged.

    public Task<(int Status, string Body)> StartSequenceAsync(string source)
        => SendRawAsync(HttpMethod.Post, "admin/sequence/start", JsonContent.Create(new { source }));

    public Task<(int Status, string Body)> GetSequenceStatusAsync()
        => SendRawAsync(HttpMethod.Get, "admin/sequence/status", null);

    public Task<(int Status, string Body)> CancelSequenceAsync()
        => SendRawAsync(HttpMethod.Post, "admin/sequence/cancel", null);

    private async Task<(int Status, string Body)> SendRawAsync(HttpMethod method, string path, HttpContent? content)
    {
        using var req = new HttpRequestMessage(method, path) { Content = content };
        using var resp = await _http.SendAsync(req);
        return ((int)resp.StatusCode, await resp.Content.ReadAsStringAsync());
    }

    public async Task<object?> RunTestsAsync()
    {
        var resp = await _http.GetAsync("admin/test/run");
        if (!resp.IsSuccessStatusCode) return null;
        return await resp.Content.ReadFromJsonAsync<object>();
    }
}
