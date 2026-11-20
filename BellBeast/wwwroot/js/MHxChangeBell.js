/*
 * MHxChangeBell.js — กระดิ่งน้ำเงินบน topbar หน้า Main (#btnChangeBell)
 * "การเปลี่ยนแปลงวันนี้" ตั้งแต่ 00:00:
 *   1) รับคลอรีน  2) ส่งคืนคลอรีน  3) ยกคลอรีน (ยกขึ้น / ยกลง)   ← remark CDS สถานี 15 (เฟส 1-2), 62 (เฟส 3-4)
 *   4) รับ PACl   5) รับ Alum                                    ← /api/chem_report (เที่ยวรถ, ไม่นับล้างถัง)
 * badge = จำนวนรายการทั้งหมดของวันนี้ (ไม่เคลียร์เมื่อเปิดดู, เริ่มใหม่ตอนเที่ยงคืน)
 */
(function () {
    "use strict";

    var EVENT_PATH = "/api/event/summary";
    var CHEM_PATH = "/api/chem_report";
    var POLL_MS = 120000;
    var TIMEOUT_MS = 15000;
    var DUMMY_PREFIX = "ZZ";            // AquadatRemarkHelper.DummyUnloadPrefix — เลขหลอกตอนเขียนแค่ "ยกขึ้น"

    var STATIONS = [
        { id: 15, name: "CDS เฟส 1-2", short: "เฟส 1-2" },
        { id: 62, name: "CDS เฟส 3-4", short: "เฟส 3-4" }
    ];

    var state = {
        cl: null,          // { Rec:{15:[ids],62:[ids]}, Ret:..., Tiu:..., Unl:... } — ids รวมเลขหลอก
        clErr: false,
        trips: null,       // { PACL:[trip], ALUM:[trip] }
        chemErr: false,
        at: null,
        day: ""
    };

    // ------------------------------------------------------------ utils
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function pad(n) { return (n < 10 ? "0" : "") + n; }
    function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
    function hhmm(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }

    /** "yyyy-MM-dd HH:mm[:ss]" → "HH:mm" */
    function timeOf(s) {
        var m = /(\d{1,2}):(\d{2})/.exec(String(s || "").slice(10));
        return m ? pad(+m[1]) + ":" + m[2] : "";
    }

    function apiUrl(path) { return location.origin + path; }

    async function fetchJson(url, opt) {
        var ac = new AbortController();
        var t = setTimeout(function () { ac.abort(); }, TIMEOUT_MS);
        try {
            var r = await fetch(url, Object.assign({ cache: "no-store", signal: ac.signal }, opt || {}));
            if (!r.ok) throw new Error("HTTP " + r.status);
            return await r.json();
        } finally {
            clearTimeout(t);
        }
    }

    // ------------------------------------------------------------ data
    function emptyCl() {
        var o = {};
        ["Rec", "Ret", "Tiu", "Unl"].forEach(function (k) {
            o[k] = {};
            STATIONS.forEach(function (s) { o[k][s.id] = []; });
        });
        return o;
    }

    /** RemarkDetail (เลขถังรายตัว) ถ้ามี, ไม่งั้นใช้ RemarkSummary (แค่จำนวน — Uroboros รุ่นเก่า) */
    function parseChlorine(j) {
        var cl = emptyCl();
        var detail = j && Array.isArray(j.RemarkDetail) ? j.RemarkDetail : null;
        if (detail) {
            detail.forEach(function (x) {
                var bucket = cl[x && x.type] && cl[x.type][x.station_id];
                if (bucket) bucket.push(String(x.value || ""));
            });
            return cl;
        }
        (j && j.RemarkSummary || []).forEach(function (x) {
            if (!cl[x && x.type]) return;
            STATIONS.forEach(function (s) {
                var n = Number(x["station_" + s.id]) || 0;
                for (var i = 0; i < n; i++) cl[x.type][s.id].push(DUMMY_PREFIX);   // นับได้ ไม่มีเลขถัง
            });
        });
        return cl;
    }

    function parseTrips(j) {
        var out = { PACL: [], ALUM: [] };
        (j && j.rows || []).forEach(function (r) {
            var chem = String(r.Chemical || "").toUpperCase();
            if (!out[chem] || r.IsWash) return;
            var tanks = [];
            (r.Fills || []).forEach(function (f) {
                var t = String(f.Tank || "").trim();
                if (t && tanks.indexOf(t) < 0) tanks.push(t);
            });
            out[chem].push({
                time: timeOf(r.DoneAt) || String(r.Time || "").slice(0, 5),
                company: String(r.Company || "").trim(),
                tonnes: (Number(r.NetWeight) || 0) / 1000,
                tanks: tanks
            });
        });
        Object.keys(out).forEach(function (k) {
            out[k].sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
        });
        return out;
    }

    async function refresh() {
        var now = new Date();
        var today = ymd(now);
        if (state.day !== today) {                 // ข้ามเที่ยงคืน: ล้างของเมื่อวาน
            state.cl = null; state.trips = null; state.day = today;
        }

        var jobs = [
            fetchJson(apiUrl(EVENT_PATH)).then(function (j) {
                if (!j || j.ok !== true) throw new Error("event summary not ok");
                state.cl = parseChlorine(j); state.clErr = false;
            }).catch(function () { state.clErr = true; }),

            fetchJson(apiUrl(CHEM_PATH), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ startDate: today, endDate: today, dateField: "DAYOUT" })
            }).then(function (j) {
                if (!j || j.ok !== true) throw new Error("chem_report not ok");
                state.trips = parseTrips(j); state.chemErr = false;
            }).catch(function () { state.chemErr = true; })
        ];

        await Promise.all(jobs);
        state.at = new Date();
        render();
    }

    /** คลอรีนนับเป็น "เหตุการณ์": 1 ต่อ (ประเภท, สถานี) ที่มีถังอย่างน้อย 1 — ไม่ใช่จำนวนถัง */
    function countClEvents(type) {
        if (!state.cl) return 0;
        return STATIONS.reduce(function (n, s) { return n + (state.cl[type][s.id].length ? 1 : 0); }, 0);
    }

    /** badge = เหตุการณ์คลอรีน + เที่ยวรถ PACl/Alum */
    function total() {
        var n = countClEvents("Rec") + countClEvents("Ret") + countClEvents("Tiu") + countClEvents("Unl");
        if (state.trips) n += state.trips.PACL.length + state.trips.ALUM.length;
        return n;
    }

    // ------------------------------------------------------------ UI
    var ui = null;

    function ensureStyles() {
        if (document.getElementById("chgBellStyle")) return;
        var css = [
            "#btnChangeBell .chg-badge{position:absolute;top:-6px;right:-6px;min-width:16px;height:16px;padding:0 4px;",
            "  border-radius:999px;background:#2f7fe0;color:#fff;font-size:10px;font-weight:700;",
            "  display:none;align-items:center;justify-content:center;line-height:16px}",
            "#btnChangeBell .chg-badge.on{display:flex}",
            ".chg-menu{position:fixed;z-index:2147483646;top:52px;right:12px;width:min(400px,calc(100vw - 32px));",
            "  max-height:70vh;overflow:auto;border-radius:14px;padding:10px 12px;color:#fff;font-size:13px;",
            "  background:linear-gradient(180deg,rgba(28,34,44,.98),rgba(14,18,26,.99));",
            "  border:1px solid rgba(77,163,255,.35);box-shadow:0 14px 40px rgba(0,0,0,.5)}",
            ".chg-menu[hidden]{display:none}",
            ".chg-hd{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}",
            ".chg-hd h4{margin:0;font-size:14px;font-weight:700}",
            ".chg-hd .at{margin-left:auto;font-size:11px;color:rgba(255,255,255,.6)}",
            ".chg-sec{border-top:1px solid rgba(255,255,255,.08);padding:6px 0}",
            ".chg-sec>b{display:block;font-weight:700;color:#9ccbff;margin-bottom:2px}",
            ".chg-row{display:flex;gap:8px;align-items:baseline;padding:2px 0}",
            ".chg-row .s{width:86px;flex:none;color:rgba(255,255,255,.7)}",
            ".chg-row .n{width:22px;flex:none;font-weight:700;color:#4da3ff;text-align:right}",
            ".chg-row .n.z{color:rgba(255,255,255,.35)}",
            ".chg-row .d{min-width:0;color:rgba(255,255,255,.75);overflow-wrap:anywhere}",
            ".chg-row .d.ids{font-family:ui-monospace,Consolas,monospace;font-size:12px}",
            ".chg-row .d.mute{color:rgba(255,255,255,.45)}",
            ".chg-err{font-size:12px;color:#ffd99a;padding:2px 0}"
        ].join("\n");
        var s = document.createElement("style");
        s.id = "chgBellStyle";
        s.textContent = css;
        document.head.appendChild(s);
    }

    function buildUi() {
        var bell = document.getElementById("btnChangeBell");
        if (!bell) return null;
        ensureStyles();

        var badge = el("i", "chg-badge");
        bell.appendChild(badge);

        var menu = el("div", "chg-menu");
        menu.hidden = true;
        menu.setAttribute("role", "dialog");
        menu.setAttribute("aria-label", "การเปลี่ยนแปลงวันนี้");
        document.body.appendChild(menu);

        bell.addEventListener("click", function (e) {
            e.stopPropagation();
            menu.hidden = !menu.hidden;
            if (!menu.hidden) closeIotMenu();
            if (!menu.hidden) {                    // วางใต้กระดิ่ง (topbar อยู่ใต้ nav ของ layout)
                var rc = bell.getBoundingClientRect();
                menu.style.top = Math.round(rc.bottom + 6) + "px";
                menu.style.right = Math.max(8, Math.round(window.innerWidth - rc.right)) + "px";
            }
            render();
            if (!menu.hidden) refresh();
        });
        bell.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bell.click(); }
        });
        document.addEventListener("click", function (e) {
            if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") menu.hidden = true;
        });

        // กดกระดิ่งแดง (IoT) → ปิดเมนูน้ำเงิน (IoT หยุด propagation ที่ตัวกระดิ่ง จึงต้องฟังที่ปุ่มเอง)
        var iot = document.getElementById("btnIotAlarm");
        if (iot) iot.addEventListener("click", function () { menu.hidden = true; });

        return { bell: bell, badge: badge, menu: menu };
    }

    /** เมนู IoT (MHxIotAlarm.js) — ปิดเมื่อเปิดเมนูน้ำเงิน ให้แสดงทีละอัน */
    function closeIotMenu() {
        var m = document.querySelector(".iota-menu");
        if (m) m.hidden = true;
    }

    function row(label, n, detail, cls) {
        var r = el("div", "chg-row");
        r.appendChild(el("span", "s", label));
        r.appendChild(el("span", "n" + (n ? "" : " z"), String(n)));
        r.appendChild(el("span", "d " + (cls || ""), detail));
        return r;
    }

    function idsText(ids) {
        var real = ids.filter(function (v) { return v && v.indexOf(DUMMY_PREFIX) !== 0; });
        if (!ids.length) return { t: "—", c: "mute" };
        if (!real.length) return { t: "ไม่ระบุเลขถัง", c: "mute" };
        var t = real.join(" ");
        if (real.length < ids.length) t += " · ไม่ระบุเลข " + (ids.length - real.length);
        return { t: t, c: "ids" };
    }

    function clSection(title, types) {
        var sec = el("div", "chg-sec");
        sec.appendChild(el("b", null, title));
        if (!state.cl) {
            sec.appendChild(el("div", "chg-err", state.clErr ? "โหลด remark CDS ไม่ได้" : "กำลังโหลด…"));
            return sec;
        }
        STATIONS.forEach(function (s) {
            types.forEach(function (tp) {
                var ids = state.cl[tp.key][s.id];
                var x = idsText(ids);
                sec.appendChild(row(tp.label ? s.short + " " + tp.label : s.name, ids.length, x.t, x.c));
            });
        });
        return sec;
    }

    function chemSection(title, key) {
        var sec = el("div", "chg-sec");
        sec.appendChild(el("b", null, title));
        if (!state.trips) {
            sec.appendChild(el("div", "chg-err", state.chemErr ? "โหลดข้อมูลรถสารเคมีไม่ได้" : "กำลังโหลด…"));
            return sec;
        }
        var list = state.trips[key];
        if (!list.length) {
            sec.appendChild(row("—", 0, "ยังไม่มีวันนี้", "mute"));
            return sec;
        }
        list.forEach(function (t) {
            var parts = ["1 คัน", t.tonnes.toFixed(1) + " ตัน"];
            if (t.tanks.length) parts.push("ถัง " + t.tanks.join(" "));
            sec.appendChild(row(t.time || "—", 1, parts.join(" · ")));
        });
        return sec;
    }

    function render() {
        if (!ui) return;
        var n = total();
        ui.badge.textContent = n > 99 ? "99+" : String(n);
        ui.badge.classList.toggle("on", n > 0);
        ui.bell.title = "การเปลี่ยนแปลงวันนี้: " + (n ? n + " รายการ" : "ไม่มี")
            + (state.clErr || state.chemErr ? " · โหลดข้อมูลบางส่วนไม่ได้" : "");

        if (ui.menu.hidden) return;
        var m = ui.menu;
        m.textContent = "";

        var hd = el("div", "chg-hd");
        hd.appendChild(el("h4", null, "การเปลี่ยนแปลงวันนี้"));
        hd.appendChild(el("span", "at", state.at ? "อัปเดต " + hhmm(state.at) : "กำลังโหลด…"));
        m.appendChild(hd);

        m.appendChild(clSection("รับคลอรีน", [{ key: "Rec" }]));
        m.appendChild(clSection("ส่งคืนคลอรีน", [{ key: "Ret" }]));
        m.appendChild(clSection("ยกคลอรีน", [{ key: "Tiu", label: "ขึ้น" }, { key: "Unl", label: "ลง" }]));
        m.appendChild(chemSection("รับ PACl", "PACL"));
        m.appendChild(chemSection("รับ Alum", "ALUM"));
    }

    function start() {
        ui = buildUi();
        if (!ui) return;
        render();
        refresh();
        setInterval(refresh, POLL_MS);
    }

    // export ไว้ทดสอบ
    window.MHxChangeBell = { parseChlorine: parseChlorine, parseTrips: parseTrips, refresh: refresh, _state: state };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
