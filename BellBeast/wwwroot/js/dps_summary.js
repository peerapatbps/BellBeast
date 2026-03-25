/* dps_summary.js
 * - fetch /api/dps/summary
 * - update FlowAB + SumFlowAB + pump statuses (from data.Aq)
 * - update AIR COMPRESSOR (AirP1/AirP2 -> AIR1/AIR2 + AircompStatus)
 * - safe for injected partial (guard + one timer per section)
 */
(function () {
    "use strict";

    // mapping: pump tag -> configID
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
        // รองรับ key เป็น number หรือ string
        return aq[cfg]?.value_text ?? aq[String(cfg)]?.value_text ?? null;
    }

    async function startForSection(section) {
        if (!section) return;

        // ✅ guard: injected ซ้ำก็ไม่ start ซ้ำ
        if (section._dpsSummaryStarted) return;
        section._dpsSummaryStarted = true;

        const url = section.getAttribute("data-dps-summary-url") || "/api/dps/summary";
        const refreshSec = Math.max(2, parseInt(section.getAttribute("data-dps-refresh-sec") || "5", 10) || 5);
        const pollMs = refreshSec * 1000;

        const elFlow = section.querySelector("#dpsFlowAB");
        const elFlowStatus = section.querySelector("#dpsFlowStatus");
        const elSumFlow = section.querySelector("#dpsSumFlowAB");
        const elOverviewStatus = section.querySelector("#dpsOverviewStatus");

        // AIR COMPRESSOR card
        const elAirStatus = section.querySelector("#AircompStatus");
        const elAir1 = section.querySelector("#AIR1");
        const elAir2 = section.querySelector("#AIR2");

        // pumps: <span data-pump="7P01A">...</span>
        const pumpEls = Array.from(section.querySelectorAll("[data-pump]"));

        let inFlight = false;

        async function tick() {
            if (inFlight) return;
            inFlight = true;

            try {
                const res = await fetch(url, { method: "GET", cache: "no-store" });
                if (!res.ok) throw new Error("HTTP " + res.status);
                const data = await res.json();

                // ---- pumps (from data.Aq) ----
                const aq = data?.Aq;
                for (const pe of pumpEls) {
                    const pumpName = pe.getAttribute("data-pump") || "";
                    const cfg = PUMP_TO_CFG[pumpName];
                    const vt = cfg ? readAqValueText(aq, cfg) : null;
                    applyPumpStatus(pe, vt);
                }

                // ---- FlowAB ----
                const flowText = fmtNumber(data?.FlowAB, 0);
                if (elFlow) elFlow.textContent = (flowText ?? "-");
                setStatus(elFlowStatus, flowText !== null);

                // ---- SumFlowAB ----
                const sumFlowText = fmtNumber(data?.SumFlowAB, 0);
                const okOverview = (sumFlowText !== null);
                if (elSumFlow) elSumFlow.textContent = (sumFlowText ?? "-");
                setStatus(elOverviewStatus, okOverview);

                // ---- AIR COMPRESSOR (AirP1/AirP2 from backend) ----
                const air1Text = fmtNumber(data?.AirP1, 2);
                const air2Text = fmtNumber(data?.AirP2, 2);

                if (elAir1) elAir1.textContent = (air1Text ?? "-");
                if (elAir2) elAir2.textContent = (air2Text ?? "-");

                // OK ถ้าอย่างน้อย 1 ตัวอ่านได้ (ไม่ null)
                const okAir = (air1Text !== null) || (air2Text !== null);
                setStatus(elAirStatus, okAir);

            } catch (e) {
                // reset UI
                for (const pe of pumpEls) applyPumpStatus(pe, null);

                if (elFlow) elFlow.textContent = "-";
                if (elSumFlow) elSumFlow.textContent = "-";
                setStatus(elFlowStatus, false);
                setStatus(elOverviewStatus, false);

                if (elAir1) elAir1.textContent = "-";
                if (elAir2) elAir2.textContent = "-";
                setStatus(elAirStatus, false);

            } finally {
                inFlight = false;
            }
        }

        tick();
        section._dpsSummaryTimer = setInterval(tick, pollMs);
    }

    window.DPSSummary = {
        initWithin(root) {
            const scope = root || document;
            const sections = scope.matches?.("section.dps-block")
                ? [scope]
                : Array.from(scope.querySelectorAll("section.dps-block"));

            for (const s of sections) startForSection(s);
        }
    };
})();