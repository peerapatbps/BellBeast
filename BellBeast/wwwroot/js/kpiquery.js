// KPI Query page: ตัวชี้วัด Output/Outcome ของระบบ CAR (CAR Lean proposal)
// ข้อมูลทั้งหมดจาก LabVenture /api/kpi ผ่าน proxy /labventure/* ของ BellBeast (อ่านได้โดยไม่ login;
// ปุ่ม "คำนวณใหม่" ต้อง login LabVenture เป็น Admin)
(function () {
    "use strict";

    const LV = "/labventure/api";
    const $ = id => document.getElementById(id);
    const CAR_STATUS = { 10: "รอตอบ", 15: "ส่งต่อ", 20: "รออนุมัติ", 30: "ติดตาม#1", 40: "ติดตาม#2", 50: "รอพิจารณาปิด", 60: "ปิดแล้ว", 70: "ตีกลับ" };
    const SLOT_STATUS = { on_time: ["ตรงเวลา", "st-ok"], late: ["ช้า", "st-warn"], missing: ["ขาด", "lv-red"], unknown: ["ไม่ทราบเวลา", "st-no"], pending: ["ยังไม่ถึงกำหนด", "st-no"] };

    const state = { summary: null, options: null, trend: "breach_escalation_pct", tab: "episodes", seq: 0 };

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
        query();
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
            await query();
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
    async function query() {
        const { from, to } = range();
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
            setStatus(e.message);
            if (e.status === 502 || e.status === 404) { $("conn").textContent = e.status === 404 ? "LabVenture ยังไม่มี /api/kpi (ต้องอัปเดต)" : e.message; $("conn").hidden = false; }
        } finally { $("btnQuery").disabled = false; }
    }

    document.querySelectorAll("#presets .kq-btn").forEach(b => b.addEventListener("click", () => applyPreset(b.dataset.preset)));
    document.querySelectorAll("#tabs .kq-btn").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
    $("btnQuery").addEventListener("click", query);
    $("nodeSel").addEventListener("change", loadTab);
    $("trendPeriod").addEventListener("change", loadTrend);
    let resizeT;
    window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(loadTrend, 200); });

    $("filters").innerHTML = FILTERS.episodes;
    $("filters").querySelectorAll("select, input").forEach(el => el.addEventListener("change", loadTab));
    query();
})();
