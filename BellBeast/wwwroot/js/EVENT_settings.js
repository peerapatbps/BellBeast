(function () {
    "use strict";

    const STORAGE_KEY = "event_refresh_settings_v1";
    const DEFAULT_REFRESH_MIN = 15;

    let _booted = false;

    function clamp(n, min, max, fallback) {
        const x = Number(n);
        if (!Number.isFinite(x)) return fallback;
        return Math.max(min, Math.min(max, x));
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return { refreshMin: DEFAULT_REFRESH_MIN };
            }

            const o = JSON.parse(raw);

            // รองรับของเก่าแบบ left/right แล้ว migrate มาใช้ค่าเดียว
            if (o && o.refreshMin !== undefined) {
                return {
                    refreshMin: clamp(o.refreshMin, 5, 60, DEFAULT_REFRESH_MIN)
                };
            }

            if (o && (o.leftRefreshMin !== undefined || o.rightRefreshMin !== undefined)) {
                const merged = Math.max(
                    Number.isFinite(Number(o.leftRefreshMin)) ? Number(o.leftRefreshMin) : DEFAULT_REFRESH_MIN,
                    Number.isFinite(Number(o.rightRefreshMin)) ? Number(o.rightRefreshMin) : DEFAULT_REFRESH_MIN
                );
                return {
                    refreshMin: clamp(merged, 5, 60, DEFAULT_REFRESH_MIN)
                };
            }

            return { refreshMin: DEFAULT_REFRESH_MIN };
        } catch {
            return { refreshMin: DEFAULT_REFRESH_MIN };
        }
    }

    function saveSettings(s) {
        const refreshMin = clamp(s && s.refreshMin, 5, 60, DEFAULT_REFRESH_MIN);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ refreshMin }));
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

            saveSettings({ refreshMin });
            el.classList.remove("on");

            if (window.EVENTView && typeof window.EVENTView.restartWithin === "function") {
                const sec = document.querySelector("section.event-block") || document;
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
            openPopup();
        }, true);
    }

    function initWithin(root) {
        boot();
    }

    window.EVENTSettings = {
        initWithin,
        loadSettings,
        openPopup
    };

    try { window.EVENTSettings.initWithin(document); } catch { }
})();