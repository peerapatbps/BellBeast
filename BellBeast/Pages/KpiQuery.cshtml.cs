using Microsoft.AspNetCore.Mvc.RazorPages;
using System.Globalization;

namespace BellBeast.Pages
{
    // สืบค้นตัวชี้วัด Output/Outcome ของระบบ CAR (CAR Lean proposal) — ข้อมูลจาก LabVenture /api/kpi ผ่าน proxy /labventure/*
    public class KpiQueryModel : PageModel
    {
        public string DefaultStartYmd { get; private set; } = "";
        public string DefaultEndYmd { get; private set; } = "";

        public void OnGet()
        {
            var today = DateTime.UtcNow.AddHours(7).Date;   // เวลาไทย (เครื่อง deploy อาจตั้ง พ.ศ. → ใช้ InvariantCulture เสมอ)
            DefaultStartYmd = today.AddDays(-29).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            DefaultEndYmd = today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
    }
}
