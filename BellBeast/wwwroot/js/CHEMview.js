(function () {
    "use strict";

    /* =========================
       CONSTANTS
    ========================= */

    const DEFAULT_POLL_SEC = 15;
    const TIMEOUT_MS = 8000;

    const CAP_ALUM_M3 = 625;
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

    let _inflight = null;

    /* =========================
       API URL
    ========================= */

    function inferBackendBase() {
        const proto = (location.protocol === "https:") ? "https" : "http";
        return `${proto}://${location.hostname}:8888`;
    }

    function apiUrl(path) {
        if (!path.startsWith("/")) path = "/" + path;
        return inferBackendBase() + path;
    }

    function getSummaryPath(section) {
        return section.getAttribute("data-chem-summary-url") || "/api/chem/summary";
    }

    function getRefreshSec(section) {
        try {
            const raw = localStorage.getItem("chem_refresh_settings_v1");
            if (!raw) return DEFAULT_POLL_SEC;

            const o = JSON.parse(raw);
            const n = Number(o?.refreshSec);

            return Number.isFinite(n) && n >= 5 && n <= 60 ? n : DEFAULT_POLL_SEC;
        } catch {
            return DEFAULT_POLL_SEC;
        }
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

        setText(scope, "ALUM1.TANKA.READ", fmtInt(a1Ta));
        setText(scope, "ALUM1.TANKB.READ", fmtInt(a1Tb));

        setFill(scope, "ALUM1.TANKA.FILL", pctFill(a1Ta, CAP_ALUM_M3));
        setFill(scope, "ALUM1.TANKB.FILL", pctFill(a1Tb, CAP_ALUM_M3));

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

        setText(scope, "PACL1.TANKA.READ", fmtInt(p1Ta));
        setText(scope, "PACL1.TANKB.READ", fmtInt(p1Tb));

        setFill(scope, "PACL1.TANKA.FILL", pctFill(p1Ta, CAP_PACL_A_M3));
        setFill(scope, "PACL1.TANKB.FILL", pctFill(p1Tb, CAP_PACL_B1_M3));

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

        setText(scope, "ALUM2.TANKA.READ", fmtInt(a2Ta));
        setText(scope, "ALUM2.TANKB.READ", fmtInt(a2Tb));

        setFill(scope, "ALUM2.TANKA.FILL", pctFill(a2Ta, CAP_ALUM_M3));
        setFill(scope, "ALUM2.TANKB.FILL", pctFill(a2Tb, CAP_ALUM_M3));


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

        setText(scope, "PACL2.TANKA.READ", fmtInt(p2Ta));
        setText(scope, "PACL2.TANKB.READ", fmtInt(p2Tb));

        setFill(scope, "PACL2.TANKA.FILL", pctFill(p2Ta, CAP_PACL_A_M3));
        setFill(scope, "PACL2.TANKB.FILL", pctFill(p2Tb, CAP_PACL_B2_M3));

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
    }

    /* =========================
       POLLING
    ========================= */

    async function refreshSection(section) {
        const data = await fetchChemSummary(section, getSummaryPath(section), TIMEOUT_MS);
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

    window.CHEMView = { initWithin, destroyWithin, restartWithin };

})();