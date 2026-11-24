#nullable enable
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace BellBeast.Services;

/// <summary>
/// AquaDAT 2.0 ADFS SAML login for BellBeast, ported from Uroboros' Aquadat2LoginProbe
/// (handoff/Aquadat2/SOP_Aquadat2_Read_Write_Remark.docx §การเข้าสู่ระบบและยืนยันตัวตน, 6 steps):
///
///   1. GET  /api/Authen/Saml/login        → 303 to ADFS (madfed.mwa.co.th) + Saml2.&lt;RelayState&gt; cookie
///   2. GET  the ADFS page                  → #loginForm
///   3. POST UserName/Password              → auto-post page carrying SAMLResponse
///   4. POST /Saml2/Acs                     → 200 + AuthCookie, one-time token in the body
///   5. POST /api/Authen/Saml/loginbypass   → { data: { token (JWT), refreshToken } }
///   6. use Authorization: Bearer &lt;token&gt;
///
/// The JWT (HS256, 12 h) carries nameid (employee id), Organization and Position — read for the
/// signed-in badge. SOP Pitfalls: aquadat2 is AD-backed, so a wrong password counts toward AD
/// lockout — the interactive form login tries ONCE; only the built-in test account walks the
/// closed rotation set (media/aquadat2.ini), never an open guess.
/// </summary>
public static class AdfsLogin
{
    public const string DefaultBase = "https://aquadat2.mwa.co.th";

    public static string BaseUrl =>
        (Environment.GetEnvironmentVariable("AQ2_BASE") ?? DefaultBase).TrimEnd('/');

    /// <summary>What the cookie/badge needs after a successful login.</summary>
    public sealed record Result(
        string Token, string? RefreshToken, string Username,
        string DisplayName, string Position, string Organization);

    // ---------------------------------------------------------------------------------------------
    // Public entry points
    // ---------------------------------------------------------------------------------------------

    /// <summary>One ADFS login with a single password (the interactive form path). Null on failure.</summary>
    public static Task<Result?> LoginAsync(string user, string password, CancellationToken ct = default) =>
        LoginWithCandidatesAsync(user, new[] { password }, delayMs: 0, ct);

    /// <summary>
    /// Try the given passwords in order on independent cookie jars until one is accepted (built-in
    /// test account only). <paramref name="delayMs"/> spaces attempts so ADFS is not hammered.
    /// </summary>
    public static async Task<Result?> LoginWithCandidatesAsync(
        string user, IReadOnlyList<string> passwords, int delayMs, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(user) || passwords.Count == 0) return null;
        var baseUrl = BaseUrl;

        for (int i = 0; i < passwords.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            using var http = NewClient();
            var (ok, html) = await TrySamlLoginAsync(http, baseUrl, user, passwords[i], ct).ConfigureAwait(false);
            if (ok)
            {
                var res = await CompleteAsync(http, baseUrl, user, html, ct).ConfigureAwait(false);
                if (res is not null) return res;
            }
            if (i + 1 < passwords.Count && delayMs > 0)
                await Task.Delay(delayMs, ct).ConfigureAwait(false);
        }
        return null;
    }

    /// <summary>
    /// Built-in test-account credentials, read from media/aquadat2.ini [LOGIN] USERNAME/PASSWORD
    /// (same file Uroboros uses; kept out of git). Returns ("","") when the file/keys are missing.
    /// </summary>
    public static (string user, string password) ReadBypassCredential()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "media", "aquadat2.ini");
        var ini = ReadIni(path);
        ini.TryGetValue(("LOGIN", "USERNAME"), out var user);
        ini.TryGetValue(("LOGIN", "PASSWORD"), out var pass);
        return (user ?? "", pass ?? "");
    }

    /// <summary>
    /// AD domain prepended to a bare employee id at normal login. Taken from env AQ2_DOMAIN,
    /// else the domain of the test account in media/aquadat2.ini (e.g. water.mwa\00102616 →
    /// water.mwa), else "water.mwa". ADFS rejects a bare id, so domain\user is required.
    /// </summary>
    public static string DefaultDomain
    {
        get
        {
            var env = Environment.GetEnvironmentVariable("AQ2_DOMAIN");
            if (!string.IsNullOrWhiteSpace(env)) return env.Trim().Trim('\\');
            var (iniUser, _) = ReadBypassCredential();
            int bs = iniUser.IndexOf('\\');
            if (bs > 0) return iniUser[..bs];
            return "water.mwa";
        }
    }

    /// <summary>Prepend the AD domain when the user typed a bare id (no "domain\" and no UPN "@").</summary>
    public static string NormalizeUsername(string typed)
    {
        var u = (typed ?? "").Trim();
        if (u.Length == 0) return u;
        if (u.Contains('\\') || u.Contains('@')) return u;
        return $"{DefaultDomain}\\{u}";
    }

    /// <summary>True when two AD usernames name the same account (compares the id part, case-insensitive).</summary>
    public static bool SameAccount(string a, string b)
    {
        static string Id(string s)
        {
            s = (s ?? "").Trim();
            int bs = s.LastIndexOf('\\');
            if (bs >= 0) s = s[(bs + 1)..];
            int at = s.IndexOf('@');
            if (at >= 0) s = s[..at];
            return s.Trim();
        }
        var ia = Id(a);
        return ia.Length > 0 && string.Equals(ia, Id(b), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Closed MWA rotation set for the test account. For an 8-char all-same-digit stored password
    /// (e.g. 44444444) candidates step +1 and wrap 9→1 (4,5,…,9,1,2,3); otherwise the stored value
    /// is tried first, then 11111111..99999999. Capped at 9 — never an open guess.
    /// </summary>
    public static List<string> BuildCandidates(string stored)
    {
        var list = new List<string>();
        if (IsDigitPattern(stored, out int d))
        {
            for (int k = 0; k < 9; k++)
            {
                int digit = ((d - 1 + k) % 9) + 1;
                list.Add(new string((char)('0' + digit), 8));
            }
        }
        else
        {
            if (!string.IsNullOrWhiteSpace(stored)) list.Add(stored);
            for (int d2 = 1; d2 <= 9; d2++)
            {
                var c = new string((char)('0' + d2), 8);
                if (!list.Contains(c)) list.Add(c);
            }
        }
        return list;
    }

    // ---------------------------------------------------------------------------------------------
    // Steps 4–6 + JWT claims
    // ---------------------------------------------------------------------------------------------

    private static async Task<Result?> CompleteAsync(
        HttpClient http, string baseUrl, string user, string postLoginHtml, CancellationToken ct)
    {
        if (!TryParseSamlResponseForm(postLoginHtml, out var acsUrl, out var samlResponse, out var relayState))
            return null;

        // Step 4 — POST the SAMLResponse to the ACS endpoint
        var acsFields = new Dictionary<string, string> { ["SAMLResponse"] = samlResponse };
        if (!string.IsNullOrEmpty(relayState)) acsFields["RelayState"] = relayState;
        using var acsForm = new FormUrlEncodedContent(acsFields);
        using var acsResp = await http.PostAsync(AbsUrl(acsUrl, baseUrl), acsForm, ct).ConfigureAwait(false);
        var acsBody = await acsResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        var oneTime = ExtractQueryParam(acsResp.Headers.Location?.ToString(), "token") ?? ExtractTokenFromBody(acsBody);
        if (string.IsNullOrWhiteSpace(oneTime)) return null;

        // Step 5 — exchange the one-time token for the JWT
        using var bypassBody = new StringContent(
            JsonSerializer.Serialize(new { token = oneTime }), Encoding.UTF8, "application/json");
        using var bypassResp = await http.PostAsync(
            $"{baseUrl}/api/Authen/Saml/loginbypass", bypassBody, ct).ConfigureAwait(false);
        var bypassJson = await bypassResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        var jwt = ReadLoginResult(bypassJson, out var refreshToken);
        if (string.IsNullOrWhiteSpace(jwt)) return null;

        var claims = ParseJwtClaims(jwt);
        string Pick(params string[] keys)
        {
            foreach (var k in keys)
                if (claims.TryGetValue(k, out var v) && !string.IsNullOrWhiteSpace(v)) return v.Trim();
            return "";
        }
        var display = Pick("name", "unique_name", "FullName", "fullName", "DisplayName", "given_name");
        var position = Pick("Position", "position", "title");
        var org = Pick("Organization", "organization", "org");
        if (string.IsNullOrWhiteSpace(display)) display = user;

        return new Result(jwt, refreshToken, user, display, position, org);
    }

    /// <summary>Decode a JWT payload into a flat string map (string &amp; number claims only).</summary>
    public static Dictionary<string, string> ParseJwtClaims(string jwt)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var parts = jwt.Split('.');
            if (parts.Length < 2) return map;
            var json = Encoding.UTF8.GetString(Base64UrlDecode(parts[1]));
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return map;
            foreach (var p in doc.RootElement.EnumerateObject())
            {
                map[p.Name] = p.Value.ValueKind switch
                {
                    JsonValueKind.String => p.Value.GetString() ?? "",
                    JsonValueKind.Number => p.Value.ToString(),
                    _ => p.Value.ToString(),
                };
            }
        }
        catch { /* malformed token → no claims */ }
        return map;
    }

    private static byte[] Base64UrlDecode(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4) { case 2: s += "=="; break; case 3: s += "="; break; }
        return Convert.FromBase64String(s);
    }

    // ---------------------------------------------------------------------------------------------
    // Steps 1–3 (ADFS form) — ported from Aquadat2LoginProbe
    // ---------------------------------------------------------------------------------------------

    private static async Task<(bool ok, string html)> TrySamlLoginAsync(
        HttpClient http, string baseUrl, string user, string pass, CancellationToken ct)
    {
        // Step 1
        using var startResp = await http.GetAsync($"{baseUrl}/api/Authen/Saml/login", ct).ConfigureAwait(false);
        if (startResp.StatusCode is not (HttpStatusCode.SeeOther or HttpStatusCode.Found)) return (false, "");
        var adfsUrl = startResp.Headers.Location?.ToString();
        if (string.IsNullOrWhiteSpace(adfsUrl)) return (false, "");

        // Step 2
        using var formResp = await http.GetAsync(adfsUrl, ct).ConfigureAwait(false);
        var formHtml = await formResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!TryParseLoginForm(formHtml, adfsUrl, out var postUrl, out var fields)) return (false, "");

        // Step 3
        fields["UserName"] = user;
        fields["Password"] = pass;
        if (!fields.ContainsKey("AuthMethod")) fields["AuthMethod"] = "FormsAuthentication";
        using var form = new FormUrlEncodedContent(fields);
        var postResp = await http.PostAsync(postUrl, form, ct).ConfigureAwait(false);
        var html = await postResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        // follow ADFS self-redirects (MSISAuth cookies) up to the SAMLResponse page
        var current = postResp;
        int guard = 0;
        try
        {
            while (current.StatusCode is (HttpStatusCode.Found or HttpStatusCode.SeeOther)
                   && current.Headers.Location != null && guard++ < 5)
            {
                var next = AbsUrl(current.Headers.Location.ToString(), adfsUrl);
                current.Dispose();
                current = await http.GetAsync(next, ct).ConfigureAwait(false);
                html = await current.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            }
        }
        finally { current.Dispose(); }

        return TryParseSamlResponseForm(html, out _, out _, out _) ? (true, html) : (false, html);
    }

    private static HttpClient NewClient()
    {
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = true,
            CookieContainer = new CookieContainer(),
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
        };
        var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(60) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("BellBeast-adfs/1.0");
        return http;
    }

    // ---------------------------------------------------------------------------------------------
    // Parsing helpers (ported)
    // ---------------------------------------------------------------------------------------------

    private static readonly Regex RxFormLogin = new(
        @"<form\b[^>]*\bid=[""']?loginForm[""']?[^>]*>", RegexOptions.IgnoreCase);
    private static readonly Regex RxAction = new(@"\baction=[""']([^""']+)[""']", RegexOptions.IgnoreCase);
    private static readonly Regex RxInput = new(@"<input\b[^>]*>", RegexOptions.IgnoreCase);
    private static readonly Regex RxAttr = new(@"\b(name|value|type)=[""']([^""']*)[""']", RegexOptions.IgnoreCase);

    private static bool TryParseLoginForm(string html, string pageUrl, out string postUrl,
        out Dictionary<string, string> fields)
    {
        postUrl = "";
        fields = new Dictionary<string, string>(StringComparer.Ordinal);
        var m = RxFormLogin.Match(html);
        if (!m.Success) return false;

        var actionM = RxAction.Match(m.Value);
        postUrl = AbsUrl(actionM.Success ? WebUtility.HtmlDecode(actionM.Groups[1].Value) : pageUrl, pageUrl);

        foreach (Match im in RxInput.Matches(html))
        {
            string? name = null, value = null, type = null;
            foreach (Match am in RxAttr.Matches(im.Value))
            {
                var k = am.Groups[1].Value.ToLowerInvariant();
                var v = WebUtility.HtmlDecode(am.Groups[2].Value);
                if (k == "name") name = v;
                else if (k == "value") value = v;
                else if (k == "type") type = v;
            }
            if (string.IsNullOrEmpty(name)) continue;
            if (string.Equals(type, "submit", StringComparison.OrdinalIgnoreCase)) continue;
            if (!fields.ContainsKey(name)) fields[name] = value ?? "";
        }
        return true;
    }

    private static readonly Regex RxSamlResp = new(
        @"name=[""']SAMLResponse[""'][^>]*\bvalue=[""']([^""']+)[""']", RegexOptions.IgnoreCase);
    private static readonly Regex RxRelay = new(
        @"name=[""']RelayState[""'][^>]*\bvalue=[""']([^""']*)[""']", RegexOptions.IgnoreCase);
    private static readonly Regex RxAcsAction = new(
        @"<form\b[^>]*\baction=[""']([^""']*Acs[^""']*)[""']", RegexOptions.IgnoreCase);

    private static bool TryParseSamlResponseForm(string html, out string acsUrl,
        out string samlResponse, out string relayState)
    {
        acsUrl = ""; samlResponse = ""; relayState = "";
        var sm = RxSamlResp.Match(html);
        if (!sm.Success) return false;
        samlResponse = WebUtility.HtmlDecode(sm.Groups[1].Value);
        var rm = RxRelay.Match(html);
        relayState = rm.Success ? WebUtility.HtmlDecode(rm.Groups[1].Value) : "";
        var am = RxAcsAction.Match(html);
        acsUrl = am.Success ? WebUtility.HtmlDecode(am.Groups[1].Value) : "/Saml2/Acs";
        return true;
    }

    private static readonly Regex RxBypassToken = new(
        @"adfs_bypasstoken[^""'<>\s]*[?&]token=([^""'&<>\s\\]+)", RegexOptions.IgnoreCase);
    private static readonly Regex RxAnyToken = new(
        @"[?&]token=([^""'&<>\s\\]+)", RegexOptions.IgnoreCase);

    private static string? ExtractTokenFromBody(string body)
    {
        if (string.IsNullOrEmpty(body)) return null;
        var m = RxBypassToken.Match(body);
        if (m.Success) return WebUtility.HtmlDecode(Uri.UnescapeDataString(m.Groups[1].Value));
        m = RxAnyToken.Match(body);
        if (m.Success) return WebUtility.HtmlDecode(Uri.UnescapeDataString(m.Groups[1].Value));
        return null;
    }

    private static string? ExtractQueryParam(string? url, string key)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        int q = url.IndexOf('?');
        if (q < 0) return null;
        foreach (var kv in url.Substring(q + 1).Split('&'))
        {
            var parts = kv.Split('=', 2);
            if (parts.Length == 2 && Uri.UnescapeDataString(parts[0]) == key)
                return Uri.UnescapeDataString(parts[1]);
        }
        return null;
    }

    private static string ReadLoginResult(string json, out string refreshToken)
    {
        refreshToken = "";
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return "";
            if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object) return "";
            string Get(string name) =>
                data.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
            refreshToken = Get("refreshToken");
            return Get("token");
        }
        catch { return ""; }
    }

    private static string AbsUrl(string url, string baseAbsolute)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var abs)) return abs.ToString();
        return new Uri(new Uri(baseAbsolute, UriKind.Absolute), url).ToString();
    }

    private static bool IsDigitPattern(string? s, out int digit)
    {
        digit = 0;
        if (s is null || s.Length != 8) return false;
        char c0 = s[0];
        if (c0 is < '1' or > '9') return false;
        foreach (var ch in s) if (ch != c0) return false;
        digit = c0 - '0';
        return true;
    }

    // ---------------------------------------------------------------------------------------------
    // Minimal INI reader (section/key case-insensitive) — no P/Invoke, so it works for a read.
    // ---------------------------------------------------------------------------------------------

    private static Dictionary<(string, string), string> ReadIni(string path)
    {
        var ci = new Dictionary<(string, string), string>();
        if (!File.Exists(path)) return ci;
        string section = "";
        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] is ';' or '#') continue;
            if (line[0] == '[' && line[^1] == ']') { section = line[1..^1].Trim(); continue; }
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            var key = line[..eq].Trim();
            var val = line[(eq + 1)..].Trim();
            ci[(section.ToUpperInvariant(), key.ToUpperInvariant())] = val;
        }
        return ci;
    }
}
