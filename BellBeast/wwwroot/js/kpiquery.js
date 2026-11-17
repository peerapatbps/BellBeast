// KPI Query page — 2 มุมมอง: CAR Log (ค่าเริ่มต้น; ทะเบียน + รายละเอียดใบ) และ KPI (ตัวชี้วัด Output/Outcome ตาม CAR Lean proposal)
// ข้อมูลจาก LabVenture /api/car และ /api/kpi ผ่าน proxy /labventure/* ของ BellBeast (อ่านได้โดยไม่ login;
// ปุ่ม "คำนวณใหม่" ต้อง login LabVenture เป็น Admin) · หน้านี้อ่านอย่างเดียว — แก้ไข CAR ทำที่ LabVenture
(function () {
    "use strict";

    const LV = "/labventure/api";
    const $ = id => document.getElementById(id);
    // ชื่อสถานะเดียวกับหน้า CAR ของ LabVenture (CARLog.jsx STATUS)
    const CAR_STATUS = { 10: "ออกใบแล้ว", 15: "ส่งต่อแล้ว", 20: "รออนุมัติ", 30: "รอติดตาม#1", 40: "รอติดตาม#2", 50: "แก้ไขแล้ว", 60: "ปิด", 70: "ตีกลับ" };
    const SLOT_STATUS = { on_time: ["ตรงเวลา", "st-ok"], late: ["ช้า", "st-warn"], missing: ["ขาด", "lv-red"], unknown: ["ไม่ทราบเวลา", "st-no"], pending: ["ยังไม่ถึงกำหนด", "st-no"] };

    const state = {
        summary: null, options: null, trend: "breach_escalation_pct", tab: "episodes", seq: 0,
        view: "car", kpiKey: null,                                   // KPI โหลดเมื่อเปิดมุมมอง KPI ครั้งแรก / เมื่อช่วงวันที่เปลี่ยน
        cars: null, clSeq: 0, clStatus: "", openId: null, pendingKey: null,
    };

    // ===== utils =====
    const thaiToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function thaiDate(ymd) {
        if (!ymd) return "—";
        const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
        return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${String((y + 543) % 100).padStart(2, "0")}`;
    }
    const thaiDT = iso => (iso ? `${thaiDate(iso)} ${String(iso).slice(11, 16)}` : "—");
    function fmtNum(v, digits) {
        if (v == null || !Number.isFinite(Number(v))) return "—";
        return Number(v).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
    }
    function fmtVal(v, def) {
        if (v == null) return "—";
        if (def.unit === "%") return fmtNum(v, 1);
        if (def.unit === "ชม.") return fmtNum(v, v < 10 ? 1 : 0);
        if (def.unit === "บาท") return fmtNum(v, 0);
        return fmtNum(v, 1);
    }
    const hoursText = h => (h == null ? "—" : h >= 48 ? `${fmtNum(h / 24, 1)} วัน` : `${fmtNum(h, 1)} ชม.`);
    function setStatus(msg) { $("status").textContent = msg; }

    async function getJson(url, opts) {
        const r = await fetch(url, { credentials: "same-origin", ...(opts || {}) });
        if (!r.ok) {
            let msg = r.status === 502 ? "LabVenture ไม่ได้เปิดอยู่" : `HTTP ${r.status}`;
            try { const j = await r.clone().json(); if (j && j.error) msg = j.error; } catch { /* not json */ }
            const e = new Error(msg); e.status = r.status; throw e;
        }
        return r.json();
    }
    const range = () => {
        let from = $("fromDate").value, to = $("toDate").value;
        if (from > to) [from, to] = [to, from];
        return { from, to };
    };
    const qs = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== "" && v != null)).toString();

    // ===== presets =====
    function applyPreset(p) {
        const today = thaiToday();
        let from = today;
        if (p === "month") from = today.slice(0, 8) + "01";
        else if (p === "fy") { const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)); from = `${m >= 10 ? y : y - 1}-10-01`; }
        else from = addDays(today, -(Number(p) - 1));
        $("fromDate").value = from;
        $("toDate").value = today;
        document.querySelectorAll("#presets .kq-btn").forEach(b => b.classList.toggle("on", b.dataset.preset === p));
        refresh();
    }

    // ===== tiles =====
    function delta(m) {
        const cur = m.agg === "sum" ? m.per_year : m.current && m.current.value;
        const base = m.agg === "sum" ? m.baseline_per_year : m.baseline && m.baseline.value;
        if (cur == null || base == null || m.direction === "info") return "";
        // จำนวนนับที่ "ยิ่งมากยิ่งดี" (เช่น ปัญหาที่ถูกแก้ก่อนลาม) ขึ้นกับจำนวนเหตุการณ์ทั้งหมด → เทียบต่อปีแล้วตัดสินดี/แย่ไม่ได้
        if (m.agg === "sum" && m.direction === "up") return "";
        const diff = cur - base;
        if (Math.abs(diff) < 1e-9) return `<span class="kq-delta flat">= เท่าเดิม</span>`;
        const good = m.direction === "down" ? diff < 0 : diff > 0;
        const unit = m.unit === "%" ? " จุด" : "";
        return `<span class="kq-delta ${good ? "good" : "bad"}">${diff > 0 ? "▲" : "▼"} ${fmtVal(Math.abs(diff), m)}${unit} · ${good ? "ดีขึ้น" : "แย่ลง"}</span>`;
    }
    function tile(m) {
        const cur = m.current;
        const isSum = m.agg === "sum";
        const v = cur ? cur.value : null;
        let basis = "";
        if (cur && m.agg === "ratio") basis = `${fmtNum(cur.num, 0)} / ${fmtNum(cur.den, 0)}`;
        else if (cur && m.agg === "mean") basis = `${fmtNum(cur.den, 0)} ใบ${cur.extra ? ` · มัธยฐาน ${hoursText(cur.extra.median)}` : ""}`;
        else if (isSum && m.per_year != null) basis = `≈ ${fmtVal(m.per_year, m)} ${m.unit}/ปี`;
        const b = m.baseline;
        const baseV = isSum ? m.baseline_per_year : b && b.value;
        const baseTxt = baseV == null ? "baseline: ยังไม่มี" : `baseline: ${fmtVal(baseV, m)} ${m.unit}${isSum ? "/ปี" : ""}${b && b.manual ? " (กรอก)" : ""}`;
        const target = m.target != null ? ` · เป้า ${fmtVal(m.target, m)} ${m.unit}` : "";
        return `<div class="kq-tile${state.trend === m.code ? " sel" : ""}" data-code="${esc(m.code)}" title="${esc(m.description)}">
            <div class="t">${m.direction === "down" ? "↓" : m.direction === "up" ? "↑" : "·"} ${esc(m.name_th)}</div>
            <div class="v">${fmtVal(v, m)}<span class="u">${esc(m.unit)}</span></div>
            <div class="b">${esc(baseTxt)}${esc(target)} ${delta(m)}</div>
            <div class="n">${esc(basis)}</div>
        </div>`;
    }
    function renderTiles() {
        const ms = state.summary ? state.summary.metrics : [];
        $("tilesOutcome").innerHTML = ms.filter(m => m.tier === "outcome").map(tile).join("");
        $("tilesProof").innerHTML = ms.filter(m => m.tier === "outcome_proof").map(tile).join("");
        $("tilesOutput").innerHTML = ms.filter(m => m.tier === "output").map(tile).join("");
        document.querySelectorAll(".kq-tile").forEach(el => el.addEventListener("click", () => {
            state.trend = el.dataset.code;
            renderTiles();
            loadTrend();
        }));
    }

    // ===== trend chart (single series + baseline reference line) =====
    async function loadTrend() {
        const m = (state.summary?.metrics || []).find(x => x.code === state.trend);
        if (!m) return;
        $("trendTitle").textContent = `แนวโน้ม: ${m.name_th}`;
        const pt = $("trendPeriod").value;
        const { from, to } = range();
        try {
            const j = await getJson(`${LV}/kpi/values?${qs({ metric: m.code, period_type: pt, from, to, source: "live" })}`);
            drawChart(m, j.rows, pt);
        } catch (e) { $("chart").innerHTML = `<div class="kq-tip" id="tip" hidden></div><div class="muted" style="padding:20px;">${esc(e.message)}</div>`; }
    }
    function periodLabel(ps, pt) {
        if (pt === "fiscal_year") return `ปีงบ ${Number(ps.slice(0, 4)) + 544}`;
        if (pt === "month") { const [y, mm] = ps.split("-").map(Number); return `${String(mm).padStart(2, "0")}/${String((y + 543) % 100).padStart(2, "0")}`; }
        return thaiDate(ps);
    }
    function drawChart(m, rows, pt) {
        const box = $("chart");
        const W = box.clientWidth || 600, H = box.clientHeight || 240;
        const pad = { l: 46, r: 14, t: 12, b: 28 };
        const pts = rows.filter(r => r.value != null).map(r => ({ x: r.period_start, v: Number(r.value), r }));
        const baseV = m.agg === "sum" ? null : m.baseline && m.baseline.value;   // sum ต่อช่วงเทียบ baseline ต่อปีไม่ได้ → ไม่วาดเส้น
        if (!pts.length) {
            box.innerHTML = `<div class="kq-tip" id="tip" hidden></div><div class="muted" style="padding:20px; color:rgba(232,238,252,.5)">ไม่มีข้อมูลในช่วงนี้</div>`;
            return;
        }
        let max = Math.max(...pts.map(p => p.v), baseV ?? 0);
        if (m.unit === "%") max = Math.max(max, 10) > 60 ? 100 : Math.ceil(Math.max(max, 10) / 10) * 10;
        else max = max <= 0 ? 1 : max * 1.15;
        const x = i => pad.l + (pts.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (pts.length - 1));
        const y = v => pad.t + (1 - v / max) * (H - pad.t - pad.b);
        let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(m.name_th)}">`;
        for (let k = 0; k <= 4; k++) {
            const gv = (max * k) / 4, gy = y(gv);
            svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${gy}" y2="${gy}" stroke="rgba(255,255,255,.08)" stroke-width="1"/>`;
            svg += `<text x="${pad.l - 6}" y="${gy + 4}" text-anchor="end" font-size="11" fill="rgba(232,238,252,.5)">${fmtVal(gv, m)}</text>`;
        }
        const every = Math.max(1, Math.ceil(pts.length / 8));
        pts.forEach((p, i) => {
            if (i % every === 0 || i === pts.length - 1)
                svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="rgba(232,238,252,.5)">${esc(periodLabel(p.x, pt))}</text>`;
        });
        if (baseV != null) svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(baseV)}" y2="${y(baseV)}" stroke="rgba(232,238,252,.55)" stroke-width="2" stroke-dasharray="6 5"/>`;
        svg += `<polyline fill="none" stroke="#7cc4ff" stroke-width="2" stroke-linejoin="round" points="${pts.map((p, i) => `${x(i)},${y(p.v)}`).join(" ")}"/>`;
        pts.forEach((p, i) => { svg += `<circle cx="${x(i)}" cy="${y(p.v)}" r="4" fill="#7cc4ff" stroke="rgba(20,25,35,1)" stroke-width="2"/>`; });
        svg += `<rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent" id="hit"/>`;
        svg += `</svg>`;
        box.innerHTML = svg + `<div class="kq-tip" id="tip" hidden></div>`;
        const tip = $("tip");
        box.querySelector("#hit").addEventListener("mousemove", ev => {
            const rect = box.getBoundingClientRect();
            const mx = ((ev.clientX - rect.left) / rect.width) * W;
            let best = 0;
            pts.forEach((p, i) => { if (Math.abs(x(i) - mx) < Math.abs(x(best) - mx)) best = i; });
            const p = pts[best];
            const r = p.r;
            const basis = m.agg === "ratio" ? ` (${fmtNum(r.numerator, 0)}/${fmtNum(r.denominator, 0)})` : m.agg === "mean" ? ` (${fmtNum(r.denominator, 0)} ใบ)` : "";
            tip.innerHTML = `<b>${esc(periodLabel(p.x, pt))}</b><br>${fmtVal(p.v, m)} ${esc(m.unit)}${esc(basis)}${baseV != null ? `<br><span style="opacity:.7">baseline ${fmtVal(baseV, m)} ${esc(m.unit)}</span>` : ""}`;
            tip.style.left = `${(x(best) / W) * 100}%`;
            tip.style.top = `${(y(p.v) / H) * 100}%`;
            tip.hidden = false;
        });
        box.querySelector("#hit").addEventListener("mouseleave", () => { tip.hidden = true; });
    }

    // ===== tabs =====
    const FILTERS = {
        episodes: `<select class="kq-select" id="fLevel"><option value="">ทุกระดับ</option><option value="blue">น้ำเงิน (เกินครั้งแรก)</option><option value="red">แดง (เกินซ้ำ)</option></select>
                   <select class="kq-select" id="fEpiStatus"><option value="">ทุกสถานะ</option><option value="open">ยังเกินอยู่</option><option value="recovered">กลับเข้าเกณฑ์แล้ว</option></select>
                   <select class="kq-select" id="fHasCar"><option value="">CAR: ทั้งหมด</option><option value="1">มี CAR</option><option value="0">ไม่มี CAR</option></select>
                   <input class="kq-input" id="fParam" placeholder="ค้นพารามิเตอร์ เช่น turb" style="width:180px;" />
                   <select class="kq-select" id="fSource"><option value="live">ข้อมูลจริง</option><option value="baseline">baseline</option></select>`,
        cars: `<select class="kq-select" id="fCarStatus"><option value="">ทุกสถานะ</option><option value="open">ยังไม่ปิด</option><option value="60">ปิดแล้ว</option><option value="70">ตีกลับ</option></select>
               <select class="kq-select" id="fCarDate"><option value="found">ตามวันที่พบ</option><option value="issued">ตามวันที่ออกใบ</option><option value="closed">ตามวันที่ปิด</option></select>
               <label style="font-size:13px;"><input type="checkbox" id="fOverdue" /> เกินกำหนดเท่านั้น</label>
               <select class="kq-select" id="fCarSource"><option value="live">ในระบบ</option><option value="baseline">baseline (กระดาษ)</option></select>`,
        slots: `<select class="kq-select" id="fSlotStatus"><option value="">ช้า + ขาด</option><option value="late">ช้า</option><option value="missing">ขาด</option><option value="on_time">ตรงเวลา</option><option value="unknown">ไม่ทราบเวลา</option></select>`,
        defs: "",
    };
    function setTab(tab) {
        state.tab = tab;
        document.querySelectorAll("#tabs .kq-btn").forEach(b => { b.classList.toggle("on", b.dataset.tab === tab); b.classList.toggle("secondary", b.dataset.tab !== tab); });
        $("filters").innerHTML = FILTERS[tab];
        $("filters").querySelectorAll("select, input").forEach(el => el.addEventListener(el.tagName === "INPUT" && el.type === "text" ? "change" : "change", loadTab));
        loadTab();
    }
    const val = id => ($(id) ? ($(id).type === "checkbox" ? ($(id).checked ? "1" : "") : $(id).value) : "");
    const carLink = (key, label) => (key ? `<a href="/labventure/car?key=${encodeURIComponent(key)}" target="_blank" rel="noopener" style="color:#9fd0ff">${esc(label)}</a>` : esc(label));

    async function loadTab() {
        const seq = ++state.seq;
        const { from, to } = range();
        const node = $("nodeSel").value;
        const wrap = $("tableWrap");
        wrap.innerHTML = `<div class="muted" style="padding:12px;">กำลังโหลด…</div>`;
        try {
            let html = "";
            if (state.tab === "episodes") {
                const j = await getJson(`${LV}/kpi/episodes?${qs({ from, to, node, level: val("fLevel"), status: val("fEpiStatus"), has_car: val("fHasCar"), param: val("fParam"), source: val("fSource") })}`);
                html = table(["เริ่มเกิน", "พารามิเตอร์", "ค่า / เกณฑ์", "ครั้งที่เกินติดกัน", "ระดับ", "สถานะ", "CAR"], j.rows.map(e => [
                    thaiDT(e.first_breach_at),
                    `${esc(e.label)}<span class="sub">${esc(e.param_key)} · ${esc(e.node_id || "")}</span>`,
                    `${fmtNum(e.first_value, 3)} ${esc(e.unit)}<span class="sub">${e.direction === "above" ? `เกณฑ์ ≤ ${fmtNum(e.ucl, 3)}` : `เกณฑ์ ≥ ${fmtNum(e.lcl, 3)}`}${e.scenario_changed ? " · เปลี่ยนเกณฑ์ระหว่างเหตุการณ์" : ""}</span>`,
                    `<span style="font-variant-numeric:tabular-nums">${e.n_breach}</span>`,
                    e.max_level === "red" ? `<span class="pill lv-red">● แดง</span>` : `<span class="pill lv-blue">● น้ำเงิน</span>`,
                    e.status === "recovered" ? `เข้าเกณฑ์ ${thaiDT(e.recovered_at)}` : `<span class="pill st-warn">ยังเกิน</span>`,
                    e.car_number ? `${carLink(e.car_key, e.car_number)}<span class="sub">${esc(CAR_STATUS[e.car_status] || "")}${e.car_link === "manual" ? " · ผูกด้วยมือ" : ""}</span>` : `<span class="muted">—</span>`,
                ]), `${j.rows.length} เหตุการณ์`);
            } else if (state.tab === "cars") {
                const j = await getJson(`${LV}/kpi/cars?${qs({ from, to, status: val("fCarStatus"), date_field: val("fCarDate"), overdue: val("fOverdue"), source: val("fCarSource") })}`);
                html = table(["เลขที่", "เรื่อง", "พบ", "ออกใบ", "ตอบ", "ปิด", "พบ → ปิด", "สถานะ", "ตามงาน"], j.rows.map(c => [
                    carLink(c.unique_key, c.car_number || "(ไม่มีเลข)"),
                    `<span title="${esc(c.parameter_name || "")}">${esc(String(c.parameter_name || "").split("\n")[0].slice(0, 60))}</span><span class="sub">${esc(c.receiver_dept || "")}</span>`,
                    thaiDT(c.found_at), thaiDT(c.issued_at), thaiDT(c.responded_at), thaiDT(c.closed_at),
                    hoursText(c.lead_time_h),
                    `${esc(CAR_STATUS[c.final_status] || c.final_status)}${c.overdue ? ` <span class="pill lv-red">เกินกำหนด</span>` : ""}`,
                    `${(c.n_resend || 0) + (c.n_chase || 0)}<span class="sub">${c.chase_minutes ? `${fmtNum(c.chase_minutes, 0)} นาที` : ""}</span>`,
                ]), `${j.rows.length} ใบ`);
            } else if (state.tab === "slots") {
                const j = await getJson(`${LV}/kpi/slots?${qs({ from, to, node, status: val("fSlotStatus") })}`);
                const nodes = {};
                for (const r of j.by_node) { (nodes[r.node_id] ||= { on_time: 0, late: 0, missing: 0, unknown: 0, pending: 0 })[r.status] = r.n; }
                const sum = Object.entries(nodes).map(([n, c]) => {
                    const den = c.on_time + c.late + c.missing;
                    return [esc(n), `<span class="num">${den ? fmtNum((c.on_time / den) * 100, 1) + "%" : "—"}</span>`, c.on_time, c.late, c.missing, c.unknown];
                });
                html = table(["สถานี", "% ตรงเวลา", "ตรงเวลา", "ช้า", "ขาด", "ไม่ทราบเวลา"], sum, "สรุปต่อสถานี")
                    + table(["วันที่ / รอบ", "พารามิเตอร์", "ครบกำหนด", "ระบบเห็นค่า", "สถานะ"], j.rows.map(r => {
                        const st = SLOT_STATUS[r.status] || [r.status, "st-no"];
                        return [`${thaiDate(r.trans_dtm)} ${esc(r.slot === "daily" ? "รายวัน" : r.slot)}`,
                            `${esc(r.label)}<span class="sub">${esc(r.param_key)}</span>`, thaiDT(r.due_at),
                            r.first_seen_at ? `${thaiDT(r.first_seen_at)}<span class="sub">${esc(r.first_source || "")}${r.late_min ? ` · ช้า ${fmtNum(r.late_min, 0)} นาที` : ""}</span>` : "—",
                            `<span class="pill ${st[1]}">${esc(st[0])}</span>`];
                    }), `${j.rows.length} รอบ`);
            } else {
                html = defsHtml();
            }
            if (seq === state.seq) {
                wrap.innerHTML = html;
                const btn = $("btnRecompute");
                if (btn) btn.addEventListener("click", recompute);
            }
        } catch (e) {
            if (seq === state.seq) wrap.innerHTML = `<div style="padding:12px; color:#ffb3b3">${esc(e.message)}</div>`;
        }
    }
    function table(head, rows, caption) {
        return `${caption ? `<div class="kq-section-t" style="margin-top:6px;">${esc(caption)}</div>` : ""}
            <table class="kq-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead>
            <tbody>${rows.length ? rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${head.length}" class="muted">ไม่มีข้อมูล</td></tr>`}</tbody></table>`;
    }
    function defsHtml() {
        const ms = state.summary ? state.summary.metrics : [];
        const o = state.options || {};
        const s = o.settings || {};
        const last = o.status && o.status.last;
        const tierName = { outcome: "Outcome หลัก", outcome_proof: "Outcome ที่ต้องพิสูจน์", output: "Output" };
        return `<dl class="kq-defs">${ms.map(m => `<dt>${esc(tierName[m.tier])} · ${esc(m.name_th)} (${esc(m.unit)}, ${m.direction === "down" ? "ยิ่งต่ำยิ่งดี" : m.direction === "up" ? "ยิ่งสูงยิ่งดี" : "ประกอบ"})</dt><dd>${esc(m.description)}</dd>`).join("")}</dl>
            <div class="kq-section-t" style="margin-top:16px;">ค่าตั้งที่ใช้แปลผล (LabVenture app_settings.json → kpi)</div>
            <div style="font-size:13px; color:rgba(232,238,252,.75); line-height:1.7">
                วันเริ่มวัดผล: ${esc(s.start_date || "วันแรกที่มีข้อมูล")} · ตรงเวลา = สิ้นสุดช่วงรอบ + ${esc(s.on_time_grace_min)} นาที ·
                จับคู่ CAR อัตโนมัติภายใน ${esc(s.car_match_window_h)} ชม. · ตามงาน 1 ครั้ง ≈ ${esc(s.chase_minutes_default)} นาที ·
                อัตราค่าแรง: ${s.labor_rate_thb_per_hour != null ? esc(s.labor_rate_thb_per_hour) + " บาท/ชม." : "ยังไม่ตั้ง (ไม่คิดบาท/ปี)"}
            </div>
            <div class="kq-section-t" style="margin-top:16px;">การคำนวณ</div>
            <div style="font-size:13px; color:rgba(232,238,252,.75)">
                ${last ? `ล่าสุด #${esc(last.id)} ${last.ok ? "สำเร็จ" : "ล้มเหลว: " + esc(last.error)}${last.ms != null ? ` (${esc(last.ms)} ms)` : ""}` : "ยังไม่ได้คำนวณตั้งแต่เปิด LabVenture"}
                <button type="button" class="kq-btn small" id="btnRecompute" style="margin-left:8px;">คำนวณใหม่ทั้งหมด (Admin)</button>
            </div>`;
    }
    async function recompute() {
        const btn = $("btnRecompute");
        btn.disabled = true;
        setStatus("กำลังคำนวณใหม่…");
        try {
            const r = await getJson(`${LV}/kpi/recompute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full: true, baseline: true }) });
            setStatus(`คำนวณใหม่แล้ว (${r.ms} ms)`);
            await queryKpi();
        } catch (e) {
            setStatus(e.status === 401 ? "ต้องเข้าสู่ระบบ LabVenture (Admin) ก่อน" : e.message);
        } finally { btn.disabled = false; }
    }

    // ===== main =====
    function renderMeta() {
        const o = state.options;
        const sm = state.summary;
        if (!o || !sm) { $("meta").innerHTML = ""; return; }
        const br = sm.baseline_range;
        $("meta").innerHTML = [
            `ช่วงที่สืบค้น ${sm.days} วัน`,
            br ? `baseline: ${thaiDate(br.a)} – ${thaiDate(br.z)} (${sm.baseline_days} วัน)` : "baseline: ยังไม่ได้นำเข้า",
            o.data_range.baseline_cars ? `ทะเบียน CAR กระดาษ ${o.data_range.baseline_cars} ใบ` : null,
            `คำนวณเมื่อ ${thaiDT(sm.computed_at)}`,
        ].filter(Boolean).map(esc).join("<br>");
    }
    async function queryKpi() {
        const { from, to } = range();
        state.kpiKey = `${from}|${to}`;
        $("btnQuery").disabled = true;
        setStatus("กำลังสืบค้น…");
        try {
            const [sum, opt] = await Promise.all([
                getJson(`${LV}/kpi/summary?${qs({ from, to })}`),
                getJson(`${LV}/kpi/options`),
            ]);
            state.summary = sum;
            state.options = opt;
            $("conn").hidden = true;
            const sel = $("nodeSel");
            if (sel.options.length <= 1) for (const n of opt.nodes) sel.add(new Option(n.label, n.id));
            renderTiles();
            renderMeta();
            loadTrend();
            loadTab();
            setStatus(`${thaiDate(from)} – ${thaiDate(to)}`);
        } catch (e) {
            state.kpiKey = null;
            setStatus(e.message);
            if (e.status === 502 || e.status === 404) { $("conn").textContent = e.status === 404 ? "LabVenture ยังไม่มี /api/kpi (ต้องอัปเดต)" : e.message; $("conn").hidden = false; }
        } finally { $("btnQuery").disabled = false; }
    }

    // ===== CAR Log (มุมมองเริ่มต้น) =====
    const CHASE_CH = { phone: "โทร", walk: "เดินไปตาม", line: "LINE ส่วนตัว", other: "อื่น ๆ" };
    const STEP_TEXT = {
        10: "ออกใบ CAR", 15: "ส่งต่อผู้ตอบ", 20: "ตอบส่วนที่ 2 → รออนุมัติ", 30: "อนุมัติแผน → รอติดตาม#1", 40: "ติดตาม#1 → รอติดตาม#2",
        50: "ติดตามครบ → รอ ผอ.ฝผม. พิจารณา", 60: "ผอ.ฝผม. อนุมัติปิด", 70: "ผอ.ฝผม. ตีกลับ",
        reclaim: "ปลดล็อก (ยกเลิกการส่งต่อ)", edited: "แก้ไขส่วนที่ 1", deleted: "ลบใบ",
    };
    const FOLLOW_ITEMS = { correction: "การแก้ไข", prevention: "การป้องกัน" };
    const itemsText = a => (a || []).map(k => FOLLOW_ITEMS[k]).filter(Boolean).join(" / ");

    // เวลาใน DB มี 3 แบบ: 'YYYY-MM-DD HH:MM:SS' = UTC (datetime('now')) · ISO มี offset · ISO ไม่มี offset = เวลาไทย → คืน 'YYYY-MM-DDTHH:MM' เวลาไทย
    function tsTH(s) {
        if (!s) return null;
        s = String(s);
        if (/^\d{4}-\d\d-\d\d$/.test(s)) return s;
        if (/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(s)) s = s.replace(" ", "T") + "Z";
        if (/(Z|[+-]\d\d:?\d\d)$/i.test(s)) { const ms = Date.parse(s); return Number.isFinite(ms) ? new Date(ms + 7 * 3600e3).toISOString().slice(0, 16) : s.slice(0, 16); }
        return s.slice(0, 16);
    }
    const fmtD = s => { const t = tsTH(s); return !t ? "—" : t.length <= 10 ? thaiDate(t) : thaiDT(t); };
    const dayTH = s => (tsTH(s) || "").slice(0, 10);
    const codeOf = c => Number(c.status_code) || 10;
    const isOverdue = c => !!c.deadline_at && codeOf(c) < 60 && dayTH(c.deadline_at) < thaiToday();
    const holderOf = c => (c.assignee_name ? { name: c.assignee_name, dept: c.assignee_dept } : { name: c.receiver_name, dept: c.receiver_dept });
    const statusPill = code => `<span class="pill st${esc(code)}">${esc(CAR_STATUS[code] || code)}</span>`;
    const fdOf = c => { try { return JSON.parse(c.form_data || "{}") || {}; } catch { return {}; } };
    const personsText = (arr, legacy) => (Array.isArray(arr) && arr.length ? arr.filter(p => p && p.name).map(p => `${p.name}${p.dept ? ` (${p.dept})` : ""}`).join(", ") : legacy || "");
    function findingsOf(c) {
        try { const a = JSON.parse(c.findings || "null"); if (Array.isArray(a) && a.length) return a; } catch { /* old CAR */ }
        return c.recorded_value != null ? [{ value: c.recorded_value, direction: c.threshold_direction === "below" ? "below" : "above", threshold: c.threshold_value, unit: "" }] : [];
    }
    const findingText = f => {
        const u = f.unit ? ` ${f.unit}` : "";
        return `${f.value ?? "—"}${f.value != null ? u : ""}${f.threshold != null ? ` (เกณฑ์: ${f.direction === "below" ? "≥" : "≤"} ${f.threshold}${u})` : ""}`;
    };

    async function loadCars() {
        const seq = ++state.clSeq;
        $("btnQuery").disabled = true;
        if (!state.cars) $("clWrap").innerHTML = `<div class="muted" style="padding:12px;">กำลังโหลด…</div>`;
        setStatus("กำลังโหลด CAR…");
        try {
            // ดึงทั้งหมดครั้งเดียว แล้วกรองช่วงวันที่ฝั่งนี้ตามวันที่ไทย (issued_at ใน DB เป็น UTC)
            const rows = await getJson(`${LV}/car`);
            if (seq !== state.clSeq) return;
            state.cars = Array.isArray(rows) ? rows : [];
            $("conn").hidden = true;
            const sys = $("clSystem"), cur = sys.value;
            const systems = [...new Set(state.cars.map(c => c.system_type).filter(Boolean))].sort();
            sys.innerHTML = `<option value="">ทุกระบบ</option>` + systems.map(s => `<option>${esc(s)}</option>`).join("");
            sys.value = systems.includes(cur) ? cur : "";
            renderCars();
            if (state.pendingKey) {
                const c = state.cars.find(x => x.unique_key === state.pendingKey);
                state.pendingKey = null;
                if (c) openCar(c.id);
            } else if (state.openId != null) {
                if (state.cars.some(x => x.id === state.openId)) openCar(state.openId, true); else closeCar();
            }
        } catch (e) {
            if (seq !== state.clSeq) return;
            setStatus(e.message);
            $("clWrap").innerHTML = `<div style="padding:12px; color:#ffb3b3">${esc(e.message)}</div>`;
            if (e.status === 502) { $("conn").textContent = e.message; $("conn").hidden = false; }
        } finally { if (seq === state.clSeq) $("btnQuery").disabled = false; }
    }

    // ใบในขอบเขตวันที่ (ก่อนกรองสถานะ/ค้นหา) — ใช้นับ chip
    function scopedCars() {
        const scope = $("carScope").value;
        const { from, to } = range();
        return (state.cars || []).filter(c => {
            if (scope === "open") return codeOf(c) < 60;
            if (scope === "all") return true;
            const d = dayTH(c.issued_at);
            return d >= from && d <= to;
        });
    }
    function renderCars() {
        if (!state.cars) return;
        const base = scopedCars();
        const counts = {};
        base.forEach(c => { counts[codeOf(c)] = (counts[codeOf(c)] || 0) + 1; });
        const nOver = base.filter(isOverdue).length;
        if (state.clStatus && !counts[state.clStatus]) state.clStatus = "";
        $("clChips").innerHTML = `<span class="cl-chip${state.clStatus ? "" : " on"}" data-st="" role="button">ทั้งหมด <b>${base.length}</b></span>`
            + Object.keys(CAR_STATUS).filter(k => counts[k]).map(k =>
                `<span class="cl-chip${String(state.clStatus) === k ? " on" : ""}" data-st="${k}" role="button"><span class="pill st${k}" style="padding:0 6px;">${esc(CAR_STATUS[k])}</span><b>${counts[k]}</b></span>`).join("")
            + (nOver ? `<span class="cl-chip" style="cursor:default; border-color:rgba(255,80,80,.45); color:#ffc2c2;">เกินกำหนด <b>${nOver}</b></span>` : "");
        $("clChips").querySelectorAll(".cl-chip[data-st]").forEach(el => el.addEventListener("click", () => { state.clStatus = el.dataset.st; renderCars(); }));

        const q = $("clSearch").value.trim().toLowerCase();
        const sys = $("clSystem").value, typ = $("clType").value, over = $("clOverdue").checked;
        const list = base.filter(c => (!state.clStatus || String(codeOf(c)) === String(state.clStatus))
            && (!sys || c.system_type === sys)
            && (!typ || (c.car_type || "CAR") === typ)
            && (!over || isOverdue(c))
            && (!q || [c.car_number, c.unique_key, c.parameter_name, c.issuer_name, c.issuer_dept, c.receiver_name, c.receiver_dept, c.assignee_name, c.assignee_dept, c.issue_type]
                .some(v => String(v || "").toLowerCase().includes(q))));

        const head = ["เลขที่", "เรื่องที่พบ", "ผู้ออก → ผู้ถือใบ", "ออกใบ", "กำหนด", "สถานะ"];
        const rows = list.map(c => {
            const h = holderOf(c), code = codeOf(c), od = isOverdue(c);
            const subj = String(c.parameter_name || "").split("\n")[0];
            return `<tr class="cl-row${state.openId === c.id ? " sel" : ""}" data-id="${esc(c.id)}" tabindex="0">
                <td><b>${esc(c.car_number || "(ไม่มีเลข)")}</b><span class="sub">${esc(c.car_type || "CAR")}${c.system_type ? ` · ${esc(c.system_type)}` : ""}</span></td>
                <td><span title="${esc(c.parameter_name || "")}">${esc(subj.length > 90 ? subj.slice(0, 90) + "…" : subj)}</span>${c.issue_type ? `<span class="sub">${esc(c.issue_type)}</span>` : ""}</td>
                <td>${esc(c.issuer_name || "—")}<span class="sub">→ ${esc(h.name || "—")}${h.dept ? ` · ${esc(h.dept)}` : ""}</span></td>
                <td style="white-space:nowrap">${fmtD(c.issued_at)}</td>
                <td style="white-space:nowrap">${c.deadline_at ? thaiDate(dayTH(c.deadline_at)) : "—"}${od ? `<span class="sub" style="color:#ffb3b3">เกินกำหนด</span>` : ""}</td>
                <td>${statusPill(code)}${fdOf(c).s4_to_meeting && code < 60 ? `<span class="sub" style="color:#ffc2c2">ประเด็นเข้าที่ประชุม</span>` : ""}</td>
            </tr>`;
        }).join("");
        $("clWrap").innerHTML = `<table class="kq-table"><thead><tr>${head.map(x => `<th>${esc(x)}</th>`).join("")}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${head.length}" class="muted">ไม่มี CAR ตามเงื่อนไข</td></tr>`}</tbody></table>`;
        $("clWrap").querySelectorAll("tr.cl-row").forEach(tr => {
            tr.addEventListener("click", () => openCar(Number(tr.dataset.id)));
            tr.addEventListener("keydown", ev => { if (ev.key === "Enter") openCar(Number(tr.dataset.id)); });
        });
        const scope = $("carScope").value;
        const { from, to } = range();
        setStatus(`${scope === "range" ? `ออกใบ ${thaiDate(from)} – ${thaiDate(to)}` : scope === "open" ? "ใบที่ยังไม่ปิด (ทุกช่วงเวลา)" : "ทุกช่วงเวลา"} · แสดง ${list.length} / ${base.length} ใบ`);
    }

    // ── รายละเอียดใบ (drawer) ──
    const field = (label, value, wide) => (value == null || value === "" ? "" :
        `<div class="cl-f"${wide ? ' style="grid-column:1/-1"' : ""}><div class="l">${esc(label)}</div><div class="v">${esc(value)}</div></div>`);
    const sec = (n, title, body, pending) => `<div class="cl-sec${pending ? " pending" : ""}"><div class="cl-sec-t"><span class="n">${esc(n)}</span>${esc(title)}</div>${body}</div>`;
    const pendingNote = t => `<div class="cl-note">${esc(t)}</div>`;

    function carDetailHtml(c) {
        const fd = fdOf(c), code = codeOf(c), h = holderOf(c);
        const fnd = findingsOf(c);
        const dates = [["วันที่พบ", fmtD(c.record_datetime)], ["ออกใบ", fmtD(c.issued_at)], ["Deadline", c.deadline_at ? thaiDate(dayTH(c.deadline_at)) : null],
            ["กำหนดแก้ไขเสร็จ", c.correction_deadline ? thaiDate(dayTH(c.correction_deadline)) : null],
            ["กำหนดป้องกันเสร็จ", c.prevention_deadline ? thaiDate(dayTH(c.prevention_deadline)) : null],
            ["กำหนดติดตาม#2", c.followup2_deadline ? thaiDate(dayTH(c.followup2_deadline)) : null]]
            .filter(([, v]) => v && v !== "—").map(([l, v]) => field(l, v)).join("");
        let html = `<div class="cl-dates">${dates}${isOverdue(c) ? `<div class="cl-f"><div class="l">สถานะกำหนด</div><div class="v" style="color:#ffb3b3; font-weight:700">เกินกำหนด</div></div>` : ""}</div>`;

        // ส่วนที่ 1
        html += sec(1, "รายละเอียดสิ่งที่ไม่เป็นไปตามข้อกำหนด", `<div class="cl-grid2">
            ${field("ประเภท", `${c.car_type || "CAR"}${c.system_type ? ` · ${c.system_type}` : ""}`)}
            ${field("ประเภทปัญหา", c.issue_type)}
            ${field("1.1 เรื่องที่พบ", c.parameter_name, true)}
            ${fnd.length ? field("ค่าที่พบ", fnd.length === 1 ? findingText(fnd[0]) : fnd.map((f, i) => `${i + 1}) ${findingText(f)}`).join("\n"), true) : ""}
            ${field("1.2 ผู้ออก", `${c.issuer_name || "—"}${c.issuer_dept ? ` (${c.issuer_dept})` : ""}`)}
            ${field("1.3 ผู้รับ", `${c.receiver_name || "—"}${c.receiver_dept ? ` (${c.receiver_dept})` : ""}`)}
            ${c.assignee_name ? field("ผู้ถือใบปัจจุบัน (หลังส่งต่อ)", `${c.assignee_name}${c.assignee_dept ? ` (${c.assignee_dept})` : ""}`) : ""}
            ${field("หมายเหตุ", c.notes, true)}
        </div>`);

        // ส่วนที่ 2
        const fwds = Array.isArray(fd.s2_forwards) ? fd.s2_forwards : [];
        const fwdHtml = fwds.length ? `<div class="cl-f"><div class="l">ประวัติการส่งต่อ</div><ul class="cl-tl">${fwds.map(f => `<li><span class="t">${fmtD(f.at)}</span><span class="d fwd"></span><span>${f.type === "reclaim"
            ? `🔓 <b>${esc(f.by)}</b> ปลดล็อก ยกเลิกการส่งต่อจาก ${esc(f.from_name)}`
            : `<b>${esc(f.from_name)}</b> ส่งต่อให้ <b>${esc(f.to_name)}</b>${f.to_dept ? ` (${esc(f.to_dept)})` : ""}${f.reason ? ` <span class="s">— ${esc(f.reason)}</span>` : ""}`}</span></li>`).join("")}</ul></div>` : "";
        const s2done = !!(fd.s2_root_cause || fd.s2_correction);
        html += sec(2, "วิเคราะห์หาสาเหตุ และกำหนดแผนการแก้ไขและป้องกัน", fwdHtml + (s2done ? `
            ${field("ผู้เข้าประชุม", personsText(fd.s2_attendees, fd.s2_meeting_members), true)}
            ${field("2.1 สาเหตุของปัญหา", fd.s2_root_cause, true)}
            ${field("2.2 กำหนดการแก้ไข", fd.s2_correction, true)}
            ${fd.s2_correction ? `<div class="cl-note" style="margin:-4px 0 8px">${[fd.s2_correction_deadline ? `กำหนดเสร็จ ${thaiDate(fd.s2_correction_deadline)}` : "", personsText(fd.s2_correction_owners, fd.s2_correction_owner) ? `ผู้รับผิดชอบ ${personsText(fd.s2_correction_owners, fd.s2_correction_owner)}` : ""].filter(Boolean).map(esc).join(" · ")}</div>` : ""}
            ${field("2.3 กำหนดการป้องกัน", fd.s2_prevention, true)}
            ${fd.s2_prevention ? `<div class="cl-note" style="margin:-4px 0 8px">${[fd.s2_prevention_deadline ? `กำหนดเสร็จ ${thaiDate(fd.s2_prevention_deadline)}` : "", personsText(fd.s2_prevention_owners, fd.s2_prevention_owner) ? `ผู้รับผิดชอบ ${personsText(fd.s2_prevention_owners, fd.s2_prevention_owner)}` : ""].filter(Boolean).map(esc).join(" · ")}</div>` : ""}
            ${fd.s2_respondent ? `<div class="cl-note">ผู้ตอบ: ${esc(fd.s2_respondent)}${fd.s2_respondent_pos ? ` (${esc(fd.s2_respondent_pos)})` : ""}${fd.s2_responded_at ? ` · ${thaiDate(fd.s2_responded_at)}` : ""}</div>` : ""}`
            : pendingNote(code === 70 ? "ไม่มีการตอบ" : `รอผู้ถือใบตอบ: ${h.name || "—"}${h.dept ? ` (${h.dept})` : ""}`)), !s2done);

        // ส่วนที่ 3 (อนุมัติแผน — กลุ่ม 3A)
        const s3done = !!fd.s2_approver || (code >= 30 && code !== 70);
        html += sec(3, "การอนุมัติแผนการแก้ไข / ป้องกัน", s3done
            ? `<div class="cl-res pass">✅ อนุมัติ</div><div class="cl-note">${esc(fd.s2_approver || "—")}${fd.s2_approved_at ? ` · ${thaiDate(fd.s2_approved_at)}` : ""}</div>`
            : pendingNote(code === 20 ? "รอผู้อนุมัติ (กลุ่ม 3A)" : "ยังไม่ถึงขั้นนี้"), !s3done);

        // ส่วนที่ 4 (ติดตามผล)
        const check = (n, r, items, notes, by, pos, date, deadline) => `
            <div style="margin-bottom:10px;"><div class="cl-note" style="font-weight:700; color:rgba(232,238,252,.8)">ติดตามผล ครั้งที่ ${n}${deadline ? ` · กำหนด ${thaiDate(deadline)}` : ""}</div>
            ${items && items.length ? `<div class="cl-note">ติดตาม: ${esc(itemsText(items))}</div>` : ""}
            ${r ? `<div class="cl-res ${r === "pass" ? "pass" : "fail"}">${r === "pass" ? "✅ เป็นไปตามที่กำหนด" : "❌ ไม่เป็นไปตามที่กำหนด"}</div>` : pendingNote("ยังไม่บันทึกผล")}
            ${notes ? `<div class="cl-f"><div class="v">${esc(notes)}</div></div>` : ""}
            ${by ? `<div class="cl-note">${esc(by)}${pos ? ` (${esc(pos)})` : ""}${date ? ` · ${thaiDate(date)}` : ""}</div>` : ""}</div>`;
        const s4any = !!(fd.s4_check1_result || fd.s4_check2_result);
        html += sec(4, "ติดตามผลการแก้ไข / ป้องกัน", (s4any || code === 30 || code === 40)
            ? (fd.s4_check1_result || code === 30 ? check(1, fd.s4_check1_result, fd.s4_check1_items, fd.s4_check1_notes, fd.s4_check1_by, fd.s4_check1_by_pos, fd.s4_check1_date) : "")
              + (fd.s4_check2_result || code === 40 ? check(2, fd.s4_check2_result, fd.s4_check2_items, fd.s4_check2_notes, fd.s4_check2_by, fd.s4_check2_by_pos, fd.s4_check2_date, fd.s4_check2_deadline) : "")
              + (fd.s4_to_meeting ? `<div class="cl-flag">🗣 ประเด็นเข้าที่ประชุม — ติดตาม 2 ครั้งแล้วยังปิดไม่ได้</div>` : "")
            : pendingNote("ยังไม่ถึงขั้นนี้"), !s4any);

        // ส่วนที่ 5 (ผอ.ฝผม.)
        const s5done = code >= 60 || !!fd.s5_decision;
        html += sec(5, "การพิจารณาอนุมัติโดยผู้อำนวยการฝ่าย", s5done
            ? `<div class="cl-res ${fd.s5_decision === "reject" || code === 70 ? "fail" : "pass"}">${fd.s5_decision === "reject" || code === 70 ? "❌ ตีกลับ" : "✅ อนุมัติปิด"}</div>
               ${field("เหตุผล", fd.s5_reason, true)}${field("การดำเนินการ", fd.s5_action, true)}
               ${fd.s5_approver ? `<div class="cl-note">${esc(fd.s5_approver)} (ผอ.ฝผม.)${fd.s5_approved_at ? ` · ${thaiDate(fd.s5_approved_at)}` : ""}</div>` : ""}`
            : pendingNote(code === 50 ? "รอ ผอ.ฝผม. พิจารณา (กลุ่ม 3B)" : "ยังไม่ถึงขั้นนี้"), !s5done);

        html += sec("⏱", "ประวัติการดำเนินการ · การแจ้งเตือน · การตามงาน", `<div id="clTimeline"><div class="cl-note">กำลังโหลด…</div></div>`);
        return html;
    }

    async function loadTimeline(c) {
        const [steps, notes] = await Promise.allSettled([
            getJson(`${LV}/car/steps/${encodeURIComponent(c.id)}`),
            getJson(`${LV}/kpi/notifications?${qs({ car_id: c.id })}`),
        ]);
        if (state.openId !== c.id || !$("clTimeline")) return;
        const ev = [];
        if (steps.status === "fulfilled" && Array.isArray(steps.value)) for (const s of steps.value) {
            const st = String(s.step || "");
            const txt = STEP_TEXT[st] || (st.startsWith("revert:") ? `ย้อนสถานะเป็น "${CAR_STATUS[st.slice(7)] || st.slice(7)}"` : st);
            ev.push({ at: tsTH(s.at_th || s.updated_at), cls: "", txt, who: s.actor || s.updated_by, note: s.notes });
        }
        if (notes.status === "fulfilled") for (const n of notes.value.rows || []) {
            const chase = n.kind === "chase";
            const txt = chase ? `ตามงาน (${CHASE_CH[n.channel] || n.channel})${n.minutes ? ` ${fmtNum(n.minutes, 0)} นาที` : ""}`
                : `${n.kind === "resend" ? "ส่ง LINE ซ้ำ" : "แจ้ง LINE"}${n.status_code ? ` · ${CAR_STATUS[n.status_code] || n.status_code}` : ""}${n.ok ? "" : " — ส่งไม่สำเร็จ"}`;
            ev.push({ at: tsTH(n.at), cls: chase ? "chase" : "line", txt, who: n.actor || (chase ? "" : n.recipient), note: n.note || (n.ok ? "" : n.error) });
        }
        ev.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
        const failed = steps.status === "rejected" ? `<div class="cl-note" style="color:#ffb3b3">โหลดประวัติไม่ได้: ${esc(steps.reason.message)}</div>` : "";
        $("clTimeline").innerHTML = failed + (ev.length
            ? `<ul class="cl-tl">${ev.map(e => `<li><span class="t">${e.at ? (e.at.length <= 10 ? thaiDate(e.at) : thaiDT(e.at)) : "—"}</span><span class="d ${e.cls}"></span><span>${esc(e.txt)}${e.who ? ` <span class="s">· ${esc(e.who)}</span>` : ""}${e.note ? `<br><span class="s">${esc(e.note)}</span>` : ""}</span></li>`).join("")}</ul>`
            : `<div class="cl-note">ยังไม่มีประวัติ (ใบที่ออกก่อนเริ่มบันทึกขั้นตอนจะไม่มีรายการ)</div>`);
    }

    function openCar(id, keepScroll) {
        const c = (state.cars || []).find(x => x.id === id);
        if (!c) return;
        const body = $("clDBody"), top = body.scrollTop;
        state.openId = id;
        $("clDTitle").textContent = `${c.car_type || "CAR"} ${c.car_number || "(ยังไม่ระบุเลข)"}`;
        $("clDStatus").innerHTML = statusPill(codeOf(c));
        $("clDKey").textContent = c.unique_key || "";
        $("clDActs").innerHTML = `
            <a class="kq-btn small secondary" href="${LV}/car/${encodeURIComponent(c.id)}/form/pdf" target="_blank" rel="noopener" title="ใบ ${esc(c.car_type || "CAR")} สบค-08">PDF</a>
            <a class="kq-btn small secondary" href="${LV}/car/${encodeURIComponent(c.id)}/form/xlsx" title="ใบ ${esc(c.car_type || "CAR")} สบค-08">Excel</a>
            ${c.unique_key ? `<a class="kq-btn small" href="/labventure/car?key=${encodeURIComponent(c.unique_key)}" target="_blank" rel="noopener">เปิดใน LabVenture ↗</a>` : ""}`;
        body.innerHTML = carDetailHtml(c);
        body.scrollTop = keepScroll ? top : 0;
        $("clDrawer").hidden = false;
        $("clDrawerBg").hidden = false;
        document.body.style.overflow = "hidden";
        document.querySelectorAll("#clWrap tr.cl-row").forEach(tr => tr.classList.toggle("sel", Number(tr.dataset.id) === id));
        if (c.unique_key) history.replaceState(null, "", `#car=${encodeURIComponent(c.unique_key)}`);
        if (!keepScroll) $("clDClose").focus();
        loadTimeline(c);
    }
    function closeCar() {
        if ($("clDrawer").hidden) return;
        const id = state.openId;
        state.openId = null;
        $("clDrawer").hidden = true;
        $("clDrawerBg").hidden = true;
        document.body.style.overflow = "";
        document.querySelectorAll("#clWrap tr.cl-row.sel").forEach(tr => tr.classList.remove("sel"));
        history.replaceState(null, "", location.pathname + location.search);
        const tr = document.querySelector(`#clWrap tr.cl-row[data-id="${id}"]`);
        if (tr) tr.focus();
    }

    // ===== views =====
    function setView(v) {
        state.view = v;
        document.querySelectorAll("#views .kq-view").forEach(b => { const on = b.dataset.view === v; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
        $("viewCar").hidden = v !== "car";
        $("viewKpi").hidden = v !== "kpi";
        $("carScopeWrap").hidden = v !== "car";
        $("nodeWrap").hidden = v !== "kpi";
        $("meta").hidden = v !== "kpi";
        $("headIcon").textContent = v === "car" ? "📋" : "🎯";
        $("headTitle").textContent = v === "car" ? "CAR Log" : "KPI Query";
        $("headSub").textContent = v === "car" ? "ทะเบียน CAR/PAR · คลิกแถวเพื่อดูรายละเอียด" : "สืบค้น Output · Outcome ของระบบ CAR";
        if (v === "kpi") {
            closeCar();
            history.replaceState(null, "", "#kpi");
            const { from, to } = range();
            if (state.kpiKey !== `${from}|${to}`) queryKpi(); else { loadTrend(); setStatus(`${thaiDate(from)} – ${thaiDate(to)}`); }
        } else {
            if (location.hash === "#kpi") history.replaceState(null, "", location.pathname + location.search);
            if (!state.cars) loadCars(); else renderCars();
        }
    }
    const refresh = () => (state.view === "car" ? loadCars() : queryKpi());

    document.querySelectorAll("#views .kq-view").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
    document.querySelectorAll("#presets .kq-btn").forEach(b => b.addEventListener("click", () => applyPreset(b.dataset.preset)));
    document.querySelectorAll("#tabs .kq-btn").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
    $("btnQuery").addEventListener("click", refresh);
    $("nodeSel").addEventListener("change", loadTab);
    $("trendPeriod").addEventListener("change", loadTrend);
    ["fromDate", "toDate", "carScope"].forEach(id => $(id).addEventListener("change", () => { if (state.view === "car") renderCars(); }));
    $("clSearch").addEventListener("input", renderCars);
    ["clSystem", "clType", "clOverdue"].forEach(id => $(id).addEventListener("change", renderCars));
    $("clDClose").addEventListener("click", closeCar);
    $("clDrawerBg").addEventListener("click", closeCar);
    document.addEventListener("keydown", ev => { if (ev.key === "Escape") closeCar(); });
    let resizeT;
    window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (state.view === "kpi") loadTrend(); }, 200); });

    $("filters").innerHTML = FILTERS.episodes;
    $("filters").querySelectorAll("select, input").forEach(el => el.addEventListener("change", loadTab));

    // เข้าหน้า → CAR Log เป็นค่าเริ่มต้น · #kpi = เปิดมุมมอง KPI · #car=<unique_key> = เปิดรายละเอียดใบนั้น
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash.startsWith("car=")) state.pendingKey = hash.slice(4);
    setView(hash === "kpi" ? "kpi" : "car");
})();
