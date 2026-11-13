/* Alarm Monitor — z-score table + chart for the Uroboros alarm engine.
 * Data (all same-origin, proxied by BellBeast):
 *   GET /api/alarm/monitor           one row per rule: value, mean, sigma, z, k, band, status, reason
 *   GET /api/metrics/history?...     oldest-first series with rolling mean/sigma/z/upper/lower
 *   GET /api/alarm/active?zone=...   alarm feed exactly as a device sees it
 * Every dynamic string goes through textContent (no innerHTML) — values come from another service.
 */
(function () {
    'use strict';

    var MONITOR_MS = 10000, FEED_MS = 5000, CHART_MS = 30000, HIST_N = 120;
    var STATUS_ORDER = { alerting: 0, near: 1, not_ready: 2, stale: 3, no_data: 4, fsnl: 5, normal: 6 };
    var STATUS_TH = {
        alerting: 'กำลังแจ้งเตือน', near: 'ใกล้เกณฑ์', normal: 'ปกติ', not_ready: 'ยังไม่พร้อม',
        fsnl: 'FSNL (อุ่นเครื่อง)', stale: 'ข้อมูลค้าง', no_data: 'ไม่มีข้อมูล'
    };

    var $ = function (id) { return document.getElementById(id); };
    var model = { rules: [], mode: null, startedAt: null, warmupMin: 15 };
    var selected = null;           // rule id
    var valChart = null, zChart = null;

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }

    function getJson(url) {
        return fetch(url, { cache: 'no-store' }).then(function (r) {
            if (r.status === 401 || r.status === 403) { window.location.href = '/Admin/Login'; throw new Error('admin login required'); }
            return r.json().catch(function () { return null; }).then(function (j) {
                if (!r.ok) throw new Error((j && (j.error || j.detail)) || ('HTTP ' + r.status));
                return j;
            });
        });
    }

    function fmt(v, d) {
        if (v === null || v === undefined || isNaN(v)) return '–';
        var a = Math.abs(v);
        var dec = d !== undefined ? d : (a >= 1000 ? 0 : a >= 100 ? 1 : 2);
        return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    }

    function setChip(id, text, cls) {
        var c = $(id);
        c.textContent = text;
        c.className = 'am-chip' + (cls ? ' ' + cls : '');
    }

    function showError(msg) {
        var e = $('amErr');
        if (!msg) { e.style.display = 'none'; return; }
        e.textContent = msg;
        e.style.display = 'block';
    }

    // ── mode / header chips ────────────────────────────────────────────────
    function renderMode() {
        if (!model.mode) { setChip('chipMode', 'mode: –'); return; }
        if (model.mode === 'FSNL') {
            var left = '';
            if (model.startedAt) {
                var end = new Date(model.startedAt).getTime() + model.warmupMin * 60000;
                var s = Math.max(0, Math.round((end - Date.now()) / 1000));
                left = s > 0 ? ' · เหลือ ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : ' · รอ window พร้อม';
            }
            setChip('chipMode', 'FSNL อุ่นเครื่อง' + left, 'warn');
        } else {
            setChip('chipMode', 'SYNC ทำงานเต็ม', 'ok');
        }
    }

    // ── rules table ────────────────────────────────────────────────────────
    function zPosition(r) {
        // map z from [-1.5k, +1.5k] to 0..100 %, band = within ±k
        if (r.kind !== 'anomaly' || r.z === null || r.z === undefined || !r.k) return null;
        var span = 1.5 * r.k;
        var p = (r.z + span) / (2 * span) * 100;
        return Math.max(0, Math.min(100, p));
    }

    function renderRules() {
        var kind = $('kindFilter').value;
        var rows = model.rules.filter(function (r) { return !kind || r.kind === kind; }).slice();
        rows.sort(function (a, b) {
            var sa = STATUS_ORDER[a.status], sb = STATUS_ORDER[b.status];
            if (sa === undefined) sa = 9;
            if (sb === undefined) sb = 9;
            return sa - sb || String(a.title).localeCompare(String(b.title));
        });

        var tb = $('ruleRows');
        tb.textContent = '';
        rows.forEach(function (r) {
            var tr = el('tr', 'am-row' + (r.id === selected ? ' sel' : ''));
            tr.addEventListener('click', function () { select(r.id); });

            var tdDot = el('td');
            tdDot.appendChild(el('span', 'am-dot st-' + r.status));
            tr.appendChild(tdDot);

            var tdName = el('td');
            tdName.appendChild(el('div', null, r.title || r.id));
            tdName.appendChild(el('div', 'am-sub', r.stream + '.' + r.param));
            tr.appendChild(tdName);

            tr.appendChild(el('td', null, r.zone || ''));
            tr.appendChild(el('td', null, r.kind === 'anomaly' ? 'anomaly' : 'threshold ' + (r.op || '') + ' ' + fmt(r.limit)));
            tr.appendChild(el('td', 'num', r.value === null || r.value === undefined ? '–' : fmt(r.value) + (r.unit ? ' ' + r.unit : '')));

            var zTxt = r.kind === 'anomaly' ? fmt(r.z, 2) + (r.k ? '  / ±' + fmt(r.k, 1) : '') : '–';
            tr.appendChild(el('td', 'num', zTxt));

            var tdBar = el('td');
            var pos = zPosition(r);
            if (pos !== null) {
                var bar = el('div', 'am-zbar' + (r.status === 'alerting' ? ' alert' : r.status === 'near' ? ' near' : ''));
                var band = el('div', 'band');
                band.style.left = (100 / 3) + '%';
                band.style.width = (100 / 3) + '%';
                var mk = el('div', 'mk');
                mk.style.left = pos + '%';
                bar.appendChild(band);
                bar.appendChild(mk);
                tdBar.appendChild(bar);
            }
            tr.appendChild(tdBar);

            tr.appendChild(el('td', null, STATUS_TH[r.status] || r.status));
            tr.appendChild(el('td', 'reason', r.reason || ''));
            tb.appendChild(tr);
        });
        if (!rows.length) {
            var tr0 = el('tr');
            var td0 = el('td', 'am-hint', 'ไม่มี rule ที่เปิดอยู่ (ตรวจ alarm_rules.json บน Uroboros)');
            td0.colSpan = 9;
            tr0.appendChild(td0);
            tb.appendChild(tr0);
        }
    }

    function refreshMonitor() {
        return getJson('/api/alarm/monitor').then(function (j) {
            model.rules = j.rules || [];
            model.mode = j.alarm_mode;
            model.startedAt = j.started_at;
            model.warmupMin = j.warmup_minutes || 15;
            showError('');
            renderMode();
            renderRules();
            setChip('chipUpdated', 'อัปเดต ' + new Date().toLocaleTimeString('th-TH'), '');
        }).catch(function (e) {
            showError('อ่านข้อมูลจาก Uroboros ไม่ได้: ' + e.message);
            setChip('chipUpdated', 'ขาดการเชื่อมต่อ', 'bad');
        });
    }

    // ── active alarms (device view) ────────────────────────────────────────
    function refreshFeed() {
        var zone = $('zoneFilter').value.trim();
        var url = '/api/alarm/active' + (zone ? '?zone=' + encodeURIComponent(zone) : '');
        return getJson(url).then(function (j) {
            if (!j.engine_online) setChip('chipEngine', 'engine: ไม่ได้เชื่อมต่อ room', 'bad');
            else if (j.engine_stale) setChip('chipEngine', 'engine: ค้าง ' + j.age_sec + 's', 'bad');
            else setChip('chipEngine', 'engine: ส่งล่าสุด ' + j.age_sec + 's ที่แล้ว', 'ok');

            setChip('chipActive', 'active: ' + j.active_count, j.active_count > 0 ? 'bad' : 'ok');

            var box = $('activeBox');
            box.textContent = '';
            var alarms = j.alarms || [];
            if (!alarms.length) {
                box.appendChild(el('div', 'am-active-empty',
                    j.engine_stale ? 'ไม่มีข้อมูลจาก engine (ดูสถานะ engine ด้านบน)' : 'ไม่มี alarm — ปกติ'));
                return;
            }
            alarms.forEach(function (a) {
                var row = el('div', 'am-active-item' + (a.active ? '' : ' cleared'));
                row.appendChild(el('span', 'am-dot ' + (a.active ? 'st-alerting' : 'st-normal')));

                var mid = el('div');
                mid.appendChild(el('div', 't', (a.title || a.alarm_id) + (a.active ? '' : '  (จบแล้ว)')));
                var meta = [a.kind, a.zone, a.severity, a.since ? 'ตั้งแต่ ' + a.since : '']
                    .filter(Boolean).join(' · ');
                if (a.z !== null && a.z !== undefined) meta += ' · z=' + fmt(a.z, 2);
                mid.appendChild(el('div', 'm', meta));
                if (a.fallback_text) mid.appendChild(el('div', 'm', a.fallback_text));
                row.appendChild(mid);

                row.appendChild(el('div', 'v', fmt(a.value) + (a.unit ? ' ' + a.unit : '')));
                box.appendChild(row);
            });
        }).catch(function (e) {
            setChip('chipEngine', 'engine: อ่านไม่ได้', 'bad');
            showError('อ่าน alarm feed ไม่ได้: ' + e.message);
        });
    }

    // ── chart ──────────────────────────────────────────────────────────────
    function select(id) {
        selected = id;
        renderRules();
        refreshChart();
    }

    function lineDs(label, data, color, opts) {
        return Object.assign({
            label: label, data: data, borderColor: color, backgroundColor: color,
            borderWidth: 1.5, pointRadius: 0, tension: 0.15, spanGaps: true
        }, opts || {});
    }

    function refreshChart() {
        var r = model.rules.filter(function (x) { return x.id === selected; })[0];
        if (!r) return Promise.resolve();

        $('chartTitle').textContent = 'กราฟ — ' + (r.title || r.id) + '  (' + r.stream + '.' + r.param + ')';
        var url = '/api/metrics/history?stream=' + encodeURIComponent(r.stream) +
                  '&param=' + encodeURIComponent(r.param) + '&n=' + HIST_N;

        return getJson(url).then(function (h) {
            var pts = h.points || [];
            if (!pts.length) {
                $('chartBox').style.display = 'none';
                $('chartHint').style.display = 'block';
                $('chartHint').textContent = 'ยังไม่มีประวัติของจุดนี้ใน history.db (task metric.history.sample ทำงานอยู่หรือไม่?)';
                return;
            }
            $('chartHint').style.display = 'none';
            $('chartBox').style.display = 'grid';

            var labels = pts.map(function (p) { return p.ts.substr(11, 8); });
            var vals = pts.map(function (p) { return p.value; });
            var anomaly = r.kind === 'anomaly';

            var ds = [lineDs('ค่า' + (r.unit ? ' (' + r.unit + ')' : ''), vals, '#38bdf8', { borderWidth: 2 })];
            if (anomaly) {
                ds.push(lineDs('mean', pts.map(function (p) { return p.mean; }), '#94a3b8', { borderDash: [5, 4] }));
                ds.push(lineDs('+kσ', pts.map(function (p) { return p.upper; }), 'rgba(34,197,94,.7)'));
                ds.push(lineDs('−kσ', pts.map(function (p) { return p.lower; }), 'rgba(34,197,94,.7)',
                    { fill: '-1', backgroundColor: 'rgba(34,197,94,.10)' }));
            } else if (r.limit !== null && r.limit !== undefined) {
                ds.push(lineDs('limit ' + (r.op || ''), vals.map(function () { return r.limit; }), '#ef4444', { borderDash: [6, 4] }));
            }

            if (valChart) valChart.destroy();
            valChart = new Chart($('valChart'), {
                type: 'line',
                data: { labels: labels, datasets: ds },
                options: chartOptions()
            });

            var zBox = $('zBox');
            if (zChart) { zChart.destroy(); zChart = null; }
            if (anomaly && h.rule) {
                zBox.style.display = 'block';
                var k = h.rule.k || r.k || 2;
                zChart = new Chart($('zChart'), {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [
                            lineDs('z', pts.map(function (p) { return p.z; }), '#f472b6', { borderWidth: 2 }),
                            lineDs('+k', labels.map(function () { return k; }), 'rgba(239,68,68,.8)', { borderDash: [5, 4] }),
                            lineDs('−k', labels.map(function () { return -k; }), 'rgba(239,68,68,.8)', { borderDash: [5, 4] })
                        ]
                    },
                    options: chartOptions()
                });
            } else {
                zBox.style.display = 'none';
            }
        }).catch(function (e) {
            showError('อ่านกราฟไม่ได้: ' + e.message);
        });
    }

    function chartOptions() {
        return {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: '#cbd5e1', boxWidth: 12 } } },
            scales: {
                x: { ticks: { color: '#94a3b8', maxTicksLimit: 8 }, grid: { color: 'rgba(148,163,184,.08)' } },
                y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,.12)' } }
            }
        };
    }

    // ── boot ───────────────────────────────────────────────────────────────
    $('kindFilter').addEventListener('change', renderRules);
    $('zoneFilter').addEventListener('change', refreshFeed);

    refreshMonitor();
    refreshFeed();
    setInterval(refreshMonitor, MONITOR_MS);
    setInterval(refreshFeed, FEED_MS);
    setInterval(function () { if (selected) refreshChart(); }, CHART_MS);
    setInterval(renderMode, 1000);   // FSNL countdown
})();
