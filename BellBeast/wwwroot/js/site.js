// =======================================================
// BellBeast AQ Filter (ASP.NET Razor Pages)
// - Server pagination/search via /api/aqtable?page=&pageSize=&q=&plant=&station=
// - Plant chips + Station chips (toggle)
// - Checkbox select per row (highlight)
// - Button: "เพิ่มเข้า รายการที่เลือก (n)"  (moves checked => selected)
// - Selected list table (removable)  (โชว์ 5 รายการแรก)
// - Save/Load template JSON
// - Proceed Query -> POST /api/process (server proxy -> backend-config.json)
// - Logout button -> POST /api/auth/logout -> redirect /Login
// =======================================================

console.log("site.js loaded OK", new Date().toISOString());

// --------------------------
// DOM refs
// --------------------------
const statusEl = document.getElementById("status");
const statusInlineEl = document.getElementById("statusInline");

const tbody = document.querySelector("#tbl tbody");
const qEl = document.getElementById("q");

const btnReset = document.getElementById("btnReset");
const btnPrev = document.getElementById("btnPrev");
const btnNext = document.getElementById("btnNext");
const pageInfo = document.getElementById("pageInfo");

const btnAddSelected = document.getElementById("btnAddSelected");
const selectedCountEl = document.getElementById("selectedCount");

const selectedTbody = document.querySelector("#tblSelected tbody");

const plantChipsEl = document.getElementById("plantChips");
const stationChipsEl = document.getElementById("stationChips");

const btnSaveTemplate = document.getElementById("btnSaveTemplate");
const btnLoadTemplate = document.getElementById("btnLoadTemplate");
const fileTemplate = document.getElementById("fileTemplate");

const btnProceed = document.getElementById("btnProceed");
const btnClearSelected = document.getElementById("btnClearSelected");
const beginDateEl = document.getElementById("beginDate");
const endDateEl = document.getElementById("endDate");

// logout
const btnLogout = document.getElementById("btnLogout");

// --------------------------
// State
// --------------------------
let currentPage = 1;
let pageSize = 50;
let lastTotal = 0;

let activePlant = "";               // empty = all
const activeStations = new Set();   // station_code multi-toggle

const checkedMap = new Map();       // key: configID, value: row
const selectedMap = new Map();      // key: configID, value: row

const PLANTS = ["ทุกโรงงาน", "MS", "BK", "SS", "SS1", "SS2", "SS3", "SS4", "TB", "WQ"];
const STATIONS = ["TPS", "DPS", "RWS", "CDS", "CTS", "QWS", "FWS", "CWS"];

// auth cache
let authUser = "";
let authToken = "";

// backend config cache (debug)
let backendBaseUrl = "";
let queryCsvPath = "";

// --------------------------
// Helpers
// --------------------------
function setStatusText(text) {
    if (statusEl) statusEl.textContent = text;
    if (statusInlineEl) statusInlineEl.textContent = text;
}

function setStatus(total) {
    const t = `ผลลัพธ์ (${Number(total || 0).toLocaleString()} แถว)`;
    setStatusText(t);
}

function setCheckedCount(n) {
    const val = String(Number(n || 0));
    if (selectedCountEl) selectedCountEl.textContent = val;
    if (btnAddSelected) btnAddSelected.disabled = (Number(n || 0) <= 0);
}

function updatePager() {
    const totalPages = Math.max(1, Math.ceil(lastTotal / pageSize));
    if (pageInfo) pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
    if (btnPrev) btnPrev.disabled = (currentPage <= 1);
    if (btnNext) btnNext.disabled = (currentPage >= totalPages);
}

function clearChecked() {
    checkedMap.clear();
    setCheckedCount(0);
}

function debounce(fn, ms) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

// --------------------------
// Auth + Backend config
// --------------------------
async function loadAuthMe(force = false) {
    if (!force && authUser && authToken) return { username: authUser, token: authToken };

    const res = await fetch("/api/auth/me", { cache: "no-store" });

    // ✅ session หมด -> เตะออก
    if (res.status === 401) {
        window.location.href = "/Login";
        return null;
    }

    if (!res.ok) return null;

    const data = await res.json().catch(() => null);
    if (!data) return null;

    authUser = data.username || "";
    authToken = data.token || "";
    return { username: authUser, token: authToken };
}


async function loadBackendConfig() {
    const res = await fetch("/api/backend-config", { cache: "no-store" });
    if (!res.ok) return null;

    const data = await res.json().catch(() => null);
    if (!data) return null;

    backendBaseUrl = (data.backendBaseUrl || "").trim();
    queryCsvPath = (data.queryCsvPath || "").trim();
    return { backendBaseUrl, queryCsvPath };
}

async function doLogout() {
    try {
        const res = await fetch("/api/auth/logout", { method: "POST" });
        if (!res.ok) {
            const t = await res.text().catch(() => "");
            alert("Logout ไม่สำเร็จ: " + (t || res.status));
            return;
        }
    } catch (e) {
        console.error(e);
    } finally {
        authUser = "";
        authToken = "";
        window.location.href = "/Login";
    }
}

// --------------------------
// Selected render (โชว์ 5 รายการแรก)
// --------------------------
function renderSelectedTable() {
    if (!selectedTbody) return;

    selectedTbody.innerHTML = "";

    const rows = Array.from(selectedMap.values())
        .sort((a, b) => Number(a.configID) - Number(b.configID))
        .slice(0, 5);

    for (const r of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td class="col-check"><button class="btn" data-remove="${r.configID}">ลบ</button></td>
      <td>${r.configID ?? ""}</td>
      <td>${r.plant ?? ""}</td>
      <td>${r.stationCode ?? ""}</td>
      <td>${r.param ?? ""}</td>
      <td>${r.equipment ?? ""}</td>
      <td>${r.measureTh ?? ""}</td>
    `;
        selectedTbody.appendChild(tr);
    }

    selectedTbody.querySelectorAll("button[data-remove]").forEach(btn => {
        btn.addEventListener("click", () => {
            const id = Number(btn.getAttribute("data-remove"));
            selectedMap.delete(id);
            renderSelectedTable();
            loadAqTable();
        });
    });
}

// --------------------------
// Chips render
// --------------------------
function renderChips() {
    // plant chips
    if (plantChipsEl) {
        plantChipsEl.innerHTML = "";
        for (const p of PLANTS) {
            const isOn = (p === "ทุกโรงงาน" && !activePlant) || (p === activePlant);

            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chip" + (isOn ? " on" : "");
            chip.textContent = p;

            chip.addEventListener("click", () => {
                activePlant = (p === "ทุกโรงงาน") ? "" : p;
                currentPage = 1;
                clearChecked();
                renderChips();
                loadAqTable();
            });

            plantChipsEl.appendChild(chip);
        }
    }

    // station chips (multi-toggle by station_code)
    if (stationChipsEl) {
        stationChipsEl.innerHTML = "";
        for (const s of STATIONS) {
            const isOn = activeStations.has(s);

            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chip" + (isOn ? " on" : "");
            chip.textContent = s;

            chip.addEventListener("click", () => {
                if (activeStations.has(s)) activeStations.delete(s);
                else activeStations.add(s);

                currentPage = 1;
                clearChecked();
                renderChips();
                loadAqTable();
            });

            stationChipsEl.appendChild(chip);
        }
    }
}

// --------------------------
// Load AQ Table
// --------------------------
async function loadAqTable() {
    try {
        const q = (qEl?.value || "").trim();
        const stationCsv = Array.from(activeStations).join(",");

        const url =
            `/api/aqtable?page=${currentPage}` +
            `&pageSize=${pageSize}` +
            `&q=${encodeURIComponent(q)}` +
            `&plant=${encodeURIComponent(activePlant)}` +
            `&station=${encodeURIComponent(stationCsv)}`;

        const res = await fetch(url);

        if (!res.ok) {
            const msg = await res.text().catch(() => "");
            console.error("API error:", res.status, msg);
            setStatusText(`API error: ${res.status}`);
            return;
        }

        const data = await res.json();

        lastTotal = Number(data.total || 0);
        setStatus(lastTotal);

        if (data.page && Number.isFinite(data.page)) currentPage = Number(data.page);
        updatePager();

        if (!tbody) return;
        tbody.innerHTML = "";

        const rows = data.rows || [];
        for (const r of rows) {
            // normalize row fields (สำคัญ: stationCode ต้องคงไว้)
            const norm = {
                configID: Number(r.configID || 0),
                plant: r.plant || "",
                station: r.station || "",           // station_name (ไว้โชว์)
                stationCode: r.stationCode || "",   // station_code (ไว้ยิง backend)
                param: r.param || "",
                equipment: r.equipment || "",
                measureTh: r.measureTh || "",
                measureEn: r.measureEn || ""
            };

            const id = Number(norm.configID);
            const tr = document.createElement("tr");

            if (selectedMap.has(id) || checkedMap.has(id)) tr.classList.add("is-selected");

            const checked = checkedMap.has(id);

            tr.innerHTML = `
        <td class="col-check">
          <input type="checkbox" class="row-check" data-id="${id}" ${checked ? "checked" : ""} />
        </td>
        <td>${norm.configID ?? ""}</td>
        <td>${norm.plant ?? ""}</td>
        <td>${norm.stationCode || norm.station || ""}</td>
        <td>${norm.param ?? ""}</td>
        <td>${norm.equipment ?? ""}</td>
        <td>${norm.measureTh ?? ""}</td>
      `;

            tbody.appendChild(tr);

            const cb = tr.querySelector(".row-check");

            function applyCheckedState(isChecked) {
                cb.checked = isChecked;

                if (isChecked) {
                    checkedMap.set(id, norm);
                    tr.classList.add("is-selected");
                } else {
                    checkedMap.delete(id);
                    if (!selectedMap.has(id)) tr.classList.remove("is-selected");
                }

                setCheckedCount(checkedMap.size);
            }

            cb.addEventListener("click", (ev) => ev.stopPropagation());
            cb.addEventListener("change", () => applyCheckedState(cb.checked));

            tr.addEventListener("click", (ev) => {
                const t = ev.target;
                if (!t) return;

                const tag = (t.tagName || "").toUpperCase();
                if (tag === "A" || tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "LABEL")
                    return;

                applyCheckedState(!cb.checked);
            });
        }

        setCheckedCount(checkedMap.size);

    } catch (err) {
        console.error(err);
        setStatusText("JS error (see Console)");
    }
}

// --------------------------
// Template mapping
// --------------------------
function toTemplateItem(r) {
    return {
        configparam_id: Number(r.configID || 0),
        plant_en: r.plant || "",
        station_name: r.station || "",
        Param_name: r.param || "",
        equipment_name: r.equipment || "",
        measure_th: r.measureTh || ""
    };
}

function fromTemplateItem(x) {
    return {
        configID: Number(x.configparam_id || 0),
        plant: x.plant_en || "",
        station: x.station_name || "",
        stationCode: "", // template ไม่มี station_code อยู่แล้ว
        param: x.Param_name || "",
        equipment: x.equipment_name || "",
        measureTh: x.measure_th || "",
        measureEn: ""
    };
}

// --------------------------
// CSV filename
// --------------------------
function pad2(n) { return String(n).padStart(2, "0"); }
function buildCsvFilename() {
    const d = new Date();
    const dd = pad2(d.getDate());
    const MM = pad2(d.getMonth() + 1);
    const yy = pad2(d.getFullYear() % 100);
    const HH = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    return `data_${dd}${MM}${yy}${HH}${mm}.csv`;
}

// --------------------------
// Events
// --------------------------
btnReset?.addEventListener("click", () => {
    if (qEl) qEl.value = "";
    activePlant = "";
    activeStations.clear();
    renderChips();
    currentPage = 1;
    clearChecked();
    loadAqTable();
});

const onSearchInput = debounce(() => {
    currentPage = 1;
    clearChecked();
    loadAqTable();
}, 180);
qEl?.addEventListener("input", onSearchInput);

btnPrev?.addEventListener("click", () => {
    if (currentPage > 1) currentPage--;
    clearChecked();
    loadAqTable();
});

btnNext?.addEventListener("click", () => {
    currentPage++;
    clearChecked();
    loadAqTable();
});

btnAddSelected?.addEventListener("click", () => {
    for (const [id, row] of checkedMap.entries()) {
        selectedMap.set(id, row);
    }
    clearChecked();
    renderSelectedTable();
    loadAqTable();
});

// Save template
btnSaveTemplate?.addEventListener("click", async () => {
    if (selectedMap.size === 0) {
        alert("ยังไม่มีรายการที่เลือก");
        return;
    }

    const name = (prompt("ตั้งชื่อ template (ถ้าไม่ใส่จะยกเลิก):") || "").trim();
    if (!name) return;

    const items = Array.from(selectedMap.values())
        .sort((a, b) => Number(a.configID) - Number(b.configID))
        .map(toTemplateItem);

    const res = await fetch("/api/template/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, items })
    });

    if (!res.ok) {
        const t = await res.text().catch(() => "");
        alert("Save ไม่สำเร็จ: " + (t || res.status));
        return;
    }

    const data = await res.json().catch(() => null);
    alert(`Save สำเร็จ\n${data?.path || ""}\n(${items.length} รายการ)`);
});

// Load template
btnLoadTemplate?.addEventListener("click", () => {
    if (!fileTemplate) return;
    fileTemplate.value = "";
    fileTemplate.click();
});

fileTemplate?.addEventListener("change", async () => {
    const f = fileTemplate.files?.[0];
    if (!f) return;

    try {
        const text = await f.text();
        const json = JSON.parse(text);

        const arr = Array.isArray(json) ? json : (Array.isArray(json?.items) ? json.items : null);
        if (!arr) {
            alert("ไฟล์ไม่ถูกต้อง: ต้องเป็น JSON Array หรือ { items: [...] }");
            return;
        }

        selectedMap.clear();
        for (const x of arr) {
            const r = fromTemplateItem(x);
            if (r.configID > 0) selectedMap.set(r.configID, r);
        }

        renderSelectedTable();
        clearChecked();
        await loadAqTable();

        alert(`Load สำเร็จ: ${selectedMap.size} รายการ`);
    } catch (e) {
        console.error(e);
        alert("Load ไม่สำเร็จ: ไฟล์ JSON ผิดรูปแบบ");
    }
});

// Clear selected
btnClearSelected?.addEventListener("click", () => {
    selectedMap.clear();
    clearChecked();
    renderSelectedTable();
    loadAqTable();
});

// ===============================
// Proceed Query (with busy lock + safe restore)
// ===============================
function setProceedBusy(isBusy) {
    if (!btnProceed) return;

    btnProceed.disabled = isBusy;
    btnProceed.dataset.originalText ??= btnProceed.textContent || "Proceed Query";
    btnProceed.textContent = isBusy ? "Processing..." : btnProceed.dataset.originalText;

    // กัน user กด Clear ระหว่างยิง (ถ้าต้องการ)
    if (btnClearSelected) btnClearSelected.disabled = isBusy;

    // (optional) กัน edit วันที่ระหว่างยิง
    if (beginDateEl) beginDateEl.disabled = isBusy;
    if (endDateEl) endDateEl.disabled = isBusy;
}

// Proceed Query
btnProceed?.addEventListener("click", async () => {
    // กันกดซ้ำ
    if (btnProceed?.disabled) return;

    const begin = (beginDateEl?.value || "").trim();
    const end = (endDateEl?.value || "").trim();

    if (!begin || !end) { alert("กรุณาเลือกวันเริ่มต้นและวันสิ้นสุด"); return; }
    if (selectedMap.size === 0) { alert("ยังไม่มีรายการที่เลือก"); return; }

    const me = await loadAuthMe();
    if (!me || !me.username || !me.token) { alert("ยังไม่ login หรือ session หมดอายุ"); return; }

    const configs = Array.from(selectedMap.values()).map(r => ({
        configID: String(r.configID),                 // ✅ string
        plant: String(r.plant || ""),
        station: String(r.stationCode || r.station || "")
    }));

    const payload = {
        begin,
        end,
        token: authToken,                             // หรือ me.token ก็ได้
        removeOddHour: false,
        opt: "",                                      // ✅ ต้องว่าง
        csvFilename: buildCsvFilename(),
        configs,
        user: authUser
    };

    setProceedBusy(true);
    try {
        const res = await fetch("/api/process", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        // ถ้าโดนเตะออก (cookie หมดอายุ) ให้กลับหน้า login
        if (res.status === 401) {
            alert("Session หมดอายุ กรุณา login ใหม่");
            window.location.href = "/Login";
            return;
        }

        if (!res.ok) {
            const t = await res.text().catch(() => "");
            alert("Proceed Query ไม่สำเร็จ: " + (t || res.status));
            return;
        }

        // รองรับกรณี backend ส่ง JSON กลับมา (กันพลาด)
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
            const data = await res.json().catch(() => null);
            if (data?.downloadUrl) {
                window.location.href = data.downloadUrl;
                return;
            }
            alert("Proceed Query สำเร็จ (JSON)");
            return;
        }

        const blob = await res.blob();
        if (!blob || blob.size === 0) {
            alert("ได้ไฟล์ 0KB (backend อาจตอบว่าง หรือ proxy ยังผิด)");
            return;
        }

        // filename จาก header ถ้ามี
        let filename = buildCsvFilename();
        const cd = res.headers.get("content-disposition") || "";
        const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
        if (m && m[1]) filename = decodeURIComponent(m[1]);

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

    } catch (e) {
        console.error(e);
        alert("Proceed Query ไม่สำเร็จ: JS error");
    } finally {
        setProceedBusy(false);
    }
});

// Logout
btnLogout?.addEventListener("click", async () => {
    if (!confirm("ต้องการออกจากระบบหรือไม่?")) return;
    await doLogout();
});

// Fix bug calendar
// ===============================
// Date constraint: End >= Begin
// ===============================
function syncDateConstraint() {
    const begin = beginDateEl?.value || "";
    if (begin && endDateEl) {
        // บังคับ end >= begin
        endDateEl.min = begin;

        // ถ้า end ต่ำกว่า begin → ดัน end ให้เท่ากับ begin
        if (endDateEl.value && endDateEl.value < begin) {
            endDateEl.value = begin;
        }
    }
}

beginDateEl?.addEventListener("change", syncDateConstraint);
endDateEl?.addEventListener("change", () => {
    const begin = beginDateEl?.value || "";
    const end = endDateEl?.value || "";
    if (begin && end && end < begin) {
        alert("วันสิ้นสุดต้องมากกว่าหรือเท่ากับวันเริ่มต้น");
        endDateEl.value = begin;
    }
});



// --------------------------
// Boot
// --------------------------
(async function boot() {
    await loadAuthMe().catch(() => null);
    await loadBackendConfig().catch(() => null);

    renderChips();
    setCheckedCount(0);
    setStatus(0);
    renderSelectedTable();
    await loadAqTable();
})();
