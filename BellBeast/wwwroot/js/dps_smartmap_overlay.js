(function () {
    "use strict";

    // ============================
    // DPS Smartmap Overlay (single poller)
    // - point overlay refresh: 5..300 sec
    // - OnlineLab refresh: 300..900 sec (stored in same popup/settings)
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
    const STORAGE_KEY = "dps_ptc_refresh_v1"; // keep key for backward compatibility

    // defaults / limits
    const DEFAULT_DPS_REFRESH_SEC = 15;
    const MIN_DPS_REFRESH_SEC = 5;
    const MAX_DPS_REFRESH_SEC = 60;
    const DEFAULT_POINT_REFRESH_SEC = 10;
    const DEFAULT_ONLINELAB_REFRESH_SEC = 300;
    const MIN_POINT_REFRESH_SEC = 5;
    const MAX_POINT_REFRESH_SEC = 300;
    const MIN_ONLINELAB_REFRESH_SEC = 300;
    const MAX_ONLINELAB_REFRESH_SEC = 900;

    // section bind guard + poller guard
    const boundSections = new WeakSet();
    let pollTimer = null;
    let pollMs = DEFAULT_POINT_REFRESH_SEC * 1000;
    let inFlight = false;

    // ---------------------------
    // settings (localStorage)
    // supports old shape:
    //   { refreshSec }
    //   { rate1, rate2 }
    // new shape:
    //   { pointRefreshSec, onlineLabRefreshSec }
    // ---------------------------
    function clamp(n, min, max, fallback) {
        const x = Number(n);
        if (!Number.isFinite(x)) return fallback;
        return Math.max(min, Math.min(max, x));
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return {
                    dpsRefreshSec: DEFAULT_DPS_REFRESH_SEC,
                    pointRefreshSec: DEFAULT_POINT_REFRESH_SEC,
                    onlineLabRefreshSec: DEFAULT_ONLINELAB_REFRESH_SEC
                };
            }

            const o = JSON.parse(raw);

            if (o && (
                o.dpsRefreshSec !== undefined ||
                o.pointRefreshSec !== undefined ||
                o.onlineLabRefreshSec !== undefined
            )) {
                return {
                    dpsRefreshSec: clamp(
                        o.dpsRefreshSec,
                        MIN_DPS_REFRESH_SEC,
                        MAX_DPS_REFRESH_SEC,
                        DEFAULT_DPS_REFRESH_SEC
                    ),
                    pointRefreshSec: clamp(
                        o.pointRefreshSec,
                        MIN_POINT_REFRESH_SEC,
                        MAX_POINT_REFRESH_SEC,
                        DEFAULT_POINT_REFRESH_SEC
                    ),
                    onlineLabRefreshSec: clamp(
                        o.onlineLabRefreshSec,
                        MIN_ONLINELAB_REFRESH_SEC,
                        MAX_ONLINELAB_REFRESH_SEC,
                        DEFAULT_ONLINELAB_REFRESH_SEC
                    )
                };
            }

            // old format compatibility
            const r = Number(o && o.refreshSec);
            if (Number.isFinite(r) && r > 0) {
                return {
                    dpsRefreshSec: DEFAULT_DPS_REFRESH_SEC,
                    pointRefreshSec: clamp(
                        r,
                        MIN_POINT_REFRESH_SEC,
                        MAX_POINT_REFRESH_SEC,
                        DEFAULT_POINT_REFRESH_SEC
                    ),
                    onlineLabRefreshSec: DEFAULT_ONLINELAB_REFRESH_SEC
                };
            }

            return {
                dpsRefreshSec: DEFAULT_DPS_REFRESH_SEC,
                pointRefreshSec: DEFAULT_POINT_REFRESH_SEC,
                onlineLabRefreshSec: DEFAULT_ONLINELAB_REFRESH_SEC
            };
        } catch {
            return {
                dpsRefreshSec: DEFAULT_DPS_REFRESH_SEC,
                pointRefreshSec: DEFAULT_POINT_REFRESH_SEC,
                onlineLabRefreshSec: DEFAULT_ONLINELAB_REFRESH_SEC
            };
        }
    }

    function saveSettings(s) {
        const dpsRefreshSec = clamp(
            s && s.dpsRefreshSec,
            MIN_DPS_REFRESH_SEC,
            MAX_DPS_REFRESH_SEC,
            DEFAULT_DPS_REFRESH_SEC
        );

        const pointRefreshSec = clamp(
            s && s.pointRefreshSec,
            MIN_POINT_REFRESH_SEC,
            MAX_POINT_REFRESH_SEC,
            DEFAULT_POINT_REFRESH_SEC
        );

        const onlineLabRefreshSec = clamp(
            s && s.onlineLabRefreshSec,
            MIN_ONLINELAB_REFRESH_SEC,
            MAX_ONLINELAB_REFRESH_SEC,
            DEFAULT_ONLINELAB_REFRESH_SEC
        );

        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            dpsRefreshSec,
            pointRefreshSec,
            onlineLabRefreshSec
        }));
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
                <div class="k">DPS data refresh interval (sec)</div>
                <select class="inp" data-k="dpsRefreshSec">
                  <option value="5">5</option>
                  <option value="10">10</option>
                  <option value="15">15</option>
                  <option value="20">20</option>
                  <option value="30">30</option>
                  <option value="45">45</option>
                  <option value="60">60</option>
                </select>
              </div>

              <div class="row">
                <div class="k">Pressure Trend Curve Refresh rate (sec)</div>
                <select class="inp" data-k="pointRefreshSec">
                  <option value="5">5</option>
                  <option value="10">10</option>
                  <option value="15">15</option>
                  <option value="30">30</option>
                  <option value="60">60</option>
                  <option value="120">120</option>
                  <option value="180">180</option>
                  <option value="240">240</option>
                  <option value="300">300</option>
                </select>
              </div>

              <div class="row">
                <div class="k">OnlineLab Refresh rate (sec)</div>
                <select class="inp" data-k="onlineLabRefreshSec">
                  <option value="300">300</option>
                  <option value="360">360</option>
                  <option value="420">420</option>
                  <option value="480">480</option>
                  <option value="600">600</option>
                  <option value="720">720</option>
                  <option value="900">900</option>
                </select>
              </div>

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
      .dps-pop-card{width:min(460px,92vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55);color:rgba(255,255,255,.92)}
      .dps-pop-h{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10)}
      .dps-pop-h .t{font-weight:700}
      .dps-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.9);font-size:16px;cursor:pointer}
      .dps-pop-b{padding:12px 14px}
      .dps-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0}
      .dps-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
      .dps-pop-b .inp{width:140px;background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
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
        const inpDps = popup.querySelector('[data-k="dpsRefreshSec"]');
        const inpPoint = popup.querySelector('[data-k="pointRefreshSec"]');
        const inpOnlineLab = popup.querySelector('[data-k="onlineLabRefreshSec"]');
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
                inpDps.value = String(s.dpsRefreshSec);
                inpPoint.value = String(s.pointRefreshSec);
                inpOnlineLab.value = String(s.onlineLabRefreshSec);
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
            const dpsRefreshSec = clamp(
                inpDps.value,
                MIN_DPS_REFRESH_SEC,
                MAX_DPS_REFRESH_SEC,
                DEFAULT_DPS_REFRESH_SEC
            );

            const pointRefreshSec = clamp(
                inpPoint.value,
                MIN_POINT_REFRESH_SEC,
                MAX_POINT_REFRESH_SEC,
                DEFAULT_POINT_REFRESH_SEC
            );

            const onlineLabRefreshSec = clamp(
                inpOnlineLab.value,
                MIN_ONLINELAB_REFRESH_SEC,
                MAX_ONLINELAB_REFRESH_SEC,
                DEFAULT_ONLINELAB_REFRESH_SEC
            );

            saveSettings({ dpsRefreshSec, pointRefreshSec, onlineLabRefreshSec });
            closePop();

            restartPoller();
            tickAll();

            if (window.DPSSummary && typeof window.DPSSummary.restartWithin === "function") {
                window.DPSSummary.restartWithin(document);
            }

            if (window.DPSView && typeof window.DPSView.restartWithin === "function") {
                window.DPSView.restartWithin(document);
            }
        };
    }

    // ---------------------------
    // safe chart update (avoid recursion re-enter)
    // ---------------------------
    function safeUpdateChart(chart) {
        requestAnimationFrame(() => {
            try { chart.update(); } catch { }
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
        pollMs = Math.max(
            MIN_POINT_REFRESH_SEC * 1000,
            Math.min(MAX_POINT_REFRESH_SEC * 1000, Number(s.pointRefreshSec || DEFAULT_POINT_REFRESH_SEC) * 1000)
        );

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