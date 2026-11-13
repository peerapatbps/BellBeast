using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace BellBeast.Pages.Admin;

/// <summary>Admin tab that embeds BellBeast Tester (proxied at /tester, see Endpoints/TesterEndpoints.cs).</summary>
[Authorize(AuthenticationSchemes = "AdminCookie", Policy = "AdminOnly")]
public class TesterModel : PageModel
{
    public void OnGet()
    {
    }
}
