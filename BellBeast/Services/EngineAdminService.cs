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
}
