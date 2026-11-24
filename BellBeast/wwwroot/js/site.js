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
const chkAllEl = document.getElementById("chkAll");
const btnSelPrev = document.getElementById("btnSelPrev");
const btnSelNext = document.getElementById("btnSelNext");
const selPageInfo = document.getElementById("selPageInfo");
const selTotalEl = document.getElementById("selTotal");

const plantSelectEl = document.getElementById("plantSelect");
const plantFullNameEl = document.getElementById("plantFullName");
const stationSwitchesEl = document.getElementById("stationSwitches");

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

// activePlant: null = ยังไม่ได้เลือก, "" = ทุกโรงงาน, อื่นๆ = plant_en
// (null กับ "" query เหมือนกัน — ต่างกันแค่สิ่งที่ dropdown แสดง)
let activePlant = null;
const activeStations = new Set();   // station_code multi-toggle

const checkedMap = new Map();       // key: configID, value: row
const selectedMap = new Map();      // key: configID, value: row

// "รายการที่เลือก" แสดงทีละหน้า
const SELECTED_PAGE_SIZE = 10;
let selectedPage = 1;

// ลำดับที่อยากให้แสดง — ตัวที่มีจริงมาจาก /api/stations (ตัวที่ไม่อยู่ในลิสต์นี้จะต่อท้าย)
const PLANT_ORDER = ["MS", "BK", "SS", "SS1", "SS2", "SS3", "SS4", "TB", "WQ", "SL", "PS"];
const STATION_ORDER = ["TPS", "DPS", "RWS", "SRWS", "CDS", "CTS", "QWS", "FWS", "CWS"];
const ALL_PLANTS_LABEL = "ทุกโรงงาน";

// ชื่อเต็มของโรงงาน (จาก Plant export; aqtable เก็บแค่ code — SS* ในแอป = SM* ใน source)
const PLANT_NAMES = {
    BK: ["โรงงานผลิตน้ำบางเขน", "Bangkhen"],
    MS: ["โรงงานผลิตน้ำมหาสวัสดิ์", "Mahasawat"],
    SS: ["โรงงานผลิตน้ำสามเสน", "Samsen"],
    SS1: ["โรงงานผลิตน้ำสามเสน 1", "Samsen 1"],
    SS2: ["โรงงานผลิตน้ำสามเสน 2", "Samsen 2"],
    SS3: ["โรงงานผลิตน้ำสามเสน 3", "Samsen 3"],
    SS4: ["โรงงานผลิตน้ำสามเสน 4", "Samsen 4"],
    TB: ["โรงงานผลิตน้ำธนบุรี", "Thonburi"],
    WQ: ["ฝ่ายคุณภาพน้ำ (ฝคภ.)", "Water Quality"],
    PL: ["ฝ่ายทรัพยากรน้ำและสิ่งแวดล้อม (ฝนส.)", ""],
    PS: ["ฝ่ายระบบส่งน้ำดิบ (ฝรด.)", ""],
    SL: ["ส่วนสถานีสูบน้ำดิบสำแล กองระบบส่งน้ำดิบฝั่งตะวันออก", "Samlae Raw Water Pumping Station"],
};

// plant_en -> Set(station_code)   และ station_code -> Set(station_name) (ไว้ทำ tooltip)
// ถ้าโหลด /api/stations ไม่ได้ จะใช้ ORDER ข้างบนแบบไม่กรองสถานี
let plantStations = new Map();
let stationNames = new Map();
let PLANTS = [...PLANT_ORDER];
let STATIONS = [...STATION_ORDER];

const byOrder = (order) => (a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia !== ib) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    return a.localeCompare(b);
};

// auth cache
let authUser = "";
let authOk = false; // token stays server-side; /api/process injects it

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
    if (!force && authUser && authOk) return { username: authUser, authenticated: true };

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
    authOk = data.authenticated === true;
    return { username: authUser, authenticated: authOk };
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
        authOk = false;
        window.location.href = "/Login";
    }
}

// --------------------------
// Selected render (ทีละ SELECTED_PAGE_SIZE รายการ + Prev/Next)
// --------------------------
function renderSelectedTable() {
    if (!selectedTbody) return;

    selectedTbody.innerHTML = "";

    const all = Array.from(selectedMap.values())
        .sort((a, b) => Number(a.configID) - Number(b.configID));

    const totalPages = Math.max(1, Math.ceil(all.length / SELECTED_PAGE_SIZE));
    selectedPage = Math.min(Math.max(1, selectedPage), totalPages); // หน้าเกินหลังลบ/clear → ถอยกลับ

    if (selTotalEl) selTotalEl.textContent = String(all.length);
    if (selPageInfo) selPageInfo.textContent = `Page ${selectedPage} / ${totalPages}`;
    if (btnSelPrev) btnSelPrev.disabled = (selectedPage <= 1);
    if (btnSelNext) btnSelNext.disabled = (selectedPage >= totalPages);

    const start = (selectedPage - 1) * SELECTED_PAGE_SIZE;
    const rows = all.slice(start, start + SELECTED_PAGE_SIZE);

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
// โหลด plant -> stations จาก aqtable (ผ่าน /api/stations)
async function loadStationMap() {
    const res = await fetch("/api/stations");
    if (!res.ok) throw new Error(`stations ${res.status}`);
    const data = await res.json();

    const ps = new Map(), names = new Map();
    for (const r of data.rows || []) {
        const plant = r.plant || "", code = r.stationCode || "";
        if (!plant || !code) continue;
        if (!ps.has(plant)) ps.set(plant, new Set());
        ps.get(plant).add(code);
        if (!names.has(code)) names.set(code, new Set());
        if (r.stationName) names.get(code).add(`${plant}: ${r.stationName}`);
    }
    if (ps.size === 0) return;

    plantStations = ps;
    stationNames = names;
    PLANTS = [...ps.keys()].sort(byOrder(PLANT_ORDER));
    STATIONS = [...new Set([...ps.values()].flatMap(s => [...s]))].sort(byOrder(STATION_ORDER));
}

// สถานีที่เกี่ยวข้องกับ plant ที่เลือก (ไม่เลือก / ทุกโรงงาน = ทั้งหมด)
function visibleStations() {
    if (!activePlant || !plantStations.has(activePlant)) return STATIONS;
    const set = plantStations.get(activePlant);
    return STATIONS.filter(s => set.has(s));
}

function onFilterChanged() {
    currentPage = 1;
    clearChecked();
    renderChips();
    loadAqTable();
}

function renderPlantSelect() {
    if (!plantSelectEl) return;
    plantSelectEl.innerHTML = "";

    const add = (value, label) => {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        plantSelectEl.appendChild(o);
        return o;
    };

    if (activePlant === null) {
        const ph = add("__none__", "— เลือกโรงงาน —");
        ph.disabled = true;
    }
    add("", ALL_PLANTS_LABEL);
    for (const p of PLANTS) add(p, p);

    plantSelectEl.value = activePlant === null ? "__none__" : activePlant;

    if (plantFullNameEl) {
        plantFullNameEl.innerHTML = "";
        const [th, en] = PLANT_NAMES[activePlant] || [];
        if (activePlant && th) {
            const t = document.createElement("div");
            t.className = "plant-name-th";
            t.textContent = th;
            plantFullNameEl.appendChild(t);
            if (en) {
                const e = document.createElement("div");
                e.className = "plant-name-en";
                e.textContent = en;
                plantFullNameEl.appendChild(e);
            }
        }
    }
}

function renderStationSwitches() {
    if (!stationSwitchesEl) return;
    stationSwitchesEl.innerHTML = "";
    // คอลัมน์คงที่ตามจำนวนสถานีทั้งหมด -> filter แล้ว toggle ไม่ยืดขนาด
    stationSwitchesEl.style.setProperty("--station-cols", String(Math.max(STATIONS.length, 1)));

    for (const s of visibleStations()) {
        const isOn = activeStations.has(s);

        const label = document.createElement("label");
        label.className = "switch" + (isOn ? " on" : "");
        const names = stationNames.get(s);
        if (names && names.size) label.title = [...names].join("\n");

        const input = document.createElement("input");
        input.type = "checkbox";
        input.setAttribute("role", "switch");
        input.checked = isOn;
        input.value = s;

        const track = document.createElement("span");
        track.className = "switch-track";
        track.setAttribute("aria-hidden", "true");

        const text = document.createElement("span");
        text.className = "switch-label";
        text.textContent = s;

        input.addEventListener("change", () => {
            if (input.checked) activeStations.add(s);
            else activeStations.delete(s);

            // เลือกสถานีก่อน plant -> plant = ทุกโรงงาน อัตโนมัติ
            if (activePlant === null) activePlant = "";

            onFilterChanged();
        });

        label.append(input, track, text);
        stationSwitchesEl.appendChild(label);
    }
}

plantSelectEl?.addEventListener("change", () => {
    activePlant = plantSelectEl.value;

    // เลือก plant -> ตัดสถานีที่ไม่เกี่ยวข้องออก (ทั้งที่แสดงและที่เลือกค้างไว้)
    const keep = new Set(visibleStations());
    for (const s of [...activeStations]) if (!keep.has(s)) activeStations.delete(s);

    onFilterChanged();
});

function renderChips() {
    renderPlantSelect();
    renderStationSwitches();
}

// --------------------------
// "เลือกทั้งหมด" (เฉพาะแถวในหน้าผลลัพธ์ปัจจุบัน)
// --------------------------
function syncCheckAll() {
    if (!chkAllEl || !tbody) return;
    const boxes = Array.from(tbody.querySelectorAll(".row-check"));
    const n = boxes.filter(b => b.checked).length;
    chkAllEl.disabled = boxes.length === 0;
    chkAllEl.checked = boxes.length > 0 && n === boxes.length;
    chkAllEl.indeterminate = n > 0 && n < boxes.length;
}

chkAllEl?.addEventListener("change", () => {
    if (!tbody) return;
    const target = chkAllEl.checked;
    tbody.querySelectorAll(".row-check").forEach(cb => {
        if (cb.checked !== target) {
            cb.checked = target;
            cb.dispatchEvent(new Event("change")); // ใช้ applyCheckedState ของแต่ละแถว
        }
    });
    syncCheckAll();
});

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
            `&plant=${encodeURIComponent(activePlant || "")}` +
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
                syncCheckAll();
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
        syncCheckAll();

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
    activePlant = null;
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

btnSelPrev?.addEventListener("click", () => {
    selectedPage--;
    renderSelectedTable();
});

btnSelNext?.addEventListener("click", () => {
    selectedPage++;
    renderSelectedTable();
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

    const blob = await res.blob();
    const fileName = res.headers.get("Content-Disposition")?.match(/filename\*?=(?:UTF-8''|"?)([^";\r\n]+)/i)?.[1]
        ?? (name.endsWith(".json") ? name : name + ".json");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = decodeURIComponent(fileName);
    a.click();
    URL.revokeObjectURL(url);
    alert(`Save สำเร็จ — ดาวน์โหลด ${a.download} (${items.length} รายการ)`);
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
    if (!me || !me.username || !me.authenticated) { alert("ยังไม่ login หรือ session หมดอายุ"); return; }

    const configs = Array.from(selectedMap.values()).map(r => ({
        configID: String(r.configID),                 // ✅ string
        plant: String(r.plant || ""),
        station: String(r.stationCode || r.station || "")
    }));

    const payload = {
        begin,
        end,
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

// Logout — styled confirm modal (replaces window.confirm)
const logoutModal = document.getElementById("logoutModal");
const logoutCancel = document.getElementById("logoutCancel");
const logoutConfirm = document.getElementById("logoutConfirm");

function openLogoutModal() {
    if (!logoutModal) { if (confirm("ต้องการออกจากระบบหรือไม่?")) doLogout(); return; }
    logoutModal.hidden = false;
    logoutConfirm?.focus();
    document.addEventListener("keydown", onLogoutKey);
}
function closeLogoutModal() {
    if (!logoutModal) return;
    logoutModal.hidden = true;
    document.removeEventListener("keydown", onLogoutKey);
    btnLogout?.focus();
}
function onLogoutKey(e) {
    if (e.key === "Escape") closeLogoutModal();
}

btnLogout?.addEventListener("click", openLogoutModal);
logoutCancel?.addEventListener("click", closeLogoutModal);
// click on the dimmed backdrop (outside the dialog) closes it
logoutModal?.addEventListener("click", (e) => { if (e.target === logoutModal) closeLogoutModal(); });
logoutConfirm?.addEventListener("click", async () => {
    logoutConfirm.disabled = true;
    try { await doLogout(); }
    finally { logoutConfirm.disabled = false; }
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
    await loadStationMap().catch(e => console.warn("station map:", e));

    renderChips();
    setCheckedCount(0);
    setStatus(0);
    renderSelectedTable();
    await loadAqTable();
})();
