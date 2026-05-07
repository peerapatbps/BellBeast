using System.Net.Http.Json;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace BellBeast.Pages
{
    public class LoginModel : PageModel
    {
        private readonly IHttpClientFactory _httpFactory;

        public LoginModel(IHttpClientFactory httpFactory)
        {
            _httpFactory = httpFactory;
        }

        [BindProperty] public string Username { get; set; } = "";
        [BindProperty] public string Password { get; set; } = "";
        [BindProperty] public bool UseDefaultAd { get; set; }

        public string ErrorMessage { get; set; } = "";

        public void OnGet() { }

        public async Task<IActionResult> OnPostAsync()
        {

            string user;
            string pass;

            // 1) เลือก Credential จากการติ๊ก Checkbox หรือการกรอก
            if (UseDefaultAd)
            {
                // บัญชีทดสอบถูกเก็บไว้ที่ Server-side ปลอดภัยกว่า
                user = "00102616";
                pass = "99999999";
            }
            else
            {
                // ใช้ค่าจาก Input (ใส่ ?? "" เพื่อกัน Error กรณีค่าเป็น null)
                user = (Username ?? "").Trim();
                pass = (Password ?? "").Trim();
            }

            // ตรวจสอบความว่างเปล่า
            if (string.IsNullOrWhiteSpace(user) || string.IsNullOrWhiteSpace(pass))
            {
                ErrorMessage = "กรุณากรอก Username และ Password หรือเลือกบัญชีทดสอบ";
                return Page();
            }

            // 2) ขอ token จาก Aquadat
            var token = await TryLogin(user, pass);

            // fallback: brute force (ถ้าไม่ได้รหัสแรก ลองรหัส 1111-9999)
            if (token == null)
            {
                token = await BruteforceLogin(user, pass);
            }

            if (token == null)
            {
                ErrorMessage = "Login ไม่สำเร็จ (ไม่สามารถขอ token ได้)";
                return Page();
            }

            // 3) Sign in (Cookie + Claim)
            var claims = new List<Claim>
    {
        new Claim(ClaimTypes.Name, user),
        new Claim("AquadatToken", token)
    };

            var identity = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
            await HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity));

            return Redirect("/Index");
        }

        // =====================================================
        // Call Aquadat Enroll
        // =====================================================
        private async Task<string?> TryLogin(string username, string password)
        {
            try
            {
                var client = _httpFactory.CreateClient("aquadat");

                var res = await client.PostAsJsonAsync(
                    "http://aquadat.mwa.co.th:12007/api/aquaDATService/Enroll",
                    new { username, password }
                );

                if (!res.IsSuccessStatusCode)
                    return null;

                var json = await res.Content.ReadFromJsonAsync<AquadatResponse>();
                if (json?.status == 200 && !string.IsNullOrEmpty(json.results?.token))
                    return json.results.token;

                return null;
            }
            catch
            {
                return null;
            }
        }

        // =====================================================
        // Bruteforce fallback (จำกัด, ปลอดภัย)
        // =====================================================
        private async Task<string?> BruteforceLogin(string username, string lastPassword)
        {
            // ตัวเลขที่จะใช้สร้างรหัสผ่าน 8 หลัก (1-9)
            int[] digits = { 1, 2, 3, 4, 5, 6, 7, 8, 9 };

            // หาว่ารหัสล่าสุดที่ส่งมา ขึ้นต้นด้วยเลขอะไร (ถ้าไม่ใช่ตัวเลขให้เริ่มที่ 0)
            int currentDigit = 0;
            if (!string.IsNullOrEmpty(lastPassword) && char.IsDigit(lastPassword[0]))
            {
                currentDigit = int.Parse(lastPassword[0].ToString());
            }

            // วนทดสอบ 9 ครั้ง (เพื่อให้ครบทุกความเป็นไปได้ 11111111 ถึง 99999999)
            for (int i = 1; i <= 9; i++)
            {
                // คำนวณเลขถัดไป: (เลขปัจจุบัน + i - 1) % 9 + 1 
                // เช่น ถ้าล่าสุดคือ 9 ตัวถัดไปจะเป็น 1
                int nextDigit = (currentDigit + i - 1) % 9 + 1;

                // สร้าง String เลขซ้ำกัน 8 ตัว เช่น "11111111"
                var pwd = new string(nextDigit.ToString()[0], 8);

                // ลอง Login ด้วยรหัสที่สร้างขึ้น
                var token = await TryLogin(username, pwd);
                if (token != null)
                {
                    return token; // ถ้าสำเร็จ ส่ง Token กลับทันที
                }

                // รอ 300ms เพื่อไม่ให้ยิง API ถี่เกินไปจนโดน Block
                await Task.Delay(300);
            }

            return null; // ถ้าครบ 9 ครั้งแล้วยังไม่ได้ ก็ส่ง null
        }

        private class AquadatResponse
        {
            public int status { get; set; }
            public Result? results { get; set; }

            public class Result
            {
                public string? token { get; set; }
            }
        }
    }
}
