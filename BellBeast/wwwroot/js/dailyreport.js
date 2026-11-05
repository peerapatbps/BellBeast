// DailyReport page: status + downloads for MH_report and DailyLab.
// All calls go to LabVenture through BellBeast's /labventure/* proxy.
(function () {
    "use strict";

    const LV = "/labventure/api";
    const MAX_DAYS = 62; // same limit as LabVenture's DailyLab export
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
    const TH_DOW = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

    const $ = id => document.getElementById(id);

    // ===== state =====
    const mh = {};        // date → saved-dates row (last SAVE DB of the day)
    const lab = {};       // date → record-dates row
    const known = new Set(); // dates whose status has been fetched
    let labAvailable = null; // false when LabVenture has no /record-dates yet (old deploy)
    let calY, calM;       // calendar month (m = 1..12)
    let loadSeq = 0;      // newest loadStatus call wins
    let drag = null;      // { anchor, end } while dragging over the calendar

    // ===== dates (YYYY-MM-DD strings, Thai time) =====
    const thaiToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
    const monthStart = (y, m) => `${y}-${String(m).padStart(2, "0")}-01`;
    const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    function datesIn(from, to) {
        const out = [];
        for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
        return out;
    }
    function thaiShort(ymd) {
        const [y, m, d] = ymd.split("-").map(Number);
        return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${String((y + 543) % 100).padStart(2, "0")}`;
    }
    const dow = ymd => TH_DOW[new Date(ymd + "T00:00:00Z").getUTCDay()];

    function escapeHtml(s) {
        return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function setStatus(msg) { $("status").textContent = msg; }

    // ===== date inputs (native picker hidden, text shows d-MMM-yyyy like ChemReport) =====
    function ymdToDisplay(ymd) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
        return m ? `${Number(m[3])}-${MONTHS[Number(m[2]) - 1]}-${m[1]}` : (ymd || "");
    }
    function syncDateText(nativeId) {
        const native = $(nativeId);
        const text = document.querySelector(`[data-date-for="${nativeId}"]`);
        if (native && text) text.value = ymdToDisplay(native.value);
    }
    function getRange() { return { from: $("fromDate").value, to: $("toDate").value }; }
    function setRange(from, to) {
        $("fromDate").value = from;
        $("toDate").value = to;
        syncDateText("fromDate");
        syncDateText("toDate");
    }

    // ===== LabVenture connection: badge shows only when LabVenture can't be reached =====
    async function checkConnection() {
        const el = $("conn");
        const showError = text => { el.className = "dr-conn st-err"; el.textContent = text; el.hidden = false; };
        try {
            // any answer from LabVenture itself (200, or 401 = not logged in) means it is up
            const r = await fetch(`${LV}/auth/me`, { credentials: "same-origin" });
            if (r.ok || r.status === 401) el.hidden = true;
            else showError(r.status === 502 ? "LabVenture ไม่ได้เปิดอยู่" : `LabVenture error ${r.status}`);
        } catch {
            showError("ติดต่อ LabVenture ไม่ได้");
        }
    }

    // ===== fetch status =====
    async function getJson(url) {
        const r = await fetch(url, { credentials: "same-origin" });
        if (!r.ok) {
            const err = new Error(await errorText(r));
            err.status = r.status;
            throw err;
        }
        return r.json();
    }
    async function errorText(r) {
        if (r.status === 502) return "LabVenture ไม่ได้เปิดอยู่";
        try {
            const j = await r.clone().json();
            if (j && j.error) return j.error;
        } catch { /* not json */ }
        return `HTTP ${r.status}`;
    }

    async function fetchStatus(from, to) {
        const today = thaiToday();
        if (from > today) return;
        if (to > today) to = today;
        const qs = `from=${from}&to=${to}`;
        const [mhRes, labRes] = await Promise.allSettled([
            getJson(`${LV}/daily-report/saved-dates?${qs}`),
            getJson(`${LV}/write/record-dates?${qs}`),
        ]);
        if (mhRes.status === "rejected") throw mhRes.reason;

        for (const d of datesIn(from, to)) { delete mh[d]; delete lab[d]; known.add(d); }
        for (const row of mhRes.value || []) mh[row.date] = row;

        if (labRes.status === "fulfilled") {
            labAvailable = true;
            for (const row of labRes.value || []) lab[row.date] = row;
        } else if (labRes.reason && labRes.reason.status === 404) {
            labAvailable = false; // LabVenture not restarted with the new endpoint yet
        } else {
            throw labRes.reason;
        }
    }

    // ===== per-day status =====
    function info(d) {
        const today = thaiToday();
        const saved = mh[d] || null;
        const labN = lab[d] ? Number(lab[d].values_count) || 0 : 0;
        const live = d >= addDays(today, -1);
        const labKnown = labAvailable !== false;
        let state;
        if (d > today) state = "future";
        else if (!known.has(d)) state = "unknown";
        else if (!saved && live) state = "live";
        else if (!saved && (!labKnown || labN === 0)) state = "no";
        else if (saved && saved.reviewed_by && (!labKnown || labN > 0)) state = "ok";
        else state = "warn";
        return { saved, labN, labKnown, live, state };
    }

    // ===== calendar =====
    // Range to outline on the calendar; the whole shown month = nothing selected → no outline
    function isNoSelection() {
        const r = getRange();
        const end = monthEnd(calY, calM), today = thaiToday();
        return r.from === monthStart(calY, calM) && r.to === (end < today ? end : today);
    }
    function highlightRange() {
        return !drag && isNoSelection() ? { from: "9999", to: "0000" } : shownRange();
    }

    function shownRange() {
        if (!drag) return getRange();
        return drag.anchor <= drag.end ? { from: drag.anchor, to: drag.end } : { from: drag.end, to: drag.anchor };
    }

    function renderCalendar() {
        $("calMonth").textContent = `${TH_MONTHS[calM - 1]} ${calY + 543}`;
        const { from, to } = highlightRange();
        const today = thaiToday();
        const parts = TH_DOW.map(n => `<div class="dow">${n}</div>`);
        const first = new Date(Date.UTC(calY, calM - 1, 1)).getUTCDay();
        for (let i = 0; i < first; i++) parts.push("<div></div>");
        for (const d of datesIn(monthStart(calY, calM), monthEnd(calY, calM))) {
            const it = info(d);
            const cls = ["dr-day",
                it.state === "future" ? "future" : it.state === "unknown" ? "st-no" : `st-${it.state}`,
                d >= from && d <= to ? "in-range" : "",
                d === today ? "today" : ""].join(" ");
            const tags = [it.saved ? "MH" : "", it.labN > 0 ? "Lab" : ""].filter(Boolean).join(" · ");
            parts.push(`<div class="${cls}" data-date="${d}" title="${d}">${Number(d.slice(8))}<small>${tags || "&nbsp;"}</small></div>`);
        }
        $("cal").innerHTML = parts.join("");
    }

    // Only the range highlight changes while dragging — no full re-render
    function paintRange() {
        const { from, to } = highlightRange();
        document.querySelectorAll("#cal .dr-day[data-date]").forEach(el => {
            const d = el.dataset.date;
            el.classList.toggle("in-range", d >= from && d <= to);
        });
    }

    async function loadCalendarMonth() {
        renderCalendar();
        try {
            await fetchStatus(monthStart(calY, calM), monthEnd(calY, calM));
        } catch (e) {
            setStatus(`โหลดปฏิทินไม่สำเร็จ: ${e.message}`);
        }
        renderCalendar();
    }

    // ===== table =====
    function rangeDates() {
        const { from, to } = getRange();
        const today = thaiToday();
        return datesIn(from, to < today ? to : today).reverse(); // newest first
    }

    function mhCell(it) {
        if (it.saved) {
            const t = String(it.saved.saved_at || "");
            const time = /\d{2}:\d{2}/.exec(t.length > 10 ? t.slice(10) : t);
            const shift = it.saved.shift != null ? `ผลัด ${escapeHtml(it.saved.shift)}` : "SAVE แล้ว";
            return `<span class="pill ${it.saved.reviewed_by ? "st-ok" : "st-warn"}">SAVE ${shift}${time ? " · " + time[0] : ""}</span>`;
        }
        return it.live
            ? '<span class="pill st-live" title="วันนี้/เมื่อวาน ยังไม่ได้กด SAVE DB ที่หน้า DAILY">รอ SAVE DB</span>'
            : '<span class="pill st-no">ไม่มี</span>';
    }
    function peopleCell(it) {
        if (!it.saved) return '<span class="muted">—</span>';
        const p = it.saved.prepared_by ? escapeHtml(it.saved.prepared_by) : '<span class="muted">—</span>';
        const r = it.saved.reviewed_by ? escapeHtml(it.saved.reviewed_by) : "";
        return `${p}<span class="sub">${r ? "ทบทวน: " + r : "ยังไม่มีผู้ทบทวน"}</span>`;
    }
    function labCell(it, d) {
        if (!it.labKnown) return '<span class="pill st-no" title="LabVenture ยังไม่มี endpoint record-dates (ต้อง restart)">?</span>';
        if (!it.labN) return '<span class="pill st-no">ไม่มี</span>';
        const slots = lab[d] && lab[d].recorder_slots ? `<span class="sub">ลงชื่อ ${lab[d].recorder_slots} ผลัด</span>` : "";
        return `<span class="pill st-ok">${it.labN} ค่า</span>${slots}`;
    }
    function printCell(it, d) {
        const btns = [];
        if (it.saved) btns.push(`<button type="button" class="dr-btn secondary dr-print" data-dl="mh" data-date="${d}" title="MH_report ${d}">MH</button>`);
        if (!it.labKnown || it.labN) btns.push(`<button type="button" class="dr-btn secondary dr-print" data-dl="lab" data-date="${d}" title="DailyLab ${d}">Lab</button>`);
        return `<div class="dr-actions">${btns.join("")}</div>`;
    }
    function remarkCell(it) {
        const noMh = !it.saved;
        const noLab = it.labKnown && !it.labN; // unknown (old LabVenture) → don't claim it's missing
        const text = noMh && noLab ? "ไม่มีข้อมูล MH_report และ DailyLab"
            : noMh ? "ไม่มีข้อมูล MH_report"
            : noLab ? "ไม่มีข้อมูล DailyLab"
            : "";
        return text ? `<span class="dr-remark">${text}</span>` : "";
    }

    function renderTable() {
        const dates = rangeDates();
        const tbody = $("tbody");
        if (!dates.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="muted">ไม่มีวันที่ในช่วงนี้</td></tr>';
            return;
        }
        const unknownCell = '<span class="pill st-no" title="ยังโหลดสถานะไม่ได้">?</span>';
        tbody.innerHTML = dates.map(d => {
            const it = info(d);
            const date = `<td>${thaiShort(d)}<span class="sub">${dow(d)}</span></td>`;
            if (it.state === "unknown")
                return `<tr>${date}<td><span class="muted">—</span></td><td>${unknownCell}</td><td>${unknownCell}</td><td></td><td></td></tr>`;
            return `<tr>${date}<td>${peopleCell(it)}</td><td>${mhCell(it)}</td><td>${labCell(it, d)}</td><td>${printCell(it, d)}</td><td>${remarkCell(it)}</td></tr>`;
        }).join("");
        updateNote();
    }

    function updateNote() {
        const note = $("note");
        const msgs = [];
        if (labAvailable === false)
            msgs.push("LabVenture ยังไม่รู้จัก /record-dates — restart LabVenture เพื่อให้เห็นสถานะ DailyLab");
        note.hidden = !msgs.length;
        note.textContent = msgs.join("\n");
    }

    // Called on every date change (calendar, inputs, quick buttons)
    async function loadStatus() {
        const { from, to } = getRange();
        if (!from || !to || from > to) { setStatus("ช่วงวันที่ไม่ถูกต้อง"); return; }
        if (daysBetween(from, to) + 1 > MAX_DAYS) { setStatus(`เลือกได้ไม่เกิน ${MAX_DAYS} วัน`); return; }
        const seq = ++loadSeq;
        setStatus("กำลังโหลดสถานะ…");
        renderTable(); // shows what is already known right away
        try {
            await fetchStatus(from, to);
            if (seq === loadSeq) setStatus("Ready.");
        } catch (e) {
            if (seq === loadSeq) setStatus(`โหลดสถานะไม่สำเร็จ: ${e.message}`);
        }
        if (seq !== loadSeq) return;
        renderTable();
        renderCalendar();
    }

    // ===== downloads =====
    function fileNameFrom(resp, fallback) {
        const cd = resp.headers.get("Content-Disposition") || "";
        const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
        const plain = /filename="?([^";]+)"?/i.exec(cd);
        return plain ? plain[1] : fallback;
    }

    async function downloadFile(url, fallbackName) {
        let resp;
        try {
            resp = await fetch(url, { credentials: "same-origin" });
        } catch {
            return { ok: false, error: "ติดต่อ LabVenture ไม่ได้" };
        }
        if (!resp.ok) {
            if (resp.status === 401) return { ok: false, status: 401, error: "LabVenture ยังเป็นเวอร์ชันที่ต้อง login — restart LabVenture" };
            return { ok: false, status: resp.status, error: await errorText(resp) };
        }
        const blob = await resp.blob();
        const name = fileNameFrom(resp, fallbackName);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        return { ok: true, name };
    }

    const mhUrl = d => `${LV}/daily-report/export-mh.xlsx?date=${d}`;
    const labUrl = (from, to) => `${LV}/write/export.xlsx?from=${from}&to=${to}${$("optDosage").checked ? "&dosage=1" : ""}`;

    async function downloadOne(kind, d, btn) {
        if (btn) btn.disabled = true;
        setStatus(`กำลังดาวน์โหลด ${kind === "mh" ? "MH_report" : "DailyLab"} ${d}…`);
        const r = kind === "mh"
            ? await downloadFile(mhUrl(d), `MH_report_${d}.xlsx`)
            : await downloadFile(labUrl(d, d), `DailyLab_${d}.xlsx`);
        if (btn) btn.disabled = false;
        setStatus(r.ok ? `ดาวน์โหลดแล้ว: ${r.name}` : `ไม่สำเร็จ: ${r.error}`);
    }

    // Raw data table (no form): rows = date/time, columns = values, for the whole date range
    async function downloadTable() {
        const wantMh = $("optMh").checked, wantLab = $("optLab").checked;
        if (!wantMh && !wantLab) { setStatus("ติ๊ก MH_report หรือ DailyLab อย่างน้อย 1 อย่าง"); return; }
        const { from } = getRange();
        let { to } = getRange();
        const today = thaiToday();
        if (to > today) to = today;
        if (!from || from > to) { setStatus("ช่วงวันที่ไม่ถูกต้อง"); return; }
        const btn = $("btnTable");
        btn.disabled = true;
        setStatus(`กำลังสร้างตาราง ${from} – ${to}…`);
        const r = await downloadFile(`${LV}/write/table.xlsx?from=${from}&to=${to}${wantLab ? "&lab=1" : ""}${wantMh ? "&mh=1" : ""}`, `DailyReport_table_${from}_${to}.xlsx`);
        btn.disabled = false;
        if (r.ok) setStatus(`ดาวน์โหลดแล้ว: ${r.name}`);
        else if (r.status === 404) setStatus("ไม่สำเร็จ: LabVenture ยังไม่รู้จัก Download table — restart LabVenture ก่อน");
        else setStatus(`ไม่สำเร็จ: ${r.error}`);
    }

    function showMonthOf(ymd) {
        const [y, m] = ymd.split("-").map(Number);
        if (y === calY && m === calM) return false;
        calY = y; calM = m;
        return true;
    }

    // ===== calendar mouse / touch: click = one day, drag = range, Shift+click = extend =====
    function dayAt(x, y) {
        const el = document.elementFromPoint(x, y);
        const cell = el && el.closest ? el.closest("#cal .dr-day[data-date]") : null;
        return cell && !cell.classList.contains("future") ? cell.dataset.date : null;
    }
    function clampToMax(anchor, end) {
        if (Math.abs(daysBetween(anchor, end)) + 1 <= MAX_DAYS) return end;
        return addDays(anchor, end > anchor ? MAX_DAYS - 1 : -(MAX_DAYS - 1));
    }

    $("cal").addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        const d = dayAt(e.clientX, e.clientY);
        if (!d) return;
        e.preventDefault();
        const prev = getRange();
        drag = e.shiftKey && prev.from ? { anchor: prev.from, end: clampToMax(prev.from, d) } : { anchor: d, end: d };
        // clicking the day that is already the only one selected → unselect (show the whole month)
        drag.toggleOff = !e.shiftKey && prev.from === d && prev.to === d;
        paintRange();
    });
    document.addEventListener("pointermove", e => {
        if (!drag) return;
        const d = dayAt(e.clientX, e.clientY);
        if (!d) return;
        const end = clampToMax(drag.anchor, d);
        if (end !== drag.end) { drag.end = end; paintRange(); }
    });
    function finishDrag() {
        if (!drag) return;
        const { from, to } = shownRange();
        const toggleOff = drag.toggleOff && from === to && from === drag.anchor;
        drag = null;
        if (toggleOff) { selectWholeMonth(); return; }
        setRange(from, to);
        paintRange();
        loadStatus();
    }

    // No selection = the whole month shown in the calendar (up to today)
    function selectWholeMonth() {
        const end = monthEnd(calY, calM), today = thaiToday();
        setRange(monthStart(calY, calM), end < today ? end : today);
        paintRange();
        loadStatus();
    }
    document.addEventListener("pointerup", finishDrag);
    document.addEventListener("pointercancel", finishDrag);

    // ===== wiring =====
    document.querySelectorAll("[data-date-for]").forEach(text => {
        const native = $(text.dataset.dateFor);
        const open = () => { try { native.showPicker(); } catch { native.focus(); native.click(); } };
        text.addEventListener("click", open);
        text.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); open(); }
        });
        native.addEventListener("change", async () => {
            syncDateText(native.id);
            if (showMonthOf($("toDate").value)) await loadCalendarMonth(); else renderCalendar();
            loadStatus();
        });
        syncDateText(native.id);
    });

    $("btnTable").addEventListener("click", downloadTable);
    $("btnClear").addEventListener("click", selectWholeMonth);

    // Nothing selected → the table follows the month being shown
    async function changeMonth(step) {
        const followMonth = isNoSelection();
        calM += step;
        if (calM < 1) { calM = 12; calY--; }
        if (calM > 12) { calM = 1; calY++; }
        if (followMonth && monthStart(calY, calM) <= thaiToday()) {
            const end = monthEnd(calY, calM), today = thaiToday();
            setRange(monthStart(calY, calM), end < today ? end : today);
            await loadCalendarMonth();
            loadStatus();
        } else {
            loadCalendarMonth();
        }
    }
    $("calPrev").addEventListener("click", () => changeMonth(-1));
    $("calNext").addEventListener("click", () => changeMonth(1));

    $("tbody").addEventListener("click", e => {
        const b = e.target.closest("[data-dl]");
        if (b) downloadOne(b.dataset.dl, b.dataset.date, b);
    });

    // Back to this tab → re-check whether LabVenture is up
    window.addEventListener("focus", checkConnection);

    // ===== init =====
    (async function init() {
        const to = $("toDate").value || thaiToday();
        [calY, calM] = to.split("-").map(Number);
        checkConnection();
        await loadCalendarMonth();
        loadStatus();
    })();
})();
