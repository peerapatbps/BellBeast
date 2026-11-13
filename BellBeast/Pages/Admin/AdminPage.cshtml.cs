using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace BellBeast.Pages.Admin
{
    [Authorize(AuthenticationSchemes = "AdminCookie", Policy = "AdminOnly")]
    // Task status is loaded client-side via /api/admin/tasks/status, so the page
    // renders even when Uroboros is down (it is the post-login landing page).
    public class AdminPageModel : PageModel
    {
    }
}
