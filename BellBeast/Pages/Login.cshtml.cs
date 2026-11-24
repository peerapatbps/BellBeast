using System.Security.Claims;
using BellBeast.Services;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace BellBeast.Pages
{
    public class LoginModel : PageModel
    {
        [BindProperty] public string Username { get; set; } = "";
        [BindProperty] public string Password { get; set; } = "";
        [BindProperty] public bool UseDefaultAd { get; set; }

        public string ErrorMessage { get; set; } = "";

        public void OnGet() { }

        public async Task<IActionResult> OnPostAsync()
        {
            // AquaDAT 2.0 moved to ADFS (SOP_Aquadat2_Read_Write_Remark.docx §การเข้าสู่ระบบ):
            //   • Normal login — the user's own AD account via the ADFS SAML flow, tried ONCE
            //     (a wrong AD password counts toward AD lockout).
            //   • Built-in test account (bypass) — app access only. Uroboros owns the single
            //     aquadat2 session (one session per account), so BellBeast must NOT run its own
            //     ADFS login with the shared media/aquadat2.ini account: that login would evict
            //     Uroboros's session and every data query would then fail with HTTP 401 / 407
            //     ("บัญชีนี้มีการเข้าสู่ระบบจากที่อื่น"). Bypass gets a cookie identity with no
            //     aquadat2 token; data flows through Uroboros's own session (see /api/process).
            // Sapphire: the bypass identity is the dedicated aquadat2 account 000102616 (no longer
            // the media/aquadat2.ini AD account), and the old interlock that forced the ini id
            // (00102616) into bypass is removed — 00102616 logs in normally via
            // /api/Authen/Login like any other id; the interlock now guards 000102616 instead.
            const string BypassUser = "000102616";
            var typedUser = (Username ?? "").Trim();

            // Interlock (same rule as before, now on 000102616): typing the bypass account's id in
            // the normal box also forces bypass — a real /api/Authen/Login with it could evict the
            // single aquadat2 session Uroboros holds on that same account.
            bool useBypass = UseDefaultAd || AdfsLogin.SameAccount(typedUser, BypassUser);

            AdfsLogin.Result? login;

            if (useBypass)
            {
                login = new AdfsLogin.Result(
                    Token: "", RefreshToken: null, Username: BypassUser,
                    DisplayName: "", Position: "", Organization: "");
            }
            else
            {
                var pass = (Password ?? "").Trim();
                if (string.IsNullOrWhiteSpace(typedUser) || string.IsNullOrWhiteSpace(pass))
                {
                    ErrorMessage = "กรุณากรอก Username และ Password หรือเลือกบัญชีทดสอบ";
                    return Page();
                }
                // Sapphire: direct aquadat2 account login (POST /api/Authen/Login) with the bare
                // user id — replaces the ADFS SAML flow (AdfsLogin.LoginAsync) for normal users.
                var (direct, err) = await AdfsLogin.DirectLoginAsync(typedUser, pass, HttpContext.RequestAborted);
                login = direct;
                if (login is null)
                {
                    ErrorMessage = string.IsNullOrWhiteSpace(err)
                        ? "Login ไม่สำเร็จ (Username/Password ไม่ถูกต้อง หรือขอ token ไม่ได้)"
                        : $"Login ไม่สำเร็จ: {err}";
                    return Page();
                }
            }

            if (login is null)
            {
                ErrorMessage = "Login ไม่สำเร็จ (ขอ token ไม่ได้)";
                return Page();
            }

            // Cookie identity. The JWT stays server-side (injected by /api/process); the browser only
            // ever sees the display name + position, which feed the signed-in badge on /Index.
            // Built-in test account: the real AD user is kept in Name, but the badge shows a fixed
            // "bypass" label (LoginKind=bypass) instead of that account's own name/position.
            const string BypassName = "โหมดทดสอบ (Bypass)";
            const string BypassPosition = "บัญชีทดสอบระบบ";

            var displayName = useBypass ? BypassName : login.DisplayName;
            var position = useBypass ? BypassPosition : login.Position;

            var claims = new List<Claim>
            {
                new(ClaimTypes.Name, login.Username),
                new("AquadatToken", login.Token),
                new("DisplayName", displayName),
                new("Position", position),
                new("Organization", login.Organization),
                new("LoginKind", useBypass ? "bypass" : "direct"),
            };
            if (!string.IsNullOrEmpty(login.RefreshToken))
                claims.Add(new Claim("AquadatRefreshToken", login.RefreshToken));

            var identity = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
            await HttpContext.SignInAsync(
                CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity));

            return Redirect("/Index");
        }
    }
}
