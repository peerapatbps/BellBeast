# BellBeast

BellBeast is an ASP.NET Core Razor Pages application for plant-operations workflows at Mahasawat. It acts as the operator-facing web layer for dashboards, report entry points, admin controls, AI-assisted chat, and lightweight IoT coordination while proxying selected requests to backend services.

## Highlights

- MHxViewer dashboard with modular plant cards for TPS, DPS, RPS/RWS, CHEM, LAB, PTC, EVENT, and chlorine detector views
- AQ lookup/query workflows backed by a local SQLite table
- Report pages for MH and chemistry workflows
- Admin-only controls for selected backend engine actions
- Chat endpoints wired to OpenClaw-backed assistants and local RAG-style knowledge retrieval
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

- `Program.cs` - application startup, auth, routing, and minimal API endpoints
- `Pages/` - Razor Pages for dashboard, reports, login, admin, chat, and IoT views
- `Pages/MHxViewer/` - slot-rendered dashboard blocks
- `Services/` - backend proxy and feature services
- `wwwroot/` - static frontend assets
- `App_Data/` - runtime configuration and local database files

## Runtime Architecture

BellBeast sits between browser clients and backend services:

1. Users open the Razor Pages UI.
2. Frontend modules call BellBeast-owned `/api/*` endpoints.
3. BellBeast either reads local data from `App_Data` or proxies requests to configured upstream services such as Uroboros, Wayfarer, or OpenClaw-related components.
4. Responses are rendered into dashboard cards, reports, chat panels, and device-monitoring views.

This keeps browser clients on a single origin and centralizes auth, routing, and backend configuration.

## Key Pages And Features

- `/MHxViewer/MHxView` - main monitoring dashboard wall
- `/Index` - AQ lookup and query surface
- `/MH_report` - MH report page
- `/CHEM_report` - chemistry report page
- `/Admin/*` - protected admin area
- `/Chat` and `/Chat2` - AI-assisted chat surfaces
- `/IotRoom` - browser UI for connected devices and room state
- `/LedDemo` and `/WebPM` - supporting feature/demo pages

## Configuration

The application reads settings from:

- `BellBeast/appsettings.json`
- `BellBeast/appsettings.Development.json`
- `BellBeast/App_Data/backend-config.json`
- `BellBeast/App_Data/backend-config.chat2.json`

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
