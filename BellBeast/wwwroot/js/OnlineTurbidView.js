// OnlineTurbidView.js  (OnlineLab POST /api/online_lab)
// - ONLINE TURBID block: 2 rows x 4 mini charts (same chart look as DPS row4 / DPSview.js)
// - toggle CW-TW : top CW1..4 (key CWn),  bottom TW1..4 (key NTU)
//          CW-AB : top CW1..4 tank A (key CWnA), bottom CW1..4 tank B (key CWnB)
// - ยิง POST ครั้งเดียวได้ครบทั้ง 2 mode -> สลับ toggle แล้ววาดจาก cache ทันที ไม่ต้องรอ fetch
// - backend ส่ง DESC -> reverse เป็น ASC เพื่อให้ซ้าย->ขวา
// - status: ค่าล่าสุดเทียบ _ParaMax / _ParaMin ล่าสุด -> OK / HIGH / LOW
// - bell: ตรวจทุก series (ไม่ใช่แค่ mode ที่โชว์อยู่) ตามกลุ่มที่เปิดใน settings, กดกระดิ่ง = mute/unmute

(function () {

    const HOUR_WINDOW = 4;
    const TIMEOUT_MS = 8000;
    const MODE_STORAGE_KEY = "otb_mode_v1";
    const SETTINGS_KEY = "otb_settings_v1";
    const DEFAULT_MODE = "CW-TW";

    const DEFAULTS = {
        refreshMin: 5,
        alertEnabled: false,   // same as other cards: user opts in via settings
        alertMuted: false,
        alertCW: true,     // CW1..4 (รวม)
        alertCWAB: true,   // CW1..4 ถัง A / B
        alertTW: true      // TW1..4
    };

    const N = [1, 2, 3, 4];

    // slot i (0..7) -> { source, key, title, group }
    const CW = N.map(n => ({ source: `CW${n}`, key: `CW${n}`, title: `CW Turbid# ${n}`, group: "alertCW" }));
    const CWA = N.map(n => ({ source: `CW${n}`, key: `CW${n}A`, title: `CW Turbid# ${n}A`, group: "alertCWAB" }));
    const CWB = N.map(n => ({ source: `CW${n}`, key: `CW${n}B`, title: `CW Turbid# ${n}B`, group: "alertCWAB" }));
    const TW = N.map(n => ({ source: `TW${n}`, key: "NTU", title: `TW Turbid# ${n}`, group: "alertTW" }));

    const MODES = {
        "CW-TW": [...CW, ...TW],
        "CW-AB": [...CWA, ...CWB]
    };

    const ALL_SERIES = [...CW, ...CWA, ...CWB, ...TW];

    let popupOverlayEl = null;

    // ============================
    // settings
    // ============================
    function loadMode() {
        try {
            const m = localStorage.getItem(MODE_STORAGE_KEY);
            return MODES[m] ? m : DEFAULT_MODE;
        } catch {
            return DEFAULT_MODE;
        }
    }

    function saveMode(mode) {
        try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { }
    }

    function loadSettings() {
        const s = window.BBAlerts?.loadSettings?.(SETTINGS_KEY, DEFAULTS) || { ...DEFAULTS };
        s.refreshMin = [5, 10, 15].includes(Number(s.refreshMin)) ? Number(s.refreshMin) : DEFAULTS.refreshMin;
        return s;
    }

    function saveSettings(s) {
        try { window.BBAlerts?.saveSettings?.(SETTINGS_KEY, s); } catch { }
    }

    // ============================
    // Fetch (POST) - SIMPLE REQUEST (no preflight), all keys of both modes
    // ============================
    function buildPayload() {
        const bySource = new Map();
        for (const s of ALL_SERIES) {
            if (!bySource.has(s.source)) bySource.set(s.source, new Set());
            const keys = bySource.get(s.source);
            keys.add(s.key);
            keys.add(s.key + "_ParaMax");
            keys.add(s.key + "_ParaMin");
        }
        return {
            hourWindow: HOUR_WINDOW,
            sources: Array.from(bySource, ([source, keys]) => ({ source, keys: Array.from(keys) }))
        };
    }

    async function fetchOnlineLab(url) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort("timeout"), TIMEOUT_MS);
        try {
            const r = await fetch(url, {
                method: "POST",
                headers: { "content-type": "text/plain;charset=UTF-8" },
                cache: "no-store",
                body: JSON.stringify(buildPayload()),
                signal: ac.signal
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);

            const j = await r.json();
            if (!j || j.ok !== true) {
                throw new Error(j && (j.error || j.message) ? (j.error || j.message) : "online_lab not ok");
            }
            return j;
        } finally {
            clearTimeout(t);
        }
    }

    // ============================
    // Series helpers
    // ============================
    function toXY(points) {
        const out = [];
        for (const p of (points || [])) {
            if (!p) continue;
            const ts = String(p.ts || "").trim();
            const y = Number(p.value);
            if (!ts || !Number.isFinite(y)) continue;
            out.push({ x: ts, y });
        }
        return out.reverse();
    }

    function last(arr) {
        return arr.length ? arr[arr.length - 1].y : null;
    }

    // -> { main, max, min, state: "HIGH" | "LOW" | "OK" | null }
    function readSeries(graphs, spec) {
        const g = graphs ? graphs[spec.source] : null;
        const main = toXY(g && g[spec.key]);
        if (!main.length) return { main, max: [], min: [], state: null };

        const max = toXY(g[spec.key + "_ParaMax"]);
        const min = toXY(g[spec.key + "_ParaMin"]);
        const v = last(main), hi = last(max), lo = last(min);

        let state = "OK";
        if (hi !== null && v > hi) state = "HIGH";
        else if (lo !== null && v < lo) state = "LOW";
        return { main, max, min, state };
    }

    // ============================
    // Chart helpers (plot dataset only)
    // ============================
    function ensureChart(canvas) {
        if (!window.Chart) throw new Error("Chart.js not loaded");
        if (canvas._otbChart) return canvas._otbChart;

        canvas._otbChart = new Chart(canvas.getContext("2d"), {
            type: "line",
            data: {
                datasets: [
                    { label: "value", data: [], borderColor: "rgba(255,255,255,.92)", borderWidth: 2, pointRadius: 0, tension: 0 },
                    { label: "max", data: [], borderColor: "rgba(255,91,91,.95)", borderWidth: 4, pointRadius: 0, tension: 0 },
                    { label: "min", data: [], borderColor: "rgba(255,91,91,.95)", borderWidth: 4, pointRadius: 0, tension: 0 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                parsing: { xAxisKey: "x", yAxisKey: "y" },
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        type: "time",
                        time: { unit: "minute", displayFormats: { minute: "HH:mm" } },
                        ticks: { display: false },
                        grid: { display: false }
                    },
                    y: { grid: { color: "rgba(255,255,255,.06)" } }
                }
            }
        });
        return canvas._otbChart;
    }

    function destroyChart(canvas) {
        if (canvas && canvas._otbChart) {
            try { canvas._otbChart.destroy(); } catch { }
        }
        if (canvas) canvas._otbChart = null;
    }

    function setStatus(el, cls, text) {
        if (!el) return;
        el.classList.remove("ok", "warn", "bad");
        if (cls) el.classList.add(cls);
        el.textContent = text;
    }

    // ============================
    // Render 8 charts for the current mode
    // ============================
    function renderSlot(section, i, spec, graphs) {
        const canvas = section.querySelector(`[data-otb-chart="${i}"]`);
        const titleEl = section.querySelector(`[data-otb-title="${i}"]`);
        const statusEl = section.querySelector(`[data-otb-status="${i}"]`);
        const emptyEl = section.querySelector(`[data-otb-empty="${i}"]`);
        if (!canvas) return;

        if (titleEl) titleEl.textContent = spec.title;

        const s = readSeries(graphs, spec);
        if (!s.state) {
            destroyChart(canvas);
            canvas.style.display = "none";
            if (emptyEl) emptyEl.hidden = false;
            setStatus(statusEl, null, "-");
            return;
        }

        const ch = ensureChart(canvas);
        ch.data.datasets[0].data = s.main;
        ch.data.datasets[1].data = s.max;
        ch.data.datasets[2].data = s.min;
        ch.update("none");
        canvas.style.display = "";
        if (emptyEl) emptyEl.hidden = true;

        setStatus(statusEl, s.state === "OK" ? "ok" : "bad", s.state);
    }

    function render(section) {
        const mode = section._otbMode;
        const graphs = section._otbData ? section._otbData.graphs : null;

        for (const btn of section.querySelectorAll("[data-otb-mode]")) {
            btn.setAttribute("aria-pressed", String(btn.getAttribute("data-otb-mode") === mode));
        }
        MODES[mode].forEach((spec, i) => renderSlot(section, i, spec, graphs));
        evaluateAlerts(section);
    }

    // ============================
    // Bell
    // ============================
    function ruleKey(spec) {
        return `otb-${spec.source}-${spec.key}`;
    }

    function evaluateAlerts(section) {
        const settings = loadSettings();
        const graphs = section._otbData ? section._otbData.graphs : null;
        const over = [];

        for (const spec of ALL_SERIES) {
            const state = readSeries(graphs, spec).state;
            const active = window.BBAlerts?.evaluate?.(section, {
                ruleKey: ruleKey(spec),
                enabled: settings.alertEnabled && settings[spec.group],
                muted: settings.alertMuted,
                value: (state === "HIGH" || state === "LOW") ? 1 : 0,
                limit: 0,
                direction: "gt"
            }) || false;
            if (active) over.push(`${spec.title} ${state}`);
        }

        const bell = section.querySelector('[data-role="otb-alert-bell"]');
        window.BBAlerts?.setBellState?.(bell, over.length ? "alerting" : (settings.alertMuted ? "muted" : "armed"));
        if (bell && over.length) bell.title = "Bell: " + over.join(", ");
    }

    function resetAlerts(section) {
        for (const spec of ALL_SERIES) window.BBAlerts?.resetRule?.(section, ruleKey(spec));
    }

    // ============================
    // Polling
    // ============================
    async function refresh(section) {
        if (!section.isConnected) {
            stop(section);
            resetAlerts(section);
            return;
        }
        if (section._otbInflight) return;
        section._otbInflight = true;

        try {
            section._otbData = await fetchOnlineLab(section.getAttribute("data-otb-url") || "/api/online_lab");
        } catch {
            section._otbData = null;
        } finally {
            section._otbInflight = false;
        }
        render(section);
    }

    function stop(section) {
        if (section._otbTimer) clearInterval(section._otbTimer);
        section._otbTimer = null;
    }

    function restartPoller(section) {
        stop(section);
        section._otbTimer = setInterval(() => refresh(section), loadSettings().refreshMin * 60 * 1000);
    }

    // ============================
    // Settings popup
    // ============================
    function openSettings() {
        if (!popupOverlayEl) {
            popupOverlayEl = document.createElement("div");
            popupOverlayEl.className = "otb-settings-overlay";
            popupOverlayEl.innerHTML = `
                <div class="otb-settings-pop" role="dialog" aria-label="Online Turbid Settings">
                    <div class="t">Online Turbid Settings</div>
                    <div class="row">
                        <label for="otbSetRefresh">Data refresh rate</label>
                        <select id="otbSetRefresh">
                            <option value="5">5 minutes</option>
                            <option value="10">10 minutes</option>
                            <option value="15">15 minutes</option>
                        </select>
                    </div>
                    <div class="row">
                        <label><input id="otbSetAlert" type="checkbox" /> Alert when out of limit</label>
                        <label><input id="otbSetCW" type="checkbox" /> CW1–4</label>
                        <label><input id="otbSetCWAB" type="checkbox" /> CW1–4 tank A / B</label>
                        <label><input id="otbSetTW" type="checkbox" /> TW1–4</label>
                        <div class="hint">Limits come from OnlineLab ParaMax / ParaMin.</div>
                    </div>
                    <div class="row">
                        <label><input id="otbSetMuted" type="checkbox" /> Mute sound</label>
                    </div>
                    <div class="actions">
                        <button type="button" data-act="cancel">Cancel</button>
                        <button type="button" class="primary" data-act="save">Save</button>
                    </div>
                </div>`;
            document.body.appendChild(popupOverlayEl);

            popupOverlayEl.addEventListener("click", (ev) => {
                if (ev.target === popupOverlayEl || ev.target.closest('[data-act="cancel"]')) {
                    popupOverlayEl.classList.remove("show");
                }
            });

            popupOverlayEl.querySelector('[data-act="save"]').addEventListener("click", () => {
                const pop = popupOverlayEl;
                const prev = loadSettings();
                const next = {
                    ...prev,
                    refreshMin: Number(pop.querySelector("#otbSetRefresh").value) || DEFAULTS.refreshMin,
                    alertEnabled: pop.querySelector("#otbSetAlert").checked,
                    alertCW: pop.querySelector("#otbSetCW").checked,
                    alertCWAB: pop.querySelector("#otbSetCWAB").checked,
                    alertTW: pop.querySelector("#otbSetTW").checked,
                    alertMuted: pop.querySelector("#otbSetMuted").checked
                };
                saveSettings(next);
                pop.classList.remove("show");

                document.querySelectorAll("section.otb-block").forEach(sec => {
                    if (next.refreshMin !== prev.refreshMin) restartPoller(sec);
                    evaluateAlerts(sec);
                });
            });
        }

        const s = loadSettings();
        const pop = popupOverlayEl;
        pop.querySelector("#otbSetRefresh").value = String(s.refreshMin);
        pop.querySelector("#otbSetAlert").checked = !!s.alertEnabled;
        pop.querySelector("#otbSetCW").checked = !!s.alertCW;
        pop.querySelector("#otbSetCWAB").checked = !!s.alertCWAB;
        pop.querySelector("#otbSetTW").checked = !!s.alertTW;
        pop.querySelector("#otbSetMuted").checked = !!s.alertMuted;
        pop.classList.add("show");
    }

    // ============================
    // Public initWithin
    // ============================
    function bindOnce(section) {
        if (section._otbHandlersBound) return;
        section._otbHandlersBound = true;

        section.querySelector(".otb-toggle")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-otb-mode]");
            const mode = btn && btn.getAttribute("data-otb-mode");
            if (!mode || !MODES[mode] || mode === section._otbMode) return;
            section._otbMode = mode;
            saveMode(mode);
            render(section);
        });

        section.querySelector('[data-role="otb-alert-bell"]')?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.BBAlerts?.armAudio?.();

            const s = loadSettings();
            s.alertMuted = !s.alertMuted;
            saveSettings(s);
            document.querySelectorAll("section.otb-block").forEach(evaluateAlerts);
        });

        section.querySelector('[data-role="otb-settings"]')?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.BBAlerts?.armAudio?.();
            openSettings();
        });
    }

    function initWithin(root) {
        const scope = root || document;
        for (const section of scope.querySelectorAll("section.otb-block")) {
            if (section._otbBound) continue;
            section._otbBound = true;

            section._otbMode = loadMode();
            bindOnce(section);

            render(section);
            refresh(section);
            restartPoller(section);
        }
    }

    function destroyWithin(root) {
        const scope = root || document;
        for (const section of scope.querySelectorAll("section.otb-block")) {
            stop(section);
            resetAlerts(section);
            section._otbBound = false;
            for (const cv of section.querySelectorAll("[data-otb-chart]")) destroyChart(cv);
        }
    }

    window.OnlineTurbidView = { initWithin, destroyWithin };

})();
