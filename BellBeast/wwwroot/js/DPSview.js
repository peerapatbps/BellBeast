// DPSview.js  (OnlineLab POST /api/online_lab)
// - ไม่ยุ่ง UZ541xP dropdown (อันนั้น BBTrend ทำของมัน)
// - ทำเฉพาะ row4: dpsPostTrend1..4 (TW1..TW4 Post_Chlor)
// - ยิง POST ครั้งเดียว ได้ 4 กราฟใน payload เดียว
// - refresh ทุก 5 นาที
// - hourWindow=4 (ส่งให้ backend ตามสเปค)
// - ถ้า fail: ไม่แสดงกราฟ (destroy + ซ่อน canvas)
// - IMPORTANT: ทำ POST แบบ "simple request" เพื่อลด/เลี่ยง OPTIONS (CORS preflight)
//
// ✅ ตามที่สั่ง: "แค่เอา dataset มาพล็อต"
//    - X ใช้ “เวลา (ts) ที่ backend ส่งมา” ตรง ๆ (ไม่ใช้ index, ไม่ใช้ now, ไม่ใช้ time scale)
//    - ไม่ทำ window slide / ตรรกะเพิ่ม
//    - backend ส่ง DESC -> reverse เป็น ASC เพื่อให้ซ้าย->ขวา

(function () {

    // ============================
    // Settings
    // ============================
    const POLL_MS = 5 * 60 * 1000;   // 5 นาที
    const HOUR_WINDOW = 4;           // 4 ชั่วโมงล่าสุด (ส่งให้ backend)
    const TIMEOUT_MS = 8000;

    const KEY_MAIN = "Post_Chlor";
    const KEY_MAX = "Post_Chlor_ParaMax";
    const KEY_MIN = "Post_Chlor_ParaMin";

    let _inflight = null;

    // ============================
    // URL helper
    // ============================
    function inferBackendBase(root) {
        const port = "8888";
        const proto = (location.protocol === "https:") ? "https" : "http";
        const host = location.hostname;
        return `${proto}://${host}:${port}`;
    }

    function apiUrl(root, path) {
        if (!path.startsWith("/")) path = "/" + path;
        return inferBackendBase(root).replace(/\/+$/, "") + path;
    }

    // ============================
    // Fetch (POST) - SIMPLE REQUEST (no preflight)
    // ============================
    async function fetchOnlineLab(root) {
        if (_inflight) return _inflight;

        const url = apiUrl(root, "/api/online_lab");
        const payloadObj = {
            hourWindow: HOUR_WINDOW,
            sources: [
                { source: "TW1", keys: [KEY_MAIN, KEY_MAX, KEY_MIN] },
                { source: "TW2", keys: [KEY_MAIN, KEY_MAX, KEY_MIN] },
                { source: "TW3", keys: [KEY_MAIN, KEY_MAX, KEY_MIN] },
                { source: "TW4", keys: [KEY_MAIN, KEY_MAX, KEY_MIN] }
            ]
        };

        // ✅ text/plain => simple request
        const payloadText = JSON.stringify(payloadObj);

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort("timeout"), TIMEOUT_MS);

        _inflight = (async () => {
            try {
                const r = await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "text/plain;charset=UTF-8" },
                    cache: "no-store",
                    body: payloadText,
                    signal: ac.signal
                });

                if (!r.ok) throw new Error(`HTTP ${r.status}`);

                const j = await r.json();
                if (!j || j.ok !== true) {
                    throw new Error(j && (j.error || j.message) ? (j.error || j.message) : "online_lab not ok");
                }

                return j;
            } finally {
                clearTimeout(t);
                _inflight = null;
            }
        })();

        return _inflight;
    }

    // ============================
    // Chart helpers (plot dataset only)
    // ============================

    // เอา ts ที่ backend ส่งมาเป็น X label ตรง ๆ
    // backend ส่ง DESC -> reverse เป็น ASC
    function toLabelsAndY(points) {
        const labels = [];
        const ys = [];

        const arr = [];
        for (const p of (points || [])) {
            if (!p) continue;
            const ts = String(p.ts || "").trim();
            const y = Number(p.value);
            if (!ts) continue;
            if (!Number.isFinite(y)) continue;
            arr.push({ ts, y });
        }
        arr.reverse();

        for (const it of arr) {
            labels.push(it.ts);   // ✅ x = ts จาก backend ตรง ๆ
            ys.push(it.y);
        }

        return { labels, ys };
    }

    // series อื่น (max/min) ให้ได้แค่ y ตามลำดับเดียวกัน (DESC->ASC)
    function toY(points) {
        const ys = [];
        const arr = [];
        for (const p of (points || [])) {
            const y = Number(p && p.value);
            if (!Number.isFinite(y)) continue;
            arr.push(y);
        }
        arr.reverse();
        for (const y of arr) ys.push(y);
        return ys;
    }

    function ensureChart(canvas) {
        if (!window.Chart) throw new Error("Chart.js not loaded");
        if (canvas._bbChart2) return canvas._bbChart2;

        const ctx = canvas.getContext("2d");
        const ch = new Chart(ctx, {
            type: "line",
            data: {
                labels: [],   // ✅ x labels = ts strings
                datasets: [
                    { label: KEY_MAIN, data: [], borderColor: "rgba(255,255,255,.92)", borderWidth: 2, pointRadius: 0, tension: 0 },
                    { label: KEY_MAX, data: [], borderColor: "rgba(255,91,91,.95)", borderWidth: 4, pointRadius: 0, tension: 0 },
                    { label: KEY_MIN, data: [], borderColor: "rgba(255,91,91,.95)", borderWidth: 4, pointRadius: 0, tension: 0 },
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
                        time: {
                            unit: "minute",
                            displayFormats: { minute: "HH:mm" }
                        },
                        ticks: {
                            display: false    // ❗ ซ่อนตัวเลขแกน X
                        },
                        grid: {
                            display: false    // ❗ เอาเส้น grid X ออกด้วย (ถ้าอยากโล่ง ๆ)
                        }
                    },
                    y: { grid: { color: "rgba(255,255,255,.06)" } }
                }
            }
        });

        canvas._bbChart2 = ch;
        return ch;
    }

    function destroyChart(canvas) {
        if (canvas && canvas._bbChart2) {
            try { canvas._bbChart2.destroy(); } catch { }
        }
        if (canvas) canvas._bbChart2 = null;
    }

    function setVisible(canvas, visible) {
        canvas.style.display = visible ? "" : "none";
    }

    // ============================
    // Render 4 charts from one payload
    // ============================
    function pickGraph(data, source) {
        const g = data && data.graphs ? data.graphs[source] : null;
        return g || null;
    }

    function padToLen(arr, len) {
        if (arr.length === len) return arr;
        if (arr.length > len) return arr.slice(0, len);
        const out = arr.slice();
        while (out.length < len) out.push(null);
        return out;
    }

    function renderOne(canvas, graph) {
        if (!graph) {
            destroyChart(canvas);
            setVisible(canvas, false);
            return;
        }

        // ✅ labels ใช้จาก MAIN เพื่อเป็นแกน X (เวลา ts จาก backend)
        const mainPack = toLabelsAndY(graph[KEY_MAIN]);
        const labels = mainPack.labels;
        const mainY = mainPack.ys;

        if (!labels.length || !mainY.length) {
            destroyChart(canvas);
            setVisible(canvas, false);
            return;
        }

        const maxY = padToLen(toY(graph[KEY_MAX]), labels.length);
        const minY = padToLen(toY(graph[KEY_MIN]), labels.length);

        const ch = ensureChart(canvas);
        ch.data.labels = labels;
        ch.data.datasets[0].data = mainY;
        ch.data.datasets[1].data = maxY;
        ch.data.datasets[2].data = minY;

        ch.update("none");
        setVisible(canvas, true);
    }

    async function refreshRow4(root) {
        const scope = root || document;

        const c1 = scope.querySelector("#dpsPostTrend1");
        const c2 = scope.querySelector("#dpsPostTrend2");
        const c3 = scope.querySelector("#dpsPostTrend3");
        const c4 = scope.querySelector("#dpsPostTrend4");
        if (!c1 || !c2 || !c3 || !c4) return;

        try {
            const data = await fetchOnlineLab(scope);

            renderOne(c1, pickGraph(data, "TW1"));
            renderOne(c2, pickGraph(data, "TW2"));
            renderOne(c3, pickGraph(data, "TW3"));
            renderOne(c4, pickGraph(data, "TW4"));
        } catch (e) {
            destroyChart(c1); destroyChart(c2); destroyChart(c3); destroyChart(c4);
            setVisible(c1, false); setVisible(c2, false); setVisible(c3, false); setVisible(c4, false);
        }
    }

    // ============================
    // Public initWithin
    // ============================
    function initWithin(root) {
        const scope = root || document;

        // ของเดิม: UZ dropdown (BBTrend) ยังทำของมันได้
        window.BBTrend?.initWithin(scope);

        // OnlineLab row4
        if (scope._dpsOnlineLabBound === true) return;
        scope._dpsOnlineLabBound = true;

        refreshRow4(scope);

        scope._dpsOnlineLabTimer = setInterval(() => {
            refreshRow4(scope);
        }, POLL_MS);
    }

    function destroyWithin(root) {
        const scope = root || document;
        if (scope._dpsOnlineLabTimer) clearInterval(scope._dpsOnlineLabTimer);
        scope._dpsOnlineLabTimer = null;
        scope._dpsOnlineLabBound = false;

        const c = [
            scope.querySelector("#dpsPostTrend1"),
            scope.querySelector("#dpsPostTrend2"),
            scope.querySelector("#dpsPostTrend3"),
            scope.querySelector("#dpsPostTrend4"),
        ].filter(Boolean);

        for (const cv of c) {
            destroyChart(cv);
            setVisible(cv, false);
        }
    }

    window.DPSView = { initWithin, destroyWithin };

})();