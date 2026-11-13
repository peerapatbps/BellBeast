using System.Text.RegularExpressions;

/// <summary>Does what a browser does: open one of our pages and send its view token on every API call.</summary>
public static partial class ViewTokenTestHelper
{
    public const string Header = "X-View-Token";

    [GeneratedRegex("name=\"bb-view-token\" content=\"([^\"]*)\"")]
    private static partial Regex MetaRx();

    /// <summary>The view token from a page render (default /Privacy, an anonymous page with the shared layout).</summary>
    public static async Task<string> PageTokenAsync(this HttpClient client, string page = "/Privacy")
    {
        var html = await client.GetStringAsync(page);
        var m = MetaRx().Match(html);
        if (!m.Success || m.Groups[1].Value.Length == 0) throw new InvalidOperationException("no bb-view-token meta on " + page);
        return m.Groups[1].Value;
    }

    /// <summary>Adds a fresh view token to the client's default headers and returns the client.</summary>
    public static async Task<HttpClient> WithViewTokenAsync(this HttpClient client, string page = "/Privacy")
    {
        var token = await client.PageTokenAsync(page);
        client.DefaultRequestHeaders.Remove(Header);
        client.DefaultRequestHeaders.Add(Header, token);
        return client;
    }
}
