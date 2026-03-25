using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace BellBeast.Pages
{
    public class MHxViewModel : PageModel
    {
        public IActionResult OnGetSlot(string key)
        {
            key = (key ?? "EMPTY").Trim().ToUpperInvariant();

            // whitelist กัน key แปลกๆ
            var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "TPS","DPS","RPS","CHEM","CWSFWS1","CWSFWS2","CHEM1","CHEM2","PTC", "EVENT","EMPTY"
            };
            if (!allowed.Contains(key)) key = "EMPTY";

            // ส่ง key เป็น model (string) เข้า partial
            return Partial("~/Pages/MHxViewer/_SlotRenderer.cshtml", key);
        }

        // =========================
        // GET /MHxView?handler=Smartmap&keys=UZ5411,UZ5412,...
        // Server-side proxy กัน CORS (smartmap อยู่คนละ origin)
        // =========================
        public async Task<IActionResult> OnGetSmartmap(string keys, CancellationToken ct)
        {
            keys = (keys ?? "").Trim();

            // ป้องกันพวก injection/ยาวผิดปกติ
            if (keys.Length > 4000) return BadRequest("keys too long");

            // allow only A-Z 0-9 _ , -
            for (int i = 0; i < keys.Length; i++)
            {
                char ch = keys[i];
                bool ok =
                    (ch >= 'A' && ch <= 'Z') ||
                    (ch >= 'a' && ch <= 'z') ||
                    (ch >= '0' && ch <= '9') ||
                    ch == '_' || ch == ',' || ch == '-';
                if (!ok) return BadRequest("bad keys");
            }

            var url = "http://172.16.193.162/smartmap/rtu_query2.php";
            if (!string.IsNullOrEmpty(keys))
                url += "?keys=" + Uri.EscapeDataString(keys);

            try
            {
                using var http = new HttpClient(new HttpClientHandler { UseProxy = false })
                {
                    Timeout = TimeSpan.FromSeconds(10)
                };

                var json = await http.GetStringAsync(url, ct).ConfigureAwait(false);

                Response.Headers["Cache-Control"] = "no-store";
                return Content(json ?? "null", "application/json");
            }
            catch (TaskCanceledException)
            {
                return StatusCode(504, "timeout");
            }
            catch (Exception ex)
            {
                return StatusCode(502, ex.Message);
            }
        }
    }
}
