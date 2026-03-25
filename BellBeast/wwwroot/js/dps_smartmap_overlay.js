(function () {
    "use strict";

    // ============================
    // DPS Smartmap Overlay (single poller)
    // - 1 setting only (refreshSec) applies to both charts
    // - 1 interval only for the whole page (no per-chart / per-section timers)
    // - 1 request per tick (batched keys for both charts + all injected DPS sections)
    // - read `${base}_P` from /api/smartmap and plot to:
    //    sel#dpsTrendSel1 -> canvas#dpsTrend1
    //    sel#dpsTrendSel2 -> canvas#dpsTrend2
    //
    // IMPORTANT:
    // - DO NOT touch chart.options/scales/ticks callbacks here (causes recursion in some setups)
    // ============================

    const SMARTMAP_URL = "/api/smartmap";
    const STORAGE_KEY = "dps_ptc_refresh_v1"; // keep key (migrate from rate1/rate2 -> refreshSec)

    // section bind guard + poller guard
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
            if (!raw) return { refreshSec: 10 };

            const o = JSON.parse(raw);

            // new format
            const r = Number(o.refreshSec);
            if (Number.isFinite(r) && r > 0) return { refreshSec: r };

            // migrate old {rate1, rate2}
            const a = Number(o.rate1);
            const b = Number(o.rate2);
            const migrated = Math.max(
                Number.isFinite(a) ? a : 10,
                Number.isFinite(b) ? b : 10,
                10
            );
            return { refreshSec: migrated };
        } catch {
            return { refreshSec: 10 };
        }
    }

    function saveSettings(s) {
        const sec = Number(s.refreshSec) || 10;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ refreshSec: sec }));
    }

    // ---------------------------
    // popup (create once)
    // ---------------------------
    function ensurePopup() {
        let el = document.querySelector(".dps-settings-pop");
        if (el) return el;

        el = document.createElement("div");
        el.className = "dps-settings-pop";
        el.innerHTML = `
      <div class="dps-pop-card">
        <div class="dps-pop-h">
          <div class="t">DPS Trend Settings</div>
          <button class="x" type="button" aria-label="Close">✕</button>
        </div>
        <div class="dps-pop-b">
          <div class="row">
            <div class="k">Refresh (sec) — applies to both trends</div>
            <input class="inp" type="number" min="5" max="300" step="1" data-k="refreshSec">
          </div>
          <div class="hint">* 1 tick = 1 request (batched keys), window 30 นาที</div>
          <div class="actions">
            <button class="btn" data-act="apply" type="button">Apply</button>
            <button class="btn ghost" data-act="close" type="button">Close</button>
          </div>
        </div>
      </div>
    `;
        document.body.appendChild(el);

        const st = document.createElement("style");
        st.textContent = `
      .dps-settings-pop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:999999}
      .dps-settings-pop.on{display:flex}
      .dps-pop-card{width:min(420px,92vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55);color:rgba(255,255,255,.92)}
      .dps-pop-h{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10)}
      .dps-pop-h .t{font-weight:700}
      .dps-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.9);font-size:16px;cursor:pointer}
      .dps-pop-b{padding:12px 14px}
      .dps-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0}
      .dps-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
      .dps-pop-b .inp{width:120px;background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
      .dps-pop-b .hint{margin-top:8px;font-size:12px;color:rgba(255,255,255,.60)}
      .dps-pop-b .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}
      .dps-pop-b .btn{background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 12px;cursor:pointer}
      .dps-pop-b .btn.ghost{opacity:.85}
    `;
        document.head.appendChild(st);

        // click outside closes
        el.addEventListener("click", (e) => {
            if (e.target === el) el.classList.remove("on");
        });

        return el;
    }

    // ---------------------------
    // time
    // ---------------------------
    const nowMs = () => Date.now();

    // ---------------------------
    // normalize dropdown value -> base key
    // Accepts: UZ5411_P, UZ5411P, UZ5411  -> base: UZ5411
    // ---------------------------
    function normalizeSmartmapBaseKey(raw) {
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
    // smartmap fetch (batch)
    // ---------------------------
    async function fetchSmartmapBatchAsync(baseKeysCsv, timeoutMs = 10000) {
        const url = `${SMARTMAP_URL}?keys=${encodeURIComponent(baseKeysCsv)}`;

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        try {
            const resp = await fetch(url, {
                method: "GET",
                signal: ac.signal,
                cache: "no-store",
                credentials: "omit",
            });
            if (!resp.ok) throw new Error("smartmap fetch failed");
            return await resp.json(); // { "UZ5411_P":"6.64", ... }
        } finally {
            clearTimeout(t);
        }
    }

    function readPvFromMap(map, baseKey) {
        if (!map || !baseKey) return null;
        const s = map[baseKey + "_P"];
        if (s === null || s === undefined || s === "") return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    }

    // ---------------------------
    // Chart.js helpers (NO touching scales/ticks/options callbacks)
    // ---------------------------
    function getChartInstance(canvas) {
        if (!canvas) return null;
        if (canvas._chart) return canvas._chart;
        if (canvas.__chart) return canvas.__chart;
        if (window.Chart?.getChart) return window.Chart.getChart(canvas);
        return null;
    }

    function ensureOverlayDataset(chart, overlayKey) {
        const id = "__smartmap_overlay__" + overlayKey;
        const ds0 = (chart.data.datasets || []).find((ds) => ds && ds._overlayId === id);
        if (ds0) return ds0;

        const ds = {
            _overlayId: id,
            label: "smartmap",
            data: [],
            // NOTE: do NOT force parsing/ticks options here (may trigger recursion in your plugin chain)
            normalized: true,
            spanGaps: true,

            borderColor: "rgba(255,255,255,0.95)",
            backgroundColor: "rgba(255,255,255,0.95)",
            pointBorderColor: "rgba(255,255,255,0.95)",
            pointBackgroundColor: "rgba(255,255,255,0.95)",
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 3,
            showLine: true,
            tension: 0,
        };

        chart.data.datasets = chart.data.datasets || [];
        chart.data.datasets.push(ds);

        // do NOT touch chart.options.* here
        // chart.update will render new dataset
        return ds;
    }

    // ---------------------------
    // state: 30s boundary + transient point within bucket, window 30min
    // ---------------------------
    function createState() {
        return { persistent: [], transient: null, lastBucket: null };
    }

    function applyPoint30sRule(st, xMs, y, windowMs) {
        const bucket = Math.floor(xMs / 30000) * 30000;

        if (st.lastBucket === null) st.lastBucket = bucket;
        if (bucket !== st.lastBucket) {
            st.transient = null;
            st.lastBucket = bucket;
        }

        const atBoundary = xMs % 30000 === 0;
        if (atBoundary) {
            st.persistent.push({ x: xMs, y });
            st.transient = null;
        } else {
            st.transient = { x: xMs, y };
        }

        const cutoff = xMs - windowMs;
        st.persistent = st.persistent.filter((p) => p.x >= cutoff);
        if (st.transient && st.transient.x < cutoff) st.transient = null;
    }

    function buildData(st) {
        const arr = st.persistent.slice();
        if (st.transient) arr.push(st.transient);
        arr.sort((a, b) => a.x - b.x);
        return arr;
    }

    // State storage per canvas id (keeps history)
    const stateByCanvasId = new Map();
    function getStateForCanvasId(id) {
        let st = stateByCanvasId.get(id);
        if (!st) {
            st = createState();
            stateByCanvasId.set(id, st);
        }
        return st;
    }

    // ---------------------------
    // per-section binding (NO timers here)
    // ---------------------------
    function bindSection(sec) {
        if (!sec || boundSections.has(sec)) return;
        boundSections.add(sec);

        const popup = ensurePopup();
        const inp = popup.querySelector('input[data-k="refreshSec"]');
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
                inp.value = Math.max(5, Math.min(300, Number(s.refreshSec || 10)));
                popup.classList.add("on");
            });
        }

        // when select changes: tick once immediately (debounced)
        let t1 = null, t2 = null;

        const sel1 = sec.querySelector("#dpsTrendSel1");
        if (sel1) {
            sel1.addEventListener("change", () => {
                if (t1) clearTimeout(t1);
                t1 = setTimeout(() => tickAll(), 50);
            });
        }

        const sel2 = sec.querySelector("#dpsTrendSel2");
        if (sel2) {
            sel2.addEventListener("change", () => {
                if (t2) clearTimeout(t2);
                t2 = setTimeout(() => tickAll(), 50);
            });
        }

        popup.querySelector('[data-act="apply"]').onclick = () => {
            const n = Math.max(5, Math.min(300, Number(inp.value || 10)));
            saveSettings({ refreshSec: n });
            closePop();
            restartPoller();
            tickAll();
        };
    }

    // ---------------------------
    // safe chart update (avoid recursion re-enter)
    // ---------------------------
    function safeUpdateChart(chart) {
        // defer update out of current stack -> reduces chance of plugin recursion
        requestAnimationFrame(() => {
            try { chart.update(); } catch { /* ignore */ }
        });
    }

    // ---------------------------
    // tick (single request, batch keys, plot to dpsTrend1/dpsTrend2)
    // ---------------------------
    async function tickAll() {
        if (inFlight) return;
        inFlight = true;

        try {
            const secs = document.querySelectorAll("section.dps-block");
            if (!secs.length) return;

            const targets = [];
            const bases = [];

            for (const sec of secs) {
                bindSection(sec);

                const sel1 = sec.querySelector("#dpsTrendSel1");
                const sel2 = sec.querySelector("#dpsTrendSel2");
                const cvs1 = sec.querySelector("#dpsTrend1");
                const cvs2 = sec.querySelector("#dpsTrend2");

                if (sel1 && cvs1) {
                    const base = normalizeSmartmapBaseKey(sel1.value);
                    if (base) {
                        targets.push({ base, canvas: cvs1, canvasId: cvs1.id || "dpsTrend1" });
                        bases.push(base);
                    }
                }

                if (sel2 && cvs2) {
                    const base = normalizeSmartmapBaseKey(sel2.value);
                    if (base) {
                        targets.push({ base, canvas: cvs2, canvasId: cvs2.id || "dpsTrend2" });
                        bases.push(base);
                    }
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

            const x = nowMs();
            const winMs = 30 * 60 * 1000;

            for (const t of targets) {
                const pv = readPvFromMap(map, t.base);
                if (pv === null) continue;

                const chart = getChartInstance(t.canvas);
                if (!chart) continue;

                const ds = ensureOverlayDataset(chart, t.canvasId);
                const st = getStateForCanvasId(t.canvasId);

                applyPoint30sRule(st, x, pv, winMs);
                ds.data = buildData(st);

                safeUpdateChart(chart);
            }
        } finally {
            inFlight = false;
        }
    }

    // ---------------------------
    // poller (single)
    // ---------------------------
    function restartPoller() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;

        const s = loadSettings();
        pollMs = Math.max(5000, Math.min(300000, Number(s.refreshSec || 10) * 1000));

        pollTimer = setInterval(() => tickAll(), pollMs);
    }

    // ---------------------------
    // public API
    // ---------------------------
    function initWithin(root) {
        const scope = root || document;
        const secs = scope.querySelectorAll("section.dps-block");
        secs.forEach(bindSection);

        if (!pollTimer) restartPoller();
        tickAll();
    }

    window.DPSSmartmapOverlay = { initWithin, tickAll, restartPoller };
})();