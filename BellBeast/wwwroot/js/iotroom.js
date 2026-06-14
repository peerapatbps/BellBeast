(function () {
    'use strict';

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const messagesEl  = document.getElementById('iotMessages');
    const inputEl     = document.getElementById('iotInput');
    const sendBtn     = document.getElementById('sendCommandButton');
    const clearBtn    = document.getElementById('clearLogButton');
    const membersList = document.getElementById('iotMembersList');
    const memberCount = document.getElementById('iotMemberCount');
    const cfBtn       = document.getElementById('cfConnectButton');

    // CF modal DOM
    const cfModal          = document.getElementById('cfModalBackdrop');
    const cfModalClose     = document.getElementById('cfModalClose');
    const cfModalCloseBtn  = document.getElementById('cfModalCloseBtn');
    const cfStartBtn       = document.getElementById('cfStartBtn');
    const cfStopBtn        = document.getElementById('cfStopBtn');
    const cfStateBadge     = document.getElementById('cfStateBadge');
    const cfStatusHero     = document.getElementById('cfStatusHero');
    const cfStatusMain     = document.getElementById('cfStatusMain');
    const cfStatusSub      = document.getElementById('cfStatusSub');
    const cfJoinUrlEl      = document.getElementById('cfJoinUrl');
    const cfPollUrlEl      = document.getElementById('cfPollUrl');
    const cfLogPre         = document.getElementById('cfLogPre');
    const cfCopyLog        = document.getElementById('cfCopyLog');
    const cfCodePre        = document.getElementById('cfCodePre');
    const cfCopySnippet    = document.getElementById('cfCopySnippet');
    const cfEndpointsSection = document.getElementById('cfEndpointsSection');

    if (!messagesEl || !inputEl || !sendBtn) return;

    const stackEl = messagesEl.querySelector('.iot-message-stack') || createStack();
    let lastLogCount = 0;

    // tunnel state polled from server
    let tunnelState   = 'stopped'; // stopped | starting | running | error
    let publicUrl     = '';
    let statusPollTimer = null;

    // ── Init ──────────────────────────────────────────────────────────────────
    pollMembers();
    pollLog();
    setInterval(pollMembers, 5000);
    setInterval(pollLog, 3000);

    // ── Stack helpers ─────────────────────────────────────────────────────────
    function createStack() {
        const el = document.createElement('div');
        el.className = 'iot-message-stack';
        messagesEl.appendChild(el);
        return el;
    }

    function clearEmpty() {
        const e = stackEl.querySelector('.iot-empty');
        if (e) e.remove();
    }

    function scrollBottom() {
        requestAnimationFrame(function () { messagesEl.scrollTop = messagesEl.scrollHeight; });
    }

    // ── Log rendering ─────────────────────────────────────────────────────────
    const ICONS = { join: '⚡', command: '→', expire: '✗', reconnect: '↻', data: '↑' };

    function renderLogEntries(entries) {
        if (!entries || entries.length === 0) return;
        clearEmpty();
        entries.forEach(function (entry) {
            const row  = document.createElement('div');
            row.className = 'iot-log-entry ' + (entry.kind || '');
            const time = document.createElement('span'); time.className = 'iot-log-time'; time.textContent = fmtTime(entry.at);
            const icon = document.createElement('span'); icon.className = 'iot-log-icon'; icon.textContent = ICONS[entry.kind] || '·';
            const msg  = document.createElement('span'); msg.className  = 'iot-log-msg';  msg.textContent  = entry.message;
            row.appendChild(time); row.appendChild(icon); row.appendChild(msg);
            stackEl.appendChild(row);
        });
        scrollBottom();
    }

    function fmtTime(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            const now = new Date();
            const sameDay = d.toDateString() === now.toDateString();
            if (sameDay)
                return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            return d.toLocaleString('th-TH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch { return ''; }
    }

    // ── Members rendering ─────────────────────────────────────────────────────
    function renderMembers(members) {
        if (!members) return;
        membersList.innerHTML = '';

        if (members.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'iot-members-empty'; empty.textContent = 'No devices connected.';
            membersList.appendChild(empty); return;
        }

        members.forEach(function (m) {
            const chip = document.createElement('div');
            chip.className = 'iot-member-chip' + (m.online ? ' online' : '');
            chip.style.flexShrink = '0';

            const dot  = document.createElement('span'); dot.className  = 'iot-member-dot';
            const name = document.createElement('span'); name.className = 'iot-member-name'; name.textContent = m.name;
            const type = document.createElement('span'); type.className = 'iot-member-type'; type.textContent = m.type;
            const age  = document.createElement('span'); age.className  = 'iot-member-age';  age.textContent  = m.online ? fmtAge(m.lastSeenAgo) : 'offline';

            chip.appendChild(dot); chip.appendChild(name); chip.appendChild(type); chip.appendChild(age);

            // show device state fields if any
            if (m.state && typeof m.state === 'object') {
                const keys = Object.keys(m.state);
                if (keys.length > 0) {
                    const stateEl = document.createElement('span');
                    stateEl.className = 'iot-member-state';
                    stateEl.textContent = keys.slice(0, 4).map(function (k) {
                        var v = m.state[k];
                        if (typeof v === 'object') v = JSON.stringify(v);
                        return k + ': ' + v;
                    }).join(' · ');
                    if (keys.length > 4) stateEl.textContent += ' …';
                    chip.appendChild(stateEl);
                }
            }

            membersList.appendChild(chip);
        });
    }

    function fmtAge(s) { return s < 60 ? s + 's ago' : Math.floor(s / 60) + 'm ago'; }

    // ── API: room ─────────────────────────────────────────────────────────────
    async function pollMembers() {
        try {
            const r = await fetch('/api/iot/room/members', { headers: { Accept: 'application/json' } });
            if (!r.ok) return;
            renderMembers((await r.json()).members || []);
        } catch { }
    }

    async function pollLog() {
        try {
            const r = await fetch('/api/iot/room/log?last=50', { headers: { Accept: 'application/json' } });
            if (!r.ok) return;
            const entries = (await r.json()).entries || [];
            if (entries.length > lastLogCount) { renderLogEntries(entries.slice(lastLogCount)); lastLogCount = entries.length; }
        } catch { }
    }

    // ── Send command ──────────────────────────────────────────────────────────
    async function sendCommand() {
        const raw = inputEl.value.trim();
        if (!raw) return;
        sendBtn.disabled = true;
        try {
            const r = await fetch('/api/iot/room/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ raw: raw })
            });
            const d = await r.json().catch(function () { return {}; });
            if (!r.ok || !d.ok) addLocalLog('error', d.error || 'Command failed.');
            else inputEl.value = '';
        } catch (e) { addLocalLog('error', e.message || 'Network error.'); }
        finally { sendBtn.disabled = false; inputEl.focus(); await pollLog(); }
    }

    function addLocalLog(kind, message) {
        clearEmpty();
        const row  = document.createElement('div'); row.className  = 'iot-log-entry ' + kind;
        const time = document.createElement('span'); time.className = 'iot-log-time'; time.textContent = fmtTime(new Date().toISOString());
        const icon = document.createElement('span'); icon.className = 'iot-log-icon'; icon.textContent = kind === 'error' ? '!' : '·';
        const msg  = document.createElement('span'); msg.className  = 'iot-log-msg';  msg.textContent  = message;
        if (kind === 'error') msg.style.color = '#f87171';
        row.appendChild(time); row.appendChild(icon); row.appendChild(msg);
        stackEl.appendChild(row); scrollBottom();
    }

    function clearLog() {
        stackEl.innerHTML = ''; lastLogCount = 0;
        const empty = document.createElement('div');
        empty.className = 'iot-empty'; empty.textContent = 'Log cleared. Room is ready.';
        stackEl.appendChild(empty);
    }

    // ── Cloudflare tunnel API ─────────────────────────────────────────────────
    async function fetchTunnelStatus() {
        try {
            const r = await fetch('/api/iot/tunnel/status', { headers: { Accept: 'application/json' } });
            if (!r.ok) return null;
            return await r.json();
        } catch { return null; }
    }

    async function startTunnel() {
        cfStartBtn.disabled = true;
        applyTunnelUI({ state: 'starting', publicUrl: publicUrl, uptimeSec: 0, logs: [] });
        try {
            await fetch('/api/iot/tunnel/start', { method: 'POST' });
        } catch { }
        startStatusPolling();
    }

    async function stopTunnel() {
        cfStopBtn.disabled = true;
        try { await fetch('/api/iot/tunnel/stop', { method: 'POST' }); } catch { }
        stopStatusPolling();
        const status = await fetchTunnelStatus();
        if (status) applyTunnelUI(status);
    }

    // ── Status polling (active while modal is open or tunnel is starting) ─────
    function startStatusPolling() {
        stopStatusPolling();
        statusPollTimer = setInterval(async function () {
            const status = await fetchTunnelStatus();
            if (status) applyTunnelUI(status);
            // stop polling once we reach a stable state
            if (status && (status.state === 'running' || status.state === 'stopped' || status.state === 'error')) {
                if (status.state !== 'starting') stopStatusPolling();
            }
        }, 1500);
    }

    function stopStatusPolling() {
        if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
    }

    // ── Apply tunnel status to UI ─────────────────────────────────────────────
    const STATE_LABELS = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', error: 'Error' };

    function applyTunnelUI(status) {
        tunnelState = status.state || 'stopped';
        publicUrl   = status.publicUrl || '';

        // state badge
        cfStateBadge.textContent = STATE_LABELS[tunnelState] || tunnelState;
        cfStateBadge.className   = 'cf-state-badge ' + tunnelState;

        // hero card
        cfStatusHero.className = 'cf-status-hero ' + tunnelState;

        if (tunnelState === 'running') {
            const uptime = status.uptimeSec || 0;
            cfStatusMain.textContent = 'Tunnel Active · ' + fmtUptime(uptime);
            cfStatusSub.textContent  = publicUrl;
        } else if (tunnelState === 'starting') {
            cfStatusMain.textContent = 'Connecting to Cloudflare…';
            cfStatusSub.textContent  = 'Tunnel: ' + (status.tunnelName || 'IoT-Test');
        } else if (tunnelState === 'error') {
            cfStatusMain.textContent = 'Connection Error';
            cfStatusSub.textContent  = status.error || 'cloudflared exited unexpectedly';
        } else {
            cfStatusMain.textContent = 'Tunnel Stopped';
            cfStatusSub.textContent  = 'กด Start Tunnel เพื่อเปิด connection';
        }

        // buttons
        cfStartBtn.disabled = tunnelState === 'running' || tunnelState === 'starting';
        cfStopBtn.disabled  = tunnelState === 'stopped';

        // main CF button in toolbar
        cfBtn.className = 'iot-btn cf' + (tunnelState === 'running' ? ' connected' : '');

        // endpoint URLs
        const base = publicUrl || 'https://iot-test.ttangapollo.uk';
        cfJoinUrlEl.textContent = base + '/api/iot/room/join';
        cfPollUrlEl.textContent = base + '/api/iot/room/poll';
        cfCodePre.textContent   = buildSnippet(base);

        // process log
        const logs = status.logs || [];
        cfLogPre.textContent = logs.length > 0 ? logs.join('\n') : '— no output yet —';
        cfLogPre.scrollTop = cfLogPre.scrollHeight;
    }

    function fmtUptime(s) {
        if (s < 60) return s + 's';
        if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
        return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }

    // ── ESP32 snippet builder ─────────────────────────────────────────────────
    function buildSnippet(base) {
        const join = base + '/api/iot/room/join';
        const poll = base + '/api/iot/room/poll';
        return [
            '#include <WiFi.h>',
            '#include <HTTPClient.h>',
            '#include <ArduinoJson.h>',
            '',
            'const char* SSID     = "YOUR_WIFI";',
            'const char* PASSWORD = "YOUR_PASS";',
            'const char* JOIN_URL = "' + join + '";',
            'const char* POLL_URL = "' + poll + '";',
            '',
            'String deviceKey = "";',
            '',
            'void joinRoom() {',
            '  HTTPClient http;',
            '  http.begin(JOIN_URL);',
            '  http.addHeader("Content-Type", "application/json");',
            '  String body = "{\\"deviceName\\":\\"ESP32-LED\\",\\"deviceType\\":\\"LED\\"}";',
            '  if (http.POST(body) == 200) {',
            '    StaticJsonDocument<128> doc;',
            '    deserializeJson(doc, http.getString());',
            '    deviceKey = doc["key"].as<String>();',
            '  }',
            '  http.end();',
            '}',
            '',
            'void pollRoom() {',
            '  if (deviceKey == "") { joinRoom(); return; }',
            '  HTTPClient http;',
            '  http.begin(POLL_URL);',
            '  http.addHeader("Content-Type", "application/json");',
            '  String body = "{\\"key\\":\\"" + deviceKey + "\\"}";',
            '  if (http.POST(body) == 200) {',
            '    StaticJsonDocument<256> doc;',
            '    deserializeJson(doc, http.getString());',
            '    if (doc["status"] == "reconnect") { deviceKey = ""; return; }',
            '    if (!doc["command"].isNull()) {',
            '      String type = doc["command"]["type"].as<String>();',
            '      String val  = doc["command"]["value"].as<String>();',
            '      // TODO: parse val and apply (e.g. set RGB LED)',
            '    }',
            '  }',
            '  http.end();',
            '}',
            '',
            'void setup() {',
            '  WiFi.begin(SSID, PASSWORD);',
            '  while (WiFi.status() != WL_CONNECTED) delay(500);',
            '  joinRoom();',
            '}',
            '',
            'void loop() {',
            '  pollRoom();',
            '  delay(15000);',
            '}'
        ].join('\n');
    }

    // ── CF modal open / close ─────────────────────────────────────────────────
    async function openCfModal() {
        cfModal.classList.add('open');
        const status = await fetchTunnelStatus();
        if (status) applyTunnelUI(status);
        // keep polling while modal is open and tunnel is in transitional state
        if (tunnelState === 'starting') startStatusPolling();
    }

    function closeCfModal() {
        cfModal.classList.remove('open');
        // only stop polling if tunnel is not in-flight
        if (tunnelState !== 'starting') stopStatusPolling();
    }

    // ── Copy helpers ──────────────────────────────────────────────────────────
    function makeCopyBtn(btn, getText) {
        btn.addEventListener('click', function () {
            navigator.clipboard.writeText(getText()).then(function () {
                const orig = btn.textContent;
                btn.textContent = 'Copied!'; btn.classList.add('copied');
                setTimeout(function () { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
            });
        });
    }

    document.querySelectorAll('.cf-copy-btn[data-copy-target]').forEach(function (btn) {
        makeCopyBtn(btn, function () { return (document.getElementById(btn.getAttribute('data-copy-target')) || {}).textContent || ''; });
    });
    makeCopyBtn(cfCopySnippet, function () { return cfCodePre.textContent; });
    makeCopyBtn(cfCopyLog,     function () { return cfLogPre.textContent; });

    // ── Event listeners ───────────────────────────────────────────────────────
    sendBtn.addEventListener('click', sendCommand);
    clearBtn.addEventListener('click', clearLog);
    cfBtn.addEventListener('click', openCfModal);
    cfModalClose.addEventListener('click', closeCfModal);
    cfModalCloseBtn.addEventListener('click', closeCfModal);
    cfStartBtn.addEventListener('click', startTunnel);
    cfStopBtn.addEventListener('click', stopTunnel);

    cfModal.addEventListener('click', function (e) { if (e.target === cfModal) closeCfModal(); });

    inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCommand(); }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && cfModal.classList.contains('open')) closeCfModal();
    });

    // ── Sync CF button state on page load ─────────────────────────────────────
    fetchTunnelStatus().then(function (status) {
        if (status) applyTunnelUI(status);
    });
})();
