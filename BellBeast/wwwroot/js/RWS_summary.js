/* rws_summary.js
 * - fetch /api/rws/summary
 * - update RWS/RPS pump statuses
 * - update RW#1/RW#2/RW#3/RW#4 flow + sumflow
 * - evaluate flow-low alarm from RWSOnlineSettings
 */
(function () {
    "use strict";

    function setStatus(el, ok) {
        if (!el) return;
        el.classList.remove("ok", "bad");
        el.classList.add(ok ? "ok" : "bad");
        el.textContent = ok ? "OK" : "ERR";
    }

    function fmtNumber(v, decimals) {
        if (v === null || v === undefined) return null;
        const n = (typeof v === "number") ? v : Number(String(v).replace(/,/g, "").trim());
        if (!Number.isFinite(n)) return null;
        const d = (decimals ?? 0);
        return n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
    }

    function normalizePumpText(raw) {
        const s = String(raw ?? "").trim().toUpperCase();
        if (s === "ON") return "ON";
        if (s === "STANDBY" || s === "STBY") return "STBY";
        if (s === "REP" || s === "REPAIR") return "REP";
        if (s === "OFF" || s === "STOP") return "OFF";
        return "-";
    }

    function applyPumpStatus(pumpEl, rawText) {
        if (!pumpEl) return;
        const t = normalizePumpText(rawText);

        pumpEl.classList.remove("on", "stby", "rep", "off");

        if (t === "ON") {
            pumpEl.classList.add("on");
            pumpEl.textContent = "ON";
        } else if (t === "STBY") {
            pumpEl.classList.add("stby");
            pumpEl.textContent = "STBY";
        } else if (t === "REP") {
            pumpEl.classList.add("rep");
            pumpEl.textContent = "REP";
        } else if (t === "OFF") {
            pumpEl.classList.add("off");
            pumpEl.textContent = "OFF";
        } else {
            pumpEl.classList.add("stby");
            pumpEl.textContent = "-";
        }
    }

    function safeJsonAttr(section, attrName, fallbackObj) {
        const raw = section?.getAttribute(attrName);
        if (!raw) return fallbackObj;

        try {
            const o = JSON.parse(raw);
            return (o && typeof o === "object") ? o : fallbackObj;
        } catch {
            return fallbackObj;
        }
    }

    function pickMetric(data, key) {
        if (!key) return null;

        const vFlat = data?.[key];
        if (typeof vFlat === "number") return vFlat;

        if (vFlat !== null && vFlat !== undefined) {
            const n = Number(String(vFlat).replace(/,/g, "").trim());
            if (Number.isFinite(n)) return n;
        }

        const m = data?.Metrics || data?.metrics || null;
        if (m && typeof m === "object") {
            const v = m[key] ?? m[String(key)];

            if (typeof v === "number") return v;

            if (v !== null && v !== undefined) {
                const n = Number(String(v).replace(/,/g, "").trim());
                if (Number.isFinite(n)) return n;
            }
        }

        return null;
    }

    function loadRpsRefreshSec() {
        const settings = window.RWSOnlineSettings?.loadSettings?.();
        const settingsValue = Number(settings?.rpsRefreshSec);

        if (Number.isFinite(settingsValue)) {
            return Math.max(5, Math.min(60, settingsValue));
        }

        try {
            const raw = localStorage.getItem("rws_online_lab_refresh_v1");
            if (!raw) return 5;

            const o = JSON.parse(raw);
            const n = Number(o?.rpsRefreshSec);
            if (!Number.isFinite(n)) return 5;

            return Math.max(5, Math.min(60, n));
        } catch {
            return 5;
        }
    }

    function loadAlarmSettings() {
        const s = window.RWSOnlineSettings?.loadSettings?.() || {};

        return {
            flowAlertEnabled: Boolean(s.flowAlertEnabled),

            rw1FlowLowLimit: Number.isFinite(Number(s.rw1FlowLowLimit)) ? Number(s.rw1FlowLowLimit) : 1000,
            rw2FlowLowLimit: Number.isFinite(Number(s.rw2FlowLowLimit)) ? Number(s.rw2FlowLowLimit) : 1000,
            rw3FlowLowLimit: Number.isFinite(Number(s.rw3FlowLowLimit)) ? Number(s.rw3FlowLowLimit) : 1000,
            rw4FlowLowLimit: Number.isFinite(Number(s.rw4FlowLowLimit)) ? Number(s.rw4FlowLowLimit) : 1000,

            alertMuted: Boolean(s.alertMuted)
        };
    }

    function resetFlowRules(section, bell) {
        window.BBAlerts?.resetRule?.(section, "rws-flow1-low");
        window.BBAlerts?.resetRule?.(section, "rws-flow2-low");
        window.BBAlerts?.resetRule?.(section, "rws-flow3-low");
        window.BBAlerts?.resetRule?.(section, "rws-flow4-low");
        window.BBAlerts?.setBellState?.(bell, "muted");
    }

    async function startForSection(section) {
        if (!section) return;

        if (section._rwsSummaryStarted) return;
        section._rwsSummaryStarted = true;

        const url = section.getAttribute("data-rws-summary-url")
            || section.getAttribute("data-tps-summary-url")
            || "/api/rws/summary";

        const refreshSec = loadRpsRefreshSec();
        const pollMs = refreshSec * 1000;

        const pumpEls = Array.from(section.querySelectorAll("[data-pump]"));
        const pumpCfgMap = safeJsonAttr(section, "data-rws-pumps", null);

        const metricMap = safeJsonAttr(section, "data-rws-metrics", {
            flow1: "rwp1_flowp1",
            flow2: "rwp1_flowp2",
            sum1: "rwp1_sumflowp1",
            sum2: "rwp1_sumflowp2",
            flow3: "rwp2_flowp3",
            flow4: "rwp2_flowp4",
            sum3: "rwp2_sumflowp3",
            sum4: "rwp2_sumflowp4"
        });

        const elFlow1 = section.querySelector("#rwsFlow1");
        const elSum1 = section.querySelector("#rwsSum1");
        const elFlow2 = section.querySelector("#rwsFlow2");
        const elSum2 = section.querySelector("#rwsSum2");

        const elFlow3 = section.querySelector("#rwsFlow3");
        const elSum3 = section.querySelector("#rwsSum3");
        const elFlow4 = section.querySelector("#rwsFlow4");
        const elSum4 = section.querySelector("#rwsSum4");

        const elBell = section.querySelector('[data-role="rws-alert-bell"]');

        const st1 = section.querySelector("#rwsKpi1Status");
        const st2 = section.querySelector("#rwsKpi2Status");
        const st3 = section.querySelector("#rwsKpi3Status");
        const st4 = section.querySelector("#rwsKpi4Status");

        let inFlight = false;

        function resetAllBad() {
            for (const pe of pumpEls) applyPumpStatus(pe, null);

            if (elFlow1) elFlow1.textContent = "-";
            if (elSum1) elSum1.textContent = "-";
            if (elFlow2) elFlow2.textContent = "-";
            if (elSum2) elSum2.textContent = "-";
            if (elFlow3) elFlow3.textContent = "-";
            if (elSum3) elSum3.textContent = "-";
            if (elFlow4) elFlow4.textContent = "-";
            if (elSum4) elSum4.textContent = "-";

            setStatus(st1, false);
            setStatus(st2, false);
            setStatus(st3, false);
            setStatus(st4, false);

            resetFlowRules(section, elBell);
        }

        async function tick() {
            if (inFlight) return;
            inFlight = true;

            try {
                const res = await fetch(url, { method: "GET", cache: "no-store" });
                if (!res.ok) throw new Error("HTTP " + res.status);

                const data = await res.json();

                const pumpsByName = data?.Pumps || data?.pumps || null;
                const aqById = data?.Aq || data?.aq || null;

                for (const pe of pumpEls) {
                    const pumpName = pe.getAttribute("data-pump") || "";

                    let raw = null;

                    if (pumpsByName && typeof pumpsByName === "object") {
                        raw = pumpsByName[pumpName];
                    }

                    if ((raw === null || raw === undefined) && aqById && pumpCfgMap && pumpCfgMap[pumpName]) {
                        const cfg = pumpCfgMap[pumpName];
                        raw = aqById?.[cfg]?.value_text ?? aqById?.[String(cfg)]?.value_text ?? null;
                    }

                    applyPumpStatus(pe, raw);
                }

                const flow1 = pickMetric(data, metricMap.flow1);
                const flow2 = pickMetric(data, metricMap.flow2);
                const sum1 = pickMetric(data, metricMap.sum1);
                const sum2 = pickMetric(data, metricMap.sum2);

                const flow3 = pickMetric(data, metricMap.flow3);
                const flow4 = pickMetric(data, metricMap.flow4);
                const sum3 = pickMetric(data, metricMap.sum3);
                const sum4 = pickMetric(data, metricMap.sum4);

                const f1t = fmtNumber(flow1, 0);
                const f2t = fmtNumber(flow2, 0);
                const s1t = fmtNumber(sum1, 0);
                const s2t = fmtNumber(sum2, 0);

                const f3t = fmtNumber(flow3, 0);
                const f4t = fmtNumber(flow4, 0);
                const s3t = fmtNumber(sum3, 0);
                const s4t = fmtNumber(sum4, 0);

                if (elFlow1) elFlow1.textContent = (f1t ?? "-");
                if (elFlow2) elFlow2.textContent = (f2t ?? "-");
                if (elSum1) elSum1.textContent = (s1t ?? "-");
                if (elSum2) elSum2.textContent = (s2t ?? "-");

                if (elFlow3) elFlow3.textContent = (f3t ?? "-");
                if (elFlow4) elFlow4.textContent = (f4t ?? "-");
                if (elSum3) elSum3.textContent = (s3t ?? "-");
                if (elSum4) elSum4.textContent = (s4t ?? "-");

                setStatus(st1, f1t !== null);
                setStatus(st2, f2t !== null);
                setStatus(st3, f3t !== null);
                setStatus(st4, f4t !== null);

                const settings = loadAlarmSettings();

                const flow1Low = window.BBAlerts?.evaluate?.(section, {
                    ruleKey: "rws-flow1-low",
                    enabled: settings.flowAlertEnabled,
                    muted: settings.alertMuted,
                    value: flow1,
                    limit: settings.rw1FlowLowLimit,
                    direction: "lt"
                }) || false;

                const flow2Low = window.BBAlerts?.evaluate?.(section, {
                    ruleKey: "rws-flow2-low",
                    enabled: settings.flowAlertEnabled,
                    muted: settings.alertMuted,
                    value: flow2,
                    limit: settings.rw2FlowLowLimit,
                    direction: "lt"
                }) || false;

                const flow3Low = window.BBAlerts?.evaluate?.(section, {
                    ruleKey: "rws-flow3-low",
                    enabled: settings.flowAlertEnabled,
                    muted: settings.alertMuted,
                    value: flow3,
                    limit: settings.rw3FlowLowLimit,
                    direction: "lt"
                }) || false;

                const flow4Low = window.BBAlerts?.evaluate?.(section, {
                    ruleKey: "rws-flow4-low",
                    enabled: settings.flowAlertEnabled,
                    muted: settings.alertMuted,
                    value: flow4,
                    limit: settings.rw4FlowLowLimit,
                    direction: "lt"
                }) || false;

                const anyAlerting = flow1Low || flow2Low || flow3Low || flow4Low;

                window.BBAlerts?.setBellState?.(
                    elBell,
                    anyAlerting ? "alerting" : (settings.alertMuted ? "muted" : "armed")
                );

            } catch (e) {
                resetAllBad();
            } finally {
                inFlight = false;
            }
        }

        tick();
        section._rwsSummaryTimer = setInterval(tick, pollMs);
        window.RWSOnlineSettings?.syncBell?.(section);
    }

    function stopForSection(section) {
        if (!section) return;

        if (section._rwsSummaryTimer) {
            clearInterval(section._rwsSummaryTimer);
            section._rwsSummaryTimer = null;
        }

        section._rwsSummaryStarted = false;
    }

    window.RWSSummary = {
        initWithin(root) {
            const scope = root || document;
            const sections = scope.matches?.("section.rws-block")
                ? [scope]
                : Array.from(scope.querySelectorAll("section.rws-block"));

            for (const s of sections) startForSection(s);
        },

        restartWithin(root) {
            const scope = root || document;
            const sections = scope.matches?.("section.rws-block")
                ? [scope]
                : Array.from(scope.querySelectorAll("section.rws-block"));

            for (const s of sections) {
                stopForSection(s);
                startForSection(s);
            }
        }
    };
})();