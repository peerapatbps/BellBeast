/* =========================================================
   ptc_smartmap_overlay.js  (single poller, DPS-like)
   - Overlay PV from /api/smartmap onto EXISTING PTC charts (BBTrendPTC)
   - 1 setting (refreshSec) applies to both PTC big charts
   - 1 interval for whole page, 1 request per tick (batched keys)
   - Reads base key from dropdown (canvas data-select) or data-code/default
   ========================================================= */
(function () {
    "use strict";

    const SMARTMAP_URL = "/api/smartmap";
    const STORAGE_KEY = "ptc_smartmap_refresh_v1";

    const boundSections = new WeakSet();
    let pollTimer = null;
    let pollMs = 10000;
    let inFlight = false;

    // ---------------------------
    // settings (localStorage)
    // ---------------------------
    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { refreshSec: 10, seriesRefreshSec: 10800, alertEnabled: false, alertMuted: false };

            const o = JSON.parse(raw);
            const r1 = Number(o.refreshSec);
            const r2 = Number(o.seriesRefreshSec);

            const validSeries = [10800, 21600, 32400, 43200];

            return {
                refreshSec: (Number.isFinite(r1) && r1 > 0) ? r1 : 10,
                seriesRefreshSec: validSeries.includes(r2) ? r2 : 10800,
                alertEnabled: Boolean(o.alertEnabled),
                alertMuted: Boolean(o.alertMuted)
            };
        } catch {
            return { refreshSec: 10, seriesRefreshSec: 10800, alertEnabled: false, alertMuted: false };
        }
    }

    function saveSettings(s) {
        const refreshSec = Math.max(5, Math.min(60, Number(s.refreshSec) || 10));

        const rawSeries = Number(s.seriesRefreshSec);
        const seriesRefreshSec = [10800, 21600, 32400, 43200].includes(rawSeries)
            ? rawSeries
            : 10800;

        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            refreshSec,
            seriesRefreshSec,
            alertEnabled: Boolean(s.alertEnabled),
            alertMuted: Boolean(s.alertMuted)
        }));
    }

    function syncBell(sec) {
        if (!sec) return;
        const bell = sec.querySelector('[data-role="ptc-alert-bell"]');
        const s = loadSettings();
        window.BBAlerts?.setBellState?.(bell, s.alertMuted ? "muted" : "armed");
    }

    // ---------------------------
    // popup (create once) - same UX as DPS
    // ---------------------------
    function ensurePopup() {
        let el = document.querySelector(".ptc-settings-pop");
        if (el) return el;

        el = document.createElement("div");
        el.className = "ptc-settings-pop";
        el.innerHTML = `
                          <div class="ptc-pop-card">
                            <div class="ptc-pop-h">
                              <div class="t">PTC Overlay Settings</div>
                              <button class="x" type="button" aria-label="Close">✕</button>
                            </div>
                            <div class="ptc-pop-b">
                              <div class="row">
                                  <div class="k">Overlay refresh (seconds)</div>
                                  <select class="inp" data-k="refreshSec">
                                    <option value="5">5 seconds</option>
                                    <option value="10">10 seconds</option>
                                    <option value="15">15 seconds</option>
                                    <option value="30">30 seconds</option>
                                    <option value="60">60 seconds</option>
                                  </select>
                                </div>

                                <div class="row">
                                  <div class="k">Upper/Lower limit refresh</div>
                                  <select class="inp" data-k="seriesRefreshSec">
                                    <option value="10800">3 hours</option>
                                    <option value="21600">6 hours</option>
                                    <option value="32400">9 hours</option>
                                    <option value="43200">12 hours</option>
                                  </select>
                                </div>

                                <div class="row">
                                  <div class="k">Enable out-of-control alarm</div>
                                  <label class="toggle"><input type="checkbox" data-k="alertEnabled"> <span>On</span></label>
                                </div>

                                <div class="row">
                                  <div class="k">Mute bell sound</div>
                                  <label class="toggle"><input type="checkbox" data-k="alertMuted"> <span>Muted</span></label>
                                </div>
      
                              <div class="actions">
                                <button class="btn" data-act="apply" type="button">Save</button>
                                <button class="btn ghost" data-act="close" type="button">Cancel</button>
                              </div>
                            </div>
                          </div>
                        `;
        document.body.appendChild(el);

        const st = document.createElement("style");
        st.textContent = `
          .ptc-settings-pop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:999999}
          .ptc-settings-pop.on{display:flex}
          .ptc-pop-card{width:min(420px,92vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55);color:rgba(255,255,255,.92)}
          .ptc-pop-h{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10)}
          .ptc-pop-h .t{font-weight:700}
          .ptc-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.9);font-size:16px;cursor:pointer}
          .ptc-pop-b{padding:12px 14px}
          .ptc-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0}
          .ptc-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
          .ptc-pop-b .inp{width:120px;background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
          .ptc-pop-b .toggle{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,.92)}
          .ptc-pop-b .hint{margin-top:8px;font-size:12px;color:rgba(255,255,255,.60)}
          .ptc-pop-b .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}
          .ptc-pop-b .btn{background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 12px;cursor:pointer}
          .ptc-pop-b .btn.ghost{opacity:.85}
        `;
        document.head.appendChild(st);

        el.addEventListener("click", (e) => { if (e.target === el) el.classList.remove("on"); });
        return el;
    }

    // ---------------------------
    // normalize dropdown value -> base key (same logic as DPS)
    // Accepts: UZ5411_P, UZ5411P, UZ5411 -> base: UZ5411
    // ---------------------------
    function normalizeBaseKey(raw) {
        let s = (raw || "").trim().toUpperCase();
        if (!s) return "";
        if (s.endsWith("_P")) s = s.slice(0, -2);
        if (!s.includes("_") && s.endsWith("P")) {
            const prev = s[s.length - 2];
            if (prev >= "0" && prev <= "9") s = s.slice(0, -1);
        }
        return s;
    }

    // ---------------------------
    // fetch smartmap batch
    // ---------------------------
    async function fetchSmartmapBatchAsync(baseKeysCsv, timeoutMs = 10000) {
        const url = `${SMARTMAP_URL}?keys=${encodeURIComponent(baseKeysCsv)}`;
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        try {
            const resp = await fetch(url, { method: "GET", signal: ac.signal, cache: "no-store", credentials: "omit" });
            if (!resp.ok) throw new Error("smartmap fetch failed");
            return await resp.json(); // { "UZ5411_P":"6.64", ... }
        } finally { clearTimeout(t); }
    }

    function readPvFromMap(map, baseKey) {
        if (!map || !baseKey) return null;
        const s = map[baseKey + "_P"];
        if (s === null || s === undefined || s === "") return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    }

    // ---------------------------
    // Chart.js helpers (overlay into existing chart)
    // ---------------------------
    function getChartInstance(canvas) {
        if (!canvas) return null;
        // BBTrendPTC uses canvas._bbChart
        if (canvas._bbChart) return canvas._bbChart;
        // fallback
        if (window.Chart?.getChart) return window.Chart.getChart(canvas);
        return null;
    }


    // หา dataset สำหรับ overlay (ถ้ายังไม่มีให้สร้างใหม่)
    function ensureOverlayDataset(chart, overlayKey) {
        const id = "__smartmap_overlay__" + overlayKey;
        const list = chart.data.datasets || (chart.data.datasets = []);
        let ds = list.find(x => x && x._id === id);
        if (!ds) {
            ds = {
                _id: id,
                label: "PV",
                data: [],
                parsing: false,

                // 🔥 เส้นหนาขึ้น
                borderWidth: 4,
                borderColor: "rgba(255,255,255,.95)",

                tension: 0,

                // 🔥 จุดทั่วไปเล็กนิด
                pointRadius: 2,
                pointBackgroundColor: "rgba(255,255,255,1)",
                pointBorderWidth: 0,

                // 🔥 จุดล่าสุดใหญ่
                pointRadius: (ctx) => {
                    const i = ctx.dataIndex;
                    const lastIndex = ctx.dataset.data.length - 1;
                    return i === lastIndex ? 8 : 2;
                },

                pointBackgroundColor: (ctx) => {
                    const i = ctx.dataIndex;
                    const lastIndex = ctx.dataset.data.length - 1;
                    return i === lastIndex
                        ? "rgba(51,209,255,1)"   // จุดล่าสุดสีฟ้า
                        : "rgba(255,255,255,1)";
                },

                pointBorderColor: "rgba(0,0,0,.4)",
                pointBorderWidth: 2
            };
            list.push(ds);
        }
        return ds;
    }

    // 30s rule + 30min window (เหมือน DPS overlay)
    function createState() { return { persistent: [], transient: null }; }
    const stateByCanvasId = new Map();
    function getStateForCanvasId(id) {
        let st = stateByCanvasId.get(id);
        if (!st) { st = createState(); stateByCanvasId.set(id, st); }
        return st;
    }
    function applyPoint30sRule(st, xMs, y, windowMs) {
        const last = st.persistent.length ? st.persistent[st.persistent.length - 1] : null;
        if (!last) {
            st.persistent.push({ x: xMs, y });
            st.transient = null;
        } else {
            const dt = xMs - last.x;
            if (dt >= 30000) {
                if (st.transient) st.persistent.push(st.transient);
                st.persistent.push({ x: xMs, y });
                st.transient = null;
            } else {
                st.transient = { x: xMs, y };
            }
        }
        const cutoff = xMs - windowMs;
        st.persistent = st.persistent.filter(p => p.x >= cutoff);
        if (st.transient && st.transient.x < cutoff) st.transient = null;
    }
    function buildData(st) {
        const arr = st.persistent.slice();
        if (st.transient) arr.push(st.transient);
        arr.sort((a, b) => a.x - b.x);
        return arr;
    }

    function safeUpdateChart(chart) {
        requestAnimationFrame(() => { try { chart.update(); } catch { } });
    }

    // ---------------------------
    // bind section (Settings button)
    // ---------------------------
    function bindSection(sec) {
        if (!sec || boundSections.has(sec)) return;
        boundSections.add(sec);

        const popup = ensurePopup();
        const inpOverlay = popup.querySelector('select[data-k="refreshSec"]');
        const inpSeries = popup.querySelector('select[data-k="seriesRefreshSec"]');
        const inpAlertEnabled = popup.querySelector('[data-k="alertEnabled"]');
        const inpAlertMuted = popup.querySelector('[data-k="alertMuted"]');

        const closePop = () => popup.classList.remove("on");
        popup.querySelector(".x").onclick = closePop;
        popup.querySelector('[data-act="close"]').onclick = closePop;

        const btnSettings = sec.querySelector("#btnSettings");
        if (btnSettings) {
            btnSettings.style.pointerEvents = "auto";
            btnSettings.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();

                const s = loadSettings();

                inpOverlay.value = String(Math.max(5, Math.min(60, Number(s.refreshSec || 10))));

                const allowedSeries = ["10800", "21600", "32400", "43200"];
                const rawSeries = String(s.seriesRefreshSec || "10800");

                inpSeries.value = allowedSeries.includes(rawSeries) ? rawSeries : "10800";
                inpAlertEnabled.checked = !!s.alertEnabled;
                inpAlertMuted.checked = !!s.alertMuted;

                popup.classList.add("on");
            });
        }

        const bell = sec.querySelector('[data-role="ptc-alert-bell"]');
        if (bell && bell.dataset.bound !== "true") {
            bell.dataset.bound = "true";
            bell.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.BBAlerts?.armAudio?.();
                const s = loadSettings();
                const wasMuted = s.alertMuted;
                s.alertMuted = !s.alertMuted;
                saveSettings(s);
                if (!wasMuted && s.alertMuted) {
                    window.BBAlerts?.resetRule?.(sec, "ptc-current-out-of-control");
                }
                syncBell(sec);
            });
        }

        popup.querySelector('[data-act="apply"]').onclick = () => {
            const n1 = Math.max(5, Math.min(60, Number(inpOverlay.value || 10)));
            const n2 = Number(inpSeries.value || 10800);
            const current = loadSettings();

            saveSettings({
                refreshSec: n1,
                seriesRefreshSec: n2,
                alertEnabled: inpAlertEnabled.checked,
                alertMuted: inpAlertMuted.checked
            });

            closePop();

            if (inpAlertMuted.checked && !current.alertMuted) {
                window.BBAlerts?.resetRule?.(sec, "ptc-current-out-of-control");
                syncBell(sec);
            }

            restartPoller();
            tickAll();

            if (window.BBTrendPTC?.restartSeriesPoller) {
                window.BBTrendPTC.restartSeriesPoller();
            }
            if (window.BBTrendPTC?.refreshAllSeriesNow) {
                window.BBTrendPTC.refreshAllSeriesNow();
            }
        };

        syncBell(sec);
    }

    function interpDatasetAtNow(dataset) {
        const data = Array.isArray(dataset?.data) ? dataset.data : [];
        if (!data.length) return null;

        const nowMs = Date.now();
        let left = null;
        let right = null;

        for (const p of data) {
            const xMs = new Date(p?.x).getTime();
            const y = Number(p?.y);
            if (!Number.isFinite(xMs) || !Number.isFinite(y)) continue;

            if (xMs <= nowMs) left = { xMs, y };
            if (xMs >= nowMs) {
                right = { xMs, y };
                break;
            }
        }

        if (!left && !right) return null;
        if (!left) return right.y;
        if (!right) return left.y;
        if (left.xMs === right.xMs) return left.y;

        const k = (nowMs - left.xMs) / (right.xMs - left.xMs);
        return left.y + ((right.y - left.y) * k);
    }

    function getBoundsAtNow(canvas) {
        const chart = getChartInstance(canvas);
        const upper = interpDatasetAtNow(chart?.data?.datasets?.[0]);
        const lower = interpDatasetAtNow(chart?.data?.datasets?.[1]);
        if (!Number.isFinite(upper) || !Number.isFinite(lower)) return null;
        return upper >= lower ? { upper, lower } : { upper: lower, lower: upper };
    }

    // ---------------------------
    // poller (single)
    // ---------------------------
    function restartPoller() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;

        const s = loadSettings();
        pollMs = Math.max(5000, Math.min(60000, Number(s.refreshSec || 10) * 1000));

        pollTimer = setInterval(() => tickAll(), pollMs);
    }

    // ---------------------------
    // tick: 1 request, batch keys, overlay PV
    // ---------------------------
    async function tickAll() {
        if (inFlight) return;
        inFlight = true;

        try {
            const secs = document.querySelectorAll("section.ptc-block");
            if (!secs.length) return;

            const targets = [];
            const bases = [];

            for (const sec of secs) {
                bindSection(sec);

                // กราฟ PTC ของคุณเป็น canvas.bb-trend-chart-ptc อยู่แล้ว
                const canvases = sec.querySelectorAll("canvas.bb-trend-chart-ptc");
                for (const cv of canvases) {
                    // อ่าน key จาก dropdown (data-select) ก่อน
                    let keyRaw = "";
                    const selId = (cv.getAttribute("data-select") || "").trim();
                    const sel = selId ? document.getElementById(selId) : null;
                    if (sel) keyRaw = sel.value;

                    // fallback: data-code / data-default
                    if (!keyRaw) keyRaw = (cv.getAttribute("data-code") || cv.getAttribute("data-default") || "").trim();

                    const base = normalizeBaseKey(keyRaw);
                    if (!base) continue;

                    const cid = cv.id || ("ptc_" + base);
                    targets.push({ base, canvas: cv, canvasId: cid });
                    bases.push(base);
                }
            }

            if (!targets.length) return;

            const uniqBases = Array.from(new Set(bases));
            let map;
            try {
                map = await fetchSmartmapBatchAsync(uniqBases.join(","));
            } catch {
                return;
            }

            const x = Date.now();
            const winMs = 30 * 60 * 1000;
            const sectionAlarm = new Map();

            for (const t of targets) {
                const pv = readPvFromMap(map, t.base);
                if (pv === null) continue;

                const sec = t.canvas.closest("section.ptc-block");

                // ✅ เพิ่มตรงนี้: Latest HH:MM:SS | value
                // (upper/lower ไม่เอา -> ส่ง null ไปเลย)
                if (typeof setLatest === "function") {
                    setLatest(t.canvas, fmtHHMMSS(x), null, null, pv);
                }

                const chart = getChartInstance(t.canvas);
                if (!chart) continue; // ถ้า BBTrendPTC ยังไม่สร้าง chart

                const ds = ensureOverlayDataset(chart, t.canvasId);
                const st = getStateForCanvasId(t.canvasId);

                applyPoint30sRule(st, x, pv, winMs);
                ds.data = buildData(st);

                safeUpdateChart(chart);

                const bounds = getBoundsAtNow(t.canvas);
                if (sec && bounds) {
                    const outOfControl = pv > bounds.upper || pv < bounds.lower;
                    if (outOfControl) sectionAlarm.set(sec, true);
                    else if (!sectionAlarm.has(sec)) sectionAlarm.set(sec, false);
                }
            }

            for (const sec of secs) {
                const settings = loadSettings();
                const bell = sec.querySelector('[data-role="ptc-alert-bell"]');
                const exceeded = window.BBAlerts?.evaluate?.(sec, {
                    ruleKey: "ptc-current-out-of-control",
                    enabled: settings.alertEnabled,
                    muted: settings.alertMuted,
                    value: sectionAlarm.get(sec) ? 1 : 0,
                    limit: 0.5,
                    direction: "gt"
                }) || false;

                window.BBAlerts?.setBellState?.(bell, exceeded ? "alerting" : (settings.alertMuted ? "muted" : "armed"));
            }
        } finally {
            inFlight = false;
        }
    }

    // ---------------------------
    // public
    // ---------------------------
    function initWithin(root) {
        const scope = root || document;
        const secs = scope.querySelectorAll("section.ptc-block");
        secs.forEach(bindSection);

        if (!pollTimer) restartPoller();
        tickAll();
    }

    function setLatest(canvas, hhmmss, upper, lower, value) {
        const latestId = canvas.getAttribute("data-latest");

        const tText = hhmmss ? `<b>${hhmmss}</b>` : `<b>--:--:--</b>`;
        const vText = (value != null) ? `<b>${value.toFixed(2)}</b>` : `<b>--</b>`;

        const html = `Latest ${tText} | ${vText}`;

        if (latestId) {
            const el = document.getElementById(latestId);
            if (el) el.innerHTML = html;
        }

        // overlay บนกราฟ (plugin latestText ใช้อันนี้)
        canvas._bbLatestText =
            (hhmmss && value != null)
                ? `${hhmmss}  ${value.toFixed(2)}`
                : "";
    }


    function pad2(n) { return String(n).padStart(2, "0"); }
    function fmtHHMMSS(ms) {
        const d = new Date(ms);
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }


    window.PTCSmartmapOverlay = { initWithin, tickAll, restartPoller, loadSettings, saveSettings, syncBell };
})();
