using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace BellBeast.Pages.Admin
{
    [Authorize(AuthenticationSchemes = "AdminCookie", Policy = "AdminOnly")]
    public class AdminPageModel : PageModel
    {
        private readonly EngineAdminService _svc;

        public AdminPageModel(EngineAdminService svc)
        {
            _svc = svc;
        }

        public object? Status { get; private set; }

        public async Task OnGetAsync()
        {
            Status = await _svc.GetStatusAsync();
        }
    }
}
