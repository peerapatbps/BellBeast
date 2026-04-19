/* dps_summary.js
 * - fetch /api/dps/summary
 * - update FlowAB + SumFlowAB + pump statuses (from data.Aq)
 * - update AIR COMPRESSOR (AirP1/AirP2 -> AIR1/AIR2 + AircompStatus)
 * - safe for injected partial (guard + one timer per section)
 */
(function () {
    "use strict";

    const PUMP_TO_CFG = {
        "7P01A": 816,
        "7P01B": 829,
        "7P02A": 842,
        "7P02B": 857
    };

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
        return "-";
    }

    function applyPumpStatus(pumpEl, rawText) {
        if (!pumpEl) return;
        const t = normalizePumpText(rawText);

        pumpEl.classList.remove("on", "stby", "rep");

        if (t === "ON") {
            pumpEl.classList.add("on");
            pumpEl.textContent = "ON";
        } else if (t === "STBY") {
            pumpEl.classList.add("stby");
            pumpEl.textContent = "STBY";
        } else if (t === "REP") {
            pumpEl.classList.add("rep");
            pumpEl.textContent = "REP";
        } else {
            pumpEl.classList.add("stby");
            pumpEl.textContent = "-";
        }
    }

    function readAqValueText(aq, cfg) {
        if (!aq) return null;
        return aq[cfg]?.value_text ?? aq[String(cfg)]?.value_text ?? null;
    }

    function loadDpsRefreshSec() {
        const settings = window.DPSSettings?.loadSettings?.();
        const settingsValue = Number(settings?.dpsRefreshSec ?? settings?.refreshSec);

        if (Number.isFinite(settingsValue)) {
            return Math.max(5, Math.min(60, settingsValue));
        }

        try {
            const raw = localStorage.getItem("dps_ptc_refresh_v1");
            if (!raw) return 15;

            const o = JSON.parse(raw);
            const n = Number(o?.dpsRefreshSec ?? o?.refreshSec);
            if (!Number.isFinite(n)) return 15;

            return Math.max(5, Math.min(60, n));
        } catch {
            return 15;
        }
    }

    function loadAlarmSettings() {
        const s = window.DPSSettings?.loadSettings?.() || {};

        return {
            flowAlertEnabled: Boolean(s.flowAlertEnabled),
            flowLowLimit: Number.isFinite(Number(s.flowLowLimit ?? s.flowAlertLimit))
                ? Number(s.flowLowLimit ?? s.flowAlertLimit)
                : 1000,

            airSumAlertEnabled: Boolean(s.airSumAlertEnabled),
            airSumLowLimit: Number.isFinite(Number(s.airSumLowLimit))
                ? Number(s.airSumLowLimit)
                : 1.0,

            alertMuted: Boolean(s.alertMuted)
        };
    }

    function resetAlarmRules(section, bell) {
        window.BBAlerts?.resetRule?.(section, "dps-flow-low");
        window.BBAlerts?.resetRule?.(section, "dps-air-sum-low");
        window.BBAlerts?.setBellState?.(bell, "muted");
    }

    function stopForSection(section) {
        if (!section) return;

        if (section._dpsSummaryTimer) {
            clearInterval(section._dpsSummaryTimer);
            section._dpsSummaryTimer = null;
        }

        section._dpsSummaryStarted = false;
    }

    async function startForSection(section) {
        if (!section) return;

        if (section._dpsSummaryStarted) return;
        section._dpsSummaryStarted = true;

        const url = section.getAttribute("data-dps-summary-url") || "/api/dps/summary";
        const refreshSec = loadDpsRefreshSec();
        const pollMs = refreshSec * 1000;

        const elFlow = section.querySelector("#dpsFlowAB");
        const elFlowStatus = section.querySelector("#dpsFlowStatus");
        const elBell = section.querySelector('[data-role="dps-alert-bell"]');

        const elSumFlow = section.querySelector("#dpsSumFlowAB");
        const elOverviewStatus = section.querySelector("#dpsOverviewStatus");

        const elAirStatus = section.querySelector("#AircompStatus");
        const elAir1 = section.querySelector("#AIR1");
        const elAir2 = section.querySelector("#AIR2");

        const pumpEls = Array.from(section.querySelectorAll("[data-pump]"));

        let inFlight = false;

        async function tick() {
            if (inFlight) return;
            inFlight = true;

            try {
                const res = await fetch(url, { method: "GET", cache: "no-store" });
                if (!res.ok) throw new Error("HTTP " + res.status);

                const data = await res.json();

                const aq = data?.Aq;
                for (const pe of pumpEls) {
                    const pumpName = pe.getAttribute("data-pump") || "";
                    const cfg = PUMP_TO_CFG[pumpName];
                    const vt = cfg ? readAqValueText(aq, cfg) : null;
                    applyPumpStatus(pe, vt);
                }

                const settings = loadAlarmSettings();

                // ---- FlowAB ----
                const flowText = fmtNumber(data?.FlowAB, 0);
                const flowValue = (typeof data?.FlowAB === "number")
                    ? data.FlowAB
                    : Number(data?.FlowAB);

                if (elFlow) elFlow.textContent = (flowText ?? "-");
                setStatus(elFlowStatus, flowText !== null);

                const flowLowExceeded = window.BBAlerts?.evaluate?.(section, {
                    ruleKey: "dps-flow-low",
                    enabled: settings.flowAlertEnabled,
                    muted: settings.alertMuted,
                    value: flowValue,
                    limit: settings.flowLowLimit,
                    direction: "lt"
                }) || false;

                // ---- SumFlowAB ----
                const sumFlowText = fmtNumber(data?.SumFlowAB, 0);
                const okOverview = (sumFlowText !== null);

                if (elSumFlow) elSumFlow.textContent = (sumFlowText ?? "-");
                setStatus(elOverviewStatus, okOverview);

                // ---- AIR COMPRESSOR ----
                const air1Value = (typeof data?.AirP1 === "number")
                    ? data.AirP1
                    : Number(data?.AirP1);

                const air2Value = (typeof data?.AirP2 === "number")
                    ? data.AirP2
                    : Number(data?.AirP2);

                const air1Text = fmtNumber(data?.AirP1, 2);
                const air2Text = fmtNumber(data?.AirP2, 2);

                if (elAir1) elAir1.textContent = (air1Text ?? "-");
                if (elAir2) elAir2.textContent = (air2Text ?? "-");

                const okAir = (air1Text !== null) || (air2Text !== null);
                setStatus(elAirStatus, okAir);

                const airSumValue =
                    (Number.isFinite(air1Value) ? air1Value : 0) +
                    (Number.isFinite(air2Value) ? air2Value : 0);

                const airSumLowExceeded = window.BBAlerts?.evaluate?.(section, {
                    ruleKey: "dps-air-sum-low",
                    enabled: settings.airSumAlertEnabled,
                    muted: settings.alertMuted,
                    value: airSumValue,
                    limit: settings.airSumLowLimit,
                    direction: "lt"
                }) || false;

                const anySummaryAlerting = flowLowExceeded || airSumLowExceeded;

                if (anySummaryAlerting) {
                    window.BBAlerts?.setBellState?.(elBell, "alerting");
                } else {
                    window.BBAlerts?.setBellState?.(
                        elBell,
                        settings.alertMuted ? "muted" : "armed"
                    );
                }

            } catch (e) {
                for (const pe of pumpEls) applyPumpStatus(pe, null);

                if (elFlow) elFlow.textContent = "-";
                if (elSumFlow) elSumFlow.textContent = "-";

                setStatus(elFlowStatus, false);
                setStatus(elOverviewStatus, false);

                if (elAir1) elAir1.textContent = "-";
                if (elAir2) elAir2.textContent = "-";

                setStatus(elAirStatus, false);

                resetAlarmRules(section, elBell);
            } finally {
                inFlight = false;
            }
        }

        tick();
        section._dpsSummaryTimer = setInterval(tick, pollMs);
        window.DPSSettings?.syncBell?.(section);
    }

    window.DPSSummary = {
        initWithin(root) {
            const scope = root || document;
            const sections = scope.matches?.("section.dps-block")
                ? [scope]
                : Array.from(scope.querySelectorAll("section.dps-block"));

            for (const s of sections) startForSection(s);
        },

        restartWithin(root) {
            const scope = root || document;
            const sections = scope.matches?.("section.dps-block")
                ? [scope]
                : Array.from(scope.querySelectorAll("section.dps-block"));

            for (const s of sections) {
                stopForSection(s);
                startForSection(s);
            }
        }
    };
})();