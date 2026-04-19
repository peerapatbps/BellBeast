(function () {
    "use strict";

    const STORAGE_KEY = "event_refresh_settings_v2";
    const DEFAULT_REFRESH_MIN = 15;
    const DEFAULT_ALERT_LIMIT = 3;

    let _booted = false;
    let _activeSection = null;

    function clamp(n, min, max, fallback) {
        const x = Number(n);
        if (!Number.isFinite(x)) return fallback;
        return Math.max(min, Math.min(max, x));
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return { refreshMin: DEFAULT_REFRESH_MIN, alertEnabled: false, alertLimit: DEFAULT_ALERT_LIMIT, alertMuted: false };
            }

            const o = window.BBAlerts?.loadSettings(STORAGE_KEY, {}) || JSON.parse(raw);

            // รองรับของเก่าแบบ left/right แล้ว migrate มาใช้ค่าเดียว
            if (o && o.refreshMin !== undefined) {
                return {
                    refreshMin: clamp(o.refreshMin, 5, 60, DEFAULT_REFRESH_MIN),
                    alertEnabled: Boolean(o.alertEnabled),
                    alertLimit: clamp(o.alertLimit, 1, 30, DEFAULT_ALERT_LIMIT),
                    alertMuted: Boolean(o.alertMuted)
                };
            }

            if (o && (o.leftRefreshMin !== undefined || o.rightRefreshMin !== undefined)) {
                const merged = Math.max(
                    Number.isFinite(Number(o.leftRefreshMin)) ? Number(o.leftRefreshMin) : DEFAULT_REFRESH_MIN,
                    Number.isFinite(Number(o.rightRefreshMin)) ? Number(o.rightRefreshMin) : DEFAULT_REFRESH_MIN
                );
                return { refreshMin: clamp(merged, 5, 60, DEFAULT_REFRESH_MIN), alertEnabled: false, alertLimit: DEFAULT_ALERT_LIMIT, alertMuted: false };
            }

            return { refreshMin: DEFAULT_REFRESH_MIN, alertEnabled: false, alertLimit: DEFAULT_ALERT_LIMIT, alertMuted: false };
        } catch {
            return { refreshMin: DEFAULT_REFRESH_MIN, alertEnabled: false, alertLimit: DEFAULT_ALERT_LIMIT, alertMuted: false };
        }
    }

    function saveSettings(s) {
        const refreshMin = clamp(s && s.refreshMin, 5, 60, DEFAULT_REFRESH_MIN);
        const payload = {
            refreshMin,
            alertEnabled: Boolean(s && s.alertEnabled),
            alertLimit: clamp(s && s.alertLimit, 1, 30, DEFAULT_ALERT_LIMIT),
            alertMuted: Boolean(s && s.alertMuted)
        };
        if (window.BBAlerts?.saveSettings) window.BBAlerts.saveSettings(STORAGE_KEY, payload);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }

    function syncBell(section) {
        if (!section) return;
        const bell = section.querySelector('[data-role="event-alert-bell"]');
        const settings = loadSettings();
        window.BBAlerts?.setBellState?.(bell, settings.alertMuted ? "muted" : "armed");
    }

    function ensurePopup() {
        let el = document.querySelector(".event-settings-pop");
        if (el) return el;

        el = document.createElement("div");
        el.className = "event-settings-pop";
        el.innerHTML = `
     <div class="event-pop-card">
  <div class="event-pop-h">
    <div class="t">Daily Events Settings</div>
    <button class="x" type="button" aria-label="Close">✕</button>
  </div>
  <div class="event-pop-b">
    <div class="row">
      <div class="k">Refresh interval</div>
      <select class="inp" data-k="refreshMin">
        <option value="5">Every 5 minutes</option>
        <option value="10">Every 10 minutes</option>
        <option value="15">Every 15 minutes</option>
        <option value="20">Every 20 minutes</option>
        <option value="30">Every 30 minutes</option>
        <option value="45">Every 45 minutes</option>
        <option value="60">Every 1 hour</option>
      </select>
    </div>
    <div class="row">
      <div class="k">Enable low-duration alert</div>
      <label class="toggle"><input type="checkbox" data-k="alertEnabled"> <span>On</span></label>
    </div>
    <div class="row">
      <div class="k">Minimum duration alert (days)</div>
      <input class="inp" data-k="alertLimit" type="number" min="1" max="30" step="1">
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
      .event-settings-pop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:999999}
      .event-settings-pop.on{display:flex}
      .event-pop-card{width:min(460px,92vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55);color:rgba(255,255,255,.92)}
      .event-pop-h{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10)}
      .event-pop-h .t{font-weight:700}
      .event-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.9);font-size:16px;cursor:pointer}
      .event-pop-b{padding:12px 14px}
      .event-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0}
      .event-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
      .event-pop-b .inp{width:160px;background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
      .event-pop-b .toggle{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,.92)}
      .event-pop-b .hint{margin-top:8px;font-size:12px;color:rgba(255,255,255,.60)}
      .event-pop-b .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}
      .event-pop-b .btn{background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 12px;cursor:pointer}
      .event-pop-b .btn.ghost{opacity:.85}
    `;
        document.head.appendChild(st);

        el.addEventListener("click", (e) => {
            if (e.target === el) el.classList.remove("on");
        });

        el.querySelector(".x").addEventListener("click", () => {
            el.classList.remove("on");
        });

        el.querySelector('[data-act="close"]').addEventListener("click", () => {
            el.classList.remove("on");
        });

        el.querySelector('[data-act="apply"]').addEventListener("click", () => {
            const inp = el.querySelector('[data-k="refreshMin"]');
            const refreshMin = clamp(inp.value, 5, 60, DEFAULT_REFRESH_MIN);
            const current = loadSettings();
            const next = {
                refreshMin,
                alertEnabled: el.querySelector('[data-k="alertEnabled"]').checked,
                alertLimit: clamp(el.querySelector('[data-k="alertLimit"]').value, 1, 30, DEFAULT_ALERT_LIMIT),
                alertMuted: el.querySelector('[data-k="alertMuted"]').checked
            };

            saveSettings(next);
            el.classList.remove("on");

            if (next.alertMuted && !current.alertMuted && _activeSection) {
                window.BBAlerts?.resetRule?.(_activeSection, "event-low-duration");
                syncBell(_activeSection);
            }

            if (window.EVENTView && typeof window.EVENTView.restartWithin === "function") {
                const sec = _activeSection || document.querySelector("section.event-block") || document;
                window.EVENTView.restartWithin(sec);
            }
        });

        return el;
    }

    function openPopup() {
        const popup = ensurePopup();
        const s = loadSettings();

        const inp = popup.querySelector('[data-k="refreshMin"]');
        inp.value = String(s.refreshMin);
        popup.querySelector('[data-k="alertEnabled"]').checked = s.alertEnabled;
        popup.querySelector('[data-k="alertLimit"]').value = String(s.alertLimit);
        popup.querySelector('[data-k="alertMuted"]').checked = s.alertMuted;

        popup.classList.add("on");
    }

    function boot() {
        if (_booted) return;
        _booted = true;

        ensurePopup();

        document.addEventListener("click", function (e) {
            const btn = e.target.closest("#eventBtnSettings");
            if (!btn) return;

            e.preventDefault();
            e.stopPropagation();
            _activeSection = btn.closest("section.event-block");
            window.BBAlerts?.armAudio?.();
            openPopup();
        }, true);

        document.addEventListener("click", function (e) {
            const bell = e.target.closest('[data-role="event-alert-bell"]');
            if (!bell) return;
            e.preventDefault();
            e.stopPropagation();
            const settings = loadSettings();
            const wasMuted = settings.alertMuted;
            settings.alertMuted = !settings.alertMuted;
            saveSettings(settings);
            const section = bell.closest("section.event-block");
            if (!wasMuted && settings.alertMuted) window.BBAlerts?.resetRule?.(section, "event-low-duration");
            syncBell(section);
        }, true);
    }

    function initWithin(root) {
        boot();
    }

    window.EVENTSettings = {
        initWithin,
        loadSettings,
        openPopup,
        syncBell
    };

    try { window.EVENTSettings.initWithin(document); } catch { }
})();
