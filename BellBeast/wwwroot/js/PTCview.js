/* =========================================================
   PTCview.js  (backend-driven)
   - ใช้กับ: <canvas class="bb-trend-chart-ptc" ...
               data-select="<selectId>" data-latest="<divId>" data-backend-port="8888"
               data-y-top data-y-band data-y-bot>
   - ต้องมี Chart.js + time adapter โหลดไว้ก่อน
   - ดึง upper/lower จาก backend port 8888 (รูปแบบข้อมูล: [{hhmm,upper,lower}, ...] หรือ {points:[...]} )
   ========================================================= */

window.BBTrendPTC = (function () {

    // cache ต่อ key (ลดโหลด backend)  **ใช้เฉพาะตอน fetch data เท่านั้น**
    // NOTE: window slide จะไม่ fetch
    const _cache = new Map(); // key -> { ts:number, points:Array }
    const SERIES_STORAGE_KEY = "ptc_smartmap_refresh_v1";
    let _seriesPollTimer = null;

    function toDateToday(hhmm) {
        const [h, m] = String(hhmm).split(":").map(x => parseInt(x, 10));
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), (h || 0), (m || 0), 0, 0);
    }

    function buildTimeline(points) {
        const now = new Date();
        const arr = (points || []).map(p => ({
            t: toDateToday(p.hhmm),
            upper: +p.upper,
            lower: +p.lower,
        }));
        arr.sort((a, b) => a.t - b.t);

        // ถ้ากลางคืน/เช้ามืด ให้ 23:xx เป็นของ “เมื่อวาน” เพื่อไม่ให้กระโดด
        if (now.getHours() < 6) {
            for (const it of arr) {
                if (it.t.getHours() === 23) it.t = new Date(it.t.getTime() - 24 * 60 * 60 * 1000);
            }
            arr.sort((a, b) => a.t - b.t);
        }
        return arr;
    }

    function readYShare(canvas) {
        const yt = parseFloat(canvas.getAttribute("data-y-top") ?? "0.10");
        const yb = parseFloat(canvas.getAttribute("data-y-band") ?? "0.80");
        const ybot = parseFloat(canvas.getAttribute("data-y-bot") ?? "0.10");

        let top = Number.isFinite(yt) ? yt : 0.10;
        let band = Number.isFinite(yb) ? yb : 0.80;
        let bot = Number.isFinite(ybot) ? ybot : 0.10;

        if (top < 0) top = 0;
        if (bot < 0) bot = 0;
        if (band <= 0) band = 0.80;

        const sum = top + band + bot;
        if (sum > 0) { top /= sum; band /= sum; bot /= sum; }
        if (band < 0.05) band = 0.05;

        return { top, band, bot };
    }

    function computeYRangeByShares(windowPoints, share) {
        let minY = Infinity, maxY = -Infinity;
        for (const p of windowPoints) {
            minY = Math.min(minY, p.lower);
            maxY = Math.max(maxY, p.upper);
        }
        if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return { min: 0, max: 10 };

        let range = maxY - minY;
        if (range <= 1e-9) { range = 1; minY -= 0.5; maxY += 0.5; }

        const padTop = range * (share.top / share.band);
        const padBot = range * (share.bot / share.band);

        return { min: minY - padBot, max: maxY + padTop };
    }

    function pad2(n) { return String(n).padStart(2, "0"); }
    function fmtHHMM(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

    function setLatest(canvas, hhmm, upper, lower) {
        const latestId = canvas.getAttribute("data-latest");
        if (!latestId) return;
        const el = document.getElementById(latestId);
        if (!el) return;

        const u = Number.isFinite(upper) ? upper : null;
        const l = Number.isFinite(lower) ? lower : null;

        if (hhmm && u != null && l != null) {
            el.innerHTML = `Latest <b>${hhmm}</b> : <b>${u.toFixed(2)} / ${l.toFixed(2)}</b>`;
        } else {
            el.innerHTML = `Latest <b>--:--</b> : <b>--</b>`;
        }
    }

    function syncSectionAlert(section) {
        // Alarm is owned by ptc_smartmap_overlay.js.
        // PTCview.js only renders upper/lower series. Do not evaluate or overwrite the bell here,
        // otherwise series refresh can clear an active out-of-control alarm.
        return;
    }

    function inferBackendUrl(canvas, key, forceTs) {
        const port = (canvas.getAttribute("data-backend-port") || "8888").trim();
        const proto = (location.protocol === "https:") ? "https" : "http";
        const host = location.hostname;

        const k = encodeURIComponent(String(key || "").trim());
        const t = encodeURIComponent(String(forceTs || Date.now()));

        return `${proto}://${host}:${port}/api/ptc/series?key=${k}&_ts=${t}`;
    }

    // ✅ Fetch เฉพาะตอน “ต้องอัปเดตข้อมูล”
    // - ไม่มี FALLBACK
    // - fail => throw (ให้ upstream ตัดสินใจ "ไม่แสดงกราฟ")
    async function fetchSeriesPoints(canvas, key, forceReload = false) {
        const k = String(key || "").trim().toUpperCase();
        if (!k) return [];

        const now = Date.now();

        if (!forceReload) {
            const hit = _cache.get(k);
            if (hit && (now - hit.ts) < 10_000) return hit.points;
        } else {
            _cache.delete(k);
        }

        const url = inferBackendUrl(canvas, k, now);

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort("timeout"), 5000);
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

            if (!Array.isArray(points) || points.length === 0) {
                throw new Error("Empty points");
            }

            _cache.set(k, { ts: now, points });
            return points;
        } finally {
            clearTimeout(t);
        }
    }

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

    function showFail(canvas, msg) {
        // ไม่แสดงกราฟ เพื่อให้รู้ว่า fail
        setLatest(canvas, null, null, null);

        if (canvas._bbChart) {
            try { canvas._bbChart.destroy(); } catch { }
        }
        canvas._bbChart = null;

        // หยุด slide timer ด้วย (กัน update วน)
        if (canvas._bbTimer) {
            clearInterval(canvas._bbTimer);
            canvas._bbTimer = null;
        }

        // แสดงข้อความแทนกราฟแบบเบา ๆ
        // (ถ้าไม่ต้องการข้อความ ให้คอมเมนต์ 2 บรรทัดนี้)
        const parent = canvas.parentElement;
        if (parent) {
            parent.textContent = msg || "PTC series load failed";
        }
    }

    function ensureChartContainer(canvas) {
        // ถ้า parent ถูก replace เป็น textContent จาก showFail แล้ว
        // ต้องสร้าง canvas ใหม่เองถึงจะวาดได้อีก
        // ดังนั้น: ถ้าต้องการให้ recover ได้ ให้ “อย่าใช้ parent.textContent”
        // ตอนนี้ requirement คือ fail แล้วไม่ต้องแสดง => OK
    }

    // ✅ เลื่อน window อย่างเดียว (ไม่ fetch)
    function slideWindowOnly(canvas) {
        const ch = canvas._bbChart;
        if (!ch) return;

        const now = new Date();
        const xMin = new Date(now.getTime() - 30 * 60 * 1000);
        const xMax = new Date(now.getTime() + 30 * 60 * 1000);

        ch.options.scales.x.min = xMin;
        ch.options.scales.x.max = xMax;

        // update แบบไม่ animate
        ch.update("none");
    }

    // ✅ update data + y-range + latest (fetch เฉพาะที่นี่)
    async function refreshData(canvas, key, forceReload = false) {
        if (!window.Chart) {
            showFail(canvas, "Chart.js not loaded");
            return;
        }

        const k = String(key || "").trim().toUpperCase();
        if (!k) return;

        if (canvas._bbBusy && canvas._bbBusyKey === k) return;
        canvas._bbBusy = true;
        canvas._bbBusyKey = k;

        try {
            const raw = await fetchSeriesPoints(canvas, k, forceReload);
            const pts = buildTimeline(raw);

            const now = new Date();
            const xMin = new Date(now.getTime() - 30 * 60 * 1000);
            const xMax = new Date(now.getTime() + 30 * 60 * 1000);

            let before = null;
            let after = null;
            const mid = [];

            for (const p of pts) {
                if (p.t < xMin) before = p;
                else if (p.t > xMax) { after = p; break; }
                else mid.push(p);
            }

            const renderPts = [];
            if (before) renderPts.push(before);
            renderPts.push(...mid);
            if (after) renderPts.push(after);

            const usePts = renderPts.length ? renderPts : pts;

            const upperData = usePts.map(p => ({ x: p.t, y: p.upper }));
            const lowerData = usePts.map(p => ({ x: p.t, y: p.lower }));

            const yrBase = mid.length ? mid : usePts;
            const share = readYShare(canvas);
            const yr = computeYRangeByShares(yrBase, share);

            let last = null;
            for (const p of pts) {
                if (p.t <= now) last = p; else break;
            }
            if (last) setLatest(canvas, fmtHHMM(last.t), last.upper, last.lower);
            else setLatest(canvas, null, null, null);

            canvas._bbTimeline = pts;
            syncSectionAlert(canvas.closest("section.ptc-block"));

            if (!canvas._bbChart) {
                const chart = new Chart(canvas.getContext("2d"), {
                    type: "line",
                    plugins: [nowLinePlugin],
                    data: {
                        datasets: [
                            { label: "Upper", data: upperData, parsing: false, borderColor: "rgba(255,91,91,.95)", borderWidth: 4, pointRadius: 0, tension: .0 },
                            { label: "Lower", data: lowerData, parsing: false, borderColor: "rgba(255,91,91,.60)", borderWidth: 4, pointRadius: 0, tension: .0 },
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

                if (!canvas._bbTimer) {
                    canvas._bbTimer = setInterval(() => {
                        if (!canvas._bbChart) return;
                        slideWindowOnly(canvas);
                    }, 2000);
                }

                return;
            }

            const ch = canvas._bbChart;
            ch.data.datasets[0].data = upperData;
            ch.data.datasets[1].data = lowerData;
            ch.options.scales.y.min = yr.min;
            ch.options.scales.y.max = yr.max;
            ch.options.scales.x.min = xMin;
            ch.options.scales.x.max = xMax;
            ch.update("none");
        } catch (e) {
            showFail(canvas, `PTC load failed: ${e && e.message ? e.message : 'error'}`);
            syncSectionAlert(canvas.closest("section.ptc-block"));
        } finally {
            canvas._bbBusy = false;
        }
    }

    function wireDropdown(canvas) {
        const selId = canvas.getAttribute("data-select");
        if (!selId) return;
        const sel = document.getElementById(selId);
        if (!sel) return;

        const k = (canvas.getAttribute("data-code") || canvas.getAttribute("data-default") || "").trim().toUpperCase();
        if (k) sel.value = k;

        if (sel._bbBound) return;
        sel._bbBound = true;

        sel.addEventListener("change", () => {
            const next = String(sel.value || "").trim().toUpperCase();
            if (!next) return;

            canvas.setAttribute("data-code", next);

            // ✅ เปลี่ยน key => fetch data ใหม่ครั้งเดียว
            refreshData(canvas, next);
        });
    }

    function getCurrentCanvasKey(canvas) {
        const selId = (canvas.getAttribute("data-select") || "").trim();
        const sel = selId ? document.getElementById(selId) : null;

        let key = "";
        if (sel) key = String(sel.value || "").trim().toUpperCase();
        if (!key) key = String(canvas.getAttribute("data-code") || canvas.getAttribute("data-default") || "").trim().toUpperCase();

        return key;
    }

    function initWithin(root) {
        const scope = root || document;
        const canvases = scope.querySelectorAll("canvas.bb-trend-chart-ptc");

        canvases.forEach(cv => {
            const key = getCurrentCanvasKey(cv) || "UZ5411P";
            cv.setAttribute("data-code", key);
            wireDropdown(cv);
            refreshData(cv, key, true);
        });

        restartSeriesPoller(scope);
    }

    function destroyWithin(root) {
        const scope = root || document;
        const canvases = scope.querySelectorAll("canvas.bb-trend-chart-ptc");
        canvases.forEach(cv => {
            if (cv._bbTimer) clearInterval(cv._bbTimer);
            if (cv._bbChart) {
                try { cv._bbChart.destroy(); } catch { }
            }
            cv._bbTimer = null;
            cv._bbChart = null;
            cv._bbBusy = false;
            cv._bbBusyKey = null;
            cv._bbTimeline = null;
        });

        if (_seriesPollTimer) {
            clearInterval(_seriesPollTimer);
            _seriesPollTimer = null;
        }
    }

    function loadSeriesRefreshSec() {
        try {
            const raw = localStorage.getItem(SERIES_STORAGE_KEY);
            if (!raw) return 10800;

            const o = JSON.parse(raw);
            const n = Number(o.seriesRefreshSec);

            return [10800, 21600, 32400, 43200].includes(n) ? n : 10800;
        } catch {
            return 10800;
        }
    }

    async function refreshAllSeriesNow(root) {
        const scope = root || document;
        const canvases = scope.querySelectorAll("canvas.bb-trend-chart-ptc");

        for (const cv of canvases) {
            const key = getCurrentCanvasKey(cv);
            if (!key) continue;

            cv.setAttribute("data-code", key);

            try {
                await refreshData(cv, key, true);
            } catch { }
        }
    }

    function restartSeriesPoller(root) {
        if (_seriesPollTimer) {
            clearInterval(_seriesPollTimer);
            _seriesPollTimer = null;
        }

        const sec = Number(loadSeriesRefreshSec() || 10800);
        const scope = root || document;

        _seriesPollTimer = setInterval(() => {
            refreshAllSeriesNow(scope);
        }, sec * 1000);

        refreshAllSeriesNow(scope);
    }

    function clearCache() { _cache.clear(); }

    return {
        initWithin,
        destroyWithin,
        clearCache,
        restartSeriesPoller,
        refreshAllSeriesNow
    };
})();
