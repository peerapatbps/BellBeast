(() => {
    /*
     * CLARIFIER block — GET /api/clarifier/summary (proxied to Uroboros).
     * Until upstream serves it, the block falls back to MOCK (LAB sheet 14-10-2569) and shows a MOCK pill.
     *
     * Payload contract ({ ok, data }):
     *   reportDate: "14-10-2569", sampledAt: "21:00"
     *   rw:    { turb: [["01:00", 52.6], ...], tss, temp, ph, alk }          // latest RW values; turb = 2-hourly series
     *   dose, jar                                                             // also sent by Uroboros; not shown on the card
     *   phases: [{ phase, times: [], cwA: [], cwB: [], cw: [], phA: [], phB: [], alkA: [], alkB: [],
     *              resCl: [], fw: [], oc }]                                    // arrays aligned with times, null = no sample
     */

    const DEFAULTS = {
        refreshMin: 10,
        cwLimit: 5,          // SD-MS-สคบ-05: CW Turb <= 5 NTU
        cwWarn: 4.5,
        alertEnabled: false,
        alertMuted: false
    };

    const STORAGE_KEY = "bb_clarifier_settings_v1";
    const RES_CL_LIMIT = 0.3;   // CW Res Cl2 <= 0.3
    const FW_LIMIT = 1;         // FW Turb <= 1
    // A/B basins share one coagulant flow meter and are split by hand on the float meters,
    // so an A/B gap in pH / alkalinity use points at an uneven split, not at the total dose
    const AB_GAP_WARN = 1;      // |A - B| turbidity, NTU
    const AB_PH_WARN = 0.1;     // |A - B| pH
    const AB_ALK_WARN = 5;      // |A - B| alkalinity, mg/L as CaCO3
    const PHASE_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f472b6"];

    let popupOverlayEl = null;

    // ---------- utils ----------
    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
        } catch {
            return { ...DEFAULTS };
        }
    }

    function saveSettings(v) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* ignore */ }
    }

    function num(v) {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function fmt(v, d) {
        const n = num(v);
        return n === null ? "-" : n.toFixed(d ?? 1);
    }

    function signed(v, d) {
        const n = num(v);
        if (n === null) return "-";
        return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(d ?? 1);
    }

    function arr(v) {
        return Array.isArray(v) ? v : [];
    }

    function lastIndex(values) {
        const a = arr(values);
        for (let i = a.length - 1; i >= 0; i--) if (num(a[i]) !== null) return i;
        return -1;
    }

    function latest(values) {
        const i = lastIndex(values);
        return i < 0 ? null : num(values[i]);
    }

    function avg2(a, b) {
        const x = num(a), y = num(b);
        if (x === null) return y;
        if (y === null) return x;
        return (x + y) / 2;
    }

    function esc(s) {
        return String(s ?? "")
            .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }

    function q(root, key) {
        return root.querySelector(`[data-clr="${key}"]`);
    }

    function setText(root, key, text) {
        const el = q(root, key);
        if (el) el.textContent = text;
    }

    function setPill(el, state, text) {
        if (!el) return;
        el.classList.remove("ok", "warn", "bad");
        if (state) el.classList.add(state);
        el.textContent = text;
    }

    // ---------- derived values ----------
    function phaseStats(p, rw, settings) {
        const times = arr(p.times);
        const iCw = lastIndex(p.cw);
        const cwA = latest(p.cwA), cwB = latest(p.cwB);
        const cw = iCw >= 0 ? num(p.cw[iCw]) : avg2(cwA, cwB);

        // day max over A/B (individual basins can exceed while the combined outlet passes)
        let maxVal = null, maxSide = "", maxTime = "";
        [["A", p.cwA], ["B", p.cwB]].forEach(([side, series]) => {
            arr(series).forEach((v, i) => {
                const n = num(v);
                if (n !== null && (maxVal === null || n > maxVal)) {
                    maxVal = n; maxSide = side; maxTime = times[i] || "";
                }
            });
        });

        const nc = arr(p.cw).filter(v => num(v) !== null && num(v) > settings.cwLimit).length;
        const samples = arr(p.cw).filter(v => num(v) !== null).length;

        const rwTurb = latest(arr(rw.turb).map(x => Array.isArray(x) ? x[1] : null));
        const rwAlk = num(rw.alk);
        const phA = latest(p.phA), phB = latest(p.phB);
        const alkA = latest(p.alkA), alkB = latest(p.alkB);
        const used = a => (a !== null && rwAlk !== null) ? rwAlk - a : null;

        let state = "ok";
        if (cw !== null && cw > settings.cwLimit) state = "bad";
        else if ((cw !== null && cw >= settings.cwWarn) || (maxVal !== null && maxVal > settings.cwLimit)) state = "warn";
        if (cw === null) state = "";

        return {
            cw, cwA, cwB, nc, samples, state,
            maxVal, maxSide, maxTime,
            removal: (rwTurb && cw !== null) ? (rwTurb - cw) / rwTurb * 100 : null,
            phA, phB,
            alkA, alkB,
            useA: used(alkA), useB: used(alkB),   // alkalinity consumed by coagulation in each basin
            resCl: latest(p.resCl),
            fw: latest(p.fw),
            ocRemoval: (num(p.oc) !== null && num(rw.oc) !== null && num(rw.oc) > 0)
                ? (num(rw.oc) - num(p.oc)) / num(rw.oc) * 100 : null
        };
    }

    function cls(value, limit, warnAt) {
        const n = num(value);
        if (n === null) return "";
        if (n > limit) return "is-bad";
        if (warnAt !== undefined && n >= warnAt) return "is-warn";
        return "";
    }

    // ---------- render ----------
    function renderHeader(root, data, stats, settings, isMock) {
        setText(root, "stamp", `LAB ${data.sampledAt || "-"} · ${data.reportDate || "-"}`);

        const nc = stats.reduce((s, x) => s + x.nc, 0);
        const total = stats.reduce((s, x) => s + x.samples, 0);
        const pct = total ? (nc / total * 100) : 0;
        setPill(q(root, "nc"), nc > 0 ? "bad" : "ok", total ? `NC ${nc}/${total} (${pct.toFixed(1)}%)` : "NC -");

        const src = q(root, "src");
        if (src) src.hidden = !isMock;

        const badPhases = stats.filter(x => x.state === "bad").length;
        const bell = root.querySelector('[data-role="clr-alert-bell"]');
        const exceeded = window.BBAlerts?.evaluate?.(root, {
            ruleKey: "clr-cw-over",
            enabled: settings.alertEnabled,
            muted: settings.alertMuted,
            value: badPhases,
            limit: 0,
            direction: "gt"
        }) || false;
        window.BBAlerts?.setBellState?.(bell, exceeded ? "alerting" : (settings.alertMuted ? "muted" : "armed"));
    }

    function renderRw(root, rw) {
        const series = arr(rw.turb).filter(x => Array.isArray(x) && num(x[1]) !== null);
        const last = series.length ? num(series[series.length - 1][1]) : null;
        const first = series.length ? num(series[0][1]) : null;
        // trend = change over ~4 h (last 3 two-hourly points)
        const ref = series.length >= 3 ? num(series[series.length - 3][1]) : first;
        const dTrend = (last !== null && ref !== null) ? last - ref : null;
        const dDay = (last !== null && first !== null) ? last - first : null;

        setText(root, "rwTurb", fmt(last, 1));
        const dEl = q(root, "rwDelta");
        if (dEl) {
            dEl.textContent = dDay === null ? "-" : `${dDay >= 0 ? "▲" : "▼"} ${signed(dDay, 1)} จาก ${series[0][0]}`;
            dEl.className = "clr-lbl " + (dDay !== null && dDay > 10 ? "is-warn" : "");
        }

        let trendState = "ok", trendText = "คงที่";
        if (dTrend !== null && dTrend > 5) { trendState = "warn"; trendText = "ขุ่นขึ้น"; }
        else if (dTrend !== null && dTrend < -5) { trendState = "ok"; trendText = "ขุ่นลด"; }
        setPill(q(root, "rwTrend"), dTrend === null ? "" : trendState, dTrend === null ? "-" : trendText);

        setText(root, "rwTss", fmt(rw.tss, 1));
        setText(root, "rwTemp", fmt(rw.temp, 1));
        setText(root, "rwPh", fmt(rw.ph, 2));
        setText(root, "rwAlk", fmt(rw.alk, 0));

        drawChart(root, "spark", {
            type: "line",
            data: {
                labels: series.map(x => x[0]),
                datasets: [{ data: series.map(x => num(x[1])), borderColor: "#fbbf24", borderWidth: 2, pointRadius: 2.5, pointBackgroundColor: "#fbbf24", tension: 0.3 }]
            },
            // spark now fills the card height -> show time ticks so the 2-hourly points are readable
            options: baseOptions({ x: true, y: false })
        });
    }

    function renderPhases(root, phases, stats, settings) {
        const host = q(root, "phases");
        if (!host) return;

        host.innerHTML = stats.map((s, i) => {
            const p = phases[i] || {};
            const n = p.phase ?? i + 1;
            const badge = s.state === "bad" ? "ERR" : s.state === "warn" ? "WARN" : s.state === "ok" ? "OK" : "-";
            // day max over A/B — shows where/when a basin went over even if the combined outlet passed
            const maxText = s.maxVal === null ? "-" : `${esc(s.maxSide)} ${fmt(s.maxVal, 1)} @${esc(String(s.maxTime).slice(0, 2))}`;
            const maxCls = s.maxVal !== null && s.maxVal > settings.cwLimit ? (s.state === "bad" ? "is-bad" : "is-warn") : "";

            const kv = (label, value, cls) =>
                `<div class="clr-kv"><span class="clr-lbl">${label}</span><span class="${cls || ""}">${value}</span></div>`;

            const gapCell = (a, b, d, warnAt) => {
                const g = (a !== null && b !== null) ? Math.abs(a - b) : null;
                return `<span class="gap ${g !== null && g > warnAt ? "is-warn" : ""}">${fmt(g, d)}</span>`;
            };
            const phCls = v => (v !== null && v < 6.8) ? "is-warn" : "";
            const alkCls = v => (v !== null && v < 40) ? "is-warn" : "";

            return `
                <div class="clr-card clr-phase" style="--clr-phase:${PHASE_COLORS[i]}">
                    <div class="clr-title">CW${esc(n)} <span class="clr-pill ${s.state}">${badge}</span></div>
                    <div class="clr-abt">
                        <span></span><span class="clr-lbl">A</span><span class="clr-lbl">B</span><span class="clr-lbl">A−B</span>
                        <span class="clr-lbl">Turb</span>
                        <span class="clr-num ${cls(s.cwA, settings.cwLimit, settings.cwWarn)}">${fmt(s.cwA, 1)}</span>
                        <span class="clr-num ${cls(s.cwB, settings.cwLimit, settings.cwWarn)}">${fmt(s.cwB, 1)}</span>
                        ${gapCell(s.cwA, s.cwB, 1, AB_GAP_WARN)}
                        <span class="clr-lbl">pH</span>
                        <span class="${phCls(s.phA)}">${fmt(s.phA, 2)}</span>
                        <span class="${phCls(s.phB)}">${fmt(s.phB, 2)}</span>
                        ${gapCell(s.phA, s.phB, 2, AB_PH_WARN)}
                        <span class="clr-lbl">Alk</span>
                        <span class="${alkCls(s.alkA)}">${fmt(s.alkA, 0)}</span>
                        <span class="${alkCls(s.alkB)}">${fmt(s.alkB, 0)}</span>
                        ${gapCell(s.alkA, s.alkB, 0, AB_ALK_WARN)}
                        <span class="clr-lbl" title="Alk ที่ถูกใช้ = RW Alk − Alk ของถัง (ยิ่งมาก = ได้สารเคมีมาก)">ใช้ Alk</span>
                        <span>${fmt(s.useA, 0)}</span>
                        <span>${fmt(s.useB, 0)}</span>
                        <span></span>
                    </div>
                    <div class="clr-kvs">
                        ${kv("รวม", fmt(s.cw, 1), "clr-num " + cls(s.cw, settings.cwLimit, settings.cwWarn))}
                        ${kv("Removal", s.removal === null ? "-" : s.removal.toFixed(0) + "%", "clr-num")}
                        ${kv("Res Cl₂", fmt(s.resCl, 2), cls(s.resCl, RES_CL_LIMIT, RES_CL_LIMIT * 0.9))}
                        ${kv("OC rem.", s.ocRemoval === null ? "-" : s.ocRemoval.toFixed(0) + "%")}
                        ${kv(`FW${esc(n)}`, fmt(s.fw, 2), cls(s.fw, FW_LIMIT, FW_LIMIT * 0.7))}
                        ${kv("Max", maxText, maxCls)}
                    </div>
                </div>`;
        }).join("");
    }

    function renderTrend(root, phases, settings) {
        const labels = arr(phases[0]?.times);
        const legend = q(root, "legend");
        if (legend) {
            legend.innerHTML = phases.map((p, i) =>
                `<span style="color:${PHASE_COLORS[i]}">━ CW${esc(p.phase ?? i + 1)}</span>`).join("")
                + `<span style="color:#f87171">┄ เกณฑ์ ${fmt(settings.cwLimit, 0)}</span>`;
        }

        const datasets = phases.map((p, i) => ({
            label: `CW${p.phase ?? i + 1}`,
            data: arr(p.cw).map(num),
            borderColor: PHASE_COLORS[i],
            backgroundColor: PHASE_COLORS[i],
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.25,
            spanGaps: true
        }));
        datasets.push({
            label: "Limit",
            data: labels.map(() => settings.cwLimit),
            borderColor: "#f87171",
            borderDash: [6, 4],
            borderWidth: 1,
            pointRadius: 0
        });

        drawChart(root, "trend", {
            type: "line",
            data: { labels, datasets },
            options: {
                ...baseOptions({ x: true, y: true }),
                interaction: { mode: "index", intersect: false },
                plugins: { legend: { display: false }, tooltip: { enabled: true } }
            }
        });
    }

    // ---------- charts ----------
    function baseOptions({ x, y }) {
        const tick = { color: "rgba(255,255,255,.45)", font: { size: 10 }, maxTicksLimit: 6 };
        return {
            animation: false,
            maintainAspectRatio: false,
            responsive: true,
            plugins: { legend: { display: false }, tooltip: { enabled: true } },
            scales: {
                x: { display: x, ticks: tick, grid: { display: false } },
                y: { display: y, ticks: { ...tick, maxTicksLimit: 4 }, grid: { color: "rgba(255,255,255,.08)" }, border: { color: "rgba(255,255,255,.08)" } }
            }
        };
    }

    function drawChart(root, key, config) {
        if (!window.Chart) return;
        const canvas = root.querySelector(`[data-clr-chart="${key}"]`);
        if (!canvas) return;

        root._clrCharts = root._clrCharts || {};
        const prev = root._clrCharts[key];
        if (prev && prev.canvas === canvas) prev.destroy();
        root._clrCharts[key] = new window.Chart(canvas.getContext("2d"), config);
    }

    // ---------- data ----------
    async function fetchSummary(root) {
        const url = root.dataset.clrSummaryUrl || "/api/clarifier/summary";
        const resp = await fetch(url, { method: "GET", cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const payload = await resp.json();
        const data = payload?.data;
        if (!data || !Array.isArray(data.phases)) throw new Error("clarifier payload missing data.phases");
        return data;
    }

    function render(root, data, isMock) {
        const settings = loadSettings();
        const rw = data.rw || {};
        const phases = arr(data.phases).slice(0, 4);
        const stats = phases.map(p => phaseStats(p, rw, settings));

        renderHeader(root, data, stats, settings, isMock);
        renderRw(root, rw);
        renderPhases(root, phases, stats, settings);
        renderTrend(root, phases, settings);
    }

    async function tick(root) {
        if (root._clrInFlight) return;
        root._clrInFlight = true;
        try {
            let data, isMock = false;
            try {
                data = await fetchSummary(root);
            } catch (err) {
                console.warn("CLARIFIER summary unavailable, showing MOCK:", err?.message || err);
                data = getMockData();
                isMock = true;
            }
            render(root, data, isMock);
        } catch (err) {
            console.error("CLARIFIER render failed:", err);
        } finally {
            root._clrInFlight = false;
        }
    }

    function restartPoller(root) {
        if (root._clrTimer) clearInterval(root._clrTimer);
        const min = Math.max(5, num(loadSettings().refreshMin) || DEFAULTS.refreshMin);
        root._clrTimer = setInterval(() => {
            if (!root.isConnected) { clearInterval(root._clrTimer); return; }
            tick(root);
        }, min * 60 * 1000);
    }

    // ---------- settings ----------
    function openSettings(root) {
        if (!popupOverlayEl) {
            popupOverlayEl = document.createElement("div");
            popupOverlayEl.className = "clr-settings-overlay";
            popupOverlayEl.innerHTML = `
                <div class="clr-settings-pop">
                    <div class="t">Clarifier Settings</div>
                    <div class="row">
                        <label for="clrSetRefresh">Data refresh rate</label>
                        <select id="clrSetRefresh">
                            <option value="5">5 minutes</option>
                            <option value="10">10 minutes</option>
                            <option value="15">15 minutes</option>
                            <option value="30">30 minutes</option>
                            <option value="60">60 minutes</option>
                        </select>
                    </div>
                    <div class="row">
                        <label for="clrSetLimit">CW Turb limit (NTU)</label>
                        <input id="clrSetLimit" type="number" min="1" max="20" step="0.5" />
                    </div>
                    <div class="row">
                        <label for="clrSetWarn">CW Turb warn at (NTU)</label>
                        <input id="clrSetWarn" type="number" min="0.5" max="20" step="0.5" />
                    </div>
                    <div class="row">
                        <label><input id="clrSetAlert" type="checkbox" /> Alert when any CW is over the limit</label>
                        <label><input id="clrSetMuted" type="checkbox" /> Mute sound</label>
                    </div>
                    <div class="actions">
                        <button type="button" data-act="cancel">Cancel</button>
                        <button type="button" class="primary" data-act="save">Save</button>
                    </div>
                </div>`;
            document.body.appendChild(popupOverlayEl);

            popupOverlayEl.addEventListener("click", (ev) => {
                if (ev.target === popupOverlayEl || ev.target.closest('[data-act="cancel"]')) {
                    popupOverlayEl.classList.remove("show");
                }
            });

            popupOverlayEl.querySelector('[data-act="save"]').addEventListener("click", () => {
                const pop = popupOverlayEl;
                const prev = loadSettings();
                const limit = Math.max(1, num(pop.querySelector("#clrSetLimit").value) ?? DEFAULTS.cwLimit);
                const warn = Math.min(limit, Math.max(0.5, num(pop.querySelector("#clrSetWarn").value) ?? DEFAULTS.cwWarn));
                const next = {
                    ...prev,
                    refreshMin: num(pop.querySelector("#clrSetRefresh").value) || DEFAULTS.refreshMin,
                    cwLimit: limit,
                    cwWarn: warn,
                    alertEnabled: pop.querySelector("#clrSetAlert").checked,
                    alertMuted: pop.querySelector("#clrSetMuted").checked
                };
                saveSettings(next);
                pop.classList.remove("show");

                document.querySelectorAll("section.clr-block").forEach(sec => {
                    if (!prev.alertMuted && next.alertMuted) window.BBAlerts?.resetRule?.(sec, "clr-cw-over");
                    restartPoller(sec);
                    tick(sec);
                });
            });
        }

        const s = loadSettings();
        const pop = popupOverlayEl;
        pop.querySelector("#clrSetRefresh").value = String(s.refreshMin);
        pop.querySelector("#clrSetLimit").value = String(s.cwLimit);
        pop.querySelector("#clrSetWarn").value = String(s.cwWarn);
        pop.querySelector("#clrSetAlert").checked = !!s.alertEnabled;
        pop.querySelector("#clrSetMuted").checked = !!s.alertMuted;
        pop.classList.add("show");
    }

    // ---------- init ----------
    function initWithin(scope) {
        const roots = (scope?.querySelectorAll ? scope : document).querySelectorAll("section.clr-block");
        roots.forEach(root => {
            if (root.dataset.clrInitBound === "true") return;
            root.dataset.clrInitBound = "true";

            root.querySelector('[data-role="clr-settings"]')?.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                openSettings(root);
            });

            restartPoller(root);
            tick(root);
        });
    }

    // ---------- mock: LAB sheet LM25691014 (14-10-2569) ----------
    function getMockData() {
        const times = ["01:00", "05:00", "09:00", "13:00", "17:00", "21:00"];
        return {
            reportDate: "14-10-2569",
            sampledAt: "21:00",
            rw: {
                turb: [["01:00", 52.6], ["03:00", 51.4], ["05:00", 53.7], ["07:00", 50.4], ["09:00", 70.8], ["11:00", 73],
                ["13:00", 69.7], ["15:00", 71.1], ["17:00", 65.4], ["19:00", 68.5], ["21:00", 60.1], ["23:00", 65.3]],
                tss: 46.6, temp: 28.5, ph: 7.55, alk: 102, oc: 2.78
            },
            dose: { coagulant: "PACl", phases: [15.399, 15.685, 16.718, 18.892], preCl: [2.06, 2.098, 1.776, 1.8] },
            jar: { time: "06:00", coagulant: "PACl", doses: [4, 6, 8, 10, 12, 14], turb: [3.6, 2.6, 2.1, 1.6, 1.7, 1.4], recMin: 4, recMax: 6 },
            phases: [
                {
                    phase: 1, times,
                    cwA: [4.2, 4.9, 2.4, 2.9, 3.3, 3.5], cwB: [3.1, 4.9, 3.6, 4.4, 3.9, 4.4], cw: [3.8, 3.7, 2.4, 3.4, 3.7, 4.0],
                    phA: [7.16, 7.11, 7.16, 7.12, 7.11, 7.12], phB: [7.15, 7.09, 7.18, 7.15, 7.10, 7.15],
                    alkA: [92, 93, 91, 88, 92, 92], alkB: [92, 94, 92, 88, 93, 93],
                    resCl: [0.04, 0.05, 0, 0.02, 0.09, 0.12], fw: [0.41, 0.27, 0.29, 0.35, 0.72, 0.57], oc: 1.32
                },
                {
                    phase: 2, times,
                    cwA: [3.3, 4.3, 3.4, 4.3, 4.5, 3.8], cwB: [3.2, 3.6, 3.4, 3.9, 4.1, 3.3], cw: [3.1, 4.2, 3.3, 3.5, 4.6, 4.0],
                    phA: [7.17, 7.16, 7.18, 7.11, 7.12, 7.16], phB: [7.13, 7.13, 7.14, 7.13, 7.09, 7.14],
                    alkA: [92, 93, 90, 87, 92, 92], alkB: [91, 94, 90, 86, 90, 91],
                    resCl: [0.03, 0.02, 0.02, 0.01, 0.07, 0.10], fw: [0.22, 0.23, 0.18, 0.20, 0.34, 0.22], oc: 1.24
                },
                {
                    phase: 3, times,
                    cwA: [3.5, 5.0, 3.7, 4.2, 6.9, 4.8], cwB: [4.0, 5.1, 3.9, 7.0, 6.3, 3.9], cw: [2.9, 4.8, 3.1, 4.2, 5.4, 4.7],
                    phA: [7.06, 7.05, 7.06, 7.00, 7.00, 7.06], phB: [7.05, 7.02, 7.00, 7.00, 6.98, 7.00],
                    alkA: [88, 90, 87, 85, 89, 90], alkB: [89, 90, 89, 86, 90, 89],
                    resCl: [0.06, 0.09, 0.03, 0.02, 0.14, 0.21], fw: [0.29, 0.53, 0.70, 0.47, 0.51, 0.39], oc: 1.33
                },
                {
                    phase: 4, times,
                    cwA: [5.5, 6.1, 4.8, 4.5, 6.0, 5.5], cwB: [4.9, 6.4, 4.7, 5.2, 8.1, 5.1], cw: [4.8, 5.4, 3.4, 3.4, 6.7, 5.3],
                    phA: [7.06, 7.02, 7.07, 7.00, 7.05, 7.07], phB: [7.10, 7.05, 7.11, 7.10, 7.03, 7.11],
                    alkA: [88, 89, 87, 86, 89, 89], alkB: [88, 89, 85, 84, 89, 90],
                    resCl: [0.08, 0.15, 0.05, 0, 0.09, 0.29], fw: [0.52, 0.71, 0.34, 0.64, 0.62, 0.52], oc: 1.08
                }
            ]
        };
    }

    window.ClarifierView = {
        initWithin,
        tick
    };
})();
