using Microsoft.AspNetCore.Mvc.RazorPages;
using System.Globalization;
using System.Text.Json;

namespace BellBeast.Pages
{
    public class CHEM_reportModel : PageModel
    {
        public record CodeName(string Code, string Name);

        public List<CodeName> Products { get; private set; } = new();
        public List<CodeName> Companies { get; private set; } = new();

        public string DefaultStartYmd { get; private set; } = "";
        public string DefaultEndYmd { get; private set; } = "";
        public string BackendBaseUrl { get; private set; } = "";
        public string ChemReportPath { get; private set; } = "/api/chem_report";
        public string ChemExportPath { get; private set; } = "/api/chem_report/export";


        private readonly IHttpClientFactory _http;

        public CHEM_reportModel(IHttpClientFactory http)
        {
            _http = http;
        }

        // ===== backend-config.json DTO =====
        private sealed class BackendConfig
        {
            public string BackendBaseUrl { get; set; } = "http://127.0.0.1:8888";
            public string ChemReportPath { get; set; } = "/api/chem_report";
            public string ChemExportPath { get; set; } = "/api/chem_report/export";
            public string LookupProductsPath { get; set; } = "/api/lookup/products";
            public string LookupCompaniesPath { get; set; } = "/api/lookup/companies";
        }


        private static BackendConfig LoadBackendConfig()
        {
            try
            {
                var path = Path.Combine(AppContext.BaseDirectory, "backend-config.json");
                if (!System.IO.File.Exists(path)) return new BackendConfig();

                var json = System.IO.File.ReadAllText(path);
                return JsonSerializer.Deserialize<BackendConfig>(json,
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
                ) ?? new BackendConfig();
            }
            catch
            {
                return new BackendConfig();
            }
        }

        private static string CombineUrl(string baseUrl, string path)
        {
            baseUrl = (baseUrl ?? "").Trim().TrimEnd('/');
            path = (path ?? "").Trim();
            if (string.IsNullOrWhiteSpace(baseUrl)) baseUrl = "http://127.0.0.1:8888";
            if (!path.StartsWith("/")) path = "/" + path;
            return baseUrl + path;
        }


        public async Task OnGetAsync()
        {
            // default date: last 7 days
            var today = DateTime.Today;
            DefaultEndYmd = today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            DefaultStartYmd = today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

            // ✅ อ่านจาก backend-config.json
            var cfg = LoadBackendConfig();

            var productsUrl = CombineUrl(cfg.BackendBaseUrl, cfg.LookupProductsPath);
            var companiesUrl = CombineUrl(cfg.BackendBaseUrl, cfg.LookupCompaniesPath);

            Products = await FetchCodeNameListAsync(productsUrl);
            Companies = await FetchCodeNameListAsync(companiesUrl);
        }

        private async Task<List<CodeName>> FetchCodeNameListAsync(string url)
        {
            try
            {
                var client = _http.CreateClient();
                client.Timeout = TimeSpan.FromSeconds(5);

                using var resp = await client.GetAsync(url);
                if (!resp.IsSuccessStatusCode)
                    return new();

                var json = await resp.Content.ReadAsStringAsync();

                var list = JsonSerializer.Deserialize<List<CodeName>>(
                    json,
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
                );

                return list ?? new();
            }
            catch
            {
                return new();
            }
        }
    }
}
