// RWSview.js  (OnlineLab POST /api/online_lab)
// - ทำเฉพาะ 4 mini charts: RW_NTU, RW_COND, RW_DO, RW_TEMP
// - ยิง POST ครั้งเดียว ได้ 4 กราฟใน payload เดียว (source=RW2)
// - refresh ทุก 5 นาที (ปรับได้)
// - hourWindow=4 (ส่งให้ backend ตามสเปค)
// - ถ้า fail: destroy + ซ่อน canvas
// - ทำ POST แบบ "simple request" => content-type: text/plain;charset=UTF-8
//
// Rules per key:
// - NTU: main + MAX only  (NTU, NTU_ParaMax)
// - Cond: main only       (Cond)
// - DO: main + MIN only   (DO, DO_ParaMin)
// - Temp: main only       (Temp)

(function () {
    "use strict";

    // ============================
    // Settings
    // ============================
    const POLL_MS = 5 * 60 * 1000;  // 5 นาที
    const HOUR_WINDOW = 4;
    const TIMEOUT_MS = 8000;

    const SOURCE = "RW2";

    // keys
    const K_NTU = "NTU";
    const K_NTU_MAX = "NTU_ParaMax";

    const K_COND = "Cond";

    const K_DO = "DO";
    const K_DO_MIN = "DO_ParaMin";

    const K_TEMP = "Temp";

    let _inflight = null;

    // ============================
    // URL helper (ชี้ไป backend :8888 เหมือน DPS)
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
    // Fetch OnlineLab (POST simple request)
    // ============================
    async function fetchOnlineLab(root) {
        if (_inflight) return _inflight;

        const url = apiUrl(root, "/api/online_lab");

        // ขอ keys ทั้งหมดทีเดียว (บางตัวอาจไม่มีเกณฑ์ => backend อาจไม่ส่ง)
        const payloadObj = {
            hourWindow: HOUR_WINDOW,
            sources: [
                {
                    source: SOURCE,
                    keys: [
                        K_NTU, K_NTU_MAX,
                        K_COND,
                        K_DO, K_DO_MIN,
                        K_TEMP
                    ]
                }
            ]
        };

        const payloadText = JSON.stringify(payloadObj);

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort("timeout"), TIMEOUT_MS);

        _inflight = (async () => {
            try {
                const r = await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "text/plain;charset=UTF-8" }, // ✅ simple request
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
    // Parse helpers (DESC -> ASC)
    // ============================
    function toLabelsAndY(points) {
        const arr = [];
        for (const p of (points || [])) {
            if (!p) continue;
            const ts = String(p.ts || "").trim();
            const y = Number(p.value);
            if (!ts) continue;
            if (!Number.isFinite(y)) continue;
            arr.push({ ts, y });
        }
        arr.reverse(); // backend DESC -> ASC

        const labels = [];
        const ys = [];
        for (const it of arr) {
            labels.push(it.ts);
            ys.push(it.y);
        }
        return { labels, ys };
    }

    function toY(points) {
        const arr = [];
        for (const p of (points || [])) {
            const y = Number(p && p.value);
            if (!Number.isFinite(y)) continue;
            arr.push(y);
        }
        arr.reverse();
        return arr;
    }

    function padToLen(arr, len) {
        if (arr.length === len) return arr;
        if (arr.length > len) return arr.slice(0, len);
        const out = arr.slice();
        while (out.length < len) out.push(null);
        return out;
    }

    // ============================
    // Chart helpers
    // ============================
    function ensureChart(canvas, mode) {
        if (!window.Chart) throw new Error("Chart.js not loaded");

        // reuse ถ้า mode เดิม
        if (canvas._rwsChart && canvas._rwsChart._rwsMode === mode) return canvas._rwsChart;

        // ถ้ามีของเก่าแต่ mode เปลี่ยน => destroy
        if (canvas._rwsChart) {
            try { canvas._rwsChart.destroy(); } catch { }
            canvas._rwsChart = null;
        }

        const ctx = canvas.getContext("2d");

        // dataset template ตาม mode
        // mode: "main" | "main_max" | "main_min"
        const datasets = [];
        // main
        datasets.push({
            label: "main",
            data: [],
            borderColor: "rgba(255,255,255,.92)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0
        });

        if (mode === "main_max") {
            datasets.push({
                label: "max",
                data: [],
                borderColor: "rgba(255,91,91,.95)",
                borderWidth: 4,
                pointRadius: 0,
                tension: 0
            });
        } else if (mode === "main_min") {
            datasets.push({
                label: "min",
                data: [],
                borderColor: "rgba(255,91,91,.95)",
                borderWidth: 4,
                pointRadius: 0,
                tension: 0
            });
        }

        const ch = new Chart(ctx, {
            type: "line",
            data: { labels: [], datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: { legend: { display: false } },
                scales: {
                    // ✅ ใช้ category แบบ string labels เพื่อไม่ต้องพึ่ง time-adapter
                    x: {
                        type: "category",
                        ticks: { display: false },   // ซ่อน label แกน X
                        grid: { display: false }     // เอา grid X ออก
                    },
                    y: {
                        grid: { color: "rgba(255,255,255,.06)" }
                    }
                }
            }
        });

        ch._rwsMode = mode;
        canvas._rwsChart = ch;
        return ch;
    }

    function destroyChart(canvas) {
        if (canvas && canvas._rwsChart) {
            try { canvas._rwsChart.destroy(); } catch { }
        }
        if (canvas) canvas._rwsChart = null;
    }

    function setVisible(canvas, visible) {
        canvas.style.display = visible ? "" : "none";
    }

    // ============================
    // Extract graph payload
    // ============================
    function pickGraph(data, source) {
        const g = data && data.graphs ? data.graphs[source] : null;
        return g || null;
    }

    // render by spec
    function renderSpec(canvas, graph, spec) {
        if (!canvas) return;

        if (!graph) {
            destroyChart(canvas);
            setVisible(canvas, false);
            return;
        }

        const mainPack = toLabelsAndY(graph[spec.mainKey]);
        const labels = mainPack.labels;
        const mainY = mainPack.ys;

        if (!labels.length || !mainY.length) {
            destroyChart(canvas);
            setVisible(canvas, false);
            return;
        }

        const ch = ensureChart(canvas, spec.mode);
        ch.data.labels = labels;
        ch.data.datasets[0].data = mainY;

        if (spec.mode === "main_max") {
            const maxY = padToLen(toY(graph[spec.maxKey]), labels.length);
            ch.data.datasets[1].data = maxY;
        } else if (spec.mode === "main_min") {
            const minY = padToLen(toY(graph[spec.minKey]), labels.length);
            ch.data.datasets[1].data = minY;
        }

        ch.update("none");
        setVisible(canvas, true);
    }

    async function refreshRwsCharts(root) {
        const scope = root || document;

        const cNTU = scope.querySelector("#RW_NTU");
        const cCOND = scope.querySelector("#RW_COND");
        const cDO = scope.querySelector("#RW_DO");
        const cTEMP = scope.querySelector("#RW_TEMP");

        // ถ้าไม่มี canvas ครบ ก็ไม่ทำ
        if (!cNTU && !cCOND && !cDO && !cTEMP) return;

        try {
            const data = await fetchOnlineLab(scope);
            const g = pickGraph(data, SOURCE);

            renderSpec(cNTU, g, { mode: "main_max", mainKey: K_NTU, maxKey: K_NTU_MAX });
            renderSpec(cCOND, g, { mode: "main", mainKey: K_COND });
            renderSpec(cDO, g, { mode: "main_min", mainKey: K_DO, minKey: K_DO_MIN });
            renderSpec(cTEMP, g, { mode: "main", mainKey: K_TEMP });

        } catch (e) {
            // fail: hide all
            for (const cv of [cNTU, cCOND, cDO, cTEMP].filter(Boolean)) {
                destroyChart(cv);
                setVisible(cv, false);
            }
        }
    }

    // ============================
    // Public initWithin / destroyWithin
    // ============================
    function initWithin(root) {
        const scope = root || document;

        // กัน bind ซ้ำ
        if (scope._rwsOnlineLabBound === true) return;
        scope._rwsOnlineLabBound = true;

        refreshRwsCharts(scope);

        scope._rwsOnlineLabTimer = setInterval(() => {
            refreshRwsCharts(scope);
        }, POLL_MS);
    }

    function destroyWithin(root) {
        const scope = root || document;

        if (scope._rwsOnlineLabTimer) clearInterval(scope._rwsOnlineLabTimer);
        scope._rwsOnlineLabTimer = null;
        scope._rwsOnlineLabBound = false;

        const c = [
            scope.querySelector("#RW_NTU"),
            scope.querySelector("#RW_COND"),
            scope.querySelector("#RW_DO"),
            scope.querySelector("#RW_TEMP"),
        ].filter(Boolean);

        for (const cv of c) {
            destroyChart(cv);
            setVisible(cv, false);
        }
    }

    window.RWSView = { initWithin, destroyWithin };

})();