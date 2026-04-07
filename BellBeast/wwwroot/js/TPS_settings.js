(function () {
    "use strict";

    const STORAGE_KEY = "tps_refresh_settings_v1";
    const DEFAULT_REFRESH_SEC = 15;

    let _booted = false;

    function clamp(n, min, max, fallback) {
        const x = Number(n);
        if (!Number.isFinite(x)) return fallback;
        return Math.max(min, Math.min(max, x));
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { refreshSec: DEFAULT_REFRESH_SEC };

            const o = JSON.parse(raw);
            return {
                refreshSec: clamp(o?.refreshSec, 5, 300, DEFAULT_REFRESH_SEC)
            };
        } catch {
            return { refreshSec: DEFAULT_REFRESH_SEC };
        }
    }

    function saveSettings(s) {
        const refreshSec = clamp(s?.refreshSec, 5, 300, DEFAULT_REFRESH_SEC);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ refreshSec }));
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
      <div class="k">Refresh interval (seconds)</div>
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
.tps-settings-pop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:999999}
.tps-settings-pop.on{display:flex}
.tps-pop-card{width:min(420px,92vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55);color:rgba(255,255,255,.92)}
.tps-pop-h{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10)}
.tps-pop-h .t{font-weight:700}
.tps-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.9);font-size:16px;cursor:pointer}
.tps-pop-b{padding:12px 14px}
.tps-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0}
.tps-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
.tps-pop-b .inp{width:160px;background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
.tps-pop-b .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}
.tps-pop-b .btn{background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 12px;cursor:pointer}
.tps-pop-b .btn.ghost{opacity:.85}
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
            const inp = el.querySelector('[data-k="refreshSec"]');
            const refreshSec = clamp(inp.value, 5, 300, DEFAULT_REFRESH_SEC);

            saveSettings({ refreshSec });
            el.classList.remove("on");

            if (window.TPSSummary && typeof window.TPSSummary.restartWithin === "function") {
                const sec = document.querySelector("section.tps-block") || document;
                window.TPSSummary.restartWithin(sec);
            }
        });

        return el;
    }

    function openPopup() {
        const popup = ensurePopup();
        const s = loadSettings();

        const inp = popup.querySelector('[data-k="refreshSec"]');
        inp.value = String(s.refreshSec);

        popup.classList.add("on");
    }

    function boot() {
        if (_booted) return;
        _booted = true;

        ensurePopup();

        document.addEventListener("click", function (e) {
            const btn = e.target.closest("#tpsBtnSettings");
            if (!btn) return;

            e.preventDefault();
            e.stopPropagation();
            openPopup();
        }, true);
    }

    function initWithin(root) {
        boot();
    }

    window.TPSSettings = {
        initWithin,
        loadSettings,
        openPopup
    };

    try { window.TPSSettings.initWithin(document); } catch { }
})();