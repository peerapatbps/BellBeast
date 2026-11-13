using System.Net;

namespace BellBeast.ApiAccess;

/// <summary>
/// Random meme for callers rejected for a missing / stale view token.
/// Images live in wwwroot/images/meme (gif, png, jpg, webp); drop files in or remove them, the list refreshes every minute.
/// </summary>
public sealed class RejectMemes
{
    public const string Folder = "images/meme";
    private static readonly string[] Extensions = [".gif", ".png", ".jpg", ".jpeg", ".webp"];
    private static readonly TimeSpan Refresh = TimeSpan.FromMinutes(1);

    private readonly IWebHostEnvironment _env;
    private (DateTimeOffset At, string[] Urls) _cache = (DateTimeOffset.MinValue, []);

    public RejectMemes(IWebHostEnvironment env) => _env = env;

    /// <summary>URL of a random meme (e.g. "/images/meme/hell_nah.gif"), or null when the folder is empty.</summary>
    public string? Pick()
    {
        var urls = Urls();
        return urls.Length == 0 ? null : urls[Random.Shared.Next(urls.Length)];
    }

    private string[] Urls()
    {
        var c = _cache;
        if (DateTimeOffset.UtcNow - c.At < Refresh) return c.Urls;

        var dir = Path.Combine(_env.WebRootPath ?? "", Folder.Replace('/', Path.DirectorySeparatorChar));
        var urls = Directory.Exists(dir)
            ? Directory.EnumerateFiles(dir)
                .Where(f => Extensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase))
                .Select(f => "/" + Folder + "/" + Uri.EscapeDataString(Path.GetFileName(f)))
                .OrderBy(u => u, StringComparer.Ordinal)
                .ToArray()
            : [];
        _cache = (DateTimeOffset.UtcNow, urls);
        return urls;
    }

    /// <summary>A top-level browser navigation (URL typed into a tab), not fetch/XHR/curl.</summary>
    public static bool IsBrowserNavigation(HttpRequest req)
    {
        var mode = req.Headers["Sec-Fetch-Mode"].ToString();
        if (mode.Length > 0) return mode.Equals("navigate", StringComparison.OrdinalIgnoreCase);
        var accept = req.Headers.Accept.ToString();
        return accept.Contains("text/html", StringComparison.OrdinalIgnoreCase);   // older browsers without Sec-Fetch-*
    }

    /// <summary>Small self-contained page; the image is scaled to fit (never wider than 480 px or taller than 55% of the screen).</summary>
    public static string Page(string? memeUrl)
    {
        var img = memeUrl is null ? "" :
            $"<img src=\"{WebUtility.HtmlEncode(memeUrl)}\" alt=\"nope\">";
        return $$"""
            <!doctype html>
            <html lang="th">
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>401 · BellBeast</title>
            <style>
              :root { color-scheme: dark; }
              html, body { height: 100%; margin: 0; }
              body { display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box;
                     background: #0b1220; color: #e6ecf8; font: 15px/1.6 system-ui, "Segoe UI", Tahoma, sans-serif; text-align: center; }
              main { max-width: 520px; width: 100%; }
              img { display: block; margin: 0 auto 18px; width: auto; height: auto;
                    max-width: min(480px, 100%); max-height: 55vh; object-fit: contain; border-radius: 12px;
                    box-shadow: 0 10px 40px rgba(0,0,0,.45); }
              h1 { margin: 0 0 6px; font-size: 22px; }
              p { margin: 0; }
              .msg { font-size: 17px; color: #e6ecf8; }
            </style>
            </head>
            <body>
            <main>
              {{img}}
              <h1>401 · ไม่ผ่าน</h1>
              <p class="msg">รู้นะว่าแอบเอาไปใช้ .. ไม่ให้หรอก 😂</p>
            </main>
            </body>
            </html>
            """;
    }
}
