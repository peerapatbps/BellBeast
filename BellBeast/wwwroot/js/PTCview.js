/* =========================================================
   PTCview.js  (backend-driven)
   - ใช้กับ: <canvas class="bb-trend-chart-ptc" ...
               data-select="<selectId>" data-latest="<divId>" data-backend-port="443"
               data-y-top data-y-band data-y-bot>
   - ต้องมี Chart.js + time adapter โหลดไว้ก่อน
   - ดึง upper/lower ผ่าน route ของ BellBeast บนพอร์ต 443 (รูปแบบข้อมูล: [{hhmm,upper,lower}, ...] หรือ {points:[...]} )
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
        const base = (canvas.getAttribute("data-backend-base") || location.origin).trim().replace(/\/+$/, "");
        const k = encodeURIComponent(String(key || "").trim());
        const t = encodeURIComponent(String(forceTs || Date.now()));

        return `${base}/api/ptc/series?key=${k}&_ts=${t}`;
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

    // ตัด timeline ให้เหลือเฉพาะช่วง now±30 นาที (+ จุดก่อน/หลังขอบ 1 จุด ให้เส้นลากถึงขอบกราฟ)
    function sliceWindow(pts, now) {
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

        // ฐานคิดแกน y = จุดใน window + ค่าเส้นที่ขอบซ้าย/ขวา (interpolate)
        // จุด upper/lower ห่างกันชั่วโมงละจุด -> ถ้าใช้แค่ mid ช่วงที่เส้นขึ้น/ลงขั้นบันไดจะหลุดกรอบ y
        const yBase = mid.slice();
        const edgeAt = (x) => {
            // ขอบซ้าย: before -> จุดแรกใน window, ขอบขวา: จุดสุดท้ายใน window -> after
            const l = x === xMin ? before : (mid.length ? mid[mid.length - 1] : before);
            const r = x === xMin ? (mid.length ? mid[0] : after) : after;
            if (!l || !r) return null;
            const span = r.t - l.t;
            const f = span > 0 ? (x - l.t) / span : 0;
            return { upper: l.upper + (r.upper - l.upper) * f, lower: l.lower + (r.lower - l.lower) * f };
        };
        for (const x of [xMin, xMax]) {
            const e = edgeAt(x);
            if (e) yBase.push(e);
        }
        // signature ของชุดจุดที่อยู่ในกราฟ -> เปลี่ยนเมื่อมีจุดเข้า/ออก window เท่านั้น
        const sig = usePts.length ? `${usePts[0].t.getTime()}|${usePts[usePts.length - 1].t.getTime()}|${usePts.length}` : "";

        return { xMin, xMax, mid, usePts, yBase, sig };
    }

    // ✅ เลื่อน window (ไม่ fetch) แต่ตัดเส้น upper/lower ใหม่จาก raw ใน memory ด้วย
    // เดิมเลื่อนแค่แกน x -> ข้อมูลที่ตัดไว้ตอน fetch (±30 นาที) หลุดขอบหลัง ~1 ชม. เส้นควบคุมหายจนกว่าจะ refresh รอบใหญ่ (3 ชม.)
    function slideWindowOnly(canvas) {
        const ch = canvas._bbChart;
        if (!ch) return;

        const now = new Date();

        // build ใหม่ทุกรอบ: hhmm ผูกกับ "วันนี้" -> ข้ามเที่ยงคืน/ข้ามเกณฑ์ 06:00 ต้องเปลี่ยนวันตาม
        const raw = canvas._bbRaw;
        const pts = raw ? buildTimeline(raw) : (canvas._bbTimeline || []);
        canvas._bbTimeline = pts;

        const w = sliceWindow(pts, now);

        ch.options.scales.x.min = w.xMin;
        ch.options.scales.x.max = w.xMax;

        const changed = w.sig !== canvas._bbWindowSig;
        if (changed) {
            canvas._bbWindowSig = w.sig;
            ch.data.datasets[0].data = w.usePts.map(p => ({ x: p.t, y: p.upper }));
            ch.data.datasets[1].data = w.usePts.map(p => ({ x: p.t, y: p.lower }));

            const yr = computeYRangeByShares(w.yBase.length ? w.yBase : w.usePts, readYShare(canvas));
            ch.options.scales.y.min = yr.min;
            ch.options.scales.y.max = yr.max;
        }

        // update แบบไม่ animate
        ch.update("none");

        // แกน y เพิ่งคิดใหม่จาก upper/lower -> ให้ overlay ขยายรับจุด PV อีกครั้ง
        if (changed) notifyOverlay();
    }

    // upper/lower ชุดใหม่มาแล้ว (เปลี่ยน key / refresh รอบใหญ่) -> ให้ overlay วางจุด PV + badge + ขยายแกน y ทันที
    // ไม่ต้องรอ poll รอบถัดไป (แกน y ที่เพิ่งตั้งใหม่คิดจาก upper/lower อย่างเดียว)
    function notifyOverlay() {
        try { window.PTCSmartmapOverlay?.tickAll?.(); } catch { }
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

        // เปลี่ยน dropdown เร็ว ๆ -> response ของ key เก่าที่กลับมาทีหลังต้องทิ้ง ไม่ให้ทับเส้นของ key ใหม่
        const seq = (canvas._bbReqSeq || 0) + 1;
        canvas._bbReqSeq = seq;
        const stale = () => canvas._bbReqSeq !== seq;

        try {
            const raw = await fetchSeriesPoints(canvas, k, forceReload);
            if (stale()) return;
            const pts = buildTimeline(raw);

            const now = new Date();
            const { xMin, xMax, usePts, yBase, sig } = sliceWindow(pts, now);

            const upperData = usePts.map(p => ({ x: p.t, y: p.upper }));
            const lowerData = usePts.map(p => ({ x: p.t, y: p.lower }));

            const yrBase = yBase.length ? yBase : usePts;
            const share = readYShare(canvas);
            const yr = computeYRangeByShares(yrBase, share);

            let last = null;
            for (const p of pts) {
                if (p.t <= now) last = p; else break;
            }
            // Latest เป็นของ ptc_smartmap_overlay.js (เวลา | ค่า PV) -> ถ้ามี overlay อย่าเขียนทับด้วย upper/lower
            if (!window.PTCSmartmapOverlay) {
                if (last) setLatest(canvas, fmtHHMM(last.t), last.upper, last.lower);
                else setLatest(canvas, null, null, null);
            }

            canvas._bbRaw = raw;       // slideWindowOnly ใช้ตัด window ใหม่โดยไม่ต้อง fetch
            canvas._bbTimeline = pts;
            canvas._bbWindowSig = sig;
            canvas._bbSeriesKey = k;   // overlay ใช้เช็คว่า upper/lower ที่อยู่ในกราฟเป็นของ key ปัจจุบัน
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

                notifyOverlay();
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
            notifyOverlay();
        } catch (e) {
            if (stale()) return;
            canvas._bbSeriesKey = null;
            showFail(canvas, `PTC load failed: ${e && e.message ? e.message : 'error'}`);
            syncSectionAlert(canvas.closest("section.ptc-block"));
        } finally {
            if (!stale()) canvas._bbBusy = false;
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

    // canvas ของ PTC เท่านั้น: DPS ก็ใช้ class bb-trend-chart-ptc แต่เป็นของ BBTrend.js
    // (ถ้าคุมซ้อนกัน 2 ตัว จะแย่ง _bbChart / sel._bbBound / แกน y กัน)
    function ptcCanvases(scope) {
        return Array.from((scope || document).querySelectorAll("section.ptc-block canvas.bb-trend-chart-ptc"));
    }

    function initWithin(root) {
        const scope = root || document;
        const canvases = ptcCanvases(scope);
        if (!canvases.length) return;

        canvases.forEach(cv => {
            const key = getCurrentCanvasKey(cv) || "UZ5411P";
            cv.setAttribute("data-code", key);
            wireDropdown(cv);
            refreshData(cv, key, true);
        });

        restartSeriesPoller();
    }

    function destroyWithin(root) {
        const scope = root || document;
        const canvases = ptcCanvases(scope);
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
            cv._bbRaw = null;
            cv._bbWindowSig = null;
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
        const canvases = ptcCanvases(root);

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

        // timer เดียวทั้งหน้า -> วิ่งทั้ง document เสมอ
        // (เดิมผูก scope ของ slot ล่าสุดที่ init -> ถ้าไม่ใช่ slot PTC เส้น upper/lower จะไม่ refresh)
        const sec = Number(loadSeriesRefreshSec() || 10800);

        _seriesPollTimer = setInterval(() => {
            refreshAllSeriesNow(document);
        }, sec * 1000);

        refreshAllSeriesNow(document);
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
