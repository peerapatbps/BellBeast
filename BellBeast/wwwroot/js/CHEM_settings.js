(function () {
    "use strict";

    const STORAGE_KEY = "chem_refresh_settings_v2";

    const DEFAULT_REFRESH_SEC = 15;
    const MIN_REFRESH_SEC = 5;
    const MAX_REFRESH_SEC = 60;

    const DEFAULT_CHLORINE_LOW_FILL_LIMIT = 1;

    const CHLORINE_FILL_KEYS = [
        "CHLORINE1.LINEA.FILL",
        "CHLORINE1.LINEB.FILL",
        "CHLORINE2.LINEA.FILL",
        "CHLORINE2.LINEB.FILL"
    ];

    const CHLORINE_RULE_KEYS = [
        "chem-chlorine1-linea-fill-low",
        "chem-chlorine1-lineb-fill-low",
        "chem-chlorine2-linea-fill-low",
        "chem-chlorine2-lineb-fill-low"
    ];

    const boundSections = new WeakSet();
    let activeSection = null;

    function clamp(n, min, max, fallback) {
        const x = Number(n);
        if (!Number.isFinite(x)) return fallback;
        return Math.max(min, Math.min(max, x));
    }

    function normalizeSettings(o) {
        const chlorineLowFillLimit = clamp(
            o?.chlorineLowFillLimit ?? o?.alertLimit,
            1,
            100,
            DEFAULT_CHLORINE_LOW_FILL_LIMIT
        );

        return {
            refreshSec: clamp(
                o?.refreshSec,
                MIN_REFRESH_SEC,
                MAX_REFRESH_SEC,
                DEFAULT_REFRESH_SEC
            ),

            chlorineAlertEnabled: Boolean(o?.chlorineAlertEnabled ?? o?.alertEnabled),
            chlorineLowFillLimit,

            // backward compatible for existing CHEMView logic
            alertEnabled: Boolean(o?.chlorineAlertEnabled ?? o?.alertEnabled),
            alertLimit: chlorineLowFillLimit,

            alertMuted: Boolean(o?.alertMuted),

            chlorineFillKeys: CHLORINE_FILL_KEYS.slice()
        };
    }

    function defaultSettings() {
        return normalizeSettings({
            refreshSec: DEFAULT_REFRESH_SEC,
            chlorineAlertEnabled: false,
            chlorineLowFillLimit: DEFAULT_CHLORINE_LOW_FILL_LIMIT,
            alertMuted: false
        });
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const o = raw ? JSON.parse(raw) : {};
            return normalizeSettings(o || {});
        } catch {
            return defaultSettings();
        }
    }

    function saveSettings(s) {
        const payload = normalizeSettings(s || {});

        if (window.BBAlerts?.saveSettings) {
            window.BBAlerts.saveSettings(STORAGE_KEY, payload);
        } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        }
    }

    function getChlorineFillKeys() {
        return CHLORINE_FILL_KEYS.slice();
    }

    function getChlorineRuleKeys() {
        return CHLORINE_RULE_KEYS.slice();
    }

    function syncBell(sec) {
        if (!sec) return;
        const bell = sec.querySelector('[data-role="chem-alert-bell"]');
        const s = loadSettings();
        window.BBAlerts?.setBellState?.(bell, s.alertMuted ? "muted" : "armed");
    }

    function resetChlorineRules(sec) {
        if (!sec) return;

        for (const ruleKey of CHLORINE_RULE_KEYS) {
            window.BBAlerts?.resetRule?.(sec, ruleKey);
        }

        // backward compatible with old single-rule workflow
        window.BBAlerts?.resetRule?.(sec, "chem-low-fill");
        window.BBAlerts?.resetRule?.(sec, "chem-chlorine-low-fill");
    }

    function ensurePopup() {
        let el = document.querySelector(".chem-settings-pop");

        if (el && !el.querySelector('[data-k="chlorineLowFillLimit"]')) {
            el.remove();
            el = null;
        }

        if (el) return el;

        el = document.createElement("div");
        el.className = "chem-settings-pop";
        el.innerHTML = `
<div class="chem-pop-card">
  <div class="chem-pop-h">
    <div class="t">CHEM Settings</div>
    <button class="x" type="button" aria-label="Close">✕</button>
  </div>

  <div class="chem-pop-b">
    <div class="row">
      <div class="k">CHEM refresh interval</div>
      <select class="inp" data-k="refreshSec">
        <option value="5">5 seconds</option>
        <option value="10">10 seconds</option>
        <option value="15">15 seconds</option>
        <option value="20">20 seconds</option>
        <option value="30">30 seconds</option>
        <option value="45">45 seconds</option>
        <option value="60">60 seconds</option>
      </select>
    </div>

    <div class="section-label">Alarm Rules</div>

    <div class="alarm-card">
      <div class="alarm-head">
        <div>
          <div class="alarm-title">Chlorine Fill Alert</div>
          <div class="alarm-sub">Alarm when any chlorine line fill is too low</div>
        </div>
        <label class="toggle">
          <input type="checkbox" data-k="chlorineAlertEnabled">
          <span>On</span>
        </label>
      </div>

      <div class="rule-box low single">
        <div class="rule-k">Low chlorine fill</div>
        <div class="rule-line">
          <span class="op">Less than</span>
          <input class="inp mini" data-k="chlorineLowFillLimit" type="number" min="1" max="100" step="1">
          <span class="unit">%</span>
        </div>
      </div>

      <div class="target-list">
        <div class="target-item">CHLORINE1.LINEA.FILL</div>
        <div class="target-item">CHLORINE1.LINEB.FILL</div>
        <div class="target-item">CHLORINE2.LINEA.FILL</div>
        <div class="target-item">CHLORINE2.LINEB.FILL</div>
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

        const oldStyle = document.querySelector("#chem-settings-pop-style");
        if (oldStyle) oldStyle.remove();

        const st = document.createElement("style");
        st.id = "chem-settings-pop-style";
        st.textContent = `
.chem-settings-pop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.58);z-index:999999}
.chem-settings-pop.on{display:flex}
.chem-pop-card{width:min(560px,94vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.58);color:rgba(255,255,255,.92);overflow:hidden}
.chem-pop-h{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.025)}
.chem-pop-h .t{font-weight:800}
.chem-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.88);font-size:17px;cursor:pointer}
.chem-pop-b{padding:14px 16px 16px}
.chem-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0}
.chem-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
.chem-pop-b .inp{width:170px;background:#1f2326;border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
.chem-pop-b .inp:focus{border-color:rgba(88,166,255,.75);box-shadow:0 0 0 3px rgba(88,166,255,.14)}
.chem-pop-b .toggle{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,.92);white-space:nowrap}
.chem-pop-b .section-label{font-size:11px;font-weight:900;color:rgba(255,255,255,.48);letter-spacing:.12em;margin:16px 0 8px;text-transform:uppercase}
.chem-pop-b .alarm-card{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.10);border-radius:15px;padding:13px;margin:10px 0}
.chem-pop-b .alarm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
.chem-pop-b .alarm-title{font-size:14px;font-weight:850;color:rgba(255,255,255,.94)}
.chem-pop-b .alarm-sub{font-size:12px;color:rgba(255,255,255,.52);margin-top:3px}
.chem-pop-b .rule-box{background:rgba(0,0,0,.16);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px}
.chem-pop-b .rule-box.low{border-left:3px solid rgba(76,201,240,.85)}
.chem-pop-b .rule-box.single{margin-top:10px}
.chem-pop-b .rule-k{font-size:12px;font-weight:800;color:rgba(255,255,255,.72);margin-bottom:8px}
.chem-pop-b .rule-line{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px}
.chem-pop-b .op{font-size:12px;color:rgba(255,255,255,.62);white-space:nowrap}
.chem-pop-b .unit{font-size:12px;color:rgba(255,255,255,.58);white-space:nowrap}
.chem-pop-b .inp.mini{width:100%;min-width:0;text-align:right}
.chem-pop-b .target-list{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.chem-pop-b .target-item{background:rgba(0,0,0,.14);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:7px 9px;font-size:11px;color:rgba(255,255,255,.66);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.chem-pop-b .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
.chem-pop-b .btn{background:#1f2326;border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.92);border-radius:11px;padding:8px 14px;cursor:pointer;font-weight:750}
.chem-pop-b .btn.primary{background:#20272d;border-color:rgba(255,255,255,.18)}
.chem-pop-b .btn.ghost{opacity:.82}
.chem-pop-b .btn:disabled{opacity:.55;cursor:not-allowed}
@media(max-width:540px){
  .chem-pop-b .row{align-items:flex-start;flex-direction:column}
  .chem-pop-b .inp{width:100%}
  .chem-pop-b .target-list{grid-template-columns:1fr}
}
        `;

        document.head.appendChild(st);

        el.addEventListener("click", (e) => {
            if (e.target === el) el.classList.remove("on");
        });

        return el;
    }

    function bindPopupHandlers(popup) {
        if (!popup || popup.dataset.bound === "true") return;
        popup.dataset.bound = "true";

        const closePop = () => popup.classList.remove("on");

        popup.querySelector(".x")?.addEventListener("click", closePop);
        popup.querySelector('[data-act="close"]')?.addEventListener("click", closePop);

        popup.querySelector('[data-act="apply"]')?.addEventListener("click", () => {
            const btn = popup.querySelector('[data-act="apply"]');
            if (btn?.disabled) return;

            try {
                if (btn) btn.disabled = true;

                const current = loadSettings();
                const q = (k) => popup.querySelector(`[data-k="${k}"]`);

                const next = {
                    refreshSec: clamp(
                        q("refreshSec")?.value,
                        MIN_REFRESH_SEC,
                        MAX_REFRESH_SEC,
                        DEFAULT_REFRESH_SEC
                    ),

                    chlorineAlertEnabled: !!q("chlorineAlertEnabled")?.checked,

                    chlorineLowFillLimit: clamp(
                        q("chlorineLowFillLimit")?.value,
                        1,
                        100,
                        DEFAULT_CHLORINE_LOW_FILL_LIMIT
                    ),

                    alertMuted: !!q("alertMuted")?.checked
                };

                saveSettings(next);
                closePop();

                if (next.alertMuted && !current.alertMuted && activeSection) {
                    resetChlorineRules(activeSection);
                    syncBell(activeSection);
                }

                if (window.CHEMView && typeof window.CHEMView.restartWithin === "function") {
                    window.CHEMView.restartWithin(document);
                }

            } catch (err) {
                console.error("[CHEM Settings] Apply failed:", err);
                alert("CHEM settings apply failed. Check Console for details.");
            } finally {
                if (btn) btn.disabled = false;
            }
        });
    }

    function openPopup(sec) {
        activeSection = sec || document.querySelector("section.chem-block") || null;

        const popup = ensurePopup();
        bindPopupHandlers(popup);

        const s = loadSettings();
        const q = (k) => popup.querySelector(`[data-k="${k}"]`);

        q("refreshSec").value = String(s.refreshSec);
        q("chlorineAlertEnabled").checked = s.chlorineAlertEnabled;
        q("chlorineLowFillLimit").value = String(s.chlorineLowFillLimit);
        q("alertMuted").checked = s.alertMuted;

        popup.classList.add("on");
    }

    function bindSection(sec) {
        if (!sec || boundSections.has(sec)) return;
        boundSections.add(sec);

        const popup = ensurePopup();
        bindPopupHandlers(popup);

        const btnSettings = sec.querySelector("#chemBtnSettings");
        if (btnSettings && btnSettings.dataset.bound !== "true") {
            btnSettings.dataset.bound = "true";
            btnSettings.style.pointerEvents = "auto";

            btnSettings.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.BBAlerts?.armAudio?.();
                openPopup(sec);
            });
        }

        const bell = sec.querySelector('[data-role="chem-alert-bell"]');
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
                    resetChlorineRules(sec);
                }

                syncBell(sec);
            });
        }

        syncBell(sec);
    }

    function initWithin(root) {
        const scope = root || document;

        const secs = scope.matches?.("section.chem-block")
            ? [scope]
            : Array.from(scope.querySelectorAll("section.chem-block"));

        secs.forEach(bindSection);
    }

    window.CHEMSettings = {
        initWithin,
        loadSettings,
        saveSettings,
        openPopup,
        syncBell,
        getChlorineFillKeys,
        getChlorineRuleKeys,
        resetChlorineRules
    };

    try { window.CHEMSettings.initWithin(document); } catch { }
})();
