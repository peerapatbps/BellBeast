/* =========================================================
   BBTrend.js (centroid-locked X + centroid-locked Y band)  ✅ FIXED for your markup
   - Works with your DPS block:
        <select id="dpsTrendSel1" class="bb-dd">...</select>
        <canvas id="dpsTrend1" class="bb-trend-chart-ptc"
                data-select="dpsTrendSel1"
                data-default="UZ5411P"
                data-backend-port="8888"
                data-y-top="0.15"
                data-y-band="0.70"
                data-y-bot="0.15"></canvas>

   Rules (ตามที่มึงสั่ง):
   - X window: now ± 30 นาที (centroid อยู่กลางเสมอ)
   - Y scale: ที่เวลา now ให้ Ybar = UpperNow - LowerNow กินพื้นที่ = data-y-band (X%)
             ส่วนบน/ล่าง = data-y-top / data-y-bot (ถ้ามี) ไม่งั้นแบ่งเท่ากัน
   - data รายชั่วโมง -> interpolate ณ เวลา now
   - ถ้า now อยู่ใกล้ขอบ window ให้มีจุด t+1 (กูเผื่อ end +2h)
   - fetch: init + dropdown change เท่านั้น
   - slide tick 2s: ไม่ fetch แต่ต้อง recompute X/Y จาก now เสมอ
   ========================================================= */

window.BBTrend = (function () {
    "use strict";

    // =========================
    // Config
    // =========================
    const CANVAS_SELECTOR = "canvas.bb-trend-chart-ptc, canvas.bb-trend-chart";
    const SELECT_SELECTOR = "select.bb-dd";
    const WIN_MS = 30 * 60 * 1000;
    const HOUR_MS = 3600_000;

    // cache series points per key (10s)
    const _cache = new Map(); // key -> { ts:number, points:any[] }

    // =========================
    // Helpers: time
    // =========================
    function floorToHour(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 0, 0, 0);
    }
    function addHours(d, h) {
        return new Date(d.getTime() + h * HOUR_MS);
    }
    function toDateToday(hhmm) {
        const [h, m] = String(hhmm).split(":").map(x => parseInt(x, 10));
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), (h || 0), (m || 0), 0, 0);
    }

    // raw backend -> timeline sorted
    function buildTimeline(rawPoints) {
        const now = new Date();
        const arr = (rawPoints || [])
            .map(p => ({
                t: toDateToday(p.hhmm),
                upper: Number(p.upper),
                lower: Number(p.lower),
            }))
            .filter(p => p.t instanceof Date && Number.isFinite(p.upper) && Number.isFinite(p.lower));

        arr.sort((a, b) => a.t - b.t);

        // ถ้าเช้ามืด (<6) ให้ 23:xx เป็นของเมื่อวาน กันกระโดดวัน
        if (now.getHours() < 6) {
            for (const it of arr) {
                if (it.t.getHours() === 23) it.t = new Date(it.t.getTime() - 24 * 60 * 60 * 1000);
            }
            arr.sort((a, b) => a.t - b.t);
        }
        return arr;
    }

    // normalize to hourly points (keep latest in hour)
    function toHourlyPoints(pointsSorted) {
        const map = new Map(); // hourMs -> {t, upper, lower}
        for (const p of pointsSorted) {
            const hMs = floorToHour(p.t).getTime();
            map.set(hMs, { t: new Date(hMs), upper: p.upper, lower: p.lower });
        }
        const out = Array.from(map.values());
        out.sort((a, b) => a.t - b.t);
        return out;
    }

    // linear interpolate at time t for upper/lower from hourly[]
    function interpAt(hourly, t, field /* "upper"|"lower" */) {
        if (!hourly || hourly.length === 0) return null;

        const tt = t.getTime();
        const first = hourly[0], last = hourly[hourly.length - 1];
        const t0 = first.t.getTime(), tN = last.t.getTime();

        // clamp ends
        if (tt <= t0) return Number.isFinite(+first[field]) ? +first[field] : null;
        if (tt >= tN) return Number.isFinite(+last[field]) ? +last[field] : null;

        // find bracket
        let left = null, right = null;
        for (let i = 0; i < hourly.length; i++) {
            const p = hourly[i];
            const ti = p.t.getTime();
            if (ti <= tt) left = p;
            if (ti >= tt) { right = p; break; }
        }
        if (!left || !right) return null;

        const a0 = left.t.getTime();
        const a1 = right.t.getTime();
        const v0 = +left[field];
        const v1 = +right[field];
        if (!Number.isFinite(v0) || !Number.isFinite(v1)) return null;
        if (a1 === a0) return v0;

        const k = (tt - a0) / (a1 - a0);
        const kk = Math.max(0, Math.min(1, Number.isFinite(k) ? k : 0));
        return v0 + (v1 - v0) * kk;
    }

    // =========================
    // Y-share rules (ตามที่มึงสั่ง)
    // - band = data-y-band (X%)
    // - ถ้าไม่กำหนด top/bot -> symmetric
    // - ถ้ากำหนด top/bot -> normalize ให้ top+bot = 1-band
    // =========================
    function readYShare(canvas) {
        const band0 = parseFloat(canvas.getAttribute("data-y-band") ?? "0.70");
        let band = Number.isFinite(band0) ? band0 : 0.70;
        band = Math.max(0.05, Math.min(0.95, band));

        const ytRaw = canvas.getAttribute("data-y-top");
        const ybRaw = canvas.getAttribute("data-y-bot");

        if (ytRaw === null || ybRaw === null) {
            const pad = (1 - band) / 2;
            return { top: pad, band, bot: pad };
        }

        let top = parseFloat(ytRaw);
        let bot = parseFloat(ybRaw);
        top = Number.isFinite(top) ? Math.max(0, top) : (1 - band) / 2;
        bot = Number.isFinite(bot) ? Math.max(0, bot) : (1 - band) / 2;

        const sum = top + bot;
        if (sum <= 1e-9) {
            const pad = (1 - band) / 2;
            return { top: pad, band, bot: pad };
        }

        const target = 1 - band;
        top = top * (target / sum);
        bot = bot * (target / sum);
        return { top, band, bot };
    }

    // CORE: compute y-range so (upperNow-lowerNow) occupies share.band
    function computeYRangeCentroid(hourly, now, share) {
        const upperNow = interpAt(hourly, now, "upper");
        const lowerNow = interpAt(hourly, now, "lower");
        if (!Number.isFinite(upperNow) || !Number.isFinite(lowerNow)) return null;

        let lo = lowerNow, hi = upperNow;
        if (hi < lo) { const tmp = lo; lo = hi; hi = tmp; }

        let band = hi - lo;
        if (band <= 1e-9) {
            band = 1;
            lo -= 0.5; hi += 0.5;
        }

        const totalRange = band / share.band;
        const padTop = totalRange * share.top;
        const padBot = totalRange * share.bot;

        return { min: lo - padBot, max: hi + padTop };
    }

    // Build window series with interpolation so line never breaks
    // Rule: include hour floor(xMin)-1 .. floor(xMax)+2  (เผื่อ t+1 ตอนเข้าใกล้ขอบ)
    function buildWindowSeries(hourly, xMin, xMax) {
        const start = addHours(floorToHour(xMin), -1);
        const end = addHours(floorToHour(xMax), +2);

        const pts = [];
        for (let t = start; t <= end; t = addHours(t, 1)) {
            const u = interpAt(hourly, t, "upper");
            const l = interpAt(hourly, t, "lower");
            if (Number.isFinite(u) && Number.isFinite(l)) pts.push({ t: new Date(t.getTime()), upper: u, lower: l });
        }
        return pts.length ? pts : hourly;
    }

    // =========================
    // Backend fetch
    // =========================
    function inferBackendUrl(canvas, key) {
        const port = (canvas.getAttribute("data-backend-port") || "8888").trim();
        const proto = (location.protocol === "https:") ? "https" : "http";
        const host = location.hostname;
        return `${proto}://${host}:${port}/api/ptc/series?key=${encodeURIComponent(String(key || "").trim())}`;
    }

    async function fetchSeriesPoints(canvas, key) {
        const k = String(key || "").trim().toUpperCase();
        if (!k) return [];

        const now = Date.now();
        const hit = _cache.get(k);
        if (hit && (now - hit.ts) < 10_000) return hit.points;

        const url = inferBackendUrl(canvas, k);

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort("timeout"), 6000);
        try {
            const r = await fetch(url, {
                method: "GET",
                headers: { "accept": "application/json" },
                cache: "no-store",
                signal: ac.signal,
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);

            const json = await r.json();
            const points = Array.isArray(json) ? json : (Array.isArray(json?.points) ? json.points : []);
            if (!Array.isArray(points) || points.length === 0) throw new Error("Empty points");

            _cache.set(k, { ts: now, points });
            return points;
        } finally {
            clearTimeout(t);
        }
    }

    // =========================
    // Chart plugin: now line
    // =========================
    const nowLinePlugin = {
        id: "nowLine",
        afterDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            if (!chartArea) return;
            const x = scales.x.getPixelForValue(new Date());
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.lineWidth = 2;
            ctx.strokeStyle = "rgba(255,255,255,.25)";
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.restore();
        }
    };

    function stopAndClear(canvas) {
        if (canvas._bbTimer) { clearInterval(canvas._bbTimer); canvas._bbTimer = null; }
        if (canvas._bbChart) { try { canvas._bbChart.destroy(); } catch { } canvas._bbChart = null; }
        canvas._bbBusy = false;
        canvas._bbBusyKey = null;
        canvas._bbFailed = true;
        canvas._bbHourly = null;
    }

    // =========================
    // Frame update (NO fetch): recompute X/Y from NOW always
    // =========================
    function updateFrame(canvas) {
        const ch = canvas._bbChart;
        const hourly = canvas._bbHourly;
        if (!ch || !hourly || !hourly.length) return;

        const now = new Date();
        const xMin = new Date(now.getTime() - WIN_MS);
        const xMax = new Date(now.getTime() + WIN_MS);

        const windowPts = buildWindowSeries(hourly, xMin, xMax);
        ch.data.datasets[0].data = windowPts.map(p => ({ x: p.t, y: p.upper }));
        ch.data.datasets[1].data = windowPts.map(p => ({ x: p.t, y: p.lower }));

        const share = readYShare(canvas);
        let yr = computeYRangeCentroid(hourly, now, share);
        if (!yr || !Number.isFinite(yr.min) || !Number.isFinite(yr.max) || (yr.max - yr.min) < 1e-9) {
            yr = { min: 0, max: 10 };
        }

        ch.options.scales.x.min = xMin;
        ch.options.scales.x.max = xMax;
        ch.options.scales.y.min = yr.min;
        ch.options.scales.y.max = yr.max;

        ch.update("none");
    }

    // =========================
    // Fetch + init (only init / dropdown change)
    // =========================
    async function refreshData(canvas, key) {
        if (!window.Chart) { stopAndClear(canvas); return; }

        const k = String(key || "").trim().toUpperCase();
        if (!k) return;

        if (canvas._bbBusy && canvas._bbBusyKey === k) return;
        canvas._bbBusy = true;
        canvas._bbBusyKey = k;
        canvas._bbFailed = false;

        try {
            const raw = await fetchSeriesPoints(canvas, k);
            const pts = buildTimeline(raw);
            const hourly = toHourlyPoints(pts);
            canvas._bbHourly = hourly;

            // create chart if needed
            if (!canvas._bbChart) {
                const now = new Date();
                const xMin = new Date(now.getTime() - WIN_MS);
                const xMax = new Date(now.getTime() + WIN_MS);

                const share = readYShare(canvas);
                const yr = computeYRangeCentroid(hourly, now, share) || { min: 0, max: 10 };
                const windowPts = buildWindowSeries(hourly, xMin, xMax);

                const chart = new Chart(canvas.getContext("2d"), {
                    type: "line",
                    plugins: [nowLinePlugin],
                    data: {
                        datasets: [
                            { label: "Upper", data: windowPts.map(p => ({ x: p.t, y: p.upper })), parsing: false, borderColor: "rgba(255,91,91,.95)", borderWidth: 4, pointRadius: 0, tension: 0 },
                            { label: "Lower", data: windowPts.map(p => ({ x: p.t, y: p.lower })), parsing: false, borderColor: "rgba(255,91,91,.60)", borderWidth: 4, pointRadius: 0, tension: 0 },
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: false,
                        plugins: { legend: { display: false } },
                        scales: {
                            x: {
                                type: "time",
                                time: { unit: "minute", stepSize: 10, displayFormats: { minute: "HH:mm" } },
                                min: xMin, max: xMax,
                                grid: { color: "rgba(255,255,255,.06)" }
                            },
                            y: {
                                min: yr.min, max: yr.max,
                                grid: { color: "rgba(255,255,255,.06)" }
                            }
                        }
                    }
                });

                canvas._bbChart = chart;

                // slide tick: NO fetch, but recompute X/Y from now always
                if (!canvas._bbTimer) {
                    canvas._bbTimer = setInterval(() => {
                        if (!canvas._bbChart) return;
                        updateFrame(canvas);
                    }, 2000);
                }
            }

            // update immediately
            updateFrame(canvas);

        } catch (e) {
            stopAndClear(canvas);
            try { console.error("[BBTrend] fetch fail", { key: k, err: (e && e.message) ? e.message : e }); } catch { }
        } finally {
            canvas._bbBusy = false;
        }
    }

    // =========================
    // Wiring: use canvas data-select="selectId"
    // =========================
    function wireCanvasWithSelect(scope, canvas) {
        if (!canvas || canvas._bbWired) return;
        canvas._bbWired = true;

        // find select
        const selId = (canvas.getAttribute("data-select") || "").trim();
        const sel = selId ? scope.querySelector(`#${CSS.escape(selId)}`) : null;

        // init key
        const initKey = (canvas.getAttribute("data-code") || canvas.getAttribute("data-default") || sel?.value || "UZ5411P").trim().toUpperCase();
        canvas.setAttribute("data-code", initKey);
        if (sel) sel.value = initKey;

        // bind change
        if (sel && !sel._bbBound) {
            sel._bbBound = true;
            sel.addEventListener("change", () => {
                const next = String(sel.value || "").trim().toUpperCase();
                if (!next) return;
                canvas.setAttribute("data-code", next);
                refreshData(canvas, next);
            });
        }

        // first fetch
        refreshData(canvas, initKey);
    }

    function initWithin(root) {
        const scope = root || document;
        const canvases = scope.querySelectorAll(CANVAS_SELECTOR);
        canvases.forEach(cv => wireCanvasWithSelect(scope, cv));
    }

    function destroyWithin(root) {
        const scope = root || document;
        scope.querySelectorAll(CANVAS_SELECTOR).forEach(stopAndClear);
    }

    function clearCache() { _cache.clear(); }

    function refreshWithin(root) {
        const scope = root || document;
        const canvases = scope.querySelectorAll(CANVAS_SELECTOR);
        canvases.forEach(cv => {
            const key = (cv.getAttribute("data-code") || cv.getAttribute("data-default") || "UZ5411P").trim().toUpperCase();
            refreshData(cv, key);
        });
    }

    return { initWithin, destroyWithin, clearCache, refreshWithin };
})();