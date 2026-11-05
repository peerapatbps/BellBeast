using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace BellBeast.Pages.Admin;

[Authorize(AuthenticationSchemes = "AdminCookie", Policy = "AdminOnly")]
public class FleetModel : PageModel
{
    public void OnGet()
    {
    }
}
