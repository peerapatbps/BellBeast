using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace BellBeast.Pages.Admin;

/// <summary>Admin → Connector Box: edit the Uroboros cb_* registry through the /api/cb/* proxy (admin group).</summary>
[Authorize(AuthenticationSchemes = "AdminCookie", Policy = "AdminOnly")]
public class ConnectorBoxModel : PageModel
{
    public void OnGet()
    {
    }
}
