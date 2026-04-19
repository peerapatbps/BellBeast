(function () {
    const STORAGE_KEY = "bb_cldetector_refresh_sec";
    const DEFAULT_REFRESH_SEC = 5;

    function loadRefreshSec() {
        const raw = localStorage.getItem(STORAGE_KEY);
        const n = Number(raw);
        return Number.isFinite(n) && n >= 5 && n <= 60 ? n : DEFAULT_REFRESH_SEC;
    }

    function saveRefreshSec(sec) {
        localStorage.setItem(STORAGE_KEY, String(sec));
    }

    function ensureStyles() {
        if (document.getElementById("cldetector-settings-style")) return;

        const css = `
.cld-settings-overlay{
    position:fixed;
    inset:0;
    background:rgba(4,10,18,.55);
    backdrop-filter:blur(10px);
    display:flex;
    align-items:center;
    justify-content:center;
    z-index:9999;
}
.cld-settings-modal{
    width:min(420px, calc(100vw - 24px));
    border-radius:22px;
    border:1px solid rgba(255,255,255,.10);
    background:
        linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.03)),
        linear-gradient(135deg, rgba(20,28,40,.97), rgba(9,14,24,.99));
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,.06),
        0 24px 60px rgba(0,0,0,.35);
    color:#eef4ff;
    overflow:hidden;
}
.cld-settings-head{
    display:flex;
    align-items:center;
    justify-content:space-between;
    padding:14px 16px;
    border-bottom:1px solid rgba(255,255,255,.08);
    font-weight:900;
    font-size:14px;
}
.cld-settings-body{
    padding:16px;
}
.cld-settings-row{
    display:flex;
    flex-direction:column;
    gap:8px;
}
.cld-settings-label{
    font-size:12px;
    font-weight:800;
    color:rgba(230,238,248,.88);
}
.cld-settings-select{
    width:100%;
    height:42px;
    border-radius:14px;
    border:1px solid rgba(255,255,255,.10);
    background:rgba(15,23,36,.96);
    color:#eef4ff;
    padding:0 12px;
    font-size:14px;
    outline:none;
}
.cld-settings-actions{
    display:flex;
    justify-content:flex-end;
    gap:10px;
    margin-top:16px;
}
.cld-settings-btn{
    height:38px;
    min-width:88px;
    padding:0 14px;
    border-radius:12px;
    border:1px solid rgba(255,255,255,.10);
    background:rgba(255,255,255,.06);
    color:#eef4ff;
    font-weight:800;
    cursor:pointer;
}
.cld-settings-btn.primary{
    background:linear-gradient(180deg, rgba(59,130,246,.95), rgba(37,99,235,.95));
    border-color:rgba(255,255,255,.12);
}
.cld-settings-close{
    background:none;
    border:none;
    color:#eef4ff;
    font-size:18px;
    cursor:pointer;
    padding:0 4px;
}
        `.trim();

        const style = document.createElement("style");
        style.id = "cldetector-settings-style";
        style.textContent = css;
        document.head.appendChild(style);
    }

    function buildOptions(selectedSec) {
        const options = [5, 10, 15, 20, 30, 45, 60];
        return options.map(sec => {
            const selected = sec === selectedSec ? " selected" : "";
            const label = sec < 60 ? `${sec} วินาที` : "1 นาที";
            return `<option value="${sec}"${selected}>${label}</option>`;
        }).join("");
    }

    function closeModal() {
        const el = document.querySelector(".cld-settings-overlay");
        if (el) el.remove();
    }

    function openModal(block) {
        closeModal();
        ensureStyles();

        const selectedSec = loadRefreshSec();

        const overlay = document.createElement("div");
        overlay.className = "cld-settings-overlay";
        overlay.innerHTML = `
            <div class="cld-settings-modal" role="dialog" aria-modal="true" aria-label="CL Detector Settings">
                <div class="cld-settings-head">
                    <span>CL Detector Settings</span>
                    <button type="button" class="cld-settings-close" aria-label="Close">✕</button>
                </div>
                <div class="cld-settings-body">
                    <div class="cld-settings-row">
                        <label class="cld-settings-label" for="cldRefreshSelect">Data refresh rate</label>
                        <select id="cldRefreshSelect" class="cld-settings-select">
                            ${buildOptions(selectedSec)}
                        </select>
                    </div>
                    <div class="cld-settings-actions">
                        <button type="button" class="cld-settings-btn" data-action="cancel">Cancel</button>
                        <button type="button" class="cld-settings-btn primary" data-action="save">Save</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const modal = overlay.querySelector(".cld-settings-modal");
        const closeBtn = overlay.querySelector(".cld-settings-close");
        const cancelBtn = overlay.querySelector('[data-action="cancel"]');
        const saveBtn = overlay.querySelector('[data-action="save"]');
        const select = overlay.querySelector("#cldRefreshSelect");

        function applyAndClose() {
            const sec = Number(select.value) || DEFAULT_REFRESH_SEC;
            saveRefreshSec(sec);

            if (block) {
                block.setAttribute("data-refresh-sec", String(sec));
            }

            closeModal();

            if (window.CLDetectorView && typeof window.CLDetectorView.restart === "function") {
                window.CLDetectorView.restart();
            } else if (window.CLDetectorView && typeof window.CLDetectorView.refresh === "function") {
                window.CLDetectorView.refresh();
            }
        }

        closeBtn.addEventListener("click", closeModal);
        cancelBtn.addEventListener("click", closeModal);
        saveBtn.addEventListener("click", applyAndClose);

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeModal();
        });

        overlay.addEventListener("keydown", (e) => {
            if (e.key === "Escape") closeModal();
        });

        setTimeout(() => modal.focus?.(), 0);
    }

    function bindWithin(root) {
        const scope = root || document;
        const block = scope.querySelector(".cldetector-block");
        if (!block) return;

        const settingsBtn = block.querySelector('.bb-section-h .bb-ico[title="Settings"], .bb-section-h .bb-ico[aria-label="Settings"]');
        if (!settingsBtn) return;

        if (settingsBtn.dataset.cldSettingsBound === "1") return;
        settingsBtn.dataset.cldSettingsBound = "1";

        const savedSec = loadRefreshSec();
        block.setAttribute("data-refresh-sec", String(savedSec));

        settingsBtn.addEventListener("click", (e) => {
            e.preventDefault();
            openModal(block);
        });
    }

    window.CLDetectorSettings = {
        initWithin: bindWithin,
        open: () => {
            const block = document.querySelector(".cldetector-block");
            if (block) openModal(block);
        }
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => bindWithin(document), { once: true });
    } else {
        bindWithin(document);
    }
})();