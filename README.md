# BellBeast

<<<<<<< HEAD
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
=======
Uroboros is the backend orchestrator, scheduler, and HTTP API listener for the BellBeast monitoring stack. It runs as a local .NET service on port `8888`, polls plant-facing data sources, imports laboratory data, synchronizes selected files through Google Drive, persists runtime data to SQLite, and exposes operational endpoints consumed by BellBeast and related tools.

## System Role

Uroboros is the backend layer in the current three-part system:

- `Uroboros` = backend orchestrator / scheduler / API listener
- `BellBeast` = frontend dashboard / operator interface
- `Wayfarer` = Playwright automation worker for WebPM2

In the current architecture, BellBeast calls Uroboros over HTTP for plant dashboards and summary views. Uroboros owns task scheduling, data acquisition, local persistence, and admin control endpoints.

## Purpose

Uroboros centralizes backend work that should not live in the frontend:

- poll plant systems on fixed intervals
- normalize and persist current values into SQLite
- serve HTTP APIs for dashboard modules
- maintain runtime task settings and health state
- import daily laboratory data into local storage
- upload and download selected runtime databases through Google Drive
- expose admin controls for pause, resume, force-run, task config, and cancellation

## Architecture Summary

The application is a single .NET console executable with three long-running runtime loops:

1. `Scheduler`
   Accepts `IEngineTask` jobs, enforces concurrency, timeout, and run-policy rules, and tracks running tasks.

2. `WebListener`
   Hosts an `HttpListener` on `http://+:8888/` and exposes health, admin, and API endpoints.

3. `TriggerLoop`
   Computes the next due time for each registered task, reads live task configuration from SQLite, and enqueues work on schedule while preserving phase across pauses and config changes.

Core execution flow:

1. `Program.Main()` builds runtime services and task registry.
2. Task defaults are loaded into `engine_admin.db`.
3. `Scheduler.RunLoopAsync()` starts with `maxConcurrency: 20`.
4. `WebListener.RunAsync()` starts the HTTP interface on port `8888`.
5. `TriggerLoop.RunAsync()` continuously evaluates due jobs and enqueues enabled tasks.
6. Task handlers fetch plant data, write SQLite state, and APIs read that state back for BellBeast.

## Repository Layout

Top level:

- `Uroboros.slnx` - solution container
- `README.md` - repository documentation
- `Uroboros/` - application source

Main source files:

- `Uroboros/Program.cs` - entry point, scheduler, HTTP listener, task registration, and many task implementations
- `Uroboros/TriggerLoopcs.cs` - periodic trigger loop with phase-preserving scheduling
- `Uroboros/AdminConfig.cs` - runtime task settings store and config service
- `Uroboros/TaskHealth.cs` - in-memory task success/failure health tracking
- `Uroboros/TpsHandlers.cs` - `/api/tps/summary`
- `Uroboros/DpsHandlers.cs` - `/api/dps/summary`
- `Uroboros/RwsHandlers.cs` - `/api/rws/summary`
- `Uroboros/ChemHandlers.cs` - `/api/chem/summary`
- `Uroboros/EVENTHandlers.cs` - `/api/event/summary`
- `Uroboros/ClDetectorHandlers.cs` - `/api/cldetector/summary`
- `Uroboros/LabSummaryModule.cs` - `/api/lab/summary`
- `Uroboros/OnlineLabHandlers.cs` - `/api/online_lab`
- `Uroboros/Listener_AQ.cs` - Aquadat verify/process APIs
- `Uroboros/Listener_CHEM.cs` - chemistry report query/export endpoints
- `Uroboros/AquadatFast.cs` - Aquadat ingestion, mapping, export, and SQLite writing
- `Uroboros/AquadatRemarkHelper.cs` - Aquadat remark and GraphQL-related helpers
- `Uroboros/PTC.cs` - PTC fetch/parse and SQLite persistence helpers
- `Uroboros/SqliteUpperLowerProvider.cs` - PTC series reader from SQLite
- `Uroboros/DailyLabImporter.cs` - daily lab import pipeline
- `Uroboros/GoogleDrive.cs` - database upload/download helpers and Drive auth

## Runtime and Hosting

### Runtime type

- .NET console application
- plain `HttpListener` server, not ASP.NET Core

### SDK and target framework

- SDK pinned in `Uroboros/global.json`
  - `10.0.102`
- target framework in `Uroboros/Uroboros.csproj`
  - `net10.0`

### Listener port

Uroboros listens on:

- `http://+:8888/`

This matches the intended deployment model documented in code comments:

- BellBeast web UI on another port, typically `5082`
- Uroboros backend listener on `8888`

### Startup behavior

At startup:

- the stage gate is initialized as paused
- task defaults are seeded into `engine_admin.db`
- scheduler, web listener, and trigger loop are started
- tasks remain subject to gate and runtime config state

## Main Modules and Responsibilities

### Scheduler and task model

Defined primarily in `Program.cs`:

- `TaskSpec`
- `IEngineTask`
- `Scheduler`
- `StageGate`
- `TaskRegistry`

Capabilities:

- task priorities
- run policies:
  - `Queue`
  - `DropIfRunning`
  - `CoalesceIfRunning`
  - `SkipIfRunning`
- per-task timeout support
- cancellation of individual running tasks
- global cancellation of all running tasks
- task health tracking
- phase-preserving rescheduling

### Runtime task configuration

`AdminConfig.cs` stores task settings in:

- `engine_admin.db`

Table:

- `task_settings`

Fields:

- `name`
- `enabled`
- `interval_ms`
- `timeout_override_ms`
- `updated_at_unixms`

This configuration controls:

- whether a task is enabled
- runtime interval overrides
- timeout overrides
- force-run hints through `updated_at_unixms`

### HTTP API layer

`WebListener` in `Program.cs` routes requests to feature handlers or admin services.

It also:

- writes JSON responses
- applies permissive CORS headers
- catches top-level handler exceptions and returns `500`

### Data acquisition and subsystem handlers

Subsystem-specific polling and read APIs are split across dedicated files:

- TPS
- DPS
- RWS
- CHEM
- EVENT
- CL Detector
- OnlineLab
- LAB
- PTC
- Aquadat

### File sync and backup tasks

`GoogleDrive.cs` implements:

- Google Drive authentication
- upload/update by name in a target folder
- download by name from a target folder
- snapshot-based SQLite upload flow
- atomic database replace with retry

### Daily lab import

`DailyLabImporter.cs` handles:

- reading lab configuration from `config_`
- locating Excel source files from `config.ini`
- parsing mapped structures
- writing imported values into SQLite table `lab_import_daily`

## Registered Background Tasks

The current task registry in `Program.cs` includes:

- `tps.refresh`
- `dps.refresh`
- `rws1.refresh`
- `rws2.refresh`
- `chem1.refresh`
- `chem2.refresh`
- `branch.refresh`
- `rcv38.refresh`
- `ptc.query.once`
- `onlinelab.query`
- `Aquadat.refresh`
- `AquadatFWS.refresh`
- `DB_upload.refresh`
- `DB_download.refresh`
- `MDB_upload.refresh`
- `MDB_download.refresh`
- `LAB.import.daily`

Default intervals from the current catalog:

- most dashboard refresh tasks: `5000 ms`
- PTC: `30000 ms`
- Aquadat: `30000 ms`
- DB and MDB sync tasks: `30000 ms`
- lab import task is currently also seeded at `30000 ms` on `master`

The trigger loop enforces a hard minimum interval of:

- `250 ms`

Certain tasks also have higher minimums in `TaskConfigService.MinIntervalMsByTask`, including:

- `DB_upload.refresh`
- `MDB_upload.refresh`
- `Aquadat.refresh`
- `AquadatFWS.refresh`
- `ptc.query.once`

## API Endpoints

### Health and task inspection

- `GET /health`
- `GET /tasks`
- `GET /tasks/running`
- `POST /tasks/enqueue`
- `POST /tasks/cancel/{guid}`

### Admin control

- `GET /admin/tasks/config`
- `POST /admin/tasks/config`
- `GET /admin/tasks/status`
- `POST /admin/pause`
- `POST /admin/resume`
- `POST /admin/cancelall`
- `POST /admin/tasks/forcerun`

### Dashboard and subsystem APIs

- `POST /api/verify`
- `POST /api/process`
- `GET /api/lookup/products`
- `GET /api/lookup/companies`
- `POST /api/chem_report/export`
- `POST /api/chem_report`
- `GET /api/ptc/keys`
- `GET /api/ptc/series?key=...`
- `POST /api/online_lab`
>>>>>>> backup/bellbeast-current-changes
- `GET /api/dps/summary`
- `GET /api/tps/summary`
- `GET /api/rws/summary`
- `GET /api/chem/summary`
- `GET /api/event/summary`
- `GET /api/cldetector/summary`
- `POST /api/lab/summary`

<<<<<<< HEAD
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
=======
### Cross-system use

BellBeast consumes these APIs for live dashboard cards and detail views, especially:

- `/api/tps/summary`
- `/api/dps/summary`
- `/api/rws/summary`
- `/api/chem/summary`
- `/api/event/summary`
- `/api/cldetector/summary`
- `/api/lab/summary`
- `/api/online_lab`
- `/api/ptc/*`

## Configuration

### Present in source control

- `Uroboros/global.json` - SDK pinning
- `Uroboros/Uroboros.csproj` - package references and target framework

### Not present as ASP.NET-style app config

This repository does not currently rely on `appsettings.json` on `master`. Configuration is mostly implicit in code and external runtime files.

### Runtime file assumptions

The application expects several local files and directories relative to `AppContext.BaseDirectory` or sibling runtime paths, including:

- `data.db`
- `data_ghost.db`
- `data.db.bak`
- `engine_admin.db`
- `config_/aqtable.db`
- `config_/LAB_structure.json`
- `config_/lab_mapping.json`
- `config_/config.ini`
- `credentials.json`
- `token.json` directory used by `FileDataStore`

### Hardcoded external endpoints

The current `master` branch includes direct calls to plant and service URLs such as:

- internal `allch.cgi` sources for RWS, CHEM, and other plant systems
- Aquadat API endpoints at `aquadat.mwa.co.th`
- Aquadat GraphQL endpoint
- PTC realtime endpoints on internal IP addresses

These values are currently code-configured rather than environment-configured.

## Database and Storage

### Primary SQLite files

- `data.db`
  - primary local runtime database for current values and time-series data used by subsystem APIs

- `engine_admin.db`
  - runtime scheduler/task settings database

- `data_ghost.db`
  - snapshot/transfer name used for Google Drive upload and remote synchronization

- `data.db.bak`
  - local backup created during database replacement workflows

### Additional storage

- `config_/aqtable.db`
  - Aquadat metadata lookup source

- `lab_import_daily` table
  - populated by the daily lab import pipeline

### Access pattern

- writer tasks update SQLite state
- HTTP handlers open read-only SQLite connections to serve dashboard responses
- DB upload/download tasks snapshot and replace runtime databases with lock-aware flows

## External Integrations

### BellBeast

BellBeast acts as the operator-facing frontend and calls Uroboros over HTTP. Uroboros is the backend data source and control plane for BellBeast dashboard modules.

### Wayfarer

Wayfarer is not hosted inside this repository, but Uroboros is part of the same operational ecosystem. Uroboros currently focuses on backend polling, task orchestration, and local data APIs; Wayfarer is the automation worker for WebPM2.

### Google Drive

Used for:

- database upload
- database download
- synchronization/update workflows

Dependencies:

- `credentials.json`
- Drive OAuth token store in `token.json`

### Aquadat

Used for:

- data retrieval from the Aquadat service
- metadata mapping through `aqtable.db`
- remark-related workflows

### OnlineLab

Handled through:

- `/api/online_lab`

and supporting query tasks.

### Daily laboratory Excel imports

`DailyLabImporter.cs` depends on external lab Excel sources and JSON mapping files in `config_`.

### PTC

PTC integration reads remote realtime content and persists upper/lower series into SQLite for later API access.

## Logging and Error Handling

Logging is currently implemented through a simple console logger:

- `ConsoleLogger`

Behavior:

- task starts, success, cancellation, and failures are logged
- HTTP handler failures are caught and returned as generic `500` responses
- subsystem handlers usually log warning messages before returning structured error payloads

Current limitations:

- no structured log sink
- no log level routing
- no persistent log retention
- no correlation IDs

## Setup Instructions

### Prerequisites

- Windows environment is strongly implied
- .NET SDK `10.0.102`
- access to required network endpoints
- access to required local runtime files
- Google Drive credentials if sync tasks are used

### Clone

```powershell
git clone https://github.com/peerapatbps/Uroboros.git
cd Uroboros
```
>>>>>>> backup/bellbeast-current-changes

### Restore

```powershell
<<<<<<< HEAD
dotnet restore .\BellBeast.sln
=======
dotnet restore .\Uroboros\Uroboros.csproj
>>>>>>> backup/bellbeast-current-changes
```

### Build

```powershell
<<<<<<< HEAD
dotnet build .\BellBeast\BellBeast.csproj
=======
dotnet build .\Uroboros\Uroboros.csproj
>>>>>>> backup/bellbeast-current-changes
```

### Run

```powershell
<<<<<<< HEAD
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
=======
dotnet run --project .\Uroboros\Uroboros.csproj
```

Once running, the listener binds to:

- `http://localhost:8888/`
>>>>>>> backup/bellbeast-current-changes

## Operational Workflow

Typical runtime workflow:

<<<<<<< HEAD
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
=======
1. Start Uroboros.
2. Scheduler, listener, and trigger loop initialize.
3. Trigger loop reads `engine_admin.db` and schedules enabled tasks.
4. Polling tasks fetch external plant data and write SQLite state.
5. BellBeast requests summaries from Uroboros APIs on port `8888`.
6. Admin users can inspect and modify task behavior via `/admin/*`.
7. File sync tasks optionally upload/download database snapshots via Google Drive.
8. LAB import tasks update imported laboratory values for BellBeast LAB views.

## Build and Validation

This repository does not currently include a dedicated test project on `master`.

Recommended validation for documentation changes:

- `dotnet build .\Uroboros\Uroboros.csproj`
- optional manual HTTP smoke tests against port `8888`

## Deployment Assumptions

The current code assumes:

- Windows-compatible runtime
- local file system write access in the application base directory
- SQLite database files colocated with the executable
- plant network reachability to internal endpoints
- Google Drive credentials on disk for sync tasks
- long-running process model rather than ephemeral container execution

Operationally, this is closer to a plant-side service executable than a cloud-native stateless API.

## Known Limitations

- configuration is still heavily code-based and path-based
- external URLs and folder IDs are hardcoded in multiple modules
- no centralized configuration abstraction
- no built-in authentication or authorization on admin endpoints
- `HttpListener` is simpler than ASP.NET Core but less flexible for modern hosting scenarios
- no automated test suite is present on `master`
- runtime behavior depends on external files that are not fully documented by machine-readable config
- some task names and comments still reflect legacy naming patterns

## Future Development Notes

Recommended next improvements:

- move external URLs, folder IDs, and file locations into explicit configuration
- add startup validation for required runtime files and directories
- add authenticated admin endpoints before wider deployment
- extract task implementations from `Program.cs` into dedicated files
- add integration smoke tests for critical APIs
- document SQLite schema and runtime file contracts in more detail
- standardize naming conventions across tasks, APIs, and frontend callers
- consider a gradual migration from `HttpListener` to ASP.NET Core if hosting requirements grow

## Production Audit Notes

For architecture review, LL documentation, OPA reporting, and technical audit, the key points are:

- Uroboros is the operational backend and scheduler, not just a simple API
- port `8888` is a critical interface for BellBeast
- runtime state is split between in-memory health/scheduler state and local SQLite files
- plant polling, lab import, and cloud sync all converge in this single process
- failure in Uroboros can impact multiple frontend dashboards and backend data refresh workflows at once
>>>>>>> backup/bellbeast-current-changes
