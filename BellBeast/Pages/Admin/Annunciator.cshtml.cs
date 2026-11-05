using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace BellBeast.Pages.Admin;

/// <summary>
/// Live annunciator simulator: the 240×240 device screen (HOME / LAB / alarm) drawn in the browser from the
/// same endpoints and the same refresh rules as firmware ann-1.2.0 (wwwroot/js/annunciator.js).
/// </summary>
[Authorize(AuthenticationSchemes = "AdminCookie", Policy = "AdminOnly")]
public class AnnunciatorModel : PageModel
{
    public void OnGet()
    {
    }
}
