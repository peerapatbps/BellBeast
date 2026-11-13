# BellBeast

BellBeast is an ASP.NET Core Razor Pages application for plant-operations workflows at Mahasawat. It acts as the operator-facing web layer for dashboards, report entry points, admin controls, and lightweight IoT coordination while proxying selected requests to backend services.

## Highlights

- MHxViewer dashboard with modular plant cards for TPS, DPS, RPS/RWS, CHEM, LAB, PTC, EVENT, and chlorine detector views
- AQ lookup/query workflows backed by a local SQLite table
- Report pages for MH and chemistry workflows
- Admin-only controls for selected backend engine actions
- IoT room endpoints for device presence, commands, state snapshots, and tunnel status
- Wayfarer map summary and work-order proxy endpoints

## Tech Stack

- .NET 9
- ASP.NET Core Razor Pages
- Minimal APIs
- Cookie authentication with separate user and admin schemes
- SQLite via `Microsoft.Data.Sqlite`
- ClosedXML for spreadsheet-related workflows
- JavaScript dashboard modules in `wwwroot/js`

## Repository Layout

- `BellBeast.sln` - solution file
- `BellBeast/` - main web application
- `BellBeast.Tests/` - xUnit test project
- `.github/` - GitHub workflow/configuration files
- `open_firewall_443.bat` - helper script for opening the app port on Windows

Inside `BellBeast/` the main areas are:

- `Program.cs` - application startup, auth, middleware order, and the list of endpoint modules
- `Endpoints/` - minimal API endpoints, one file per area (dashboard, reports, engine, IoT, fleet, v1, admin API access)
- `ApiAccess/` - API catalog, API clients and keys, rate limiting, IP bans, v1 datasets
- `Pages/` - Razor Pages for dashboard, reports, login, admin, and IoT views
- `Pages/MHxViewer/` - slot-rendered dashboard blocks
- `Services/` - backend proxy and feature services
- `wwwroot/` - static frontend assets
- `App_Data/` - runtime configuration and local database files

## Runtime Architecture

BellBeast sits between browser clients and backend services:

1. Users open the Razor Pages UI.
2. Frontend modules call BellBeast-owned `/api/*` endpoints.
3. BellBeast either reads local data from `App_Data` or proxies requests to configured upstream services such as Uroboros or Wayfarer.
4. Responses are rendered into dashboard cards, reports, and device-monitoring views.

This keeps browser clients on a single origin and centralizes auth, routing, and backend configuration.

## API Access

Every endpoint is mapped on one of four route groups (`ApiGroups` in `Endpoints/EndpointHelpers.cs`); the group decides who may call it, the URL is unchanged:

| Group | Who | Used by |
|---|---|---|
| `pub` | anyone | devices and the alarm broadcast: `/api/alarm/active`, IoT room, fleet/OTA, audio clips, login helpers |
| `page` | anyone **with a live view token** from one of our pages | MHxView cards, MHxView ⚙️ engine/config, report pages, WebPM, IoT room page tunnel status |
| `user` | signed in (user cookie, admin cookie, or an API key with a grant) | AQ lookup (`/Index`), `/api/v1` |
| `admin` | admin cookie only (API keys never work here) | `/Admin/*` pages and `/api/admin/*` |

Anything not mapped on `pub` is closed by default (`FallbackPolicy`).

Request pipeline for `/api/*`, in order:

1. **IP ban** - a banned IP gets `403 ip_banned` for every page, file and API.
2. **Authentication** - user/admin cookie, or `X-Api-Key: bbk_...` / `Authorization: Bearer bbk_...`.
3. **Rate limit** - per API client (its own per-minute limit), otherwise per client IP (`RateLimit:PerIpPerMinute`). `429 rate_limited` with `Retry-After`.
4. **API gate** - `404 api_disabled` if the admin turned the API off; `401` for a bad/disabled/expired key; `403 api_not_granted` if a key calls a login-level API it was not granted.
5. **View token** - pages get a token in `<meta name="bb-view-token">` (bound to the client IP) and an HttpOnly refresh cookie; `wwwroot/js/bb-viewtoken.js` wraps `fetch` to send it as `X-View-Token`. A `page` API without a live token answers `401 {"error":"unauthorized"}` with no reason (a URL opened in a browser tab gets a meme page instead; the real reason - missing / expired / wrong IP - is only shown to admins in the IP tab); the script renews silently via `POST /api/view/renew` (after sleep, server restart or IP change) without reloading the page. Signed-in users/admins and loopback (`ViewToken:ExemptLoopback`) need no token. **IP passes** (`ApiAccess/IpPassService.cs`) let machines that cannot open our pages call only the `page` APIs granted to them: an IP entered by an admin (e.g. the TruckSidecar PC → `GET /api/chem/summary`), and every fleet device that is approved, from the connection IP its `X-Device-Key` last checked out from (never the IP it reports), for 10 minutes after that (the fleet routes default to `GET /api/cldetector/summary` for the annunciator chlorine page).
6. **Authorization** - the group's policy.

Behind the Cloudflare tunnel every request arrives from loopback, so the client IP is taken from `CF-Connecting-IP` - only when the TCP peer is loopback, so LAN clients cannot spoof it.

Admin page `/Admin/Api` (tab "API Access"):

- **APIs** - every `/api` endpoint with its access level; switch any one off (the admin-API pages themselves are locked on).
- **Datasets (v1)** - publish Uroboros realtime metrics under stable field names on `/api/v1` (see [docs/api-v1.md](docs/api-v1.md)).
- **API Clients** - create a client, copy its key (shown once; only the SHA-256 is stored), grant datasets / login-level APIs, set a per-minute limit and expiry, rotate or disable the key.
- **IP** - callers rejected for a missing/stale view token, live page viewers (IP, pages, requests), who wrote into the public IoT room (join / data / command) per IP since start-up, and site-wide IP bans (1 h / 1 day / 7 days / permanent). The admin's own IP and loopback cannot be banned. IP passes are managed here too (per IP + the fleet routes, with how often each pass was used since start-up); a rejected row has a "ให้ตั๋ว…" button that pre-fills the form.

The IoT room (`/api/iot/room/*`) is public on purpose: it is the broadcast alarm room (Uroboros pushes the alarm state as device `uroboros-alarm`; MHxView, annunciators and AlarmMonitor read it through `/api/alarm/active`). The IP tab is how fake publishers are found and banned.

## Key Pages And Features

- `/MHxViewer/MHxView` - main monitoring dashboard wall
- `/Index` - AQ lookup and query surface
- `/MH_report` - MH report page
- `/CHEM_report` - chemistry report page
- `/Admin/*` - protected admin area
- `/IotRoom` - browser UI for connected devices and room state
- `/LedDemo` and `/WebPM` - supporting feature/demo pages

Unhandled exceptions on `/api/*` return JSON instead of the `/Error` page: `502 upstream_unavailable` when Uroboros / another upstream is unreachable or times out, otherwise `500 internal_error`.

## Configuration

The application reads settings from:

- `BellBeast/appsettings.json`
- `BellBeast/appsettings.Development.json`
- `BellBeast/App_Data/backend-config.json` (read through `BackendConfigProvider`, cached until the file changes)

API access settings in `appsettings.json`:

- `Cors:AllowedOrigins` - origins allowed to call BellBeast from another site's JavaScript (empty = same-origin only; devices and the LabVenture proxy need no entry)
- `RateLimit:PerIpPerMinute` - per-IP limit on `/api` for callers without an API key (default 1200, `0` = off)
- `Uroboros:UtcOffset` - offset for Uroboros' plant-local timestamps on `/api/v1` (default `+07:00`)
- `ViewToken:IdleSeconds` - a view token dies after this long without a request (default 10 = 2 × the 5 s alarm poll)
- `ViewToken:RefreshHours` - lifetime of the refresh cookie, rolled forward every 4 h while a page is open (default 24)
- `ViewToken:ExemptLoopback` - requests from the server itself need no view token (default true; tools running on the box)
- `ViewToken:PublishTrafficToRoom` - every 30 s put viewer/rejection counts (no IPs) into the IoT room as device `bellbeast-traffic` (default true)

Runtime data written by the admin pages (gitignored, back them up with the deployment):

- `App_Data/api-catalog.json` - APIs switched off + notes
- `App_Data/api-clients.json` - API clients (key hashes, grants, limits)
- `App_Data/api-datasets.json` - `/api/v1` datasets
- `App_Data/ip-bans.json` - IP bans
- `App_Data/ip-passes.json` - IP passes (per IP) + the page APIs approved fleet devices may call

Important notes:

- Do not commit real secrets, API keys, production URLs, certificates, or local machine paths in public-facing branches.
- Review `App_Data` carefully before publishing or packaging the project.
- The default local AQ table path is `App_Data/aqtable.db`.

## Local Development

Prerequisites:

- .NET SDK 9.0
- Windows environment recommended for the current deployment scripts and port configuration
- Access to the upstream services you want to exercise during development

Run locally:

```powershell
dotnet restore
dotnet build BellBeast.sln
dotnet run --project .\BellBeast\BellBeast.csproj
```

The app is configured for port `443` in `BellBeast/appsettings.json`. Development launch profiles may also expose HTTPS on a separate local port.

## Testing

The repository includes an xUnit test project:

```powershell
dotnet test BellBeast.sln
```

## Publish Output

A publish/output copy of the application may be staged outside the repo, for example at:

- `C:\Users\peera\OneDrive\Desktop\Fullscale_V2\BellBeast_proj`

That folder is deployment output, not the authoritative Git source tree. Keep source changes in this repository, then republish as needed.

## Notes For Public Sharing

Before pushing changes to a public or shared remote, make sure to scrub:

- secrets and tokens
- local filesystem paths
- internal-only URLs
- certificates and runtime databases that should not leave the deployment machine

## License

No license file is currently included. Treat the repository as all rights reserved until a license is added.
