// RWSview.js  (OnlineLab POST /api/online_lab)
// - ทำเฉพาะ 4 mini charts: RW_NTU, RW_COND, RW_DO, RW_TEMP
// - ใช้ไฟล์นี้เป็น Settings Popup หลักของ RPS/RWS
// - เพิ่ม Alarm Rules: RW#1/RW#2/RW#3/RW#4 Flow less than
(function () {
    "use strict";

    const HOUR_WINDOW = 4;
    const TIMEOUT_MS = 8000;

    const SOURCE = "RW2";

    const STORAGE_KEY = "rws_online_lab_refresh_v1";

    const DEFAULT_RPS_REFRESH_SEC = 5;
    const MIN_RPS_REFRESH_SEC = 5;
    const MAX_RPS_REFRESH_SEC = 60;

    const DEFAULT_ONLINELAB_REFRESH_SEC = 300;
    const MIN_ONLINELAB_REFRESH_SEC = 300;
    const MAX_ONLINELAB_REFRESH_SEC = 900;

    const DEFAULT_RW1_FLOW_LOW_LIMIT = 1000;
    const DEFAULT_RW2_FLOW_LOW_LIMIT = 1000;
    const DEFAULT_RW3_FLOW_LOW_LIMIT = 1000;
    const DEFAULT_RW4_FLOW_LOW_LIMIT = 1000;

    const K_NTU = "NTU";
    const K_NTU_MAX = "NTU_ParaMax";
    const K_COND = "Cond";
    const K_DO = "DO";
    const K_DO_MIN = "DO_ParaMin";
    const K_TEMP = "Temp";

    let _inflight = null;
    let _settingsBooted = false;

    function clamp(n, min, max, fallback) {
        const x = Number(n);
        if (!Number.isFinite(x)) return fallback;
        return Math.max(min, Math.min(max, x));
    }

    function defaultSettings() {
        return {
            rpsRefreshSec: DEFAULT_RPS_REFRESH_SEC,
            onlineLabRefreshSec: DEFAULT_ONLINELAB_REFRESH_SEC,

            flowAlertEnabled: false,
            rw1FlowLowLimit: DEFAULT_RW1_FLOW_LOW_LIMIT,
            rw2FlowLowLimit: DEFAULT_RW2_FLOW_LOW_LIMIT,
            rw3FlowLowLimit: DEFAULT_RW3_FLOW_LOW_LIMIT,
            rw4FlowLowLimit: DEFAULT_RW4_FLOW_LOW_LIMIT,

            alertMuted: false
        };
    }

    function normalizeSettings(o) {
        return {
            rpsRefreshSec: clamp(
                o?.rpsRefreshSec,
                MIN_RPS_REFRESH_SEC,
                MAX_RPS_REFRESH_SEC,
                DEFAULT_RPS_REFRESH_SEC
            ),

            onlineLabRefreshSec: clamp(
                o?.onlineLabRefreshSec,
                MIN_ONLINELAB_REFRESH_SEC,
                MAX_ONLINELAB_REFRESH_SEC,
                DEFAULT_ONLINELAB_REFRESH_SEC
            ),

            flowAlertEnabled: Boolean(o?.flowAlertEnabled),

            rw1FlowLowLimit: clamp(
                o?.rw1FlowLowLimit,
                0,
                999999,
                DEFAULT_RW1_FLOW_LOW_LIMIT
            ),

            rw2FlowLowLimit: clamp(
                o?.rw2FlowLowLimit,
                0,
                999999,
                DEFAULT_RW2_FLOW_LOW_LIMIT
            ),

            rw3FlowLowLimit: clamp(
                o?.rw3FlowLowLimit,
                0,
                999999,
                DEFAULT_RW3_FLOW_LOW_LIMIT
            ),

            rw4FlowLowLimit: clamp(
                o?.rw4FlowLowLimit,
                0,
                999999,
                DEFAULT_RW4_FLOW_LOW_LIMIT
            ),

            alertMuted: Boolean(o?.alertMuted)
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
        const payload = normalizeSettings(s || {});
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }

    function loadOnlineLabRefreshSec() {
        const s = loadSettings();
        return s.onlineLabRefreshSec;
    }

    function getOnlineLabPollMs() {
        return loadOnlineLabRefreshSec() * 1000;
    }

    function syncBell(section) {
        if (!section) return;
        const bell = section.querySelector('[data-role="rws-alert-bell"]');
        const s = loadSettings();
        window.BBAlerts?.setBellState?.(bell, s.alertMuted ? "muted" : "armed");
    }

    function resetFlowRules(section) {
        window.BBAlerts?.resetRule?.(section, "rws-flow1-low");
        window.BBAlerts?.resetRule?.(section, "rws-flow2-low");
        window.BBAlerts?.resetRule?.(section, "rws-flow3-low");
        window.BBAlerts?.resetRule?.(section, "rws-flow4-low");
    }

    function isValidPopup(el) {
        return !!(
            el &&
            el.nodeType === 1 &&
            el.classList.contains("rws-settings-pop") &&
            el.querySelector('[data-k="rpsRefreshSec"]') &&
            el.querySelector('[data-k="onlineLabRefreshSec"]') &&
            el.querySelector('[data-k="rw1FlowLowLimit"]') &&
            el.querySelector('[data-act="apply"]') &&
            el.querySelector('[data-act="close"]')
        );
    }

    function logSettingsError(message, extra) {
        try {
            console.error("[RWSView settings]", message, extra || "");
        } catch { }
    }

    function ensurePopup() {
        const all = Array.from(document.querySelectorAll(".rws-settings-pop"));
        let el = null;

        for (const node of all) {
            if (isValidPopup(node) && !el) {
                el = node;
                continue;
            }

            try {
                node.remove();
            } catch (err) {
                logSettingsError("Failed to remove stale popup node.", err);
            }
        }

        if (!el) {
            el = document.createElement("div");
            el.className = "rws-settings-pop";
            el.innerHTML = `
<div class="rws-pop-card">
  <div class="rws-pop-h">
    <div class="t">RPS Settings</div>
    <button class="x" type="button" aria-label="Close">✕</button>
  </div>

  <div class="rws-pop-b">
    <div class="row">
      <div class="k">RPS data refresh interval</div>
      <select class="inp" data-k="rpsRefreshSec">
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

    <div class="section-label">Alarm Rules</div>

    <div class="alarm-card">
      <div class="alarm-head">
        <div>
          <div class="alarm-title">RPS Flow Alert</div>
          <div class="alarm-sub">Alarm when RW#1 - RW#4 flow is too low</div>
        </div>
        <label class="toggle">
          <input type="checkbox" data-k="flowAlertEnabled">
          <span>On</span>
        </label>
      </div>

      <div class="alarm-grid">
        <div class="rule-box low">
          <div class="rule-k">RW#1 Low flow</div>
          <div class="rule-line">
            <span class="op">Less than</span>
            <input class="inp mini" data-k="rw1FlowLowLimit" type="number" min="0" max="999999" step="1">
            <span class="unit">m³/h</span>
          </div>
        </div>

        <div class="rule-box low">
          <div class="rule-k">RW#2 Low flow</div>
          <div class="rule-line">
            <span class="op">Less than</span>
            <input class="inp mini" data-k="rw2FlowLowLimit" type="number" min="0" max="999999" step="1">
            <span class="unit">m³/h</span>
          </div>
        </div>

        <div class="rule-box low">
          <div class="rule-k">RW#3 Low flow</div>
          <div class="rule-line">
            <span class="op">Less than</span>
            <input class="inp mini" data-k="rw3FlowLowLimit" type="number" min="0" max="999999" step="1">
            <span class="unit">m³/h</span>
          </div>
        </div>

        <div class="rule-box low">
          <div class="rule-k">RW#4 Low flow</div>
          <div class="rule-line">
            <span class="op">Less than</span>
            <input class="inp mini" data-k="rw4FlowLowLimit" type="number" min="0" max="999999" step="1">
            <span class="unit">m³/h</span>
          </div>
        </div>
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
        }

        let st = document.getElementById("rws-settings-pop-style");
        if (!st) {
            st = document.createElement("style");
            st.id = "rws-settings-pop-style";
            st.textContent = `
.rws-settings-pop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.58);z-index:999999}
.rws-settings-pop.on{display:flex}
.rws-pop-card{width:min(560px,94vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.58);color:rgba(255,255,255,.92);overflow:hidden}
.rws-pop-h{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.025)}
.rws-pop-h .t{font-weight:800}
.rws-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.88);font-size:17px;cursor:pointer}
.rws-pop-b{padding:14px 16px 16px}
.rws-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0}
.rws-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
.rws-pop-b .inp{width:170px;background:#1f2326;border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
.rws-pop-b .inp:focus{border-color:rgba(88,166,255,.75);box-shadow:0 0 0 3px rgba(88,166,255,.14)}
.rws-pop-b .toggle{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,.92);white-space:nowrap}
.rws-pop-b .section-label{font-size:11px;font-weight:900;color:rgba(255,255,255,.48);letter-spacing:.12em;margin:16px 0 8px;text-transform:uppercase}
.rws-pop-b .alarm-card{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.10);border-radius:15px;padding:13px;margin:10px 0}
.rws-pop-b .alarm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
.rws-pop-b .alarm-title{font-size:14px;font-weight:850;color:rgba(255,255,255,.94)}
.rws-pop-b .alarm-sub{font-size:12px;color:rgba(255,255,255,.52);margin-top:3px}
.rws-pop-b .alarm-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.rws-pop-b .rule-box{background:rgba(0,0,0,.16);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px}
.rws-pop-b .rule-box.low{border-left:3px solid rgba(76,201,240,.85)}
.rws-pop-b .rule-k{font-size:12px;font-weight:800;color:rgba(255,255,255,.72);margin-bottom:8px}
.rws-pop-b .rule-line{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px}
.rws-pop-b .op{font-size:12px;color:rgba(255,255,255,.62);white-space:nowrap}
.rws-pop-b .unit{font-size:12px;color:rgba(255,255,255,.58);white-space:nowrap}
.rws-pop-b .inp.mini{width:100%;min-width:0;text-align:right}
.rws-pop-b .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
.rws-pop-b .btn{background:#1f2326;border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.92);border-radius:11px;padding:8px 14px;cursor:pointer;font-weight:750}
.rws-pop-b .btn.primary{background:#20272d;border-color:rgba(255,255,255,.18)}
.rws-pop-b .btn.ghost{opacity:.82}
@media(max-width:540px){
  .rws-pop-b .alarm-grid{grid-template-columns:1fr}
  .rws-pop-b .row{align-items:flex-start;flex-direction:column}
  .rws-pop-b .inp{width:100%}
}
            `;
            document.head.appendChild(st);
        }

        if (el.dataset.bound !== "true") {
            el.dataset.bound = "true";

            el.addEventListener("click", (e) => {
                if (e.target === el) {
                    el.classList.remove("on");
                }
            });

            const closeBtn = el.querySelector(".x");
            const cancelBtn = el.querySelector('[data-act="close"]');
            const applyBtn = el.querySelector('[data-act="apply"]');

            const closePop = () => {
                el.classList.remove("on");
            };

            closeBtn?.addEventListener("click", closePop);
            cancelBtn?.addEventListener("click", closePop);

            applyBtn?.addEventListener("click", async () => {
                if (applyBtn.disabled || el.dataset.applying === "true") return;

                el.dataset.applying = "true";
                applyBtn.disabled = true;

                try {
                    try {
                        await window.BBAlerts?.armAudio?.();
                    } catch (err) {
                        logSettingsError("Failed to arm audio before apply.", err);
                    }

                    const activeRoot = el._activeRoot || document;
                    const activeSection = el._activeSection || activeRoot.querySelector?.("section.rws-block") || document.querySelector("section.rws-block");
                    const q = (k) => el.querySelector(`[data-k="${k}"]`);

                    if (!q("rpsRefreshSec") || !q("onlineLabRefreshSec")) {
                        throw new Error("Settings popup fields are missing.");
                    }

                    const payload = {
                        rpsRefreshSec: clamp(
                            q("rpsRefreshSec").value,
                            MIN_RPS_REFRESH_SEC,
                            MAX_RPS_REFRESH_SEC,
                            DEFAULT_RPS_REFRESH_SEC
                        ),

                        onlineLabRefreshSec: clamp(
                            q("onlineLabRefreshSec").value,
                            MIN_ONLINELAB_REFRESH_SEC,
                            MAX_ONLINELAB_REFRESH_SEC,
                            DEFAULT_ONLINELAB_REFRESH_SEC
                        ),

                        flowAlertEnabled: !!q("flowAlertEnabled")?.checked,

                        rw1FlowLowLimit: clamp(
                            q("rw1FlowLowLimit")?.value,
                            0,
                            999999,
                            DEFAULT_RW1_FLOW_LOW_LIMIT
                        ),

                        rw2FlowLowLimit: clamp(
                            q("rw2FlowLowLimit")?.value,
                            0,
                            999999,
                            DEFAULT_RW2_FLOW_LOW_LIMIT
                        ),

                        rw3FlowLowLimit: clamp(
                            q("rw3FlowLowLimit")?.value,
                            0,
                            999999,
                            DEFAULT_RW3_FLOW_LOW_LIMIT
                        ),

                        rw4FlowLowLimit: clamp(
                            q("rw4FlowLowLimit")?.value,
                            0,
                            999999,
                            DEFAULT_RW4_FLOW_LOW_LIMIT
                        ),

                        alertMuted: !!q("alertMuted")?.checked
                    };

                    saveSettings(payload);
                    closePop();

                    const syncScope = activeRoot || document;
                    const sections = syncScope.matches?.("section.rws-block")
                        ? [syncScope]
                        : Array.from(syncScope.querySelectorAll?.("section.rws-block") || []);

                    if (sections.length === 0 && activeSection) sections.push(activeSection);

                    if (payload.alertMuted) {
                        for (const sec of sections) resetFlowRules(sec);
                    }

                    for (const sec of sections) syncBell(sec);

                    try {
                        if (window.RWSSummary?.restartWithin) {
                            window.RWSSummary.restartWithin(syncScope);
                        }
                    } catch (err) {
                        logSettingsError("Failed to restart RWSSummary polling.", err);
                    }

                    try {
                        refreshRwsCharts(syncScope);
                    } catch (err) {
                        logSettingsError("Failed to refresh RWS charts after apply.", err);
                    }

                    try {
                        startOnlineLabTimer(syncScope);
                    } catch (err) {
                        logSettingsError("Failed to restart OnlineLab timer.", err);
                    }

                } catch (err) {
                    logSettingsError("Apply failed.", err);
                    alert("Apply failed: " + (err?.message || err));
                } finally {
                    el.dataset.applying = "false";
                    applyBtn.disabled = false;
                }
            });
        }

        return el;
    }

    function bootSettings(root) {
        ensurePopup();

        if (_settingsBooted) return;
        _settingsBooted = true;

        document.addEventListener("click", function (e) {
            const popup = ensurePopup();
            const btn = e.target.closest("#btnSettings, #rwsBtnSettings, #rpsBtnSettings");

            if (btn) {
                const section = btn.closest("section.rws-block");
                if (!section) return;

                e.preventDefault();
                e.stopPropagation();
                window.BBAlerts?.armAudio?.();

                const s = loadSettings();
                const q = (k) => popup.querySelector(`[data-k="${k}"]`);

                if (q("rpsRefreshSec")) q("rpsRefreshSec").value = String(s.rpsRefreshSec);
                if (q("onlineLabRefreshSec")) q("onlineLabRefreshSec").value = String(s.onlineLabRefreshSec);

                if (q("flowAlertEnabled")) q("flowAlertEnabled").checked = s.flowAlertEnabled;
                if (q("rw1FlowLowLimit")) q("rw1FlowLowLimit").value = String(s.rw1FlowLowLimit);
                if (q("rw2FlowLowLimit")) q("rw2FlowLowLimit").value = String(s.rw2FlowLowLimit);
                if (q("rw3FlowLowLimit")) q("rw3FlowLowLimit").value = String(s.rw3FlowLowLimit);
                if (q("rw4FlowLowLimit")) q("rw4FlowLowLimit").value = String(s.rw4FlowLowLimit);

                if (q("alertMuted")) q("alertMuted").checked = s.alertMuted;

                popup._activeRoot = section || root || document;
                popup._activeSection = section;
                popup.classList.add("on");
                return;
            }

            const bell = e.target.closest('[data-role="rws-alert-bell"]');

            if (bell) {
                const section = bell.closest("section.rws-block");
                if (!section) return;

                e.preventDefault();
                e.stopPropagation();
                window.BBAlerts?.armAudio?.();

                const s = loadSettings();
                const wasMuted = s.alertMuted;
                s.alertMuted = !s.alertMuted;
                saveSettings(s);

                if (!wasMuted && s.alertMuted) {
                    resetFlowRules(section);
                }

                syncBell(section);
            }
        }, true);
    }

    function inferBackendBase(root) {
        const port = "8888";
        const proto = (location.protocol === "https:") ? "https" : "http";
        const host = location.hostname;
        return `${proto}://${host}:${port}`;
    }

    function apiUrl(root, path) {
        if (!path.startsWith("/")) path = "/" + path;
        return inferBackendBase(root).replace(/\/+$/, "") + path;
    }

    async function fetchOnlineLab(root) {
        if (_inflight) return _inflight;

        const url = apiUrl(root, "/api/online_lab");

        const payloadObj = {
            hourWindow: HOUR_WINDOW,
            sources: [
                {
                    source: SOURCE,
                    keys: [
                        K_NTU, K_NTU_MAX,
                        K_COND,
                        K_DO, K_DO_MIN,
                        K_TEMP
                    ]
                }
            ]
        };

        const payloadText = JSON.stringify(payloadObj);

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort("timeout"), TIMEOUT_MS);

        _inflight = (async () => {
            try {
                const r = await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "text/plain;charset=UTF-8" },
                    cache: "no-store",
                    body: payloadText,
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
                _inflight = null;
            }
        })();

        return _inflight;
    }

    function toLabelsAndY(points) {
        const arr = [];
        for (const p of (points || [])) {
            if (!p) continue;
            const ts = String(p.ts || "").trim();
            const y = Number(p.value);
            if (!ts) continue;
            if (!Number.isFinite(y)) continue;
            arr.push({ ts, y });
        }

        arr.reverse();

        const labels = [];
        const ys = [];

        for (const it of arr) {
            labels.push(it.ts);
            ys.push(it.y);
        }

        return { labels, ys };
    }

    function toY(points) {
        const arr = [];
        for (const p of (points || [])) {
            const y = Number(p && p.value);
            if (!Number.isFinite(y)) continue;
            arr.push(y);
        }

        arr.reverse();
        return arr;
    }

    function padToLen(arr, len) {
        if (arr.length === len) return arr;
        if (arr.length > len) return arr.slice(0, len);

        const out = arr.slice();
        while (out.length < len) out.push(null);
        return out;
    }

    function ensureChart(canvas, mode) {
        if (!window.Chart) throw new Error("Chart.js not loaded");

        if (canvas._rwsChart && canvas._rwsChart._rwsMode === mode) return canvas._rwsChart;

        if (canvas._rwsChart) {
            try { canvas._rwsChart.destroy(); } catch { }
            canvas._rwsChart = null;
        }

        const ctx = canvas.getContext("2d");

        const datasets = [];
        datasets.push({
            label: "main",
            data: [],
            borderColor: "rgba(255,255,255,.92)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0
        });

        if (mode === "main_max") {
            datasets.push({
                label: "max",
                data: [],
                borderColor: "rgba(255,91,91,.95)",
                borderWidth: 4,
                pointRadius: 0,
                tension: 0
            });
        } else if (mode === "main_min") {
            datasets.push({
                label: "min",
                data: [],
                borderColor: "rgba(255,91,91,.95)",
                borderWidth: 4,
                pointRadius: 0,
                tension: 0
            });
        }

        const ch = new Chart(ctx, {
            type: "line",
            data: { labels: [], datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        type: "category",
                        ticks: { display: false },
                        grid: { display: false }
                    },
                    y: {
                        grid: { color: "rgba(255,255,255,.06)" }
                    }
                }
            }
        });

        ch._rwsMode = mode;
        canvas._rwsChart = ch;
        return ch;
    }

    function destroyChart(canvas) {
        if (canvas && canvas._rwsChart) {
            try { canvas._rwsChart.destroy(); } catch { }
        }

        if (canvas) canvas._rwsChart = null;
    }

    function setVisible(canvas, visible) {
        if (!canvas) return;
        canvas.style.display = visible ? "" : "none";
    }

    function pickGraph(data, source) {
        const g = data && data.graphs ? data.graphs[source] : null;
        return g || null;
    }

    function renderSpec(canvas, graph, spec) {
        if (!canvas) return;

        if (!graph) {
            destroyChart(canvas);
            setVisible(canvas, false);
            return;
        }

        const mainPack = toLabelsAndY(graph[spec.mainKey]);
        const labels = mainPack.labels;
        const mainY = mainPack.ys;

        if (!labels.length || !mainY.length) {
            destroyChart(canvas);
            setVisible(canvas, false);
            return;
        }

        const ch = ensureChart(canvas, spec.mode);
        ch.data.labels = labels;
        ch.data.datasets[0].data = mainY;

        if (spec.mode === "main_max") {
            const maxY = padToLen(toY(graph[spec.maxKey]), labels.length);
            ch.data.datasets[1].data = maxY;
        } else if (spec.mode === "main_min") {
            const minY = padToLen(toY(graph[spec.minKey]), labels.length);
            ch.data.datasets[1].data = minY;
        }

        ch.update("none");
        setVisible(canvas, true);
    }

    async function refreshRwsCharts(root) {
        const scope = root || document;

        const cNTU = scope.querySelector("#RW_NTU");
        const cCOND = scope.querySelector("#RW_COND");
        const cDO = scope.querySelector("#RW_DO");
        const cTEMP = scope.querySelector("#RW_TEMP");

        if (!cNTU && !cCOND && !cDO && !cTEMP) return;

        try {
            const data = await fetchOnlineLab(scope);
            const g = pickGraph(data, SOURCE);

            renderSpec(cNTU, g, { mode: "main_max", mainKey: K_NTU, maxKey: K_NTU_MAX });
            renderSpec(cCOND, g, { mode: "main", mainKey: K_COND });
            renderSpec(cDO, g, { mode: "main_min", mainKey: K_DO, minKey: K_DO_MIN });
            renderSpec(cTEMP, g, { mode: "main", mainKey: K_TEMP });

        } catch (e) {
            for (const cv of [cNTU, cCOND, cDO, cTEMP].filter(Boolean)) {
                destroyChart(cv);
                setVisible(cv, false);
            }
        }
    }

    function startOnlineLabTimer(scope) {
        if (scope._rwsOnlineLabTimer) {
            clearInterval(scope._rwsOnlineLabTimer);
            scope._rwsOnlineLabTimer = null;
        }

        scope._rwsOnlineLabTimer = setInterval(() => {
            refreshRwsCharts(scope);
        }, getOnlineLabPollMs());
    }

    function restartWithin(root) {
        const scope = root || document;
        bootSettings(scope);
        refreshRwsCharts(scope);
        startOnlineLabTimer(scope);

        const sections = scope.matches?.("section.rws-block")
            ? [scope]
            : Array.from(scope.querySelectorAll("section.rws-block"));

        for (const sec of sections) syncBell(sec);
    }

    function initWithin(root) {
        const scope = root || document;

        bootSettings(scope);

        const sections = scope.matches?.("section.rws-block")
            ? [scope]
            : Array.from(scope.querySelectorAll("section.rws-block"));

        for (const sec of sections) syncBell(sec);

        if (scope._rwsOnlineLabBound === true) return;
        scope._rwsOnlineLabBound = true;

        restartWithin(scope);
    }

    function destroyWithin(root) {
        const scope = root || document;

        if (scope._rwsOnlineLabTimer) clearInterval(scope._rwsOnlineLabTimer);
        scope._rwsOnlineLabTimer = null;
        scope._rwsOnlineLabBound = false;

        const c = [
            scope.querySelector("#RW_NTU"),
            scope.querySelector("#RW_COND"),
            scope.querySelector("#RW_DO"),
            scope.querySelector("#RW_TEMP"),
        ].filter(Boolean);

        for (const cv of c) {
            destroyChart(cv);
            setVisible(cv, false);
        }
    }

    window.RWSOnlineSettings = {
        loadSettings,
        saveSettings,
        syncBell
    };

    window.RWSView = {
        initWithin,
        destroyWithin,
        restartWithin,
        loadSettings,
        saveSettings,
        syncBell
    };

})();
