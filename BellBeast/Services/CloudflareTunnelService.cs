using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting;

namespace BellBeast.Services;

public enum TunnelState { Stopped, Starting, Running, Error }

public sealed class CloudflareTunnelService : IDisposable
{
    private readonly string _appDataPath;
    private readonly string _publicUrl;
    private readonly string _cloudflaredPath;
    private readonly object _lock = new();
    private readonly ConcurrentQueue<string> _logLines = new();
    private const int MaxLogLines = 80;

    private Process? _process;
    private TunnelState _state = TunnelState.Stopped;
    private string _errorMessage = "";
    private DateTime? _startedAt;

    // parsed from config.yml at startup
    public string TunnelName { get; private set; } = "";
    public string PublicUrl  => _publicUrl;

    public CloudflareTunnelService(IConfiguration config, IWebHostEnvironment env)
    {
        _appDataPath     = Path.Combine(env.ContentRootPath, "App_Data");
        var section      = config.GetSection("CloudflareTunnel");
        _publicUrl       = section["PublicUrl"]       ?? "";
        _cloudflaredPath = section["CloudflaredPath"] ?? "cloudflared";

        // read tunnel name from config.yml for display
        TunnelName = ReadTunnelNameFromConfig();
    }

    public TunnelState State        { get { lock (_lock) return _state; } }
    public DateTime?   StartedAt    { get { lock (_lock) return _startedAt; } }
    public string      ErrorMessage { get { lock (_lock) return _errorMessage; } }

    public IReadOnlyList<string> GetRecentLogs(int count = 40)
    {
        var all  = _logLines.ToArray();
        var skip = Math.Max(0, all.Length - count);
        return all.Skip(skip).ToList();
    }

    public bool Start()
    {
        lock (_lock)
        {
            if (_state is TunnelState.Starting or TunnelState.Running) return false;
            _state        = TunnelState.Starting;
            _errorMessage = "";
            _startedAt    = null;
        }

        _logLines.Clear();
        AddLog("[BellBeast] Preparing runtime config...");

        string runtimeConfigPath;
        try
        {
            runtimeConfigPath = BuildRuntimeConfig();
        }
        catch (Exception ex)
        {
            lock (_lock) { _state = TunnelState.Error; _errorMessage = ex.Message; }
            AddLog("[ERROR] Failed to build runtime config: " + ex.Message);
            return false;
        }

        AddLog("[BellBeast] Starting cloudflared tunnel: " + TunnelName);
        AddLog("[BellBeast] Config: " + runtimeConfigPath);

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName               = _cloudflaredPath,
                Arguments              = $"--config \"{runtimeConfigPath}\" tunnel run",
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                UseShellExecute        = false,
                CreateNoWindow         = true,
            };

            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };

            proc.OutputDataReceived += (_, e) => { if (e.Data != null) HandleLog(e.Data); };
            proc.ErrorDataReceived  += (_, e) => { if (e.Data != null) HandleLog(e.Data); };
            proc.Exited += (_, _) => HandleExit(proc);

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            lock (_lock) { _process = proc; }
            return true;
        }
        catch (Exception ex)
        {
            lock (_lock) { _state = TunnelState.Error; _errorMessage = ex.Message; }
            AddLog("[ERROR] " + ex.Message);
            return false;
        }
    }

    public void Stop()
    {
        Process? proc;
        lock (_lock)
        {
            if (_state is TunnelState.Stopped) return;
            proc   = _process;
            _state = TunnelState.Stopped;
        }

        AddLog("[BellBeast] Stopping tunnel...");
        try
        {
            if (proc != null && !proc.HasExited)
            {
                proc.Kill(entireProcessTree: true);
                proc.WaitForExit(3000);
            }
        }
        catch { }

        lock (_lock) { _process = null; _startedAt = null; }
        AddLog("[BellBeast] Tunnel stopped.");
    }

    // ── Runtime config generation ─────────────────────────────────────────────
    // Reads App_Data/config.yml, substitutes credentials-file with an absolute
    // path derived from ContentRootPath (safe after publish/deploy), then writes
    // App_Data/config_runtime.yml for cloudflared to consume.
    private string BuildRuntimeConfig()
    {
        var srcPath  = Path.Combine(_appDataPath, "config.yml");
        var credPath = Path.Combine(_appDataPath, "cloudflare_token.json");
        var dstPath  = Path.Combine(_appDataPath, "config_runtime.yml");

        if (!File.Exists(srcPath))
            throw new FileNotFoundException("config.yml not found in App_Data", srcPath);
        if (!File.Exists(credPath))
            throw new FileNotFoundException("cloudflare_token.json not found in App_Data", credPath);

        var content = File.ReadAllText(srcPath);

        // Normalize to forward slashes — works on both Windows and Linux
        var credPathNorm = credPath.Replace('\\', '/');

        // Replace credentials-file line (whatever path was hardcoded)
        content = Regex.Replace(
            content,
            @"(?m)^credentials-file:.*$",
            "credentials-file: " + credPathNorm);

        File.WriteAllText(dstPath, content);
        AddLog("[BellBeast] Written: " + dstPath);
        return dstPath;
    }

    private string ReadTunnelNameFromConfig()
    {
        try
        {
            var srcPath = Path.Combine(_appDataPath, "config.yml");
            if (!File.Exists(srcPath)) return "IoT-Test";
            foreach (var line in File.ReadLines(srcPath))
            {
                var m = Regex.Match(line, @"^tunnel:\s*(.+)$");
                if (m.Success) return m.Groups[1].Value.Trim();
            }
        }
        catch { }
        return "IoT-Test";
    }

    // ── Log handling ──────────────────────────────────────────────────────────
    private void HandleLog(string line)
    {
        AddLog(line);

        // "Registered tunnel connection" is the reliable indicator that the tunnel is actually up
        if (_state == TunnelState.Starting && line.Contains("Registered tunnel connection"))
        {
            lock (_lock)
            {
                if (_state == TunnelState.Starting)
                {
                    _state     = TunnelState.Running;
                    _startedAt = DateTime.UtcNow;
                }
            }
        }

        // Track last error line — ERR lines during connection setup are normal retries,
        // actual failure is detected in HandleExit via exit code.
        if (line.Contains("ERR") || line.Contains("level=error"))
        {
            lock (_lock) { _errorMessage = line; }
        }
    }

    private void HandleExit(Process proc)
    {
        lock (_lock)
        {
            if (_process != proc) return;
            _process   = null;
            _startedAt = null;
            _state     = proc.ExitCode == 0 ? TunnelState.Stopped : TunnelState.Error;
            if (_state == TunnelState.Error)
                _errorMessage = "cloudflared exited with code " + proc.ExitCode;
        }
        AddLog("[BellBeast] Process exited (code " + proc.ExitCode + ")");
    }

    private void AddLog(string line)
    {
        _logLines.Enqueue(line);
        while (_logLines.Count > MaxLogLines)
            _logLines.TryDequeue(out _);
    }

    public void Dispose() => Stop();
}
