using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

/// <summary>Callers rejected for a missing view token get a random meme: an HTML page when they open the URL in a tab, a link in the JSON otherwise.</summary>
public sealed class RejectMemeTests
{
    private const string PageApi = "/api/engine/sequence/status";

    /// <summary>Fresh app per test so the meme list (cached for a minute) is read after the files exist.</summary>
    private static ViewTokenFactory App(params string[] memeFiles)
    {
        var f = new ViewTokenFactory();
        var dir = Path.Combine(f.Services.GetRequiredService<IWebHostEnvironment>().WebRootPath, "images", "meme");
        Directory.CreateDirectory(dir);
        foreach (var name in memeFiles) File.WriteAllBytes(Path.Combine(dir, name), "GIF89a"u8.ToArray());
        return f;
    }

    private static HttpRequestMessage Req(string? secFetchMode = null, string? accept = null)
    {
        var r = new HttpRequestMessage(HttpMethod.Get, PageApi);
        r.Headers.Add("X-Test-Remote-IP", "10.60.0.1");
        if (secFetchMode is not null) r.Headers.Add("Sec-Fetch-Mode", secFetchMode);
        if (accept is not null) r.Headers.TryAddWithoutValidation("Accept", accept);
        return r;
    }

    [Fact]
    public async Task Url_Typed_Into_A_Tab_Gets_An_Html_Page_With_A_Random_Meme()
    {
        using var f = App("hell nah.gif", "cat.gif", "notes.txt");
        var r = await f.CreateClient().SendAsync(Req("navigate", "text/html,application/xhtml+xml"));

        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.StartsWith("text/html", r.Content.Headers.ContentType?.ToString());
        var html = await r.Content.ReadAsStringAsync();
        Assert.Matches("<img src=\"/images/meme/(hell%20nah|cat)\\.gif\"", html);   // encoded, only image files
        Assert.Contains("max-height: 55vh", html);                                   // scaled to fit
        Assert.DoesNotContain("view_token", html);                                   // no hint why
        Assert.Contains("รู้นะว่าแอบเอาไปใช้ .. ไม่ให้หรอก 😂", html);
    }

    [Fact]
    public async Task Fetch_And_Curl_Keep_The_Json_Contract_With_A_Meme_Link()
    {
        using var f = App("only.gif");
        foreach (var req in new[] { Req("cors"), Req() })
        {
            var r = await f.CreateClient().SendAsync(req);
            Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
            var doc = JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;
            Assert.Equal("unauthorized", doc.GetProperty("error").GetString());
            Assert.Equal("/images/meme/only.gif", doc.GetProperty("meme").GetString());
        }
    }

    [Fact]
    public async Task Older_Browsers_Without_Sec_Fetch_Are_Detected_By_Accept()
    {
        using var f = App("only.gif");
        var r = await f.CreateClient().SendAsync(Req(accept: "text/html"));
        Assert.StartsWith("text/html", r.Content.Headers.ContentType?.ToString());
    }

    [Fact]
    public async Task Empty_Folder_Still_Rejects_Cleanly()
    {
        using var f = App();
        var page = await (await f.CreateClient().SendAsync(Req("navigate"))).Content.ReadAsStringAsync();
        Assert.DoesNotContain("<img", page);

        var json = JsonDocument.Parse(await (await f.CreateClient().SendAsync(Req("cors"))).Content.ReadAsStringAsync()).RootElement;
        Assert.Equal(JsonValueKind.Null, json.GetProperty("meme").ValueKind);
    }
}
