(function () {
    'use strict';

    const paletteEl    = document.getElementById('palette');
    const deviceSelect = document.getElementById('deviceSelect');
    const deviceDot    = document.getElementById('deviceDot');
    const previewOrb   = document.getElementById('previewOrb');
    const previewLabel = document.getElementById('previewLabel');
    const customInput  = document.getElementById('customColor');
    const sendCustomBtn = document.getElementById('sendCustomBtn');
    const offBtn       = document.getElementById('offBtn');
    const toastEl      = document.getElementById('toast');

    if (!paletteEl) return;

    // ── Preset palette ────────────────────────────────────────────────────────
    const PRESETS = [
        '#FF0000','#FF4500','#FF8C00','#FFD700','#ADFF2F','#00FF00',
        '#00FA9A','#00CED1','#00BFFF','#1E90FF','#6A5ACD','#9400D3',
        '#FF1493','#FF69B4','#FF6B35','#FFFFFF','#C0C0C0','#808080',
        '#FF4081','#40C4FF','#69F0AE','#FFFF00','#FF6E40','#EA80FC'
    ];

    let activeHex = null;
    let toastTimer = null;

    // Build swatch grid
    PRESETS.forEach(function (hex) {
        const sw = document.createElement('button');
        sw.className = 'led-swatch';
        sw.style.background = hex;
        sw.title = hex;
        sw.addEventListener('click', function () {
            sendColor(hex, sw);
        });
        paletteEl.appendChild(sw);
    });

    // ── Send color ────────────────────────────────────────────────────────────
    function sendColor(hex, swatchEl) {
        const name = deviceSelect.value;
        if (!name) { showToast('No device selected', true); return; }

        const rgb = hexToRgb(hex);
        if (!rgb) { showToast('Invalid color', true); return; }

        const raw = '{"' + name + '", "LED", "' + rgb.r + ',' + rgb.g + ',' + rgb.b + '"}';

        setSwatchActive(swatchEl);
        fetch('/api/iot/room/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw: raw })
        })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (d.ok) {
                applyPreview(hex, rgb);
                showToast('Sent ' + hex + ' → ' + name);
            } else {
                showToast(d.error || 'Command failed', true);
                clearActive();
            }
        })
        .catch(function (e) {
            showToast('Network error', true);
            clearActive();
        });
    }

    function applyPreview(hex, rgb) {
        activeHex = hex;
        const isOff = (rgb.r === 0 && rgb.g === 0 && rgb.b === 0);
        previewOrb.style.background = isOff ? '#000' : hex;
        previewOrb.style.boxShadow  = isOff ? 'none' : '0 0 32px 8px ' + hexAlpha(hex, 0.45);
        previewLabel.textContent    = isOff
            ? 'OFF · 0, 0, 0'
            : hex.toUpperCase() + ' · ' + rgb.r + ', ' + rgb.g + ', ' + rgb.b;
    }

    // ── Swatch active state ───────────────────────────────────────────────────
    function setSwatchActive(el) {
        clearActive();
        if (el) el.classList.add('active');
    }

    function clearActive() {
        paletteEl.querySelectorAll('.led-swatch.active').forEach(function (s) {
            s.classList.remove('active');
        });
    }

    // ── Custom color ──────────────────────────────────────────────────────────
    sendCustomBtn.addEventListener('click', function () {
        sendColor(customInput.value, null);
    });

    // ── OFF ───────────────────────────────────────────────────────────────────
    offBtn.addEventListener('click', function () {
        sendColor('#000000', null);
    });

    // ── Device selector ───────────────────────────────────────────────────────
    function refreshDevices() {
        fetch('/api/iot/room/members', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            const members = (d.members || []).filter(function (m) { return m.online; });
            const prev = deviceSelect.value;

            // keep existing options minus the placeholder
            deviceSelect.innerHTML = '<option value="">— no device —</option>';
            members.forEach(function (m) {
                const opt = document.createElement('option');
                opt.value = m.name;
                opt.textContent = m.name + ' (' + m.type + ')';
                deviceSelect.appendChild(opt);
            });

            // restore selection if still online
            if (prev && members.some(function (m) { return m.name === prev; }))
                deviceSelect.value = prev;

            const selected = deviceSelect.value;
            const isOnline = selected && members.some(function (m) { return m.name === selected; });
            deviceDot.className = 'led-device-dot' + (isOnline ? ' online' : '');
        })
        .catch(function () {});
    }

    deviceSelect.addEventListener('change', function () {
        const name = deviceSelect.value;
        const isOnline = !!name;
        deviceDot.className = 'led-device-dot' + (isOnline ? ' online' : '');
    });

    refreshDevices();
    setInterval(refreshDevices, 5000);

    // ── Toast ─────────────────────────────────────────────────────────────────
    function showToast(msg, isError) {
        if (toastTimer) clearTimeout(toastTimer);
        toastEl.textContent = msg;
        toastEl.className = 'led-toast' + (isError ? ' error' : '') + ' show';
        toastTimer = setTimeout(function () {
            toastEl.className = 'led-toast' + (isError ? ' error' : '');
        }, 2200);
    }

    // ── Color utilities ───────────────────────────────────────────────────────
    function hexToRgb(hex) {
        var c = hex.replace('#', '');
        if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
        if (c.length !== 6) return null;
        return {
            r: parseInt(c.slice(0,2), 16),
            g: parseInt(c.slice(2,4), 16),
            b: parseInt(c.slice(4,6), 16)
        };
    }

    function hexAlpha(hex, alpha) {
        var rgb = hexToRgb(hex);
        if (!rgb) return 'transparent';
        return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
    }
})();
