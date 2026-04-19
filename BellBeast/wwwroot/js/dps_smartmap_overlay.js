(function () {
    "use strict";

    const SMARTMAP_URL = "/api/smartmap";
    const STORAGE_KEY = "dps_ptc_refresh_v1";

    const DEFAULT_UPPERLOWER_REFRESH_SEC = 10800;
    const VALID_UPPERLOWER_REFRESH_SEC = [10800, 21600, 32400, 43200];

    const DEFAULT_DPS_REFRESH_SEC = 15;
    const MIN_DPS_REFRESH_SEC = 5;
    const MAX_DPS_REFRESH_SEC = 60;

    const DEFAULT_POINT_REFRESH_SEC = 10;
    const MIN_POINT_REFRESH_SEC = 5;
    const MAX_POINT_REFRESH_SEC = 300;

    const DEFAULT_ONLINELAB_REFRESH_SEC = 300;
    const MIN_ONLINELAB_REFRESH_SEC = 300;
    const MAX_ONLINELAB_REFRESH_SEC = 900;

    const DEFAULT_FLOW_LOW_LIMIT = 1000;
    const DEFAULT_AIR_SUM_LOW_LIMIT = 1.0;

    const boundSections = new WeakSet();
    let pollTimer = null;
    let pollMs = DEFAULT_POINT_REFRESH_SEC * 1000;
    let inFlight = false;

    function clamp(n, min, max, fallback) {
        const x = Number(n);
        if (!Number.isFinite(x)) return fallback;
        return Math.max(min, Math.min(max, x));
    }

    function defaultSettings() {
        return {
            refreshSec: DEFAULT_DPS_REFRESH_SEC,
            dpsRefreshSec: DEFAULT_DPS_REFRESH_SEC,
            pointRefreshSec: DEFAULT_POINT_REFRESH_SEC,
            onlineLabRefreshSec: DEFAULT_ONLINELAB_REFRESH_SEC,
            upperLowerRefreshSec: DEFAULT_UPPERLOWER_REFRESH_SEC,

            alertEnabled: false,
            alertMuted: false,

            flowAlertEnabled: false,
            flowLowLimit: DEFAULT_FLOW_LOW_LIMIT,
            flowAlertLimit: DEFAULT_FLOW_LOW_LIMIT,

            airSumAlertEnabled: false,
            airSumLowLimit: DEFAULT_AIR_SUM_LOW_LIMIT
        };
    }

    function normalizeSettings(o) {
        const rawUpper = Number(o?.upperLowerRefreshSec);
        const dpsRefreshSec = clamp(
            o?.dpsRefreshSec ?? o?.refreshSec,
            MIN_DPS_REFRESH_SEC,
            MAX_DPS_REFRESH_SEC,
            DEFAULT_DPS_REFRESH_SEC
        );

        const flowLowLimit = clamp(
            o?.flowLowLimit ?? o?.flowAlertLimit,
            0,
            999999,
            DEFAULT_FLOW_LOW_LIMIT
        );

        return {
            refreshSec: dpsRefreshSec,
            dpsRefreshSec,

            pointRefreshSec: clamp(
                o?.pointRefreshSec ?? o?.refreshSec,
                MIN_POINT_REFRESH_SEC,
                MAX_POINT_REFRESH_SEC,
                DEFAULT_POINT_REFRESH_SEC
            ),

            onlineLabRefreshSec: clamp(
                o?.onlineLabRefreshSec,
                MIN_ONLINELAB_REFRESH_SEC,
                MAX_ONLINELAB_REFRESH_SEC,
                DEFAULT_ONLINELAB_REFRESH_SEC
            ),

            upperLowerRefreshSec: VALID_UPPERLOWER_REFRESH_SEC.includes(rawUpper)
                ? rawUpper
                : DEFAULT_UPPERLOWER_REFRESH_SEC,

            alertEnabled: Boolean(o?.alertEnabled),
            alertMuted: Boolean(o?.alertMuted),

            flowAlertEnabled: Boolean(o?.flowAlertEnabled),
            flowLowLimit,
            flowAlertLimit: flowLowLimit,

            airSumAlertEnabled: Boolean(o?.airSumAlertEnabled),
            airSumLowLimit: clamp(
                o?.airSumLowLimit,
                0,
                999999,
                DEFAULT_AIR_SUM_LOW_LIMIT
            )
        };
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return defaultSettings();

            const o = JSON.parse(raw);
            return normalizeSettings(o || {});
        } catch {
            return defaultSettings();
        }
    }

    function saveSettings(s) {
        const normalized = normalizeSettings(s || {});
        localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    }

    function syncBell(sec) {
        if (!sec) return;
        const bell = sec.querySelector('[data-role="dps-alert-bell"]');
        const s = loadSettings();
        window.BBAlerts?.setBellState?.(bell, s.alertMuted ? "muted" : "armed");
    }

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
      <div class="k">DPS data refresh interval</div>
      <select class="inp" data-k="dpsRefreshSec">
        <option value="5">5 seconds</option>
        <option value="10">10 seconds</option>
        <option value="15">15 seconds</option>
        <option value="20">20 seconds</option>
        <option value="30">30 seconds</option>
        <option value="45">45 seconds</option>
        <option value="60">60 seconds</option>
      </select>
    </div>

    <div class="row">
      <div class="k">Pressure trend curve refresh</div>
      <select class="inp" data-k="pointRefreshSec">
        <option value="5">5 seconds</option>
        <option value="10">10 seconds</option>
        <option value="15">15 seconds</option>
        <option value="30">30 seconds</option>
        <option value="60">60 seconds</option>
        <option value="120">120 seconds</option>
        <option value="180">180 seconds</option>
        <option value="240">240 seconds</option>
        <option value="300">300 seconds</option>
      </select>
    </div>

    <div class="row">
      <div class="k">OnlineLab refresh</div>
      <select class="inp" data-k="onlineLabRefreshSec">
        <option value="300">300 seconds</option>
        <option value="360">360 seconds</option>
        <option value="420">420 seconds</option>
        <option value="480">480 seconds</option>
        <option value="600">600 seconds</option>
        <option value="720">720 seconds</option>
        <option value="900">900 seconds</option>
      </select>
    </div>

    <div class="row">
      <div class="k">Upper/Lower limit refresh</div>
      <select class="inp" data-k="upperLowerRefreshSec">
        <option value="10800">3 hours</option>
        <option value="21600">6 hours</option>
        <option value="32400">9 hours</option>
        <option value="43200">12 hours</option>
      </select>
    </div>

    <div class="section-label">Alarm Rules</div>

    <div class="alarm-card">
      <div class="alarm-head">
        <div>
          <div class="alarm-title">DPS Flow Alert</div>
          <div class="alarm-sub">Alarm when DPS flow is too low</div>
        </div>
        <label class="toggle">
          <input type="checkbox" data-k="flowAlertEnabled">
          <span>On</span>
        </label>
      </div>

      <div class="rule-box low single">
        <div class="rule-k">Low flow</div>
        <div class="rule-line">
          <span class="op">Less than</span>
          <input class="inp mini" data-k="flowLowLimit" type="number" min="0" max="999999" step="1">
          <span class="unit">m³/h</span>
        </div>
      </div>
    </div>

    <div class="alarm-card">
      <div class="alarm-head">
        <div>
          <div class="alarm-title">Air Compressor Sum Alert</div>
          <div class="alarm-sub">Alarm when Air Comp 1 + Air Comp 2 is too low</div>
        </div>
        <label class="toggle">
          <input type="checkbox" data-k="airSumAlertEnabled">
          <span>On</span>
        </label>
      </div>

      <div class="rule-box low single">
        <div class="rule-k">Low air sum</div>
        <div class="rule-line">
          <span class="op">Less than</span>
          <input class="inp mini" data-k="airSumLowLimit" type="number" min="0" max="999999" step="0.1">
          <span class="unit">bar</span>
        </div>
      </div>
    </div>

    <div class="alarm-card">
      <div class="alarm-head">
        <div>
          <div class="alarm-title">Trend Out-of-Control Alarm</div>
          <div class="alarm-sub">Alarm when selected pressure trend is outside upper/lower limits</div>
        </div>
        <label class="toggle">
          <input type="checkbox" data-k="alertEnabled">
          <span>On</span>
        </label>
      </div>
    </div>

    <div class="section-label">Notification</div>

    <div class="row">
      <div class="k">Mute bell sound</div>
      <label class="toggle">
        <input type="checkbox" data-k="alertMuted">
        <span>Muted</span>
      </label>
    </div>

    <div class="actions">
      <button class="btn primary" data-act="apply" type="button">Apply</button>
      <button class="btn ghost" data-act="close" type="button">Close</button>
    </div>
  </div>
</div>
        `;
        document.body.appendChild(el);

        const st = document.createElement("style");
        st.textContent = `
.dps-settings-pop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.58);z-index:999999}
.dps-settings-pop.on{display:flex}
.dps-pop-card{width:min(560px,94vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.58);color:rgba(255,255,255,.92);overflow:hidden}
.dps-pop-h{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.025)}
.dps-pop-h .t{font-weight:800}
.dps-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.88);font-size:17px;cursor:pointer}
.dps-pop-b{padding:14px 16px 16px}
.dps-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0}
.dps-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
.dps-pop-b .inp{width:170px;background:#1f2326;border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
.dps-pop-b .inp:focus{border-color:rgba(88,166,255,.75);box-shadow:0 0 0 3px rgba(88,166,255,.14)}
.dps-pop-b .toggle{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,.92);white-space:nowrap}
.dps-pop-b .section-label{font-size:11px;font-weight:900;color:rgba(255,255,255,.48);letter-spacing:.12em;margin:16px 0 8px;text-transform:uppercase}
.dps-pop-b .alarm-card{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.10);border-radius:15px;padding:13px;margin:10px 0}
.dps-pop-b .alarm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
.dps-pop-b .alarm-title{font-size:14px;font-weight:850;color:rgba(255,255,255,.94)}
.dps-pop-b .alarm-sub{font-size:12px;color:rgba(255,255,255,.52);margin-top:3px}
.dps-pop-b .rule-box{background:rgba(0,0,0,.16);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px}
.dps-pop-b .rule-box.low{border-left:3px solid rgba(76,201,240,.85)}
.dps-pop-b .rule-box.single{margin-top:10px}
.dps-pop-b .rule-k{font-size:12px;font-weight:800;color:rgba(255,255,255,.72);margin-bottom:8px}
.dps-pop-b .rule-line{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px}
.dps-pop-b .op{font-size:12px;color:rgba(255,255,255,.62);white-space:nowrap}
.dps-pop-b .unit{font-size:12px;color:rgba(255,255,255,.58);white-space:nowrap}
.dps-pop-b .inp.mini{width:100%;min-width:0;text-align:right}
.dps-pop-b .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
.dps-pop-b .btn{background:#1f2326;border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.92);border-radius:11px;padding:8px 14px;cursor:pointer;font-weight:750}
.dps-pop-b .btn.primary{background:#20272d;border-color:rgba(255,255,255,.18)}
.dps-pop-b .btn.ghost{opacity:.82}
@media(max-width:540px){
  .dps-pop-b .row{align-items:flex-start;flex-direction:column}
  .dps-pop-b .inp{width:100%}
}
        `;
        document.head.appendChild(st);

        el.addEventListener("click", (e) => {
            if (e.target === el) el.classList.remove("on");
        });

        return el;
    }

    const nowMs = () => Date.now();

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

    async function fetchSmartmapBatchAsync(baseKeysCsv, timeoutMs = 10000) {
        const url = `${SMARTMAP_URL}?keys=${encodeURIComponent(baseKeysCsv)}`;

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);

        try {
            const resp = await fetch(url, {
                method: "GET",
                signal: ac.signal,
                cache: "no-store",
                credentials: "omit"
            });

            if (!resp.ok) throw new Error("smartmap fetch failed");
            return await resp.json();
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
            tension: 0
        };

        chart.data.datasets = chart.data.datasets || [];
        chart.data.datasets.push(ds);
        return ds;
    }

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

    const stateByCanvasId = new Map();

    function getStateForCanvasId(id) {
        let st = stateByCanvasId.get(id);
        if (!st) {
            st = createState();
            stateByCanvasId.set(id, st);
        }
        return st;
    }

    function bindSection(sec) {
        if (!sec || boundSections.has(sec)) return;
        boundSections.add(sec);

        const popup = ensurePopup();

        const inpDps = popup.querySelector('[data-k="dpsRefreshSec"]');
        const inpPoint = popup.querySelector('[data-k="pointRefreshSec"]');
        const inpOnlineLab = popup.querySelector('[data-k="onlineLabRefreshSec"]');
        const inpUpperLower = popup.querySelector('[data-k="upperLowerRefreshSec"]');

        const inpFlowAlertEnabled = popup.querySelector('[data-k="flowAlertEnabled"]');
        const inpFlowLowLimit = popup.querySelector('[data-k="flowLowLimit"]');

        const inpAirSumAlertEnabled = popup.querySelector('[data-k="airSumAlertEnabled"]');
        const inpAirSumLowLimit = popup.querySelector('[data-k="airSumLowLimit"]');

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
                window.BBAlerts?.armAudio?.();

                const s = loadSettings();

                inpDps.value = String(s.dpsRefreshSec);
                inpPoint.value = String(s.pointRefreshSec);
                inpOnlineLab.value = String(s.onlineLabRefreshSec);

                const rawUpper = String(s.upperLowerRefreshSec || 10800);
                const allowedUpper = ["10800", "21600", "32400", "43200"];
                inpUpperLower.value = allowedUpper.includes(rawUpper) ? rawUpper : "10800";

                inpFlowAlertEnabled.checked = !!s.flowAlertEnabled;
                inpFlowLowLimit.value = String(s.flowLowLimit);

                inpAirSumAlertEnabled.checked = !!s.airSumAlertEnabled;
                inpAirSumLowLimit.value = String(s.airSumLowLimit);

                inpAlertEnabled.checked = !!s.alertEnabled;
                inpAlertMuted.checked = !!s.alertMuted;

                popup.classList.add("on");
            });
        }

        const bell = sec.querySelector('[data-role="dps-alert-bell"]');
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
                    window.BBAlerts?.resetRule?.(sec, "dps-current-out-of-control");
                    window.BBAlerts?.resetRule?.(sec, "dps-flow-low");
                    window.BBAlerts?.resetRule?.(sec, "dps-air-sum-low");
                }

                syncBell(sec);
            });
        }

        let t1 = null;
        let t2 = null;

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

            const rawUpper = Number(inpUpperLower.value || 10800);
            const upperLowerRefreshSec = VALID_UPPERLOWER_REFRESH_SEC.includes(rawUpper)
                ? rawUpper
                : DEFAULT_UPPERLOWER_REFRESH_SEC;

            const flowLowLimit = clamp(
                inpFlowLowLimit.value,
                0,
                999999,
                DEFAULT_FLOW_LOW_LIMIT
            );

            const airSumLowLimit = clamp(
                inpAirSumLowLimit.value,
                0,
                999999,
                DEFAULT_AIR_SUM_LOW_LIMIT
            );

            const current = loadSettings();

            saveSettings({
                dpsRefreshSec,
                pointRefreshSec,
                onlineLabRefreshSec,
                upperLowerRefreshSec,

                flowAlertEnabled: inpFlowAlertEnabled.checked,
                flowLowLimit,

                airSumAlertEnabled: inpAirSumAlertEnabled.checked,
                airSumLowLimit,

                alertEnabled: inpAlertEnabled.checked,
                alertMuted: inpAlertMuted.checked
            });

            closePop();

            if (inpAlertMuted.checked && !current.alertMuted) {
                window.BBAlerts?.resetRule?.(sec, "dps-current-out-of-control");
                window.BBAlerts?.resetRule?.(sec, "dps-flow-low");
                window.BBAlerts?.resetRule?.(sec, "dps-air-sum-low");
                syncBell(sec);
            }

            restartPoller();
            tickAll();

            if (window.DPSSummary && typeof window.DPSSummary.restartWithin === "function") {
                window.DPSSummary.restartWithin(document);
            }

            if (window.DPSView && typeof window.DPSView.restartWithin === "function") {
                window.DPSView.restartWithin(document);
            }

            if (window.DPSUpperLower && typeof window.DPSUpperLower.restartWithin === "function") {
                window.DPSUpperLower.restartWithin(document);
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

    function safeUpdateChart(chart) {
        requestAnimationFrame(() => {
            try { chart.update(); } catch { }
        });
    }

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
            const sectionAlarm = new Map();

            for (const t of targets) {
                const pv = readPvFromMap(map, t.base);
                if (pv === null) continue;

                const sec = t.canvas.closest("section.dps-block");
                const chart = getChartInstance(t.canvas);
                if (!chart) continue;

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
                const bell = sec.querySelector('[data-role="dps-alert-bell"]');

                const exceeded = window.BBAlerts?.evaluate?.(sec, {
                    ruleKey: "dps-current-out-of-control",
                    enabled: settings.alertEnabled,
                    muted: settings.alertMuted,
                    value: sectionAlarm.get(sec) ? 1 : 0,
                    limit: 0.5,
                    direction: "gt"
                }) || false;

                if (exceeded) {
                    window.BBAlerts?.setBellState?.(bell, "alerting");
                } else if (settings.alertMuted) {
                    window.BBAlerts?.setBellState?.(bell, "muted");
                } else {
                    window.BBAlerts?.setBellState?.(bell, "armed");
                }
            }
        } finally {
            inFlight = false;
        }
    }

    function restartPoller() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;

        const s = loadSettings();
        pollMs = Math.max(
            MIN_POINT_REFRESH_SEC * 1000,
            Math.min(
                MAX_POINT_REFRESH_SEC * 1000,
                Number(s.pointRefreshSec || DEFAULT_POINT_REFRESH_SEC) * 1000
            )
        );

        pollTimer = setInterval(() => tickAll(), pollMs);
    }

    function initWithin(root) {
        const scope = root || document;
        const secs = scope.querySelectorAll("section.dps-block");
        secs.forEach(bindSection);

        if (!pollTimer) restartPoller();
        tickAll();
    }

    window.DPSSettings = {
        loadSettings,
        saveSettings,
        syncBell
    };

    window.DPSSmartmapOverlay = {
        initWithin,
        tickAll,
        restartPoller,
        loadSettings,
        saveSettings,
        syncBell
    };
})();