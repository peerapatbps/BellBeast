/* tps_summary.js
 * - fetch /api/tps/summary
 * - update TPS KPIs + pump statuses (from data.Pumps)
 * - update tanks PK/TP/RB (from data.Tanks)
 * - render RCV38 chart (from data.RCV38 [{t:"HH:mm", v:number}])
 * - safe for injected partial (guard + one timer per section)
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

    function clampPct(p) {
        if (!Number.isFinite(p)) return null;
        if (p < 0) return 0;
        if (p > 100) return 100;
        return p;
    }

    function setGauge(gaugeEl, pct) {
        if (!gaugeEl) return;
        const cp = clampPct(pct);
        gaugeEl.style.setProperty("--fill", String(cp ?? 0));
    }

    function getAlertSettings() {
        const s = (window.TPSSettings && typeof window.TPSSettings.loadSettings === "function")
            ? window.TPSSettings.loadSettings()
            : {};

        const pressureHighLimit = Number.isFinite(Number(s.pressureHighLimit ?? s.pressureAlertLimit))
            ? Number(s.pressureHighLimit ?? s.pressureAlertLimit)
            : 4.5;

        return {
            pressureAlertEnabled: Boolean(s.pressureAlertEnabled),
            pressureLowLimit: Number.isFinite(Number(s.pressureLowLimit)) ? Number(s.pressureLowLimit) : 2.5,
            pressureHighLimit: pressureHighLimit,
            pressureAlertLimit: pressureHighLimit,
            serviceWaterFlowAlertEnabled: Boolean(s.serviceWaterFlowAlertEnabled),
            serviceWaterFlowLowLimit: Number.isFinite(Number(s.serviceWaterFlowLowLimit)) ? Number(s.serviceWaterFlowLowLimit) : 5.0,
            pressureAlertMuted: Boolean(s.pressureAlertMuted)
        };
    }

    function ensureChart(section, canvas) {
        // guard: ถ้าไม่มี Chart.js -> คืน null (ไม่ throw)
        if (!canvas || typeof window.Chart === "undefined") return null;

        // reuse chart per section
        if (section._tpsRcv38ChartObj && section._tpsRcv38ChartObj.canvas === canvas) {
            return section._tpsRcv38ChartObj;
        }

        // ถ้ามีของเก่าแต่ canvas เปลี่ยน -> destroy
        if (section._tpsRcv38ChartObj && typeof section._tpsRcv38ChartObj.destroy === "function") {
            try { section._tpsRcv38ChartObj.destroy(); } catch (e) { }
        }

        const ctx = canvas.getContext("2d");
        const chart = new window.Chart(ctx, {
            type: "line",
            data: { labels: [], datasets: [{ data: [] }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: true,
                        intersect: false,
                        mode: "index",
                        callbacks: {
                            title: (items) => (items?.[0]?.label ?? ""),
                            label: (item) => ` ${fmtNumber(item.parsed?.y, 2) ?? "-"}`
                        }
                    }
                },
                elements: {
                    line: { tension: 0.25, borderWidth: 3 },
                    point: {
                        radius: (ctx2) => {
                            const i = ctx2.dataIndex;
                            const n = (ctx2.chart?.data?.labels?.length ?? 0);
                            return (i === n - 1) ? 5 : 0; // จุดล่าสุดใหญ่
                        },
                        hoverRadius: 6
                    }
                },
                scales: {
                    x: {
                        type: "category",
                        ticks: {
                            display: true,
                            color: "rgba(255,255,255,.6)",
                            maxRotation: 45,
                            autoSkip: true,
                            maxTicksLimit: 6
                        },
                        grid: {
                            display: true,
                            color: (ctx) => ctx.tick.value === 0
                                ? "rgba(255,255,255,.18)"
                                : "rgba(255,255,255,.06)"
                        }
                    },
                    y: {
                        ticks: {
                            display: true,
                            color: "rgba(255,255,255,.6)",
                            maxTicksLimit: 5,
                            callback: function (value) {
                                return value + " %";
                            }
                        },
                        grid: {
                            display: true,
                            color: (ctx) => ctx.tick.value === 0
                                ? "rgba(255,255,255,.18)"
                                : "rgba(255,255,255,.06)"
                        }
                    }
                }
            }
        });

        section._tpsRcv38ChartObj = chart;
        return chart;
    }

    async function startForSection(section) {
        if (!section) return;

        // ✅ guard: injected ซ้ำก็ไม่ start ซ้ำ
        if (section._tpsSummaryStarted) return;
        section._tpsSummaryStarted = true;

        const url = section.getAttribute("data-tps-summary-url") || "/api/tps/summary";
        const s = (window.TPSSettings && typeof window.TPSSettings.loadSettings === "function")
            ? window.TPSSettings.loadSettings()
            : { refreshSec: 15 };

        const refreshSec = Math.max(5, Math.min(300, Number(s.refreshSec || 15)));
        const pollMs = refreshSec * 1000;

        // ---- top KPIs ----
        const elTrFlow = section.querySelector("#tpsTrFlow");
        const elTrFlowStatus = section.querySelector("#tpsTrFlowStatus");
        const elTotalDaily = section.querySelector("#tpsTotalDailyFlow");

        const elPressure = section.querySelector("#tpsPressure");
        const elPressureStatus = section.querySelector("#tpsPressureStatus");
        const elBell = section.querySelector('[data-role="tps-alert-bell"]');

        const elCwt = section.querySelector("#tpsCwtLevel");
        const elCwtStatus = section.querySelector("#tpsCwtStatus");

        const elOverviewStatus = section.querySelector("#tpsOverviewStatus");
        const elSvcWater = section.querySelector("#tpsSvcWater");
        const elSvcWaterTot = section.querySelector("#tpsSvcWaterTot");

        // ---- pumps ----
        const pumpEls = Array.from(section.querySelectorAll("[data-pump]"));

        // ---- tanks (PK/TP/RB) ----
        const tankMap = {
            PK: {
                status: section.querySelector("#tpsPkStatus"),
                dq: section.querySelector("#tpsPkDQ"),
                pin: section.querySelector("#tpsPkPin"),
                pout: section.querySelector("#tpsPkPout"),
                pct: section.querySelector("#tpsPkPct"),
                level: section.querySelector("#tpsPkLevel"),
                gauge: section.querySelector("#tpsPkGauge"),
            },
            TP: {
                status: section.querySelector("#tpsTpStatus"),
                dq: section.querySelector("#tpsTpDQ"),
                pin: section.querySelector("#tpsTpPin"),
                pout: section.querySelector("#tpsTpPout"),
                pct: section.querySelector("#tpsTpPct"),
                level: section.querySelector("#tpsTpLevel"),
                gauge: section.querySelector("#tpsTpGauge"),
            },
            RB: {
                status: section.querySelector("#tpsRbStatus"),
                dq: section.querySelector("#tpsRbDQ"),
                pin: section.querySelector("#tpsRbPin"),
                pout: section.querySelector("#tpsRbPout"),
                pct: section.querySelector("#tpsRbPct"),
                level: section.querySelector("#tpsRbLevel"),
                gauge: section.querySelector("#tpsRbGauge"),
            }
        };

        // ---- RCV38 ----
        const elRcvStatus = section.querySelector("#tpsRcv38Status");
        const elRcvCanvas = section.querySelector("#tpsRcv38Chart");

        let inFlight = false;

        function resetAllBad() {
            // pumps
            for (const pe of pumpEls) applyPumpStatus(pe, null);

            // KPIs
            if (elTrFlow) elTrFlow.textContent = "-";
            if (elTotalDaily) elTotalDaily.textContent = "-";
            if (elPressure) elPressure.textContent = "-";
            if (elCwt) elCwt.textContent = "-";
            if (elSvcWater) elSvcWater.textContent = "-";
            if (elSvcWaterTot) elSvcWaterTot.textContent = "-";

            setStatus(elTrFlowStatus, false);
            setStatus(elPressureStatus, false);
            setStatus(elCwtStatus, false);
            setStatus(elOverviewStatus, false);
            window.BBAlerts?.resetRule?.(section, "pressure-low");
            window.BBAlerts?.resetRule?.(section, "pressure-high");
            window.BBAlerts?.resetRule?.(section, "service-water-flow-low");
            window.BBAlerts?.setBellState?.(elBell, "muted");

            // tanks
            for (const k of Object.keys(tankMap)) {
                const t = tankMap[k];
                if (t.dq) t.dq.textContent = "-";
                if (t.pin) t.pin.textContent = "-";
                if (t.pout) t.pout.textContent = "-";
                if (t.pct) t.pct.textContent = "-";
                if (t.level) t.level.textContent = "-";
                setGauge(t.gauge, 0);
                setStatus(t.status, false);
            }

            // RCV chart
            setStatus(elRcvStatus, false);
            if (section._tpsRcv38ChartObj && typeof section._tpsRcv38ChartObj.destroy === "function") {
                try { section._tpsRcv38ChartObj.destroy(); } catch (e) { }
            }
            section._tpsRcv38ChartObj = null;
            // clear canvas area (optional)
            if (elRcvCanvas && elRcvCanvas.getContext) {
                const c = elRcvCanvas.getContext("2d");
                try { c.clearRect(0, 0, elRcvCanvas.width, elRcvCanvas.height); } catch (e) { }
            }
        }

        async function tick() {
            if (inFlight) return;
            inFlight = true;

            try {
                const res = await fetch(url, { method: "GET", cache: "no-store" });
                if (!res.ok) throw new Error("HTTP " + res.status);
                const data = await res.json();

                // ---- pumps (from data.Pumps) ----
                const pumps = data?.Pumps || {};
                for (const pe of pumpEls) {
                    const pumpName = pe.getAttribute("data-pump") || "";
                    applyPumpStatus(pe, pumps[pumpName]);
                }

                // ---- TR FLOW + Total Daily (flow*24) ----
                const trFlow = (typeof data?.TR_flow === "number") ? data.TR_flow : Number(data?.TR_flow);
                const trFlowText = fmtNumber(trFlow, 0);
                if (elTrFlow) elTrFlow.textContent = (trFlowText ?? "-");
                setStatus(elTrFlowStatus, trFlowText !== null);

                const daily = Number.isFinite(trFlow) ? (trFlow * 24.0) : NaN;
                const dailyText = fmtNumber(daily, 0);
                if (elTotalDaily) elTotalDaily.textContent = (dailyText ?? "-");

                // ---- Pressure ----
                const pText = fmtNumber(data?.TR_pressure, 2);
                const pressureValue = (typeof data?.TR_pressure === "number") ? data.TR_pressure : Number(data?.TR_pressure);
                if (elPressure) elPressure.textContent = (pText ?? "-");
                setStatus(elPressureStatus, pText !== null);

                const alertSettings = getAlertSettings();

                const pressureLowExceeded = window.BBAlerts?.evaluate?.(section, {
                    ruleKey: "pressure-low",
                    enabled: alertSettings.pressureAlertEnabled,
                    muted: alertSettings.pressureAlertMuted,
                    value: pressureValue,
                    limit: alertSettings.pressureLowLimit,
                    direction: "lt"
                }) || false;

                const pressureHighExceeded = window.BBAlerts?.evaluate?.(section, {
                    ruleKey: "pressure-high",
                    enabled: alertSettings.pressureAlertEnabled,
                    muted: alertSettings.pressureAlertMuted,
                    value: pressureValue,
                    limit: alertSettings.pressureHighLimit,
                    direction: "gt"
                }) || false;

                // ---- CWT ----
                const cwtText = fmtNumber(data?.TR_cwt, 2);
                if (elCwt) elCwt.textContent = (cwtText ?? "-");
                setStatus(elCwtStatus, cwtText !== null);

                // ---- Overview (service water) ----
                const svcText = fmtNumber(data?.SVwater_flow, 0);
                const svcTotText = fmtNumber(data?.SVwater_sumflow, 1);

                if (elSvcWater) elSvcWater.textContent = (svcText ?? "-");
                if (elSvcWaterTot) elSvcWaterTot.textContent = (svcTotText ?? "-");

                setStatus(elOverviewStatus, (svcText !== null) || (svcTotText !== null));

                const serviceWaterValue = (typeof data?.SVwater_flow === "number")
                    ? data.SVwater_flow
                    : Number(data?.SVwater_flow);

                const serviceWaterLowExceeded = window.BBAlerts?.evaluate?.(section, {
                    ruleKey: "service-water-flow-low",
                    enabled: alertSettings.serviceWaterFlowAlertEnabled,
                    muted: alertSettings.pressureAlertMuted,
                    value: serviceWaterValue,
                    limit: alertSettings.serviceWaterFlowLowLimit,
                    direction: "lt"
                }) || false;

                const anyAlerting =
                    pressureLowExceeded ||
                    pressureHighExceeded ||
                    serviceWaterLowExceeded;

                window.BBAlerts?.setBellState?.(
                    elBell,
                    anyAlerting
                        ? "alerting"
                        : (alertSettings.pressureAlertMuted ? "muted" : "armed")
                );

                // ---- Tanks ----
                const tanks = data?.Tanks || {};
                for (const name of ["PK", "TP", "RB"]) {
                    const t = tanks?.[name] || {};
                    const ui = tankMap[name];

                    // คุณโชว์เป็น "ΔQ" แต่ payload เป็น Qin -> ใช้ Qin ตรง ๆ
                    const qinText = fmtNumber(t?.Qin, 0);
                    const pinText = fmtNumber(t?.Pin, 2);
                    const poutText = fmtNumber(t?.Pout, 2);
                    const lvlText = fmtNumber(t?.Level, 2);
                    const pctVal = (typeof t?.Percent === "number") ? t.Percent : Number(t?.Percent);
                    const pctText = fmtNumber(pctVal, 2);

                    if (ui.dq) ui.dq.textContent = (qinText ?? "-");
                    if (ui.pin) ui.pin.textContent = (pinText ?? "-");
                    if (ui.pout) ui.pout.textContent = (poutText ?? "-");
                    if (ui.level) ui.level.textContent = (lvlText ?? "-");
                    if (ui.pct) {ui.pct.textContent = (pctText !== null && pctText !== undefined)? `${Math.round(Number(pctText))}%`: "-";}
                    setGauge(ui.gauge, pctVal);
                    const okTank = (qinText !== null) || (lvlText !== null);
                    setStatus(ui.status, okTank);
                }

                // ---- RCV38 chart ----
                const series = Array.isArray(data?.RCV38) ? data.RCV38 : [];
                const xs = series.map(p => String(p?.t ?? "")).filter(s => s.length > 0);
                const ys = series.map(p => (typeof p?.v === "number") ? p.v : Number(p?.v)).filter(n => Number.isFinite(n));

                // ต้องยาวเท่ากันจริง (กัน payload เพี้ยน)
                const n = Math.min(xs.length, ys.length);
                if (n >= 2 && elRcvCanvas) {
                    const chart = ensureChart(section, elRcvCanvas);
                    if (chart) {
                        chart.data.labels = xs.slice(0, n);
                        chart.data.datasets[0].data = ys.slice(0, n);
                        chart.update("none");
                        setStatus(elRcvStatus, true);
                    } else {
                        // ไม่มี Chart.js
                        setStatus(elRcvStatus, false);
                    }
                } else {
                    setStatus(elRcvStatus, false);
                    if (section._tpsRcv38ChartObj && typeof section._tpsRcv38ChartObj.destroy === "function") {
                        try { section._tpsRcv38ChartObj.destroy(); } catch (e) { }
                    }
                    section._tpsRcv38ChartObj = null;
                }

            } catch (e) {
                resetAllBad();
            } finally {
                inFlight = false;
            }
        }

        tick();
        section._tpsSummaryTimer = setInterval(tick, pollMs);
        window.TPSSettings?.syncBell?.(section);
    }

    function stopForSection(section) {
        if (!section) return;

        if (section._tpsSummaryTimer) {
            clearInterval(section._tpsSummaryTimer);
            section._tpsSummaryTimer = null;
        }

        if (section._tpsRcv38ChartObj && typeof section._tpsRcv38ChartObj.destroy === "function") {
            try { section._tpsRcv38ChartObj.destroy(); } catch { }
        }
        section._tpsRcv38ChartObj = null;

        section._tpsSummaryStarted = false;
    }

    window.TPSSummary = {
        initWithin(root) {
            const scope = root || document;
            const sections = scope.matches?.("section.tps-block")
                ? [scope]
                : Array.from(scope.querySelectorAll("section.tps-block"));

            for (const s of sections) startForSection(s);
        },

        restartWithin(root) {
            const scope = root || document;
            const sections = scope.matches?.("section.tps-block")
                ? [scope]
                : Array.from(scope.querySelectorAll("section.tps-block"));

            for (const s of sections) {
                stopForSection(s);
                startForSection(s);
            }
        }
    };
})();
