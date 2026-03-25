# BellBeast

BellBeast is an ASP.NET Core Razor Pages dashboard project for industrial monitoring, visualization, and operations support. It is designed to present plant and process information in a modular block-based UI, with support for live data, summaries, charts, and custom operational views.

## Overview

This project provides a web-based monitoring interface for process and utility systems. The application focuses on:

- Real-time dashboard presentation
- Modular block and slot layout rendering
- Integration with backend services and local data sources
- Support for summary cards, trend views, and operational status displays
- Flexible UI components for plant-specific pages

## Main Features

- ASP.NET Core Razor Pages architecture
- Modular dashboard blocks
- Live summary endpoint integration
- Support for custom charts and trend displays
- Configurable backend and API connection
- Suitable for internal monitoring and operations support use cases

## Project Structure

    BellBeast/
    ├─ Pages/              # Razor Pages views and page models
    ├─ Services/           # Application services / backend integration
    ├─ Properties/         # Launch and project properties
    ├─ App_Data/           # Local application data / database files
    ├─ wwwroot/            # Static files (css, js, lib, images)
    ├─ Program.cs          # Application startup
    ├─ BellBeast.csproj    # Project file
    └─ README.md

## Technology Stack

- ASP.NET Core Razor Pages
- C#
- HTML / CSS / JavaScript
- SQLite
- Microsoft.Data.Sqlite
- System.Data.OleDb

## NuGet Packages

This project currently uses the following main packages:

### Top-level packages

- **Microsoft.Data.Sqlite** (`10.0.1`)  
  Lightweight ADO.NET provider for SQLite, used for connecting to and working with SQLite databases in the application.

- **System.Data.OleDb** (`10.0.2`)  
  Provides OLE DB data access support for .NET applications.

### Transitive packages

These packages are installed automatically as dependencies of the main packages:

- **Microsoft.Data.Sqlite.Core** (`10.0.1`)  
  Core SQLite provider library used internally by `Microsoft.Data.Sqlite`.

- **SQLitePCLRaw.bundle_e_sqlite3** (`2.1.11`)  
  Bundles SQLite native components needed for common SQLite usage scenarios.

- **SQLitePCLRaw.core** (`2.1.11`)  
  Core low-level API for SQLite interop.

- **SQLitePCLRaw.lib.e_sqlite3** (`2.1.11`)  
  Native SQLite library wrapper used by SQLitePCLRaw.

- **SQLitePCLRaw.provider.e_sqlite3** (`2.1.11`)  
  Provider implementation for loading and using the bundled SQLite native library.

- **System.Configuration.ConfigurationManager** (`10.0.2`)  
  Supports legacy-style configuration access patterns in .NET applications.

- **System.Diagnostics.EventLog** (`10.0.2`)  
  Provides access to Windows Event Log APIs.

- **System.Diagnostics.PerformanceCounter** (`10.0.2`)  
  Provides access to Windows performance counters.

- **System.Memory** (`4.5.3`)  
  Adds memory-related types used internally by some libraries.

- **System.Security.Cryptography.ProtectedData** (`10.0.2`)  
  Provides access to Windows Data Protection API (DPAPI).

- **System.Threading.AccessControl** (`10.0.2`)  
  Supports access control and audit rules for synchronization primitives.

## Getting Started

### 1. Clone the repository

    git clone https://github.com/peerapatbps/BellBeast.git
    cd BellBeast

### 2. Restore dependencies

    dotnet restore

### 3. Run the project

    dotnet run

Or open the project in Visual Studio and run it from there.

## Development Notes

- The `.vs/`, `bin/`, and `obj/` folders should not be committed to Git.
- Configuration values may be stored in:
  - `appsettings.json`
  - `appsettings.Development.json`
  - local project-specific files in `App_Data/`

## Recommended .gitignore

    .vs/
    bin/
    obj/
    *.user
    *.suo

## Current Status

This repository is under active development. Features, structure, and configuration may continue to evolve as the system grows.

## Author

Developed by Peerapat S.

## License

This project is currently intended for private or internal use unless otherwise specified.
