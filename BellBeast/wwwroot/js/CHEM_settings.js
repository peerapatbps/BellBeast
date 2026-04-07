(function () {
    "use strict";

    const STORAGE_KEY = "chem_refresh_settings_v1";
    const DEFAULT_REFRESH_SEC = 15;
    const MIN_REFRESH_SEC = 5;
    const MAX_REFRESH_SEC = 60;

    const boundSections = new WeakSet();

    function clamp(n, min, max, fallback) {
        const x = Number(n);
        if (!Number.isFinite(x)) return fallback;
        return Math.max(min, Math.min(max, x));
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return { refreshSec: DEFAULT_REFRESH_SEC };
            }

            const o = JSON.parse(raw);
            return {
                refreshSec: clamp(
                    o && o.refreshSec,
                    MIN_REFRESH_SEC,
                    MAX_REFRESH_SEC,
                    DEFAULT_REFRESH_SEC
                )
            };
        } catch {
            return { refreshSec: DEFAULT_REFRESH_SEC };
        }
    }

    function saveSettings(s) {
        const refreshSec = clamp(
            s && s.refreshSec,
            MIN_REFRESH_SEC,
            MAX_REFRESH_SEC,
            DEFAULT_REFRESH_SEC
        );

        localStorage.setItem(STORAGE_KEY, JSON.stringify({ refreshSec }));
    }

    function ensurePopup() {
        let el = document.querySelector(".chem-settings-pop");
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
        <div class="k">CHEM refresh interval (sec)</div>
        <select class="inp" data-k="refreshSec">
          <option value="5">5</option>
          <option value="10">10</option>
          <option value="15">15</option>
          <option value="20">20</option>
          <option value="30">30</option>
          <option value="45">45</option>
          <option value="60">60</option>
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
.chem-settings-pop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:999999}
.chem-settings-pop.on{display:flex}
.chem-pop-card{width:min(420px,92vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55);color:rgba(255,255,255,.92)}
.chem-pop-h{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10)}
.chem-pop-h .t{font-weight:700}
.chem-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.9);font-size:16px;cursor:pointer}
.chem-pop-b{padding:12px 14px}
.chem-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0}
.chem-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
.chem-pop-b .inp{width:140px;background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
.chem-pop-b .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}
.chem-pop-b .btn{background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 12px;cursor:pointer}
.chem-pop-b .btn.ghost{opacity:.85}
`;
        document.head.appendChild(st);

        el.addEventListener("click", (e) => {
            if (e.target === el) el.classList.remove("on");
        });

        return el;
    }

    function bindSection(sec) {
        if (!sec || boundSections.has(sec)) return;
        boundSections.add(sec);

        const popup = ensurePopup();
        const inp = popup.querySelector('[data-k="refreshSec"]');
        const closePop = () => popup.classList.remove("on");

        popup.querySelector(".x").onclick = closePop;
        popup.querySelector('[data-act="close"]').onclick = closePop;

        const btnSettings = sec.querySelector("#chemBtnSettings");
        if (btnSettings) {
            btnSettings.style.pointerEvents = "auto";
            btnSettings.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();

                const s = loadSettings();
                inp.value = String(s.refreshSec);
                popup.classList.add("on");
            });
        }

        popup.querySelector('[data-act="apply"]').onclick = () => {
            const refreshSec = clamp(
                inp.value,
                MIN_REFRESH_SEC,
                MAX_REFRESH_SEC,
                DEFAULT_REFRESH_SEC
            );

            saveSettings({ refreshSec });
            closePop();

            if (window.CHEMView && typeof window.CHEMView.restartWithin === "function") {
                window.CHEMView.restartWithin(document);
            }
        };
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
        loadSettings
    };

    try { window.CHEMSettings.initWithin(document); } catch { }

})();