(function () {
    "use strict";

    const API_URL = "/api/event/summary";

    const CAP = {
        ALUM: 625.0,
        PACL_P1: 25.0,
        PACL_P2: 25.0,
        PACL_P3: 25.0,
        PACL_P4: 23.0,
        CHLORINE: 6000.0
    };

    const FACT = {
        ALUM: 1.313,
        PACL: 1.190
    };

    function clamp(v, min, max) {
        v = Number(v);
        if (isNaN(v)) return min;
        return Math.max(min, Math.min(max, v));
    }

    function num(v, fallback = 0) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    function fmtInt(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return "0";
        return Math.round(n).toLocaleString("en-US");
    }

    function fmt1(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return "0.0";
        return n.toLocaleString("en-US", {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1
        });
    }

    function pct(value, capacity) {
        if (!Number.isFinite(value) || !Number.isFinite(capacity) || capacity <= 0) return 0;
        return clamp((value / capacity) * 100.0, 0, 100);
    }

    function toDisplayDateTime(serverTsLocal) {
        if (!serverTsLocal) return "UPDATE: -";

        const parts = String(serverTsLocal).split(" ");
        if (parts.length !== 2) return `UPDATE: ${serverTsLocal}`;

        const d = parts[0].split("-");
        const t = parts[1].slice(0, 5);

        if (d.length !== 3) return `UPDATE: ${serverTsLocal}`;
        return `UPDATE: ${d[2]}-${d[1]}-${d[0]} ${t}`;
    }

    function chemRowMap(chemData) {
        const map = {};
        (chemData || []).forEach(function (row) {
            if (!row || !row.ProductCode) return;
            map[String(row.ProductCode)] = row;
        });
        return map;
    }

    function aqVal(aq, id) {
        const x = aq && aq[String(id)];
        if (!x) return null;
        if (x.value === null || x.value === undefined) return null;

        const n = Number(x.value);
        return Number.isFinite(n) ? n : null;
    }

    function buildTankRead(value, capacity) {
        const v = num(value, 0);
        const p = pct(v, capacity);
        return `${fmtInt(v)} / ${fmtInt(capacity)}<br>(${fmt1(p)}%)`;
    }

    function buildPayloadMap(resp) {
        const out = {};
        const aq = resp?.Aq || {};
        const aqMid = resp?.AqMidnight || {};
        const chem = chemRowMap(resp?.ChemData || []);

        const alumChem = chem["01"] || null;
        const paclChem = chem["03"] || null;
        const chChem = chem["02"] || null;

        out["UPDATE_TEXT"] = toDisplayDateTime(resp?.ServerTsLocal);

        // -------------------------
        // LEFT SUMMARY
        // -------------------------
        out["ALUM.IN"] = alumChem ? String(alumChem.qty ?? 0) : "0";
        out["ALUM.EQ"] = alumChem ? fmtInt(alumChem.total_net ?? 0) : "0";

        out["PACL.IN"] = paclChem ? String(paclChem.qty ?? 0) : "0";
        out["PACL.EQ"] = paclChem ? fmtInt(paclChem.total_net ?? 0) : "0";

        out["CHLORINE.IN"] = chChem ? String(chChem.qty ?? 0) : "0";
        out["CHLORINE.EQ"] = chChem ? fmtInt(chChem.total_net ?? 0) : "0";

        // -------------------------
        // AQ current
        // -------------------------
        const alumP12A = aqVal(aq, 93);
        const alumP12B = aqVal(aq, 96);
        const alumP34A = aqVal(aq, 155);
        const alumP34B = aqVal(aq, 158);

        const paclP12A = aqVal(aq, 8405);
        const paclP12B = aqVal(aq, 8407);
        const paclP34A = aqVal(aq, 8419);
        const paclP34B = aqVal(aq, 8421);

        const chP12A = aqVal(aq, 127);
        const chP12B = aqVal(aq, 128);
        const chP34A = aqVal(aq, 190);
        const chP34B = aqVal(aq, 191);

        // -------------------------
        // AQ midnight
        // -------------------------
        const alumP12AMid = aqVal(aqMid, 93);
        const alumP12BMid = aqVal(aqMid, 96);
        const alumP34AMid = aqVal(aqMid, 155);
        const alumP34BMid = aqVal(aqMid, 158);

        const paclP12AMid = aqVal(aqMid, 8405);
        const paclP12BMid = aqVal(aqMid, 8407);
        const paclP34AMid = aqVal(aqMid, 8419);
        const paclP34BMid = aqVal(aqMid, 8421);

        const chP12AMid = aqVal(aqMid, 127);
        const chP12BMid = aqVal(aqMid, 128);
        const chP34AMid = aqVal(aqMid, 190);
        const chP34BMid = aqVal(aqMid, 191);

        // -------------------------
        // NET from current tank values
        // -------------------------
        const alumP12Net = (num(alumP12A, 0) + num(alumP12B, 0)) * FACT.ALUM;
        const alumP34Net = (num(alumP34A, 0) + num(alumP34B, 0)) * FACT.ALUM;

        const paclP12Net = (num(paclP12A, 0) + num(paclP12B, 0)) * FACT.PACL;
        const paclP34Net = (num(paclP34A, 0) + num(paclP34B, 0)) * FACT.PACL;

        out["ALUM.P12.DELTA"] = fmt1(alumP12Net);
        out["ALUM.P34.DELTA"] = fmt1(alumP34Net);

        out["PACL.P12.DELTA"] = fmt1(paclP12Net);
        out["PACL.P34.DELTA"] = fmt1(paclP34Net);

        out["CHLORINE.P12.DELTA"] = "-";
        out["CHLORINE.P34.DELTA"] = "-";

        // -------------------------
        // ALUM TANKS
        // -------------------------
        out["ALUM.P12.TANKA.FILL"] = pct(num(alumP12A, 0), CAP.ALUM);
        out["ALUM.P12.TANKA.MIDNIGHT"] = pct(num(alumP12AMid, 0), CAP.ALUM);
        out["ALUM.P12.TANKA.READ"] = buildTankRead(alumP12A, CAP.ALUM);

        out["ALUM.P12.TANKB.FILL"] = pct(num(alumP12B, 0), CAP.ALUM);
        out["ALUM.P12.TANKB.MIDNIGHT"] = pct(num(alumP12BMid, 0), CAP.ALUM);
        out["ALUM.P12.TANKB.READ"] = buildTankRead(alumP12B, CAP.ALUM);

        out["ALUM.P34.TANKA.FILL"] = pct(num(alumP34A, 0), CAP.ALUM);
        out["ALUM.P34.TANKA.MIDNIGHT"] = pct(num(alumP34AMid, 0), CAP.ALUM);
        out["ALUM.P34.TANKA.READ"] = buildTankRead(alumP34A, CAP.ALUM);

        out["ALUM.P34.TANKB.FILL"] = pct(num(alumP34B, 0), CAP.ALUM);
        out["ALUM.P34.TANKB.MIDNIGHT"] = pct(num(alumP34BMid, 0), CAP.ALUM);
        out["ALUM.P34.TANKB.READ"] = buildTankRead(alumP34B, CAP.ALUM);

        // -------------------------
        // PACL TANKS
        // -------------------------
        out["PACL.P12.TANKA.FILL"] = pct(num(paclP12A, 0), CAP.PACL_P1);
        out["PACL.P12.TANKA.MIDNIGHT"] = pct(num(paclP12AMid, 0), CAP.PACL_P1);
        out["PACL.P12.TANKA.READ"] = buildTankRead(paclP12A, CAP.PACL_P1);

        out["PACL.P12.TANKB.FILL"] = pct(num(paclP12B, 0), CAP.PACL_P2);
        out["PACL.P12.TANKB.MIDNIGHT"] = pct(num(paclP12BMid, 0), CAP.PACL_P2);
        out["PACL.P12.TANKB.READ"] = buildTankRead(paclP12B, CAP.PACL_P2);

        out["PACL.P34.TANKA.FILL"] = pct(num(paclP34A, 0), CAP.PACL_P3);
        out["PACL.P34.TANKA.MIDNIGHT"] = pct(num(paclP34AMid, 0), CAP.PACL_P3);
        out["PACL.P34.TANKA.READ"] = buildTankRead(paclP34A, CAP.PACL_P3);

        out["PACL.P34.TANKB.FILL"] = pct(num(paclP34B, 0), CAP.PACL_P4);
        out["PACL.P34.TANKB.MIDNIGHT"] = pct(num(paclP34BMid, 0), CAP.PACL_P4);
        out["PACL.P34.TANKB.READ"] = buildTankRead(paclP34B, CAP.PACL_P4);

        // -------------------------
        // CHLORINE TANKS
        // -------------------------
        out["CHLORINE.P12.TANKA.FILL"] = pct(num(chP12A, 0), CAP.CHLORINE);
        out["CHLORINE.P12.TANKA.MIDNIGHT"] = pct(num(chP12AMid, 0), CAP.CHLORINE);
        out["CHLORINE.P12.TANKA.READ"] = buildTankRead(chP12A, CAP.CHLORINE);

        out["CHLORINE.P12.TANKB.FILL"] = pct(num(chP12B, 0), CAP.CHLORINE);
        out["CHLORINE.P12.TANKB.MIDNIGHT"] = pct(num(chP12BMid, 0), CAP.CHLORINE);
        out["CHLORINE.P12.TANKB.READ"] = buildTankRead(chP12B, CAP.CHLORINE);

        out["CHLORINE.P34.TANKA.FILL"] = pct(num(chP34A, 0), CAP.CHLORINE);
        out["CHLORINE.P34.TANKA.MIDNIGHT"] = pct(num(chP34AMid, 0), CAP.CHLORINE);
        out["CHLORINE.P34.TANKA.READ"] = buildTankRead(chP34A, CAP.CHLORINE);

        out["CHLORINE.P34.TANKB.FILL"] = pct(num(chP34B, 0), CAP.CHLORINE);
        out["CHLORINE.P34.TANKB.MIDNIGHT"] = pct(num(chP34BMid, 0), CAP.CHLORINE);
        out["CHLORINE.P34.TANKB.READ"] = buildTankRead(chP34B, CAP.CHLORINE);

        return out;
    }

    function applyBindings(bindMap) {
        document.querySelectorAll("[data-bind]").forEach(function (el) {
            const key = el.getAttribute("data-bind");
            if (Object.prototype.hasOwnProperty.call(bindMap, key)) {
                el.innerHTML = bindMap[key];
            }
        });

        document.querySelectorAll("[data-bind-fill]").forEach(function (el) {
            const key = el.getAttribute("data-bind-fill");
            if (Object.prototype.hasOwnProperty.call(bindMap, key)) {
                el.style.setProperty("--fill", clamp(bindMap[key], 0, 100));
            }
        });

        document.querySelectorAll("[data-bind-midnight]").forEach(function (el) {
            const key = el.getAttribute("data-bind-midnight");
            if (Object.prototype.hasOwnProperty.call(bindMap, key)) {
                el.style.setProperty("--midnight", clamp(bindMap[key], 0, 100));
            }
        });
    }

    async function loadEventSummary() {
        const resp = await fetch(API_URL, {
            method: "GET",
            cache: "no-store"
        });

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }

        const json = await resp.json();
        const bindMap = buildPayloadMap(json);
        applyBindings(bindMap);

        window.EVENT_SUMMARY_RAW = json;
        window.EVENT_SUMMARY_BIND = bindMap;
    }

    loadEventSummary().catch(function (err) {
        console.error("[EVENTview] load failed:", err);
    });
})();