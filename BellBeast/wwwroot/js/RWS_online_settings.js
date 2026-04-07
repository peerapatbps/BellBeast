(function () {
    "use strict";

    const STORAGE_KEY = "rws_online_lab_refresh_v1";
    const DEFAULT_ONLINELAB_REFRESH_SEC = 300;
    const MIN_ONLINELAB_REFRESH_SEC = 300;
    const MAX_ONLINELAB_REFRESH_SEC = 900;

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
                return { onlineLabRefreshSec: DEFAULT_ONLINELAB_REFRESH_SEC };
            }

            const o = JSON.parse(raw);
            return {
                onlineLabRefreshSec: clamp(
                    o && o.onlineLabRefreshSec,
                    MIN_ONLINELAB_REFRESH_SEC,
                    MAX_ONLINELAB_REFRESH_SEC,
                    DEFAULT_ONLINELAB_REFRESH_SEC
                )
            };
        } catch {
            return { onlineLabRefreshSec: DEFAULT_ONLINELAB_REFRESH_SEC };
        }
    }

    function saveSettings(s) {
        const onlineLabRefreshSec = clamp(
            s && s.onlineLabRefreshSec,
            MIN_ONLINELAB_REFRESH_SEC,
            MAX_ONLINELAB_REFRESH_SEC,
            DEFAULT_ONLINELAB_REFRESH_SEC
        );

        localStorage.setItem(STORAGE_KEY, JSON.stringify({ onlineLabRefreshSec }));
    }

    function ensurePopup() {
        let el = document.querySelector(".rws-settings-pop");
        if (el) return el;

        el = document.createElement("div");
        el.className = "rws-settings-pop";
        el.innerHTML = `
      <div class="rws-pop-card">
        <div class="rws-pop-h">
          <div class="t">RWS Trend Settings</div>
          <button class="x" type="button" aria-label="Close">✕</button>
        </div>
        <div class="rws-pop-b">
          <div class="row">
            <div class="k">OnlineLab Refresh (sec) — applies to RW_NTU / RW_COND / RW_DO / RW_TEMP</div>
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

          <div class="hint">* Summary data ยัง refresh ตาม data-rws-refresh-sec เดิม</div>
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
      .rws-settings-pop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:999999}
      .rws-settings-pop.on{display:flex}
      .rws-pop-card{width:min(460px,92vw);background:#2b3136;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55);color:rgba(255,255,255,.92)}
      .rws-pop-h{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10)}
      .rws-pop-h .t{font-weight:700}
      .rws-pop-h .x{background:transparent;border:0;color:rgba(255,255,255,.9);font-size:16px;cursor:pointer}
      .rws-pop-b{padding:12px 14px}
      .rws-pop-b .row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0}
      .rws-pop-b .k{font-size:13px;color:rgba(255,255,255,.75)}
      .rws-pop-b .inp{width:140px;background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 10px;outline:none}
      .rws-pop-b .hint{margin-top:8px;font-size:12px;color:rgba(255,255,255,.60)}
      .rws-pop-b .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}
      .rws-pop-b .btn{background:#1f2326;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.92);border-radius:10px;padding:8px 12px;cursor:pointer}
      .rws-pop-b .btn.ghost{opacity:.85}
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
        const inpOnlineLab = popup.querySelector('[data-k="onlineLabRefreshSec"]');
        const closePop = () => popup.classList.remove("on");

        popup.querySelector(".x").onclick = closePop;
        popup.querySelector('[data-act="close"]').onclick = closePop;

        const btnSettings = sec.querySelector("#rwsBtnSettings");
        if (btnSettings) {
            btnSettings.style.pointerEvents = "auto";
            btnSettings.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();

                const s = loadSettings();
                inpOnlineLab.value = String(s.onlineLabRefreshSec);
                popup.classList.add("on");
            });
        }

        popup.querySelector('[data-act="apply"]').onclick = () => {
            const onlineLabRefreshSec = clamp(
                inpOnlineLab.value,
                MIN_ONLINELAB_REFRESH_SEC,
                MAX_ONLINELAB_REFRESH_SEC,
                DEFAULT_ONLINELAB_REFRESH_SEC
            );

            saveSettings({ onlineLabRefreshSec });
            closePop();

            if (window.RWSView && typeof window.RWSView.restartWithin === "function") {
                window.RWSView.restartWithin(document);
            }
        };
    }

    function initWithin(root) {
        const scope = root || document;
        const secs = scope.matches?.("section.rws-block")
            ? [scope]
            : Array.from(scope.querySelectorAll("section.rws-block"));

        secs.forEach(bindSection);
    }

    window.RWSOnlineSettings = {
        initWithin,
        loadSettings
    };
})();