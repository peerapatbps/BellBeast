(function () {
    "use strict";

    /* =========================
       CONSTANTS
    ========================= */

    const DEFAULT_POLL_SEC = 15;
    const TIMEOUT_MS = 8000;

    const CAP_ALUM_M3 = 750;
    const CAP_PACL_A_M3 = 25;
    const CAP_PACL_B1_M3 = 25;
    const CAP_PACL_B2_M3 = 24;
    const CAP_CL_KG = 6000;

    const FACT_PACL = 8.6434;
    const FACT_ALUM = 5.4135;
    const FACT_CL = 3.6;

    const FLOW_ID = { P1: 1, P2: 2, P3: 39, P4: 40 };

    const DOSE = {
        PACL: { P1: 8402, P2: 8404, P3: 8416, P4: 8418 },
        ALUM: { P1: 89, P2: 92, P3: 151, P4: 154 },
        PRE: { P1: 129, P2: 131, P3: 192, P4: 194 },
        POST: { P1: 133, P2: 135, P3: 196, P4: 198 }
    };

    const STATUS = {

        ALUM12_PUMP: [81, 83, 85],
        ALUM12_TANK_A: 95,
        ALUM12_TANK_B: 98,
        ALUM12_TANK_A_VAL: 93,
        ALUM12_TANK_B_VAL: 96,

        PACL12_PUMP: [8395, 8397, 8399],
        PACL12_TANK_A: 8406,
        PACL12_TANK_B: 8408,
        PACL12_TANK_A_VAL: 8405,
        PACL12_TANK_B_VAL: 8407,

        CL12_TANK_A: 4325,
        CL12_TANK_B: 4326,

        CL34_TANK_A: 4327,
        CL34_TANK_B: 4328,

        ALUM3_PUMP: [137, 139, 141],
        ALUM4_PUMP: [143, 145, 147],
        ALUM2_TANK_C: 157,
        ALUM2_TANK_D: 160,
        ALUM2_TANK_C_VAL: 155,
        ALUM2_TANK_D_VAL: 158,

        PACL34_PUMP: [8409, 8411, 8413],
        PACL2_TANK_C: 8420,
        PACL2_TANK_D: 8422,
        PACL2_TANK_C_VAL: 8419,
        PACL2_TANK_D_VAL: 8421,

        CL12_EVAP: [109, 111, 113, 115],
        CL12_CHLOR: [117, 118, 119, 120, 121],

        CL34_EVAP: [171, 173, 175, 177, 179],
        CL34_CHLOR: [181, 182, 183, 184, 185]

    };

    const METRIC = {
        CL1A: { stream: "CHEM1", key: "cl_lineA" },
        CL1B: { stream: "CHEM1", key: "cl_lineB" },
        CL2A: { stream: "CHEM2", key: "cl_lineC" },
        CL2B: { stream: "CHEM2", key: "cl_lineD" }
    };

    /* =========================
       TANK PREDICTION (port ของ TruckSidecar Predictor.Predict)
       ฐาน = ค่าที่ใหม่กว่าระหว่าง API (Aquadat ราย 2 ชม.) กับ "ระดับหลังเติม" ที่พนักงานบันทึกใน sidecar
             (จาก chem.db ผ่าน /api/chem_report — เวลาของค่า = เวลาชั่งออก ไม่ใช่เวลากดบันทึก)
       อัตราใช้ (ถัง ON เท่านั้น):
         1) อัตราจ่ายจริง flow×dose ของเฟสในกลุ่มถังร่วม ÷ จำนวนถังที่ ON ในกลุ่ม (ถ้า > 0)
         2) ค่าเริ่มต้นต่อสาร ÷ จำนวนถังที่ ON ของสารนั้น
       (sidecar มีขั้นเฉลี่ยจากประวัติ API ระหว่าง 1 กับ 2 — การ์ดไม่มีประวัติจึงข้ามขั้นนั้น)
       ระดับ = ฐาน − อัตรา × ชม.ที่ผ่านไปจากฐาน, ตัดที่ 0 .. max(พิกัด, ฐาน)
    ========================= */

    const TANKS = [
        { name: "ALUM A", chem: "ALUM", lvl: STATUS.ALUM12_TANK_A_VAL, st: STATUS.ALUM12_TANK_A, cap: CAP_ALUM_M3, phases: ["P1", "P2"], bind: "ALUM1.TANKA" },
        { name: "ALUM B", chem: "ALUM", lvl: STATUS.ALUM12_TANK_B_VAL, st: STATUS.ALUM12_TANK_B, cap: CAP_ALUM_M3, phases: ["P1", "P2"], bind: "ALUM1.TANKB" },
        { name: "ALUM C", chem: "ALUM", lvl: STATUS.ALUM2_TANK_C_VAL, st: STATUS.ALUM2_TANK_C, cap: CAP_ALUM_M3, phases: ["P3", "P4"], bind: "ALUM2.TANKA" },
        { name: "ALUM D", chem: "ALUM", lvl: STATUS.ALUM2_TANK_D_VAL, st: STATUS.ALUM2_TANK_D, cap: CAP_ALUM_M3, phases: ["P3", "P4"], bind: "ALUM2.TANKB" },
        { name: "PACL A", chem: "PACL", lvl: STATUS.PACL12_TANK_A_VAL, st: STATUS.PACL12_TANK_A, cap: CAP_PACL_A_M3, phases: ["P1", "P2"], bind: "PACL1.TANKA" },
        { name: "PACL B", chem: "PACL", lvl: STATUS.PACL12_TANK_B_VAL, st: STATUS.PACL12_TANK_B, cap: CAP_PACL_B1_M3, phases: ["P1", "P2"], bind: "PACL1.TANKB" },
        { name: "PACL C", chem: "PACL", lvl: STATUS.PACL2_TANK_C_VAL, st: STATUS.PACL2_TANK_C, cap: CAP_PACL_A_M3, phases: ["P3", "P4"], bind: "PACL2.TANKA" },
        { name: "PACL D", chem: "PACL", lvl: STATUS.PACL2_TANK_D_VAL, st: STATUS.PACL2_TANK_D, cap: CAP_PACL_B2_M3, phases: ["P3", "P4"], bind: "PACL2.TANKB" }
    ];

    /** ยอดใช้ทั้งระบบ m³/ชม. ต่อสาร (เหมือน defaultUsagePerHour ใน TruckSidecar config.json) — แบ่งตามจำนวนถังที่ ON */
    const DEFAULT_USAGE_M3H = { ALUM: 1.25, PACL: 1.0 };
    /** อัตราจ่ายจริงเก่ากว่านี้ไม่ใช้ (เหมือน MaxDoseAgeHours ของ sidecar) */
    const MAX_DOSE_AGE_H = 6;

    const REFILL_PATH = "/api/chem_report";
    const REFILL_POLL_MS = 120000;     // chem.db เปลี่ยนเมื่อมีการ upload ใหม่เท่านั้น ไม่ต้องดึงถี่
    const REFILL_LOOKBACK_DAYS = 2;    // ดูเที่ยวที่ชั่งออกย้อนหลังกี่วัน (API ราย 2 ชม. จะแซงค่านี้อยู่แล้ว)

    let _inflight = null;

    /* =========================
       API URL
    ========================= */

    function inferBackendBase() {
        return location.origin;
    }

    function apiUrl(path) {
        if (!path.startsWith("/")) path = "/" + path;
        return inferBackendBase() + path;
    }

    function getSummaryPath(section) {
        return section.getAttribute("data-chem-summary-url") || "/api/chem/summary";
    }

    function getRefreshSec(section) {
        const settings = window.CHEMSettings?.loadSettings?.();
        const n = Number(settings?.refreshSec);
        return Number.isFinite(n) && n >= 5 && n <= 60 ? n : DEFAULT_POLL_SEC;
    }

    function restartWithin(root) {
        destroyWithin(root);
        initWithin(root);
    }

    /* =========================
       FETCH
    ========================= */

    async function fetchChemSummary(section, path, timeout) {

        if (_inflight) return _inflight;

        const url = apiUrl(path);

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeout);

        _inflight = (async () => {

            try {

                const r = await fetch(url, { method: "GET", cache: "no-store", signal: ac.signal });

                if (!r.ok) throw new Error("HTTP " + r.status);

                const j = await r.json();

                if (!j || j.ok !== true) throw new Error("summary not ok");

                return j;

            }
            finally {
                clearTimeout(t);
                _inflight = null;
            }

        })();

        return _inflight;
    }

    /* =========================
       EXTRACTORS
    ========================= */

    function numOrNull(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function pickById(payload, id) {

        id = String(id);

        if (payload.byId?.[id]) return payload.byId[id];
        if (payload.aq?.[id]) return payload.aq[id];
        if (payload.Aq?.[id]) return payload.Aq[id];
        if (payload.aqLatest?.[id]) return payload.aqLatest[id];

        const rows = payload.rows || payload.items || payload.aqRows;

        if (Array.isArray(rows)) {
            for (const r of rows) {
                const rid = r.configId ?? r.cfgId ?? r.id;
                if (String(rid) === id) return r;
            }
        }

        return null;
    }

    function pickValue(p, id) {
        const o = pickById(p, id);
        return o ? numOrNull(o.value ?? o.val ?? o.v ?? o.num) : null;
    }

    function pickStatus(p, id) {
        const o = pickById(p, id);
        if (!o) return null;

        const v =
            o.status ?? o.state ?? o.text ?? o.value_text ?? o.valueText ??
            o.valueText1 ?? o.valueTxt ?? o.str ?? o.value_string;

        if (v != null && v !== "") return String(v);

        const n = o.value ?? o.val ?? o.v ?? o.num;
        return (n == null) ? null : String(n);
    }

    function pickMetric(p, stream, key) {

        const mc = p.metrics_current || p.metrics || p.metricsCurrent;

        if (mc) {

            if (mc[stream]?.[key] != null) {
                const v = mc[stream][key];
                return typeof v === "object" ? numOrNull(v.value) : numOrNull(v);
            }

            const flat = `${stream}.${key}`;
            if (mc[flat] != null) return numOrNull(mc[flat]);

        }

        return null;
    }

    /* =========================
       DOM HELPERS
    ========================= */

    function setText(scope, key, val) {
        const el = scope.querySelector(`[data-bind="${key}"]`);
        if (el) el.textContent = (val == null || val === "") ? "-" : String(val);
    }

    function setFill(scope, key, p) {
        const el = scope.querySelector(`[data-bind-fill="${key}"]`);
        if (!el) return;
        const v = Math.max(0, Math.min(100, Number(p) || 0));
        el.style.setProperty("--fill", v);
    }

    function normalizeState(s) {
        const t = String(s ?? "").trim().toUpperCase();
        // RUN / ON
        if (t === "RUN" || t.includes("RUN") || t === "ON" || t.includes(" ON") || t === "1") return "on";
        // STANDBY / STBY
        if (t === "STANDBY" || t.includes("STANDBY") || t === "STBY" || t.includes("STBY") || t === "2") return "stby";
        // REPAIR / REP
        if (t === "REPAIR" || t.includes("REPAIR") || t === "REP" || t.includes("REP") || t === "3") return "rep";
        return "off";
    }

    function setSlotState(scope, key, state) {
        const el = scope.querySelector(`[data-bind="${key}"]`);
        if (!el) {
            console.warn("bind not found:", key);
            return;
        }
        const st = normalizeState(state);
        el.classList.remove("on", "stby", "rep", "off");
        el.classList.add(st);
    }

    function setOkChip(scope, card, ok) {
        setText(scope, `${card}.OK_TEXT`, ok ? "OK" : "--");
        const el = scope.querySelector(`.chem-card[data-card="${card}"]`);
        if (!el) return;
        el.classList.remove("ok", "rep");
        el.classList.add(ok ? "ok" : "rep");
    }

    function setTankModeChips(scope, card, a, b) {
        const on = (normalizeState(a) === "on") || (normalizeState(b) === "on");
        const elOn = scope.querySelector(`[data-bind="${card}.TANK_ON"]`);
        const elSt = scope.querySelector(`[data-bind="${card}.TANK_STBY"]`);
        if (elOn) elOn.style.display = on ? "" : "none";
        if (elSt) elSt.style.display = on ? "none" : "";
    }

    function setTankStatusText(scope, key, rawStatus) {
        const el = scope.querySelector(`[data-bind="${key}"]`);
        if (!el) return;

        // โชว์ค่าดิบแบบอ่านง่าย
        const t = String(rawStatus ?? "").trim();
        el.textContent = t !== "" ? t : "-";
    }

    function fmtInt(n) {
        return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "0";
    }

    function fmt1(n) {
        const x = Number(n);
        if (!Number.isFinite(x)) return "0";
        return x.toLocaleString("en-US", {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1
        });
    }

    function pctFill(v, c) {
        if (!Number.isFinite(v) || !Number.isFinite(c) || c <= 0) return 0;
        return (v / c) * 100;
    }

    /* =========================
       RATE CALC
    ========================= */

    function rateLh(flow, dose, factor, div3600) {
        if (flow == null || dose == null) return null;
        const base = flow * dose * factor;
        return div3600 ? (base / 3600) : base;
    }

    function rateKgh(flow, dose) {
        if (flow == null || dose == null) return null;
        if (flow > 15) {
            flow = flow / 3600;
        }
        return flow * dose * FACT_CL;
    }

    /* =========================
       TANK PREDICTION
    ========================= */

    /** "yyyy-MM-dd HH:mm[:ss]" → Date (เวลาท้องถิ่น) */
    function parseLocalTs(s) {
        const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s ?? "").trim());
        if (!m) return null;
        const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        return isNaN(d.getTime()) ? null : d;
    }

    function ymd(d) {
        const p = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    function hhmm(d) {
        const p = n => String(n).padStart(2, "0");
        return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function tankKey(name) {
        return String(name ?? "").trim().replace(/\s+/g, " ").toUpperCase();
    }

    /**
     * ระดับหลังเติมล่าสุดต่อถังจาก chem.db (เหมือน RecordStore.LatestAfterReadings)
     * เวลา = เวลาชั่งออก (DoneAt) — ไม่มี (Uroboros รุ่นเก่า) → เวลากดบันทึก (AfterAt) — ไม่มีทั้งคู่ = ข้าม
     */
    function latestAfterReadings(rows) {
        const out = {};
        for (const r of (Array.isArray(rows) ? rows : [])) {
            for (const f of (Array.isArray(r?.Fills) ? r.Fills : [])) {
                if (f?.LevelAfter == null || f.LevelAfter === "") continue;
                const lvl = numOrNull(f.LevelAfter);
                if (lvl == null) continue;
                const at = parseLocalTs(r.DoneAt) || parseLocalTs(f.AfterAt);
                if (!at) continue;
                const k = tankKey(f.Tank);
                if (!out[k] || at > out[k].at)
                    out[k] = { at, level: lvl, wash: !!r.IsWash, truck: r.Truck || "" };
            }
        }
        return out;
    }

    async function fetchRefills(section) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - REFILL_LOOKBACK_DAYS);
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), TIMEOUT_MS * 2);
        try {
            const r = await fetch(apiUrl(REFILL_PATH), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ startDate: ymd(start), endDate: ymd(now), dateField: "DAYOUT" }),
                cache: "no-store",
                signal: ac.signal
            });
            if (!r.ok) throw new Error("HTTP " + r.status);
            const j = await r.json();
            if (!j || j.ok !== true) throw new Error("chem_report not ok");
            section._chemRefills = latestAfterReadings(j.rows);
        } finally {
            clearTimeout(t);
        }
    }

    /** ดึงระดับหลังเติมเป็นระยะ (ไม่บล็อกการ render) — ล้มเหลว = ใช้ค่าเดิม/ใช้แต่ API */
    function maybeRefreshRefills(section) {
        const now = Date.now();
        if (section._chemRefillBusy || now - (section._chemRefillAt || 0) < REFILL_POLL_MS) return;
        section._chemRefillBusy = true;
        section._chemRefillAt = now;
        fetchRefills(section)
            .then(() => { if (section._chemLast) renderTanks(section, section._chemLast); })
            .catch(() => { })
            .finally(() => { section._chemRefillBusy = false; });
    }

    /** อัตราจ่ายจริง m³/ชม. ของเฟสหนึ่ง ต่อสาร — null = ไม่ทราบ flow */
    function phaseRateM3h(p, chem, phase) {
        const flow = pickValue(p, FLOW_ID[phase]);
        if (flow == null) return null;
        const dose = pickValue(p, DOSE[chem][phase]) ?? 0;        // dose ว่าง = เฟสนี้ไม่จ่าย
        const factor = chem === "ALUM" ? FACT_ALUM : FACT_PACL;
        const lh = rateLh(flow, dose, factor, phase === "P3" || phase === "P4");
        return Math.max(0, lh) / 1000;
    }

    function predictTanks(p, refills, now) {
        const isOn = t => normalizeState(t.status) === "on";
        const rows = TANKS.map(t => {
            const o = pickById(p, t.lvl);
            const raw = o ? (o.value ?? o.val ?? o.v ?? o.num) : null;
            const lv = raw == null || raw === "" ? null : numOrNull(raw);   // Number(null) = 0 → ต้องกันก่อน
            return {
                ...t,
                status: pickStatus(p, t.st),
                api: lv == null ? null : { level: lv, at: parseLocalTs(o.ts ?? o.time ?? o.timestamp) },
                op: refills?.[tankKey(t.name)] || null
            };
        });

        // อัตราจ่ายจริงใช้ได้เมื่อ flow ไม่เก่าเกิน MAX_DOSE_AGE_H
        const flowTs = Object.values(FLOW_ID)
            .map(id => parseLocalTs(pickById(p, id)?.ts))
            .filter(Boolean)
            .reduce((a, b) => (a && a > b ? a : b), null);
        const doseFresh = flowTs == null || (now - flowTs) / 3600000 <= MAX_DOSE_AGE_H;

        return rows.map(t => {
            let base = null;
            if (t.op && (!t.api || !t.api.at || t.op.at > t.api.at))
                base = { level: t.op.level, at: t.op.at, src: t.op.wash ? "พนักงานบันทึกหลังล้างถัง" : "พนักงานบันทึกหลังเติม" };
            else if (t.api)
                base = { level: t.api.level, at: t.api.at, src: "API" };
            if (!base) return { tank: t, pred: null };

            let rate = 0, rateSrc = "ไม่ทราบสถานะถัง";
            if (t.status != null && t.status !== "") {
                if (!isOn(t)) {
                    rateSrc = "ถังไม่ได้ ON";
                } else {
                    const group = rows.filter(o => o.chem === t.chem && o.phases.join() === t.phases.join());
                    const onInGroup = Math.max(1, group.filter(isOn).length);
                    let groupRate = null;
                    if (doseFresh) {
                        for (const ph of t.phases) {
                            const r = phaseRateM3h(p, t.chem, ph);
                            if (r != null) groupRate = (groupRate ?? 0) + r;
                        }
                    }
                    if (groupRate != null && groupRate > 0) {
                        rate = groupRate / onInGroup;
                        rateSrc = `อัตราจ่ายจริง ${t.phases.join("+")} ${groupRate.toFixed(2)} m³/ชม. ÷ ${onInGroup} ถัง`;
                    } else if (DEFAULT_USAGE_M3H[t.chem] > 0) {
                        const onCount = Math.max(1, rows.filter(o => o.chem === t.chem && isOn(o)).length);
                        rate = DEFAULT_USAGE_M3H[t.chem] / onCount;
                        rateSrc = `ค่าเริ่มต้น ${DEFAULT_USAGE_M3H[t.chem]} m³/ชม. ÷ ${onCount} ถัง`;
                    }
                }
            }

            const elapsedH = base.at ? Math.max(0, (now - base.at) / 3600000) : 0;
            const level = Math.min(Math.max(base.level - rate * elapsedH, 0), Math.max(t.cap, base.level));
            return { tank: t, pred: { level, base, rate, rateSrc, elapsedH } };
        });
    }

    /** เวลาบนป้ายที่มา: วันนี้ = HH:mm, วันอื่น = dd/MM (ป้ายแคบ) */
    function srcTime(d, now) {
        if (!d) return "";
        const p = n => String(n).padStart(2, "0");
        return d.toDateString() === now.toDateString()
            ? `${p(d.getHours())}:${p(d.getMinutes())}`
            : `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
    }

    /** แถบลายปะ "ใช้ไปแล้ว" — สร้างครั้งแรกที่ต้องใช้ (markup เดิมมีแค่ chem-fill) */
    function usedBand(box) {
        const well = box?.querySelector(".chem-well");
        if (!well) return null;
        let el = well.querySelector(".chem-used");
        if (!el) {
            el = document.createElement("div");
            el.className = "chem-used";
            el.hidden = true;
            const fill = well.querySelector(".chem-fill");
            if (fill) fill.after(el); else well.prepend(el);
        }
        return el;
    }

    function renderTanks(scope, p) {
        const now = new Date();
        for (const { tank: t, pred } of predictTanks(p, scope._chemRefills, now)) {
            const fmtLv = v => (t.chem === "PACL" ? fmt1(v) : fmtInt(v));
            const box = scope.querySelector(`[data-bind-fill="${t.bind}.FILL"]`);
            const band = usedBand(box);
            const src = box?.querySelector(".chem-src");
            if (!pred) {
                setText(scope, `${t.bind}.READ`, null);
                setFill(scope, `${t.bind}.FILL`, 0);
                if (band) band.hidden = true;
                if (src) { src.textContent = `${fmtInt(t.cap)} m³`; src.className = "chem-src"; }
                if (box) { box.removeAttribute("title"); box.classList.remove("read-light"); }
                continue;
            }

            const fillPct = Math.min(100, pctFill(pred.level, t.cap));
            setText(scope, `${t.bind}.READ`, fmtLv(pred.level));
            setFill(scope, `${t.bind}.FILL`, fillPct);
            box?.classList.toggle("read-light", fillPct < 55);

            // ลายปะ: จากระดับปัจจุบันขึ้นไปถึงระดับฐาน — เฉพาะถังที่กำลังถูกใช้ (อัตรา > 0)
            const used = pred.base.level - pred.level;
            if (band) {
                const usedPct = Math.min(pctFill(used, t.cap), Math.max(0, 100 - fillPct));
                band.hidden = !(pred.rate > 0 && usedPct >= 0.3);
                box.style.setProperty("--used", band.hidden ? 0 : usedPct);
            }

            // ป้ายที่มาของฐาน: API (เทา) / เติม-ล้าง จาก chem.db (ฟ้า)
            const fromRefill = pred.base.src !== "API";
            if (src) {
                const verb = fromRefill ? (pred.base.src.includes("ล้าง") ? "ล้าง" : "เติม") : "API";
                src.textContent = `${verb} ${srcTime(pred.base.at, now)}`.trim();
                src.className = "chem-src " + (fromRefill ? "src-refill" : "src-api");
            }

            if (box) {
                const lines = [
                    `${t.name}: ${fmtLv(pred.level)} / ${fmtInt(t.cap)} m³`,
                    `ฐาน: ${pred.base.src} ${fmtLv(pred.base.level)} m³` + (pred.base.at ? ` @ ${hhmm(pred.base.at)}` : ""),
                    `อัตราใช้: ${pred.rate.toFixed(3)} m³/ชม. (${pred.rateSrc})`,
                    pred.rate > 0 ? `ผ่านไป ${pred.elapsedH.toFixed(2)} ชม. → −${(pred.rate * pred.elapsedH).toFixed(3)} m³` : null,
                    t.api && pred.base.src !== "API"
                        ? `API ล่าสุด: ${fmtLv(t.api.level)} m³` + (t.api.at ? ` @ ${hhmm(t.api.at)}` : "")
                        : null
                ].filter(Boolean);
                box.title = lines.join("\n");
            }
        }
    }

    /* =========================
       RENDER
    ========================= */

    function renderAll(scope, p) {

        const f1 = pickValue(p, FLOW_ID.P1);
        const f2 = pickValue(p, FLOW_ID.P2);
        const f3 = pickValue(p, FLOW_ID.P3);
        const f4 = pickValue(p, FLOW_ID.P4);

        /* ---------- ALUM1 ---------- */

        const a1p1 = pickValue(p, DOSE.ALUM.P1);
        const a1p2 = pickValue(p, DOSE.ALUM.P2);

        setText(scope, "ALUM1.P1.MG", fmtInt(a1p1));
        setText(scope, "ALUM1.P2.MG", fmtInt(a1p2));

        setText(scope, "ALUM1.P1.LH", fmtInt(rateLh(f1, a1p1, FACT_ALUM, false)));
        setText(scope, "ALUM1.P2.LH", fmtInt(rateLh(f2, a1p2, FACT_ALUM, false)));

        STATUS.ALUM12_PUMP.forEach((id, i) => {
            setSlotState(scope, `ALUM1.PUMP.${i + 1}`, pickStatus(p, id));
        });

        const a1Ta = pickValue(p, STATUS.ALUM12_TANK_A_VAL);
        const a1Tb = pickValue(p, STATUS.ALUM12_TANK_B_VAL);

        const alum1TankA = pickStatus(p, STATUS.ALUM12_TANK_A);
        const alum1TankB = pickStatus(p, STATUS.ALUM12_TANK_B);

        setStatusChip(scope, "ALUM1.TANKA", alum1TankA);
        setStatusChip(scope, "ALUM1.TANKB", alum1TankB);

        /* ---------- PACL1 ---------- */

        const p1p1 = pickValue(p, DOSE.PACL.P1);
        const p1p2 = pickValue(p, DOSE.PACL.P2);

        setText(scope, "PACL1.P1.MG", fmtInt(p1p1));
        setText(scope, "PACL1.P2.MG", fmtInt(p1p2));

        setText(scope, "PACL1.P1.LH", fmtInt(rateLh(f1, p1p1, FACT_PACL, false)));
        setText(scope, "PACL1.P2.LH", fmtInt(rateLh(f2, p1p2, FACT_PACL, false)));

        STATUS.PACL12_PUMP.forEach((id, i) => {
            setSlotState(scope, `PACL1.PUMP.${i + 1}`, pickStatus(p, id));
        });

        const p1Ta = pickValue(p, STATUS.PACL12_TANK_A_VAL);
        const p1Tb = pickValue(p, STATUS.PACL12_TANK_B_VAL);

        const pacl1TankA = pickStatus(p, STATUS.PACL12_TANK_A);
        const pacl1TankB = pickStatus(p, STATUS.PACL12_TANK_B);

        setStatusChip(scope, "PACL1.TANKA", pacl1TankA);
        setStatusChip(scope, "PACL1.TANKB", pacl1TankB);

        /* ---------- ALUM2 ---------- */

        const a2p3 = pickValue(p, DOSE.ALUM.P3);
        const a2p4 = pickValue(p, DOSE.ALUM.P4);

        setText(scope, "ALUM2.P3.MG", fmtInt(a2p3));
        setText(scope, "ALUM2.P4.MG", fmtInt(a2p4));

        setText(scope, "ALUM2.P3.LH", fmtInt(rateLh(f3, a2p3, FACT_ALUM, true)));
        setText(scope, "ALUM2.P4.LH", fmtInt(rateLh(f4, a2p4, FACT_ALUM, true)));

        STATUS.ALUM3_PUMP.forEach((id, i) => {
            setSlotState(scope, `ALUM3.PUMP.${i + 1}`, pickStatus(p, id));
        });

        STATUS.ALUM4_PUMP.forEach((id, i) => {
            setSlotState(scope, `ALUM4.PUMP.${i + 1}`, pickStatus(p, id));
        });

        const a2Ta = pickValue(p, STATUS.ALUM2_TANK_C_VAL);
        const a2Tb = pickValue(p, STATUS.ALUM2_TANK_D_VAL);


        const alum2TankA = pickStatus(p, STATUS.ALUM2_TANK_C);
        const alum2TankB = pickStatus(p, STATUS.ALUM2_TANK_D);

        setStatusChip(scope, "ALUM2.TANKA", alum2TankA);
        setStatusChip(scope, "ALUM2.TANKB", alum2TankB);

        /* ---------- PACL2 ---------- */

        const p2p3 = pickValue(p, DOSE.PACL.P3);
        const p2p4 = pickValue(p, DOSE.PACL.P4);

        setText(scope, "PACL2.P3.MG", fmtInt(p2p3));
        setText(scope, "PACL2.P4.MG", fmtInt(p2p4));

        setText(scope, "PACL2.P3.LH", fmtInt(rateLh(f3, p2p3, FACT_PACL, true)));
        setText(scope, "PACL2.P4.LH", fmtInt(rateLh(f4, p2p4, FACT_PACL, true)));

        STATUS.PACL34_PUMP.forEach((id, i) => {
            setSlotState(scope, `PACL2.PUMP.${i + 1}`, pickStatus(p, id));
        });

        const p2Ta = pickValue(p, STATUS.PACL2_TANK_C_VAL);
        const p2Tb = pickValue(p, STATUS.PACL2_TANK_D_VAL);

        // ระดับถัง ALUM/PACL: API + ระดับหลังเติมจาก chem.db → คาดการณ์แบบ TruckSidecar
        renderTanks(scope, p);

        const pacl2TankC = pickStatus(p, STATUS.PACL2_TANK_C);
        const pacl2TankD = pickStatus(p, STATUS.PACL2_TANK_D);

        setStatusChip(scope, "PACL2.TANKC", pacl2TankC);
        setStatusChip(scope, "PACL2.TANKD", pacl2TankD);

        /* ---------- CHLORINE1 ---------- */

        const pre1 = pickValue(p, DOSE.PRE.P1);
        const pre2 = pickValue(p, DOSE.PRE.P2);
        const post1 = pickValue(p, DOSE.POST.P1);
        const post2 = pickValue(p, DOSE.POST.P2);

        setText(scope, "CHLORINE1.PRE.P1.MG", fmt1(pre1));
        setText(scope, "CHLORINE1.PRE.P2.MG", fmt1(pre2));
        setText(scope, "CHLORINE1.POST.P1.MG", fmt1(post1));
        setText(scope, "CHLORINE1.POST.P2.MG", fmt1(post2));

        setText(scope, "CHLORINE1.PRE.P1.KGH", fmt1(rateKgh(f1, pre1)));
        setText(scope, "CHLORINE1.PRE.P2.KGH", fmt1(rateKgh(f2, pre2)));
        setText(scope, "CHLORINE1.POST.P1.KGH", fmt1(rateKgh(f1, post1)));
        setText(scope, "CHLORINE1.POST.P2.KGH", fmt1(rateKgh(f2, post2)));

        STATUS.CL12_EVAP.forEach((id, i) => {
            setSlotState(scope, `CHLORINE1.EVAP.${i + 1}`, pickStatus(p, id));
        });

        STATUS.CL12_CHLOR.forEach((id, i) => {
            setSlotState(scope, `CHLORINE1.CHLORINATOR.${i + 1}`, pickStatus(p, id));
        });

        const cl1A = pickMetric(p, METRIC.CL1A.stream, METRIC.CL1A.key);
        const cl1B = pickMetric(p, METRIC.CL1B.stream, METRIC.CL1B.key);

        setText(scope, "CHLORINE1.LINEA.READ", fmtInt(cl1A));
        setText(scope, "CHLORINE1.LINEB.READ", fmtInt(cl1B));

        setFill(scope, "CHLORINE1.LINEA.FILL", pctFill(cl1A, CAP_CL_KG));
        setFill(scope, "CHLORINE1.LINEB.FILL", pctFill(cl1B, CAP_CL_KG));

        const Cl1LineA = pickStatus(p, STATUS.CL12_TANK_A);
        const Cl1LineB = pickStatus(p, STATUS.CL12_TANK_B);

        setStatusChip(scope, "CHLORINE1.LINEA", Cl1LineA);
        setStatusChip(scope, "CHLORINE1.LINEB", Cl1LineB);

        /* ---------- CHLORINE2 ---------- */

        const pre3 = pickValue(p, DOSE.PRE.P3);
        const pre4 = pickValue(p, DOSE.PRE.P4);
        const post3 = pickValue(p, DOSE.POST.P3);
        const post4 = pickValue(p, DOSE.POST.P4);

        setText(scope, "CHLORINE2.PRE.P3.MG", fmt1(pre3));
        setText(scope, "CHLORINE2.PRE.P4.MG", fmt1(pre4));
        setText(scope, "CHLORINE2.POST.P3.MG", fmt1(post3));
        setText(scope, "CHLORINE2.POST.P4.MG", fmt1(post4));

        setText(scope, "CHLORINE2.PRE.P3.KGH", fmt1(rateKgh(f3, pre3)));
        setText(scope, "CHLORINE2.PRE.P4.KGH", fmt1(rateKgh(f4, pre4)));
        setText(scope, "CHLORINE2.POST.P3.KGH", fmt1(rateKgh(f3, post3)));
        setText(scope, "CHLORINE2.POST.P4.KGH", fmt1(rateKgh(f4, post4)));

        STATUS.CL34_EVAP.forEach((id, i) => {
            setSlotState(scope, `CHLORINE2.EVAP.${i + 1}`, pickStatus(p, id));
        });

        STATUS.CL34_CHLOR.forEach((id, i) => {
            setSlotState(scope, `CHLORINE2.CHLORINATOR.${i + 1}`, pickStatus(p, id));
        });

        const cl2A = pickMetric(p, METRIC.CL2A.stream, METRIC.CL2A.key);
        const cl2B = pickMetric(p, METRIC.CL2B.stream, METRIC.CL2B.key);

        setText(scope, "CHLORINE2.LINEA.READ", fmtInt(cl2A));
        setText(scope, "CHLORINE2.LINEB.READ", fmtInt(cl2B));

        setFill(scope, "CHLORINE2.LINEA.FILL", pctFill(cl2A, CAP_CL_KG));
        setFill(scope, "CHLORINE2.LINEB.FILL", pctFill(cl2B, CAP_CL_KG));

        const Cl2LineA = pickStatus(p, STATUS.CL34_TANK_A);
        const Cl2LineB = pickStatus(p, STATUS.CL34_TANK_B);

        setStatusChip(scope, "CHLORINE2.LINEA", Cl2LineA);
        setStatusChip(scope, "CHLORINE2.LINEB", Cl2LineB);



        setOkChip(scope, "ALUM1", (a1Ta != null && a1Tb != null));
        setOkChip(scope, "ALUM2", (a2Ta != null && a2Tb != null));
        setOkChip(scope, "PACL1", (p1Ta != null && p1Tb != null));
        setOkChip(scope, "PACL2", (p2Ta != null && p2Tb != null));
        setOkChip(scope, "CHLORINE1", (cl1A != null && cl1B != null));
        setOkChip(scope, "CHLORINE2", (cl2A != null && cl2B != null));

        const alertSettings = window.CHEMSettings?.loadSettings?.();
        const bell = scope.querySelector('[data-role="chem-alert-bell"]');

        if (alertSettings) {
            const chlorineFills = [
                pctFill(cl1A, CAP_CL_KG), // CHLORINE1.LINEA.FILL
                pctFill(cl1B, CAP_CL_KG), // CHLORINE1.LINEB.FILL
                pctFill(cl2A, CAP_CL_KG), // CHLORINE2.LINEA.FILL
                pctFill(cl2B, CAP_CL_KG)  // CHLORINE2.LINEB.FILL
            ];

            const chlorineRuleKeys = [
                "chem-chlorine1-linea-fill-low",
                "chem-chlorine1-lineb-fill-low",
                "chem-chlorine2-linea-fill-low",
                "chem-chlorine2-lineb-fill-low"
            ];

            let anyAlerting = false;

            for (let i = 0; i < chlorineFills.length; i++) {
                const fillValue = Number.isFinite(chlorineFills[i]) ? chlorineFills[i] : null;

                const low = window.BBAlerts?.evaluate?.(scope, {
                    ruleKey: chlorineRuleKeys[i],
                    enabled: alertSettings.chlorineAlertEnabled ?? alertSettings.alertEnabled,
                    muted: alertSettings.alertMuted,
                    value: fillValue,
                    limit: alertSettings.chlorineLowFillLimit ?? alertSettings.alertLimit,
                    direction: "lt"
                }) || false;

                anyAlerting = anyAlerting || low;
            }

            window.BBAlerts?.setBellState?.(
                bell,
                anyAlerting
                    ? "alerting"
                    : (alertSettings.alertMuted ? "muted" : "armed")
            );
        }
    }

    /* =========================
       POLLING
    ========================= */

    async function refreshSection(section) {
        maybeRefreshRefills(section);
        const data = await fetchChemSummary(section, getSummaryPath(section), TIMEOUT_MS);
        section._chemLast = data;
        renderAll(section, data);
    }

    function initWithin(root) {

        const scope = root || document;
        const sections = scope.querySelectorAll("section.chem-block");

        sections.forEach(sec => {

            if (sec._chemBound) return;
            sec._chemBound = true;

            refreshSection(sec).catch(() => { });

            const pollMs = getRefreshSec(sec) * 1000;

            sec._chemTimer = setInterval(() => {
                refreshSection(sec).catch(() => { });
            }, pollMs);

        });

    }

    function statusLabel(rawStatus) {
        const t = String(rawStatus ?? "").trim().toUpperCase();
        if (t === "" || t === "0" || t === "OFF") return "OFF";
        if (t.includes("STANDBY") || t === "STBY" || t === "2") return "STBY";
        if (t.includes("REPAIR") || t.includes("REP") || t === "3") return "REP";
        if (t.includes("RUN") || t.includes("ON") || t === "1") return "ON";
        return t; // fallback
    }

    function setStatusChip(scope, key, rawStatus) {
        const el = scope.querySelector(`[data-bind="${key}"]`);
        if (!el) return;

        const st = normalizeState(rawStatus);

        el.classList.remove("on", "stby", "rep", "off");
        el.classList.add(st);

        // ✅ โชว์คำย่อบน chip
        el.textContent = statusLabel(rawStatus);
    }

    function destroyWithin(root) {

        const scope = root || document;
        const sections = scope.querySelectorAll("section.chem-block");

        sections.forEach(sec => {
            if (sec._chemTimer) clearInterval(sec._chemTimer);
            sec._chemBound = false;
        });

    }

    window.CHEMView = { initWithin, destroyWithin, restartWithin, predictTanks, latestAfterReadings };

})();
