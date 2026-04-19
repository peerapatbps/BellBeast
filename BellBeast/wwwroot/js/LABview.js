(() => {
    const DEFAULTS = {
        rwOption: "TURBIDITY",
        tempOverlay: true,
        statusMode: "normal",
        zone4Filter: "CW Turbid",
        refreshMin: 10,
        alertEnabled: false,
        alertLimit: 2,
        alertMuted: false
    };

    const STORAGE_KEY = "bb_lab_settings_v5";

    const RW_OPTIONS = [
        "TURBIDITY",
        "pH",
        "ALKALINITY",
        "CONDUCTIVITY",
        "DISSOLVED OXYGEN",
        "HARDNESS",
        "OXYGEN CONSUMED"
    ];

    const CHARTS = {
        rw: null,
        z4: [null, null, null, null]
    };

    let pollTimer = null;
    let popupOverlayEl = null;
    let popupEl = null;
    let rootEl = null;
    let inFlightPromise = null;

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULTS };
            return { ...DEFAULTS, ...JSON.parse(raw) };
        } catch {
            return { ...DEFAULTS };
        }
    }

    function saveSettings(v) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
    }

    function syncBell() {
        const bell = rootEl?.querySelector('[data-role="lab-alert-bell"]');
        const settings = loadSettings();
        window.BBAlerts?.setBellState?.(bell, settings.alertMuted ? "muted" : "armed");
    }

    function getRoot(scope) {
        return scope?.querySelector?.("section.lab-block") || document.querySelector("section.lab-block");
    }

    function getSummaryUrl(root) {
        return root?.dataset?.labSummaryUrl || "/api/lab/summary";
    }

    function getRefreshMs() {
        const settings = loadSettings();
        const min = Number(settings.refreshMin || DEFAULTS.refreshMin);
        return Math.max(5, min) * 60 * 1000;
    }

    function safeArray(v) {
        return Array.isArray(v) ? v : [];
    }

    function toNumber(v) {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function clamp(value, min, max, fallback) {
        const n = toNumber(value);
        if (n === null) return fallback ?? min;
        return Math.max(min, Math.min(max, n));
    }

    function getChartJs() {
        if (!window.Chart) {
            console.error("Chart.js not found");
            return null;
        }
        return window.Chart;
    }

    function destroyChart(chart) {
        if (chart && typeof chart.destroy === "function") chart.destroy();
    }

    function parseSimplePairs(arr) {
        return safeArray(arr)
            .map(x => ({
                ts: Array.isArray(x) ? String(x[0] ?? "") : "",
                value: Array.isArray(x) ? toNumber(x[1]) : null
            }))
            .filter(x => x.ts && x.value !== null);
    }

    function buildMergedRwLabels(seriesA, seriesB) {
        const set = new Set();
        seriesA.forEach(x => set.add(x.ts));
        seriesB.forEach(x => set.add(x.ts));
        return Array.from(set).sort();
    }

    function alignSeriesByLabels(labels, series) {
        const map = new Map(series.map(x => [x.ts, x.value]));
        return labels.map(ts => map.has(ts) ? map.get(ts) : null);
    }

    function toHourAmPm(ts) {
        const s = String(ts || "");
        const hhmm = s.split(" ").pop() || "";
        const hh = Number(hhmm.split(":")[0]);
        if (!Number.isFinite(hh)) return s;

        const suffix = hh >= 12 ? "PM" : "AM";
        const hour12 = (hh % 12) === 0 ? 12 : (hh % 12);
        return `${hour12}${suffix}`;
    }

    function getRwTitle(option) {
        switch (option) {
            case "TURBIDITY": return "RW Turbid vs Temp (°C)";
            case "pH": return "RW pH vs Temp (°C)";
            case "ALKALINITY": return "RW Alkalinity vs Temp (°C)";
            case "CONDUCTIVITY": return "RW Conductivity vs Temp (°C)";
            case "DISSOLVED OXYGEN": return "RW Dissolved Oxygen vs Temp (°C)";
            case "HARDNESS": return "RW Hardness vs Temp (°C)";
            case "OXYGEN CONSUMED": return "RW Oxygen Consumed vs Temp (°C)";
            default: return "RW Chart";
        }
    }

    function setRwTitle(option) {
        const el = rootEl?.querySelector(".lab-top-title");
        if (el) el.textContent = getRwTitle(option);
    }

    function normalizeStatusKey(key) {
        return String(key || "").trim().toUpperCase();
    }

    function getStatusRules(mode) {
        const normal = {
            "CW T": { type: "max", max: 5 },
            "CW CL": { type: "max", max: 0.3 },
            "FW T": { type: "max", max: 1 },
            "TW CL": { type: "range", min: 1.0, max: 1.4 }
        };

        const emergency = {
            "CW T": { type: "max", max: 3 },
            "CW CL": { type: "max", max: 0.5 },
            "FW T": { type: "max", max: 1 },
            "TW CL": { type: "range", min: 1.0, max: 1.4 }
        };

        return mode === "emergency" ? emergency : normal;
    }

    function classifyStatusItem(item, mode) {
        const rawReal = item?.value_real;
        const rawText = item?.value_text;

        const isNullish =
            rawReal === null || rawReal === undefined ||
            rawText === null || rawText === undefined || rawText === "";

        const value = rawReal ?? toNumber(rawText);

        // null = ดำ
        if (value === null && isNullish) return "off";

        const key = normalizeStatusKey(item?.key);
        const group =
            key.includes("CW") && key.includes("CL") ? "CW CL" :
                key.includes("CW") && key.includes("T") ? "CW T" :
                    key.includes("FW") && key.includes("T") ? "FW T" :
                        key.includes("TW") && key.includes("CL") ? "TW CL" :
                            null;

        if (!group) return "off";

        const rule = getStatusRules(mode)[group];
        if (!rule) return "off";

        // 0 ต้องเข้ากติกาปกติ ไม่ใช่ดำ
        if (rule.type === "max") return value <= rule.max ? "ok" : "bad";
        if (rule.type === "range") return value >= rule.min && value <= rule.max ? "ok" : "bad";

        return "off";
    }

    function renderStatus(items, mode) {
        const grid = rootEl?.querySelector("#labStatusGrid");
        if (!grid) return 0;

        const byKey = new Map(safeArray(items).map(x => [normalizeStatusKey(x.key), x]));
        const keys = [
            "CW1 T", "CW2 T", "CW3 T", "CW4 T",
            "CW1 CL", "CW2 CL", "CW3 CL", "CW4 CL",
            "FW1 T", "FW2 T", "FW3 T", "FW4 T",
            "TW1 CL", "TW2 CL", "TW3 CL", "TW4 CL"
        ];

        grid.innerHTML = "";
        let badCount = 0;

        for (const key of keys) {
            const item = byKey.get(normalizeStatusKey(key));
            const cls = classifyStatusItem(item, mode);
            if (cls === "bad") badCount++;

            const pill = document.createElement("div");
            pill.className = "status-pill";

            const dot = document.createElement("span");
            dot.className = `status-dot ${cls}`;

            pill.appendChild(dot);
            pill.appendChild(document.createTextNode(key));
            grid.appendChild(pill);
        }
        return badCount;
    }

    function renderRecommend(zone2) {
        const q = sel => rootEl?.querySelector(sel);
        q("#labDosePaclP12").textContent = zone2?.pacl?.p12 ?? "-";
        q("#labDosePaclP34").textContent = zone2?.pacl?.p34 ?? "-";
        q("#labDoseAlumP12").textContent = zone2?.alum?.p12 ?? "-";
        q("#labDoseAlumP34").textContent = zone2?.alum?.p34 ?? "-";
    }

    function renderRwChart(zone1, settings) {
        const Chart = getChartJs();
        if (!Chart) return;

        const optionKey = settings.rwOption;
        const tempKey = "TEMPERATURE";

        const optionSeries = parseSimplePairs(zone1?.[optionKey]);
        const tempSeries = parseSimplePairs(zone1?.[tempKey]);

        const labels = buildMergedRwLabels(optionSeries, tempSeries);
        const displayLabels = labels.map(toHourAmPm);
        const optionData = alignSeriesByLabels(labels, optionSeries);
        const tempData = alignSeriesByLabels(labels, tempSeries);

        const canvas = rootEl?.querySelector("#labRwChart");
        if (!canvas) return;

        destroyChart(CHARTS.rw);

        CHARTS.rw = new Chart(canvas.getContext("2d"), {
            type: "line",
            data: {
                labels: displayLabels,
                datasets: [
                    {
                        data: optionData,
                        yAxisID: "y",
                        borderColor: "#39a8ff",
                        backgroundColor: "#39a8ff",
                        pointBackgroundColor: "#39a8ff",
                        pointBorderColor: "#39a8ff",
                        borderWidth: 2,
                        pointRadius: 2,
                        tension: 0.2
                    },
                    ...(settings.tempOverlay ? [{
                        data: tempData,
                        yAxisID: "y1",
                        borderColor: "#ff5b7f",
                        backgroundColor: "#ff5b7f",
                        pointBackgroundColor: "#ff5b7f",
                        pointBorderColor: "#ff5b7f",
                        borderWidth: 2,
                        pointRadius: 2,
                        tension: 0.2
                    }] : [])
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: "index", intersect: false },
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        ticks: {
                            color: "rgba(255,255,255,.78)",
                            autoSkip: false,
                            maxRotation: 0,
                            minRotation: 0
                        },
                        grid: { color: "rgba(255,255,255,.08)" }
                    },
                    y: {
                        position: "left",
                        ticks: { color: "#39a8ff" },
                        grid: { color: "rgba(255,255,255,.08)" }
                    },
                    y1: {
                        display: !!settings.tempOverlay,
                        position: "right",
                        ticks: { color: "#ff5b7f" },
                        grid: { drawOnChartArea: false }
                    }
                }
            }
        });

        setRwTitle(optionKey);
    }

    function getZone4Rule(filterLabel, mode) {
        const rules = getStatusRules(mode);
        switch (filterLabel) {
            case "CW Turbid": return rules["CW T"];
            case "CW Pre CL": return rules["CW CL"];
            case "FW Turbid": return rules["FW T"];
            case "TW Pos CL": return rules["TW CL"];
            case "TW Turbid": return null;
            default: return null;
        }
    }

    function buildSuggestedYRange(values, rule) {
        const nums = values.filter(v => typeof v === "number" && Number.isFinite(v));
        if (!nums.length && !rule) return { min: 0, max: 10 };

        const dataMin = nums.length ? Math.min(...nums) : 0;
        const dataMax = nums.length ? Math.max(...nums) : 1;

        if (!rule) {
            const span = Math.max(1, dataMax - dataMin);
            return {
                min: Math.max(0, dataMin - span * 0.15),
                max: dataMax + span * 0.15
            };
        }

        if (rule.type === "range") {
            const band = rule.max - rule.min;
            const lower = band * (15 / 70);
            const upper = band * (15 / 70);
            return {
                min: Math.max(0, Math.min(dataMin, rule.min - lower)),
                max: Math.max(dataMax, rule.max + upper)
            };
        }

        if (rule.type === "max") {
            const total = rule.max / 0.85;
            return {
                min: 0,
                max: Math.max(dataMax, total)
            };
        }

        return { min: 0, max: Math.max(10, dataMax) };
    }

    function isZone4Exceeded(value, rule) {
        if (value === null) return false;
        if (!rule) return false;

        if (rule.type === "max") return value > rule.max;
        if (rule.type === "range") return !(value >= rule.min && value <= rule.max);

        return false;
    }

    function buildZone4Bands(points, rule) {
        const bands = [];
        let streak = 0;

        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const value = Array.isArray(p) ? toNumber(p[1]) : null;
            const exceeded = isZone4Exceeded(value, rule);

            if (exceeded) {
                streak += 1;
                bands.push({
                    index: i,
                    color: streak === 1
                        ? "rgba(59,130,246,.22)"
                        : "rgba(255,59,59,.24)"
                });
            } else {
                streak = 0;
            }
        }

        return bands;
    }

    const zone4BandPlugin = {
        id: "zone4BandPlugin",
        beforeDatasetsDraw(chart, args, pluginOptions) {
            const bands = pluginOptions?.bands || [];
            if (!bands.length) return;

            const { ctx, chartArea, scales } = chart;
            const xScale = scales.x;
            if (!xScale || !chartArea) return;

            ctx.save();

            for (const band of bands) {
                const i = band.index;
                const center = xScale.getPixelForValue(i);

                let left;
                let right;

                if (i === 0) {
                    const next = xScale.getPixelForValue(i + 1);
                    const half = (next - center) / 2;
                    left = center - half;
                    right = center + half;
                } else if (i === xScale.ticks.length - 1) {
                    const prev = xScale.getPixelForValue(i - 1);
                    const half = (center - prev) / 2;
                    left = center - half;
                    right = center + half;
                } else {
                    const prev = xScale.getPixelForValue(i - 1);
                    const next = xScale.getPixelForValue(i + 1);
                    left = center - (center - prev) / 2;
                    right = center + (next - center) / 2;
                }

                const shrink = Math.min(10, Math.max(4, (right - left) * 0.12));
                ctx.fillStyle = band.color;
                ctx.fillRect(
                    left + shrink,
                    chartArea.top,
                    Math.max(0, (right - left) - shrink * 2),
                    chartArea.bottom - chartArea.top
                );
            }

            ctx.restore();
        }
    };

    function classifyZone4Latest(points, filterLabel, mode) {
        const last = safeArray(points).at(-1);
        if (!Array.isArray(last)) return "warn";

        const value = toNumber(last[1]);

        // null = ไม่มีข้อมูลจริง ค่อยถือว่าไม่พร้อม
        if (value === null) return "warn";

        const rule = getZone4Rule(filterLabel, mode);
        if (!rule) return "ok";

        // 0 ต้องเข้าเกณฑ์ปกติ ไม่ใช่ BAD
        if (rule.type === "max") return value <= rule.max ? "ok" : "bad";
        if (rule.type === "range") return value >= rule.min && value <= rule.max ? "ok" : "bad";

        return "warn";
    }

    function renderZone4(zone4, settings) {
        const Chart = getChartJs();
        if (!Chart) return;

        const filterLabel = settings.zone4Filter;
        const rule = getZone4Rule(filterLabel, settings.statusMode);

        const titles = [
            rootEl.querySelector("#labCardTitle1"),
            rootEl.querySelector("#labCardTitle2"),
            rootEl.querySelector("#labCardTitle3"),
            rootEl.querySelector("#labCardTitle4")
        ];

        const statuses = [
            rootEl.querySelector("#labCardStatus1"),
            rootEl.querySelector("#labCardStatus2"),
            rootEl.querySelector("#labCardStatus3"),
            rootEl.querySelector("#labCardStatus4")
        ];

        const canvases = [
            rootEl.querySelector("#labChart1"),
            rootEl.querySelector("#labChart2"),
            rootEl.querySelector("#labChart3"),
            rootEl.querySelector("#labChart4")
        ];

        const series = safeArray(zone4?.series);

        for (let i = 0; i < 4; i++) {
            if (titles[i]) titles[i].textContent = `${filterLabel} #${i + 1}`;

            const s = series[i] || { configparam_id: null, points: [] };
            const points = safeArray(s.points);
            const labels = points.map(x => Array.isArray(x) ? toHourAmPm(x[0]) : "");
            const values = points.map(x => Array.isArray(x) ? toNumber(x[1]) : null);
            const bands = buildZone4Bands(points, rule);

            const badgeCls = classifyZone4Latest(points, filterLabel, settings.statusMode);
            const badgeEl = statuses[i];
            if (badgeEl) {
                badgeEl.className = `ov-status ${badgeCls}`;
                badgeEl.textContent = badgeCls === "ok" ? "OK" : "BAD";
            }

            destroyChart(CHARTS.z4[i]);

            if (!canvases[i]) continue;

            const yRange = buildSuggestedYRange(values, rule);

            CHARTS.z4[i] = new Chart(canvases[i].getContext("2d"), {
                type: "line",
                data: {
                    labels,
                    datasets: [{
                        data: values,
                        borderColor: "#39a8ff",
                        backgroundColor: "#39a8ff",
                        pointBackgroundColor: "#39a8ff",
                        pointBorderColor: "#39a8ff",
                        borderWidth: 2,
                        pointRadius: 2,
                        tension: 0.2
                    }]
                },
                plugins: [zone4BandPlugin],
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: false },
                        zone4BandPlugin: { bands }
                    },
                    scales: {
                        x: {
                            ticks: {
                                color: "rgba(255,255,255,.72)",
                                autoSkip: false,
                                maxRotation: 25,
                                minRotation: 25
                            },
                            grid: { color: "rgba(255,255,255,.08)" }
                        },
                        y: {
                            min: yRange.min,
                            max: yRange.max,
                            ticks: { color: "rgba(255,255,255,.72)" },
                            grid: { color: "rgba(255,255,255,.08)" }
                        }
                    }
                }
            });
        }
    }

    async function fetchLabSummary(settings) {
        const url = getSummaryUrl(rootEl);

        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                rwZone: {
                    option: settings.rwOption,
                    fix: "TEMPERATURE"
                },
                zone4: {
                    filter: settings.zone4Filter
                }
            })
        });

        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(txt || `HTTP ${resp.status}`);
        }

        return await resp.json();
    }

    async function tick() {
        const settings = loadSettings();

        if (inFlightPromise) return inFlightPromise;

        inFlightPromise = (async () => {
            try {
                const payload = await fetchLabSummary(settings);
                const data = payload?.data || {};

                renderRwChart(data.zone1, settings);
                renderRecommend(data.zone2 || {});
                  const badCount = renderStatus(data.zone3?.items || [], settings.statusMode);
                  renderZone4(data.zone4 || {}, settings);
                  const exceeded = window.BBAlerts?.evaluate?.(rootEl, {
                      ruleKey: "lab-bad-count",
                      enabled: settings.alertEnabled,
                      muted: settings.alertMuted,
                      value: badCount,
                      limit: settings.alertLimit,
                      direction: "gt"
                  }) || false;
                  window.BBAlerts?.setBellState?.(
                      rootEl?.querySelector('[data-role="lab-alert-bell"]'),
                      exceeded ? "alerting" : (settings.alertMuted ? "muted" : "armed")
                  );
              } catch (err) {
                  console.error("LAB fetch/render failed:", err);
              } finally {
                inFlightPromise = null;
            }
        })();

        return inFlightPromise;
    }

    function restartPoller() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }

        pollTimer = setInterval(() => {
            tick();
        }, getRefreshMs());
    }

    function closePopup() {
        popupOverlayEl?.classList.remove("show");
    }

    function setModeButtons(mode) {
        const normalBtn = popupEl?.querySelector("#labModeNormal");
        const emergencyBtn = popupEl?.querySelector("#labModeEmergency");
        if (!normalBtn || !emergencyBtn) return;

        normalBtn.dataset.active = String(mode === "normal");
        emergencyBtn.dataset.active = String(mode === "emergency");

        normalBtn.classList.toggle("primary", mode === "normal");
        emergencyBtn.classList.toggle("primary", mode === "emergency");
    }

    function ensurePopup() {
        if (popupOverlayEl && popupEl) return popupEl;

        popupOverlayEl = document.createElement("div");
        popupOverlayEl.className = "lab-settings-overlay";

        popupEl = document.createElement("div");
        popupEl.className = "lab-settings-pop";
        popupEl.innerHTML = `
                                    <div class="lab-settings-title">LAB Settings</div>

                                    <div class="lab-settings-row">
                                        <label>Data refresh rate</label>
                                        <select id="labSetRefreshMin">
                                            <option value="5">5 minutes</option>
                                            <option value="10">10 minutes</option>
                                            <option value="15">15 minutes</option>
                                            <option value="30">30 minutes</option>
                                            <option value="60">60 minutes</option>
                                            <option value="90">90 minutes</option>
                                        </select>
                                    </div>

                                    <div class="lab-settings-row">
                                        <label>RW Option</label>
                                        <select id="labSetRwOption">
                                            ${RW_OPTIONS.map(x => `<option value="${x}">${x}</option>`).join("")}
                                        </select>
                                    </div>

                                    <div class="lab-settings-row">
                                        <label style="display:flex;align-items:center;gap:8px;">
                                            <input type="checkbox" id="labSetTempOverlay" checked />
                                            Plot TEMPERATURE overlay
                                        </label>
                                    </div>

                                    <div class="lab-settings-row">
                                        <label>Status Mode</label>
                                        <div style="display:flex;gap:8px;">
                                            <button type="button" id="labModeNormal" class="primary" style="flex:1;">Normal</button>
                                            <button type="button" id="labModeEmergency" style="flex:1;">Emergency</button>
                                        </div>
                                    </div>
                                    <div class="lab-settings-row">
                                        <label style="display:flex;align-items:center;gap:8px;">
                                            <input type="checkbox" id="labAlertEnabled" />
                                            Enable bad-status alert
                                        </label>
                                    </div>
                                    <div class="lab-settings-row">
                                        <label>Bad-status alert limit</label>
                                        <input type="number" id="labAlertLimit" min="1" max="16" step="1" />
                                    </div>
                                    <div class="lab-settings-row">
                                        <label style="display:flex;align-items:center;gap:8px;">
                                            <input type="checkbox" id="labAlertMuted" />
                                            Mute bell sound
                                        </label>
                                    </div>

                                    <div class="lab-settings-actions">
                                        <button type="button" id="labSetCancel">Cancel</button>
                                        <button type="button" id="labSetSave" class="primary">Save</button>
                                    </div>
                                `;

        popupOverlayEl.appendChild(popupEl);
        document.body.appendChild(popupOverlayEl);

        popupEl.querySelector("#labSetCancel")?.addEventListener("click", closePopup);

        popupEl.querySelector("#labSetSave")?.addEventListener("click", async () => {
            const current = loadSettings();
            const next = {
                ...current,
                refreshMin: Number(popupEl.querySelector("#labSetRefreshMin")?.value || DEFAULTS.refreshMin),
                rwOption: popupEl.querySelector("#labSetRwOption")?.value || "TURBIDITY",
                tempOverlay: !!popupEl.querySelector("#labSetTempOverlay")?.checked,
                alertEnabled: !!popupEl.querySelector("#labAlertEnabled")?.checked,
                alertLimit: clamp(Number(popupEl.querySelector("#labAlertLimit")?.value || DEFAULTS.alertLimit), 1, 16),
                alertMuted: !!popupEl.querySelector("#labAlertMuted")?.checked
            };

            const normalBtn = popupEl.querySelector("#labModeNormal");
            next.statusMode = normalBtn?.dataset?.active === "true" ? "normal" : "emergency";

            saveSettings(next);
            if (next.alertMuted && !current.alertMuted) {
                window.BBAlerts?.resetRule?.(rootEl, "lab-bad-count");
                syncBell();
            }
            restartPoller();
            closePopup();
            await tick();
        });

        popupEl.querySelector("#labModeNormal")?.addEventListener("click", () => setModeButtons("normal"));
        popupEl.querySelector("#labModeEmergency")?.addEventListener("click", () => setModeButtons("emergency"));

        popupOverlayEl.addEventListener("click", (ev) => {
            if (ev.target === popupOverlayEl) closePopup();
        });

        return popupEl;
    }

    function openPopup() {
        ensurePopup();
        const settings = loadSettings();

        const refreshSel = popupEl.querySelector("#labSetRefreshMin");
        const sel = popupEl.querySelector("#labSetRwOption");
        const chk = popupEl.querySelector("#labSetTempOverlay");

        if (refreshSel) refreshSel.value = String(settings.refreshMin ?? DEFAULTS.refreshMin);
        if (sel) sel.value = settings.rwOption;
        if (chk) chk.checked = !!settings.tempOverlay;
        const alertEnabled = popupEl.querySelector("#labAlertEnabled");
        const alertLimit = popupEl.querySelector("#labAlertLimit");
        const alertMuted = popupEl.querySelector("#labAlertMuted");
        if (alertEnabled) alertEnabled.checked = !!settings.alertEnabled;
        if (alertLimit) alertLimit.value = String(settings.alertLimit ?? DEFAULTS.alertLimit);
        if (alertMuted) alertMuted.checked = !!settings.alertMuted;
        setModeButtons(settings.statusMode);

        popupOverlayEl.classList.add("show");
    }

    function bindSettingsButton() {
        const btn = rootEl?.querySelector("#labBtnSettings");
        if (!btn || btn.dataset.bound === "true") return;

        btn.dataset.bound = "true";
        btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            window.BBAlerts?.armAudio?.();
            openPopup();
        });

        const bell = rootEl?.querySelector('[data-role="lab-alert-bell"]');
        if (bell && bell.dataset.bound !== "true") {
            bell.dataset.bound = "true";
            bell.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const settings = loadSettings();
                const wasMuted = settings.alertMuted;
                settings.alertMuted = !settings.alertMuted;
                saveSettings(settings);
                if (!wasMuted && settings.alertMuted) window.BBAlerts?.resetRule?.(rootEl, "lab-bad-count");
                syncBell();
            });
        }
    }

    function mapZone4FilterKey(filterKey) {
        switch ((filterKey || "").toLowerCase()) {
            case "cw_turbid": return "CW Turbid";
            case "cw_precl": return "CW Pre CL";
            case "fw_turbid": return "FW Turbid";
            case "tw_turbid": return "TW Turbid";
            case "tw_postcl": return "TW Pos CL";
            default: return "CW Turbid";
        }
    }

    function bindFilterButtons() {
        const btns = rootEl?.querySelectorAll(".filter-btn");
        if (!btns?.length) return;

        btns.forEach(btn => {
            if (btn.dataset.bound === "true") return;
            btn.dataset.bound = "true";

            btn.addEventListener("click", async () => {
                btns.forEach(x => x.classList.remove("active"));
                btn.classList.add("active");

                const settings = loadSettings();
                settings.zone4Filter = mapZone4FilterKey(btn.dataset.filter);
                saveSettings(settings);

                await tick();
            });
        });

        const settings = loadSettings();
        const activeFilterKey = (() => {
            switch (settings.zone4Filter) {
                case "CW Turbid": return "cw_turbid";
                case "CW Pre CL": return "cw_precl";
                case "FW Turbid": return "fw_turbid";
                case "TW Turbid": return "tw_turbid";
                case "TW Pos CL": return "tw_postcl";
                default: return "cw_turbid";
            }
        })();

        btns.forEach(x => x.classList.toggle("active", x.dataset.filter === activeFilterKey));
    }

    function initWithin(scope) {
        const root = getRoot(scope);
        if (!root) return;

        if (root.dataset.labInitBound === "true") {
            rootEl = root;
            return;
        }

        root.dataset.labInitBound = "true";
        rootEl = root;

        bindSettingsButton();
        bindFilterButtons();
        syncBell();
        restartPoller();
        tick();
    }

    window.LABView = {
        initWithin,
        tick
    };
})();
