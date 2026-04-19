(function () {
    "use strict";

    const STORAGE_KEY = "tps_refresh_settings_v3";
    const DEFAULT_REFRESH_SEC = 15;

    const DEFAULT_PRESSURE_LOW_LIMIT = 2.5;
    const DEFAULT_PRESSURE_HIGH_LIMIT = 4.5;
    const DEFAULT_SERVICE_WATER_FLOW_LOW_LIMIT = 5.0;

    let _booted = false;
    let _activeSection = null;

    function clamp(n, min, max, fallback) {
        const x = Number(n);
        if (!Number.isFinite(x)) return fallback;
        return Math.max(min, Math.min(max, x));
    }

    function loadSettings() {
        const o = window.BBAlerts?.loadSettings(STORAGE_KEY, {}) || {};

        const pressureHighLimit = clamp(
            o?.pressureHighLimit ?? o?.pressureAlertLimit,
            0.1,
            99,
            DEFAULT_PRESSURE_HIGH_LIMIT
        );

        return {
            refreshSec: clamp(o?.refreshSec, 5, 300, DEFAULT_REFRESH_SEC),

            pressureAlertEnabled: Boolean(o?.pressureAlertEnabled),
            pressureLowLimit: clamp(o?.pressureLowLimit, 0.1, 99, DEFAULT_PRESSURE_LOW_LIMIT),
            pressureHighLimit: pressureHighLimit,

            // backward compatible กับ workflow เดิม
            pressureAlertLimit: pressureHighLimit,

            serviceWaterFlowAlertEnabled: Boolean(o?.serviceWaterFlowAlertEnabled),
            serviceWaterFlowLowLimit: clamp(
                o?.serviceWaterFlowLowLimit,
                0,
                99999,
                DEFAULT_SERVICE_WATER_FLOW_LOW_LIMIT
            ),

            pressureAlertMuted: Boolean(o?.pressureAlertMuted)
        };
    }

    function saveSettings(s) {
        const refreshSec = clamp(s?.refreshSec, 5, 300, DEFAULT_REFRESH_SEC);
        const pressureLowLimit = clamp(s?.pressureLowLimit, 0.1, 99, DEFAULT_PRESSURE_LOW_LIMIT);
        const pressureHighLimit = clamp(s?.pressureHighLimit, 0.1, 99, DEFAULT_PRESSURE_HIGH_LIMIT);
        const serviceWaterFlowLowLimit = clamp(
            s?.serviceWaterFlowLowLimit,
            0,
            99999,
            DEFAULT_SERVICE_WATER_FLOW_LOW_LIMIT
        );

        const payload = {
            refreshSec,

            pressureAlertEnabled: Boolean(s?.pressureAlertEnabled),
            pressureLowLimit,
            pressureHighLimit,

            // backward compatible กับ alarm เดิม
            pressureAlertLimit: pressureHighLimit,

            serviceWaterFlowAlertEnabled: Boolean(s?.serviceWaterFlowAlertEnabled),
            serviceWaterFlowLowLimit,

            pressureAlertMuted: Boolean(s?.pressureAlertMuted)
        };

        if (window.BBAlerts?.saveSettings) {
            window.BBAlerts.saveSettings(STORAGE_KEY, payload);
        } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        }
    }

    function ensurePopup() {
        let el = document.querySelector(".tps-settings-pop");
        if (el) return el;

        el = document.createElement("div");
        el.className = "tps-settings-pop";
        el.innerHTML = `
<div class="tps-pop-card">
  <div class="tps-pop-h">
    <div class="t">TPS Settings</div>
    <button class="x" type="button" aria-label="Close">✕</button>
  </div>

  <div class="tps-pop-b">
    <div class="row">
      <div class="k">Refresh interval</div>
      <select class="inp" data-k="refreshSec">
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

    <div class="section-label">Alarm Rules</div>

    <div class="alarm-card">
      <div class="alarm-head">
        <div>
          <div class="alarm-title">Pressure Alert</div>
          <div class="alarm-sub">Low / High pressure threshold</div>
        </div>
        <label class="toggle">
          <input type="checkbox" data-k="pressureAlertEnabled">
          <span>On</span>
        </label>
      </div>

      <div class="alarm-grid">
        <div class="rule-box low">
          <div class="rule-k">Low pressure</div>
          <div class="rule-line">
            <span class="op">Less than</span>
            <input class="inp mini" data-k="pressureLowLimit" type="number" min="0.1" max="99" step="0.1">
            <span class="unit">kg/cm²</span>
          </div>
        </div>

        <div class="rule-box high">
          <div class="rule-k">High pressure</div>
          <div class="rule-line">
            <span class="op">Over</span>
            <input class="inp mini" data-k="pressureHighLimit" type="number" min="0.1" max="99" step="0.1">
            <span class="unit">kg/cm²</span>
          </div>
        </div>
      </div>
    </div>

    <div class="alarm-card">
      <div class="alarm-head">
        <div>
          <div class="alarm-title">Service Water Flow Alert</div>
          <div class="alarm-sub">Low flow threshold</div>
        </div>
        <label class="toggle">
          <input type="checkbox" data-k="serviceWaterFlowAlertEnabled">
          <span>On</span>
        </label>
      </div>

      <div class="rule-box low single">
        <div class="rule-k">Low flow</div>
        <div class="rule-line">
          <span class="op">Less than</span>
          <input class="inp mini" data-k="serviceWaterFlowLowLimit" type="number" min="0" max="99999" step="0.1">
          <span class="unit">m³/h</span>
        </div>
      </div>
    </div>

    <div class="section-label">Notification</div>

    <div class="row">
      <div class="k">Mute bell sound</div>
      <label class="toggle">
        <input type="checkbox" data-k="pressureAlertMuted">
        <span>Muted</span>
      </label>
    </div>

    <div class="actions">
      <button class="btn primary" data-act="apply" type="button">Save</button>
      <button class="btn ghost" data-act="close" type="button">Cancel</button>
    </div>
  </div>
</div>`;

        document.body.appendChild(el);

        const st = document.createElement("style");
        st.textContent = `
.tps-settings-pop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.58);z-index:999999}
.tps-settings-pop.on{display:flex}
.tps-pop-card{width:min(560px,94vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.58);color:rgba(255,255,255,.92);overflow:hidden}
.tps-pop-h{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.025)}
.tps-pop-h .t{font-weight:800}
.tps-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.88);font-size:17px;cursor:pointer}
.tps-pop-b{padding:14px 16px 16px}
.tps-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0}
.tps-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
.tps-pop-b .inp{width:170px;background:#1f2326;border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
.tps-pop-b .toggle{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,.92);white-space:nowrap}
.tps-pop-b .section-label{font-size:11px;font-weight:900;color:rgba(255,255,255,.48);letter-spacing:.12em;margin:16px 0 8px;text-transform:uppercase}
.tps-pop-b .alarm-card{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.10);border-radius:15px;padding:13px;margin:10px 0}
.tps-pop-b .alarm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
.tps-pop-b .alarm-title{font-size:14px;font-weight:850;color:rgba(255,255,255,.94)}
.tps-pop-b .alarm-sub{font-size:12px;color:rgba(255,255,255,.52);margin-top:3px}
.tps-pop-b .alarm-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.tps-pop-b .rule-box{background:rgba(0,0,0,.16);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px}
.tps-pop-b .rule-box.low{border-left:3px solid rgba(76,201,240,.85)}
.tps-pop-b .rule-box.high{border-left:3px solid rgba(255,176,64,.9)}
.tps-pop-b .rule-box.single{margin-top:10px}
.tps-pop-b .rule-k{font-size:12px;font-weight:800;color:rgba(255,255,255,.72);margin-bottom:8px}
.tps-pop-b .rule-line{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px}
.tps-pop-b .op{font-size:12px;color:rgba(255,255,255,.62);white-space:nowrap}
.tps-pop-b .unit{font-size:12px;color:rgba(255,255,255,.58);white-space:nowrap}
.tps-pop-b .inp.mini{width:100%;min-width:0;text-align:right}
.tps-pop-b .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
.tps-pop-b .btn{background:#1f2326;border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.92);border-radius:11px;padding:8px 14px;cursor:pointer;font-weight:750}
.tps-pop-b .btn.primary{background:#20272d;border-color:rgba(255,255,255,.18)}
.tps-pop-b .btn.ghost{opacity:.82}
@media(max-width:540px){
  .tps-pop-b .alarm-grid{grid-template-columns:1fr}
  .tps-pop-b .row{align-items:flex-start;flex-direction:column}
  .tps-pop-b .inp{width:100%}
}`;
        document.head.appendChild(st);

        el.addEventListener("click", (e) => {
            if (e.target === el) el.classList.remove("on");
        });

        el.querySelector(".x").addEventListener("click", () => el.classList.remove("on"));
        el.querySelector('[data-act="close"]').addEventListener("click", () => el.classList.remove("on"));

        el.querySelector('[data-act="apply"]').addEventListener("click", () => {
            const refreshSec = clamp(el.querySelector('[data-k="refreshSec"]').value, 5, 300, DEFAULT_REFRESH_SEC);

            const pressureAlertEnabled = el.querySelector('[data-k="pressureAlertEnabled"]').checked;
            const pressureLowLimit = clamp(el.querySelector('[data-k="pressureLowLimit"]').value, 0.1, 99, DEFAULT_PRESSURE_LOW_LIMIT);
            const pressureHighLimit = clamp(el.querySelector('[data-k="pressureHighLimit"]').value, 0.1, 99, DEFAULT_PRESSURE_HIGH_LIMIT);

            const serviceWaterFlowAlertEnabled = el.querySelector('[data-k="serviceWaterFlowAlertEnabled"]').checked;
            const serviceWaterFlowLowLimit = clamp(el.querySelector('[data-k="serviceWaterFlowLowLimit"]').value, 0, 99999, DEFAULT_SERVICE_WATER_FLOW_LOW_LIMIT);

            const pressureAlertMuted = el.querySelector('[data-k="pressureAlertMuted"]').checked;
            const wasMuted = loadSettings().pressureAlertMuted;

            if (pressureLowLimit >= pressureHighLimit) {
                alert("Pressure low limit must be lower than pressure high limit.");
                return;
            }

            saveSettings({
                refreshSec,
                pressureAlertEnabled,
                pressureLowLimit,
                pressureHighLimit,
                serviceWaterFlowAlertEnabled,
                serviceWaterFlowLowLimit,
                pressureAlertMuted
            });

            el.classList.remove("on");

            if (pressureAlertMuted && !wasMuted && _activeSection) {
                window.BBAlerts?.resetRule?.(_activeSection, "pressure-low");
                window.BBAlerts?.resetRule?.(_activeSection, "pressure-high");
                window.BBAlerts?.resetRule?.(_activeSection, "service-water-flow-low");
                window.BBAlerts?.resetRule?.(_activeSection, "pressure-high");
                syncBell(_activeSection);
            }

            if (window.TPSSummary?.restartWithin) {
                const sec = _activeSection || document.querySelector("section.tps-block") || document;
                window.TPSSummary.restartWithin(sec);
            }
        });

        return el;
    }

    function syncBell(section) {
        if (!section) return;
        const settings = loadSettings();
        const bell = section.querySelector('[data-role="tps-alert-bell"]');
        const state = settings.pressureAlertMuted ? "muted" : "armed";
        window.BBAlerts?.setBellState?.(bell, state);
    }

    function openPopup(section) {
        _activeSection = section || document.querySelector("section.tps-block") || null;
        const popup = ensurePopup();
        const s = loadSettings();

        popup.querySelector('[data-k="refreshSec"]').value = String(s.refreshSec);

        popup.querySelector('[data-k="pressureAlertEnabled"]').checked = s.pressureAlertEnabled;
        popup.querySelector('[data-k="pressureLowLimit"]').value = String(s.pressureLowLimit);
        popup.querySelector('[data-k="pressureHighLimit"]').value = String(s.pressureHighLimit);

        popup.querySelector('[data-k="serviceWaterFlowAlertEnabled"]').checked = s.serviceWaterFlowAlertEnabled;
        popup.querySelector('[data-k="serviceWaterFlowLowLimit"]').value = String(s.serviceWaterFlowLowLimit);

        popup.querySelector('[data-k="pressureAlertMuted"]').checked = s.pressureAlertMuted;

        popup.classList.add("on");
    }

    function boot() {
        if (_booted) return;
        _booted = true;

        ensurePopup();

        document.addEventListener("click", function (e) {
            const btn = e.target.closest("#tpsBtnSettings");
            if (btn) {
                e.preventDefault();
                e.stopPropagation();
                window.BBAlerts?.armAudio?.();
                openPopup(btn.closest("section.tps-block"));
                return;
            }

            const bell = e.target.closest('[data-role="tps-alert-bell"]');
            if (!bell) return;

            e.preventDefault();
            e.stopPropagation();
            window.BBAlerts?.armAudio?.();

            const settings = loadSettings();
            const wasMuted = settings.pressureAlertMuted;
            settings.pressureAlertMuted = !settings.pressureAlertMuted;
            saveSettings(settings);

            const section = bell.closest("section.tps-block");

            if (!wasMuted && settings.pressureAlertMuted) {
                window.BBAlerts?.resetRule?.(section, "pressure-low");
                window.BBAlerts?.resetRule?.(section, "pressure-high");
                window.BBAlerts?.resetRule?.(section, "service-water-flow-low");
            }

            syncBell(section);
        }, true);
    }

    function initWithin(root) {
        boot();
    }

    window.TPSSettings = {
        initWithin,
        loadSettings,
        openPopup,
        syncBell
    };

    try { window.TPSSettings.initWithin(document); } catch { }
})();