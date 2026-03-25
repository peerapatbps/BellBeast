using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace BellBeast.Pages.Admin
{
    public class LoginModel : PageModel
    {
        private readonly IConfiguration _cfg;
        public LoginModel(IConfiguration cfg) => _cfg = cfg;

        [BindProperty] public string Username { get; set; } = "00102616";
        [BindProperty] public string Password { get; set; } = "";
        public string? ErrorMessage { get; set; }

        public void OnGet() { }

        public async Task<IActionResult> OnPostAsync()
        {
            var allowedUser = (_cfg["AdminAuth:AllowedUsername"] ?? "").Trim();
            var storedHex = (_cfg["AdminAuth:PasswordPbkdf2"] ?? "").Trim(); // คุณเก็บ sha256 hex ไว้ช่องนี้

            if (string.IsNullOrWhiteSpace(allowedUser) || string.IsNullOrWhiteSpace(storedHex))
            {
                ErrorMessage = "AdminAuth config missing";
                return Page();
            }

            if (!string.Equals((Username ?? "").Trim(), allowedUser, StringComparison.Ordinal))
            {
                ErrorMessage = "Invalid username";
                return Page();
            }

            if (!VerifySha256Hex(Password ?? "", storedHex))
            {
                ErrorMessage = "Invalid password";
                return Page();
            }

            var claims = new List<Claim>
{
            new Claim(ClaimTypes.Name, allowedUser),
            new Claim("role", "admin"),              // ✅ ตรงกับ policy RequireClaim("role","admin")
            new Claim(ClaimTypes.Role, "Admin"),     // (optional) เผื่ออยากใช้ Role-based อื่นๆ
        };

            var identity = new ClaimsIdentity(claims, "AdminCookie");
            var principal = new ClaimsPrincipal(identity);

            await HttpContext.SignInAsync(
                "AdminCookie",
                principal,
                new AuthenticationProperties
                {
                    IsPersistent = false,
                    ExpiresUtc = DateTimeOffset.UtcNow.AddMinutes(15)
                });

            return RedirectToPage("/Admin/AdminPage");

        }

        private static bool VerifySha256Hex(string password, string storedHex)
        {
            storedHex = (storedHex ?? "").Trim().ToLowerInvariant();

            var actualHex = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(password ?? ""))
            ).ToLowerInvariant();

            if (actualHex.Length != storedHex.Length) return false;

            var diff = 0;
            for (int i = 0; i < actualHex.Length; i++)
                diff |= actualHex[i] ^ storedHex[i];

            return diff == 0;
        }
    }
}
