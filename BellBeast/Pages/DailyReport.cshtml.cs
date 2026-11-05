using Microsoft.AspNetCore.Mvc.RazorPages;
using System.Globalization;

namespace BellBeast.Pages
{
    // MH_report + DailyLab download page. Data comes from LabVenture through the /labventure/* proxy.
    public class DailyReportModel : PageModel
    {
        public string DefaultStartYmd { get; private set; } = "";
        public string DefaultEndYmd { get; private set; } = "";

        public void OnGet()
        {
            var today = DateTime.Today;
            DefaultStartYmd = new DateTime(today.Year, today.Month, 1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            DefaultEndYmd = today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
    }
}
