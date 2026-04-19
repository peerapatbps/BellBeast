(function () {
    "use strict";

    const API_URL = "/api/event/summary";
    const DEFAULT_REFRESH_MIN = 15;
    const DEFAULT_ALERT_LIMIT = 3;

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

    let _inflight = null;

    function clamp(v, min, max) {
        v = Number(v);
        if (isNaN(v)) return min;
        return Math.max(min, Math.min(max, v));
    }

    function clampNum(v, min, max, fallback) {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function loadSettings() {
        const settings = window.EVENTSettings?.loadSettings?.();
        if (settings) {
            return {
                refreshMin: clampNum(settings.refreshMin, 5, 60, DEFAULT_REFRESH_MIN),
                alertEnabled: Boolean(settings.alertEnabled),
                alertLimit: clampNum(settings.alertLimit, 1, 30, DEFAULT_ALERT_LIMIT),
                alertMuted: Boolean(settings.alertMuted)
            };
        }

        return {
            refreshMin: DEFAULT_REFRESH_MIN,
            alertEnabled: false,
            alertLimit: DEFAULT_ALERT_LIMIT,
            alertMuted: false
        };
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

    function fmt3(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return "0.000";
        return n.toLocaleString("en-US", {
            minimumFractionDigits: 3,
            maximumFractionDigits: 3
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

        const remarkSummary = resp?.RemarkSummary || [];
        const remarkMap = Object.fromEntries(
            remarkSummary.map(x => [x?.type, x || {}])
        );

        const rec15 = Number(remarkMap.Rec?.station_15 ?? 0);
        const rec62 = Number(remarkMap.Rec?.station_62 ?? 0);
        const ret15 = Number(remarkMap.Ret?.station_15 ?? 0);
        const ret62 = Number(remarkMap.Ret?.station_62 ?? 0);
        const unl15 = Number(remarkMap.Unl?.station_15 ?? 0);
        const unl62 = Number(remarkMap.Unl?.station_62 ?? 0);

        const chlorineIn = rec15 + rec62;
        const chlorineOut = ret15 + ret62;

        out["UPDATE_TEXT"] = toDisplayDateTime(resp?.ServerTsLocal);

        out["ALUM.IN"] = alumChem ? String(alumChem.qty ?? 0) : "0";
        out["ALUM.EQ"] = alumChem ? fmt3((alumChem.total_net ?? 0) / 1000) : "0";

        out["PACL.IN"] = paclChem ? String(paclChem.qty ?? 0) : "0";
        out["PACL.EQ"] = paclChem ? fmt3((paclChem.total_net ?? 0) / 1000) : "0";

        out["CHLORINE.IN"] = String(chlorineIn);
        out["CHLORINE.OUT"] = String(chlorineOut);

        const Dose_Alum_P1 = aqVal(aq, 89) || 24;
        const Dose_Alum_P2 = aqVal(aq, 92) || 24;
        const Dose_Alum_P3 = aqVal(aq, 151) || 24;
        const Dose_Alum_P4 = aqVal(aq, 154) || 24;

        const Dose_PACl_P1 = aqVal(aq, 8402) || 12;
        const Dose_PACl_P2 = aqVal(aq, 8404) || 12;
        const Dose_PACl_P3 = aqVal(aq, 8416) || 13;
        const Dose_PACl_P4 = aqVal(aq, 8419) || 10;

        const Dose_PrCl_P1 = aqVal(aq, 129) || 1.8;
        const Dose_PrCl_P2 = aqVal(aq, 131) || 1.8;
        const Dose_PoCl_P1 = aqVal(aq, 133) || 2;
        const Dose_PoCl_P2 = aqVal(aq, 135) || 2;
        const Dose_PrCl_P3 = aqVal(aq, 192) || 1.6;
        const Dose_PrCl_P4 = aqVal(aq, 194) || 1.7;
        const Dose_PoCl_P3 = aqVal(aq, 196) || 1.6;
        const Dose_PoCl_P4 = aqVal(aq, 198) || 1.7;

        const Flow1 = Math.round((aqVal(aq, 1) || 0) * 10) / 10;
        const Flow2 = Math.round((aqVal(aq, 2) || 0) * 10) / 10;
        const Flow3 = Math.round(((aqVal(aq, 39) || 0) / 3600) * 10) / 10;
        const Flow4 = Math.round(((aqVal(aq, 40) || 0) / 3600) * 10) / 10;

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

        const FullCL12 = aqVal(aqMid, 6972) - unl15 + rec15;
        const FullCL34 = aqVal(aqMid, 6973) - unl62 + rec62;

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

        const alumP12Remain = num(alumP12A, 0) + num(alumP12B, 0);
        const alumP34Remain = num(alumP34A, 0) + num(alumP34B, 0);

        const alumP12UsePerDay =
            (num(Flow1, 0) * num(Dose_Alum_P1, 0) * 5.4135 * 24 / 1000) +
            (num(Flow2, 0) * num(Dose_Alum_P2, 0) * 5.4135 * 24 / 1000);

        const alumP34UsePerDay =
            (num(Flow3, 0) * num(Dose_Alum_P3, 0) * 5.4135 * 24 / 1000) +
            (num(Flow4, 0) * num(Dose_Alum_P4, 0) * 5.4135 * 24 / 1000);

        const alumP12Delta = alumP12UsePerDay > 0 ? alumP12Remain / alumP12UsePerDay : 0;
        const alumP34Delta = alumP34UsePerDay > 0 ? alumP34Remain / alumP34UsePerDay : 0;

        out["ALUM.P12.NET"] = fmt1(alumP12Remain * FACT.ALUM);
        out["ALUM.P34.NET"] = fmt1(alumP34Remain * FACT.ALUM);
        out["ALUM.P12.DELTA"] = fmtInt(alumP12Delta);
        out["ALUM.P34.DELTA"] = fmtInt(alumP34Delta);

        const PAClP12Remain = num(paclP12A, 0) + num(paclP12B, 0);
        const PAClP34Remain = num(paclP34A, 0) + num(paclP34B, 0);

        const PAClP12UsePerDay =
            (num(Flow1, 0) * num(Dose_PACl_P1, 0) * 8.6434 * 24 / 1000) +
            (num(Flow2, 0) * num(Dose_PACl_P2, 0) * 8.6434 * 24 / 1000);

        const PAClP34UsePerDay =
            (num(Flow3, 0) * num(Dose_PACl_P3, 0) * 8.6434 * 24 / 1000) +
            (num(Flow4, 0) * num(Dose_PACl_P4, 0) * 8.6434 * 24 / 1000);

        const PAClP12Delta = PAClP12UsePerDay > 0 ? PAClP12Remain / PAClP12UsePerDay : 0;
        const PAClP34Delta = PAClP34UsePerDay > 0 ? PAClP34Remain / PAClP34UsePerDay : 0;

        out["PACL.P12.NET"] = fmt1(PAClP12Remain * FACT.PACL);
        out["PACL.P34.NET"] = fmt1(PAClP34Remain * FACT.PACL);
        out["PACL.P12.DELTA"] = fmt1(PAClP12Delta);
        out["PACL.P34.DELTA"] = fmt1(PAClP34Delta);

        const CLP12Remain = num(FullCL12 * 1000, 0) + num(chP12A, 0) + num(chP12B, 0);
        const CLP12UsePerDay =
            ((num(Dose_PrCl_P1, 0) + num(Dose_PoCl_P1, 0)) * num(Flow1, 0) * 3.6 +
                (num(Dose_PrCl_P2, 0) + num(Dose_PoCl_P2, 0)) * num(Flow2, 0) * 3.6) * 24;

        const CLP12Delta = CLP12UsePerDay > 0 ? CLP12Remain / CLP12UsePerDay : 0;

        const CLP34Remain = num(FullCL34 * 1000, 0) + num(chP34A, 0) + num(chP34B, 0);
        const CLP34UsePerDay =
            ((num(Dose_PrCl_P3, 0) + num(Dose_PoCl_P3, 0)) * num(Flow3, 0) * 3.6 +
                (num(Dose_PrCl_P4, 0) + num(Dose_PoCl_P4, 0)) * num(Flow4, 0) * 3.6) * 24;

        const CLP34Delta = CLP34UsePerDay > 0 ? CLP34Remain / CLP34UsePerDay : 0;

        out["CHLORINE.P12.NET"] = FullCL12;
        out["CHLORINE.P34.NET"] = FullCL34;
        out["CHLORINE.P12.DELTA"] = fmt1(CLP12Delta);
        out["CHLORINE.P34.DELTA"] = fmt1(CLP34Delta);

        return out;
    }

    function applyAllBindings(bindMap, root) {
        const scope = root || document;

        scope.querySelectorAll("[data-bind]").forEach(function (el) {
            const key = el.getAttribute("data-bind");
            if (key && Object.prototype.hasOwnProperty.call(bindMap, key)) {
                el.innerHTML = bindMap[key];
            }
        });

        scope.querySelectorAll("[data-bind-fill]").forEach(function (el) {
            const key = el.getAttribute("data-bind-fill");
            if (Object.prototype.hasOwnProperty.call(bindMap, key)) {
                el.style.setProperty("--fill", clamp(bindMap[key], 0, 100));
            }
        });

        scope.querySelectorAll("[data-bind-midnight]").forEach(function (el) {
            const key = el.getAttribute("data-bind-midnight");
            if (Object.prototype.hasOwnProperty.call(bindMap, key)) {
                el.style.setProperty("--midnight", clamp(bindMap[key], 0, 100));
            }
        });
    }

    async function fetchEventSummary(url) {
        if (_inflight) return _inflight;

        _inflight = (async () => {
            const resp = await fetch(url, {
                method: "GET",
                cache: "no-store"
            });

            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }

            return await resp.json();
        })();

        try {
            return await _inflight;
        } finally {
            _inflight = null;
        }
    }

    async function refreshAll(root) {
        const scope = root || document;
        const url = scope.getAttribute?.("data-event-summary-url") || API_URL;

        const json = await fetchEventSummary(url);
        const bindMap = buildPayloadMap(json);

        applyAllBindings(bindMap, scope);

        scope._eventRaw = json;
        scope._eventBind = bindMap;
        window.EVENT_SUMMARY_RAW = json;
        window.EVENT_SUMMARY_BIND = bindMap;

        const settings = loadSettings();
        const bell = scope.querySelector?.('[data-role="event-alert-bell"]');
        const deltaKeys = [
            "ALUM.P12.DELTA",
            "ALUM.P34.DELTA",
            "PACL.P12.DELTA",
            "PACL.P34.DELTA",
            "CHLORINE.P12.DELTA",
            "CHLORINE.P34.DELTA"
        ];
        const deltaValues = deltaKeys
            .map(key => Number(bindMap[key]))
            .filter(Number.isFinite);
        const minDelta = deltaValues.length ? Math.min(...deltaValues) : null;
        const exceeded = window.BBAlerts?.evaluate?.(scope, {
            ruleKey: "event-low-duration",
            enabled: settings.alertEnabled,
            muted: settings.alertMuted,
            value: minDelta,
            limit: settings.alertLimit,
            direction: "lt"
        }) || false;
        window.BBAlerts?.setBellState?.(bell, exceeded ? "alerting" : (settings.alertMuted ? "muted" : "armed"));
    }

    function startTimer(scope) {
        if (scope._eventTimer) {
            clearInterval(scope._eventTimer);
            scope._eventTimer = null;
        }

        const s = loadSettings();
        const refreshMs = s.refreshMin * 60 * 1000;

        scope._eventTimer = setInterval(() => {
            refreshAll(scope).catch(err => console.error("[EVENTview] refresh failed:", err));
        }, refreshMs);
    }

    function restartWithin(root) {
        const scope = root && root.matches?.("section.event-block")
            ? root
            : (document.querySelector("section.event-block") || document);

        refreshAll(scope).catch(err => console.error("[EVENTview] initial failed:", err));
        startTimer(scope);
    }

    function initWithin(root) {
        const scope = root && root.matches?.("section.event-block")
            ? root
            : (document.querySelector("section.event-block") || document);

        if (scope._eventBound === true) return;
        scope._eventBound = true;

        restartWithin(scope);
    }

    function destroyWithin(root) {
        const scope = root && root.matches?.("section.event-block")
            ? root
            : (document.querySelector("section.event-block") || document);

        if (scope._eventTimer) clearInterval(scope._eventTimer);

        scope._eventTimer = null;
        scope._eventBound = false;
    }

    window.EVENTView = {
        initWithin,
        destroyWithin,
        restartWithin
    };

    try { window.EVENTView.initWithin(document); } catch { }
})();
