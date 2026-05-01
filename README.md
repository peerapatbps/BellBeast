# BellBeast

BellBeast is the BellBeast operator-facing web application for Mahasawat plant monitoring. It is an ASP.NET Core Razor Pages dashboard that presents live utility/process summaries, report entry points, admin controls, and composable MHxViewer blocks while proxying most operational data requests to backend services.

## System Role

BellBeast is the frontend dashboard and operator interface in the current three-system stack:

- `Uroboros` is the backend orchestrator, scheduler, and API listener.
- `BellBeast` is the web UI, local proxy, and operator workflow surface.
- `Wayfarer` is a separate Playwright automation worker for WebPM2 and is not part of the BellBeast `master` branch codebase at the time of this document.

## Purpose

BellBeast gives operators and engineers a single browser-based surface for:

- viewing plant utility summaries such as TPS, DPS, RPS/RWS, CHEM, LAB, event, and chlorine detector panels
- working with MHxViewer block layouts for large-screen operational display
- running AQ selection and query workflows against backend processing services
- opening operational reports such as MH and CHEM report pages
- administering selected backend scheduler actions through a protected admin area

## Repository Layout

Top-level repository:

- `BellBeast.sln`
- `BellBeast/`
- `.github/`
- `open_firewall_5082.bat`

Application project:

- `BellBeast/Program.cs`
  - ASP.NET Core startup, authentication, authorization, local APIs, and proxy endpoints
- `BellBeast/Pages/`
  - Razor Pages for login, reports, admin UI, and MHxViewer
- `BellBeast/Pages/MHxViewer/`
  - modular slot-rendered plant cards and page model for the main dashboard wall
- `BellBeast/Services/EngineAdminService.cs`
  - helper service for calling Uroboros admin/task endpoints
- `BellBeast/wwwroot/js/`
  - client-side behavior for dashboard cards, polling, charts, settings popups, and smartmap overlays
- `BellBeast/wwwroot/css/`
  - dashboard styling
- `BellBeast/wwwroot/lib/`
  - frontend library assets
- `BellBeast/App_Data/`
  - local SQLite and JSON configuration files used by the frontend app
- `BellBeast/Properties/launchSettings.json`
  - local development launch profiles
- `BellBeast/appsettings.json`
  - Kestrel binding, AQ table path, and admin auth settings

## Architecture Summary

BellBeast is a server-rendered ASP.NET Core Razor Pages application with a JavaScript-heavy dashboard frontend.

High-level flow:

1. Users authenticate through BellBeast cookie auth.
2. Razor Pages render the operator UI and MHxViewer shell.
3. Frontend JavaScript calls BellBeast local `/api/*` endpoints.
4. BellBeast either:
   - serves data from local files such as `aqtable.db`, or
   - proxies requests to configured backend services, primarily Uroboros on port `8888`.
5. Returned JSON is rendered into cards, charts, overlays, tables, and report views.

This design keeps browser clients insulated from backend base URLs, CORS issues, and some credential details while giving BellBeast a place to normalize request routing.

## Entry Points

Primary entry points:

- `BellBeast/Program.cs`
  - web host startup and endpoint mapping
- `BellBeast/Pages/Index.cshtml`
  - AQ query landing page after user login
- `BellBeast/Pages/MHxViewer/MHxView.cshtml`
  - multi-slot plant monitoring dashboard
- `BellBeast/Pages/MH_report.cshtml`
  - MH report page
- `BellBeast/Pages/CHEM_report.cshtml`
  - chemistry report page
- `BellBeast/Pages/Admin/AdminPage.cshtml`
  - protected scheduler/admin control page

## Runtime Ports and Hosting

BellBeast listens on port `5082` by default.

Configured bindings:

- `http://localhost:5082`
- `http://0.0.0.0:5082`
- development HTTPS profile also exposes `https://localhost:7269`

Sources:

- `BellBeast/appsettings.json`
- `BellBeast/Properties/launchSettings.json`

The repository also includes `open_firewall_5082.bat`, indicating Windows-host deployment where inbound access to port `5082` may need to be opened manually.

## Authentication and Authorization

BellBeast uses two cookie schemes:

- user cookie scheme for normal operator access
- `AdminCookie` for admin-only operations

Authorization behavior in `Program.cs`:

- most pages require authentication by default
- public exceptions include:
  - `/Login`
  - `/Privacy`
  - `/MH_report`
  - `/MHxViewer/MHxView`
  - `/CHEM_report`
  - `/Admin/Login`
- `/Admin/*` requires the `AdminOnly` policy and the `role=admin` claim

User login behavior:

- `Pages/Login.cshtml.cs` calls Aquadat enroll at `http://aquadat.mwa.co.th:12007/api/aquaDATService/Enroll`
- on success, BellBeast stores the Aquadat token in the user auth cookie claims
- the login flow includes a constrained brute-force fallback for numeric passwords, which is important to document for audit review

Admin login behavior:

- admin credentials are validated separately
- admin password hash is stored in `appsettings.json` under `AdminAuth`

## Main UI Modules

### AQ Query UI

The default `Index` flow combines:

- station and plant filtering
- AQ table paging/search
- selected-item staging
- template save/load
- query submission through `/api/process`

Frontend implementation:

- `BellBeast/wwwroot/js/site.js`

Local data source:

- `BellBeast/App_Data/aqtable.db`

### MHxViewer

MHxViewer is the main operational wall/dashboard page. It supports slot-based rendering of plant cards such as:

- TPS
- DPS
- RPS
- CHEM
- PTC
- EVENT
- LAB
- CLDETECTOR

Relevant files:

- `BellBeast/Pages/MHxViewer/MHxView.cshtml`
- `BellBeast/Pages/MHxViewer/MHxView.cshtml.cs`
- `BellBeast/Pages/MHxViewer/_SlotRenderer.cshtml`
- card partials under `BellBeast/Pages/MHxViewer/`

Frontend modules for live behavior live in `BellBeast/wwwroot/js/` and include:

- `TPS_summary.js`, `TPS_settings.js`
- `dps_summary.js`, `DPSview.js`, `dps_smartmap_overlay.js`
- `RWS_summary.js`, `RWSview.js`, `RWS_online_settings.js`
- `CHEM_summary.js`, `CHEMview.js`, `CHEM_settings.js`
- `LABview.js`
- `PTCview.js`, `ptc_smartmap_overlay.js`
- `EVENTview.js`, `EVENT_settings.js`
- `CLDetectorView.js`, `CLDetectorSettings.js`
- `BBTrend.js`

### Reports

- `MH_report` provides a report surface for MH data.
- `CHEM_report` loads product/company filter lists from backend lookup APIs and submits chemistry report requests via BellBeast proxy routes.

## Local Storage and Databases

BellBeast uses lightweight local files rather than a large application database on `master`.

Known runtime data/config files:

- `BellBeast/App_Data/aqtable.db`
  - local SQLite lookup table used by `/api/aqtable`
- `BellBeast/App_Data/backend-config.json`
  - backend base URL and proxied path configuration
- `BellBeast/appsettings.json`
  - Kestrel endpoint, AQ table path, admin auth hash
- `BellBeast/appsettings.Development.json`
  - development overrides when present

Published artifacts in `bin/Release/.../publish/App_Data/` may also contain additional DB files copied from feature branches or release packages. Those are deployment outputs, not authoritative source-of-truth architecture for `master`.

## Configuration

### appsettings.json

Key settings currently used on `master`:

- `Kestrel:Endpoints:Http:Url`
- `AqTable:DbPath`
- `AdminAuth:AllowedUsername`
- `AdminAuth:PasswordPbkdf2`

### App_Data/backend-config.json

This file controls the backend routing used by BellBeast proxy endpoints. Current keys include:

- `backendBaseUrl`
- `queryCsvPath`
- `dailyReportPath`
- `chemReportPath`
- `chemExportPath`
- `lookupProductsPath`
- `lookupCompaniesPath`
- `DpsSummaryPath`
- `tpsSummaryPath`
- `rwsSummaryPath`
- `chemSummaryPath`
- `eventSummaryPath`
- `labSummaryPath`
- `cldetectorPath`

Operational note:

- `Program.cs` normalizes and validates this file at runtime.
- Some config key casing is inconsistent, so edits should be validated carefully after deployment.

## API Surface

BellBeast exposes a mix of local APIs and backend proxies.

### Local/auth/config endpoints

- `GET /api/backend-config`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/admin/auth/logout`
- `GET /api/admin/auth/logout`
- `GET /api/admin/auth/me`

### Local AQ and template endpoints

- `GET /api/stations`
- `GET /api/aqtable`
- `POST /api/template/save`

### Backend/proxy endpoints

- `POST /api/process`
- `POST /api/dailyreport`
- `POST /api/chem_report`
- `POST /api/chem_report/export`
- `GET /api/dps/summary`
- `GET /api/tps/summary`
- `GET /api/rws/summary`
- `GET /api/chem/summary`
- `GET /api/event/summary`
- `GET /api/cldetector/summary`
- `POST /api/lab/summary`

### Admin-to-Uroboros control endpoints

- `POST /api/admin/pause`
- `POST /api/admin/resume`
- `POST /api/admin/cancelall`
- `POST /api/admin/enqueue`

### Smartmap endpoint

- `GET /api/smartmap`

The MHxViewer page model also contains a server-side smartmap proxy handler:

- `GET /MHxViewer/MHxView?handler=Smartmap&keys=...`

## External Integrations

BellBeast `master` integrates with the following systems:

- `Uroboros`
  - primary backend for summaries, processing, reports, and admin task control
- `Aquadat`
  - operator authentication/token acquisition via enroll API
- `Smartmap`
  - remote RTU/smartmap data proxy used by MHxViewer features

Wayfarer note:

- the separate `Wayfarer` repository exists in the wider system landscape as the WebPM2 automation worker
- BellBeast `master` does not currently contain the full Wayfarer UI/API integration that exists in other branches or release artifacts

## Scheduler and Background Task Relationship

BellBeast does not own the core scheduler. Uroboros does.

BellBeast can:

- read admin task status through `EngineAdminService`
- pause/resume/cancel backend execution
- enqueue named tasks

This means BellBeast acts as the operator console for scheduler control rather than the scheduler host itself.

## Logging and Error Handling

Current observed behavior:

- ASP.NET Core logging is configured through standard `Logging` settings
- production uses `/Error` and HSTS
- development uses developer exception behavior and HTTPS redirection
- many frontend-facing proxy flows preserve upstream HTTP status codes
- some page-model helper methods swallow exceptions and return empty lists or null responses instead of surfacing rich diagnostics

Operational implication:

- user-facing failures may appear as empty dropdowns/cards rather than explicit error pages
- backend reachability should be checked first when dashboard cards stop updating

## Build and Run

### Prerequisites

- Windows environment is the safest assumption because the project references `System.Data.OleDb` and includes Windows-oriented deployment artifacts
- .NET SDK 9.x
- access to dependent backend services if you want full runtime functionality

### Restore

```powershell
dotnet restore .\BellBeast.sln
```

### Build

```powershell
dotnet build .\BellBeast\BellBeast.csproj
```

### Run

```powershell
dotnet run --project .\BellBeast\BellBeast.csproj
```

Then open:

- `http://localhost:5082`

## Setup Notes

Minimum setup for local startup:

1. Ensure `BellBeast/App_Data/aqtable.db` exists.
2. Verify `BellBeast/App_Data/backend-config.json` points to the correct backend host.
3. Ensure port `5082` is available.
4. If using admin features, verify the configured admin credential hash.
5. If testing full dashboards, make sure Uroboros and any other upstream services are reachable.

## Operational Workflow

Typical runtime workflow:

1. Operator signs in through BellBeast.
2. BellBeast stores auth state in cookies.
3. User opens AQ query pages, MHxViewer, or report pages.
4. Frontend JS polls BellBeast local APIs.
5. BellBeast reads local SQLite/config files or proxies requests to backend services.
6. Dashboard cards and reports update with returned data.
7. Admin users can pause/resume/cancel/enqueue backend jobs from the admin page.

## Deployment Assumptions

The codebase suggests these deployment assumptions:

- Windows-hosted ASP.NET Core deployment
- LAN-accessible HTTP service on port `5082`
- colocated `App_Data` directory with writable/readable config and SQLite files
- reachable backend service, usually Uroboros, on port `8888`
- access to internal network dependencies such as Aquadat and Smartmap

## Known Limitations

- BellBeast depends heavily on upstream service availability; many cards do not have meaningful offline fallbacks.
- Backend base URL configuration is file-based rather than centrally managed.
- Some error handling paths intentionally fail soft, which can hide operational faults.
- The login flow includes legacy behavior and environment-specific assumptions.
- `master` does not include the full Wayfarer integration found in some other working branches/releases.
- Frontend logic is distributed across many page-specific JavaScript files, which raises maintenance cost.

## Future Development Notes

Recommended future work areas:

- consolidate proxy configuration and validation
- improve structured logging around upstream failures
- reduce duplicated polling/settings patterns across JS modules
- centralize health checks for upstream dependencies
- document release-time branch differences explicitly when features such as Wayfarer are maintained outside `master`
- consider a stronger typed API client boundary between BellBeast and Uroboros

## Validation Status

This README is based on direct inspection of the BellBeast `master` codebase, including:

- `Program.cs`
- `Pages/`
- `Pages/MHxViewer/`
- `Services/EngineAdminService.cs`
- `wwwroot/js/`
- `App_Data/backend-config.json`
- `appsettings.json`
- `launchSettings.json`

Build validation should be run after documentation updates as part of the documentation pass.
