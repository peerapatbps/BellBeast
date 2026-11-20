/*
 * MHxIotAlarm.js — IoT alarm feed on MHxView (top-center popup over the page)
 *
 * Separate from bb-alerts.js on purpose: BBAlerts = rule-based, evaluated in the browser per block;
 * this = the alarm engine (Uroboros: anomaly z-score / threshold / lab) exactly as the annunciator devices see it.
 *   GET /api/alarm/active                       level-based state, all zones
 *   GET /api/audio/clip/{id}?format=wav         Thai voice clips (same library as the devices)
 *
 * Rules (same as the device, iot-device_plan.md §3.1/§3.5):
 *   - cleared when active:false or the alarm_id disappears from the list
 *   - engine offline / stale / fetch failure is NOT all-clear: keep the last alarms until ttl_sec
 *   - ack is local to this browser; any user input acks every card on screen
 *   - an alarm_id that ended and comes back active = new event → popup + sound again
 *   - sound once per event (horn + playlist), no reminder
 *   - keeps sounding with the tab hidden / window minimized (Worker tick + audio onended, not main-thread timers)
 *   - mute = bell menu toggle, saved in cookie bb_iotalarm_mute; popups still show while muted
 * Every dynamic string goes through textContent — values come from another service.
 */
(function () {
    "use strict";

    var FEED_URL = "/api/alarm/active";
    var CLIP_URL = "/api/audio/clip/";
    var POLL_MS = 5000;
    var FETCH_TIMEOUT_MS = 4000;
    var ACK_GRACE_MS = 1500;     // ignore input right after a popup appears (in-progress scroll/click)
    var MAX_CARDS = 3;
    var ACK_KEY = "bb.iotalarm.acked.v1";
    var MUTE_COOKIE = "bb_iotalarm_mute";   // "1" = muted; toggled from the bell menu, kept 1 year

    var SEV_RANK = { critical: 3, warning: 2, info: 1 };
    var SEV_TH = { critical: "วิกฤต", warning: "เตือน", info: "แจ้ง" };

    // alarm_id → { a: <alarm object>, confirmedAt: ms, isNew: bool }
    var alarms = new Map();
    var acked = loadAcked();
    var link = { state: "init", mode: null };   // state: ok | engine_offline | engine_stale | unreachable | init
    var shownAt = 0;
    var ui = null;
    var muted = readMuted();

    function readMuted() {
        try {
            return document.cookie.split(";").some(function (c) {
                return c.trim() === MUTE_COOKIE + "=1";
            });
        } catch (e) {
            return false;
        }
    }

    function setMuted(on) {
        muted = !!on;
        try {
            document.cookie = MUTE_COOKIE + "=" + (muted ? "1" : "0") + "; path=/; max-age=31536000; SameSite=Lax";
        } catch (e) { }
        if (muted) {
            stopAll();
        } else {
            armAudio();
            unacked().forEach(announce);   // still-open alarms speak again once unmuted
        }
        render();
    }

    // ---------------------------------------------------------------- storage
    function loadAcked() {
        try {
            var raw = sessionStorage.getItem(ACK_KEY);
            var arr = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(arr) ? arr : []);
        } catch (e) {
            return new Set();
        }
    }

    function saveAcked() {
        try { sessionStorage.setItem(ACK_KEY, JSON.stringify(Array.from(acked))); } catch (e) { }
    }

    // ---------------------------------------------------------------- helpers
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }

    function sevOf(a) {
        var s = String(a.severity || a.horn || "warning").toLowerCase();
        return SEV_RANK[s] ? s : "warning";
    }

    function fmtValue(v) {
        if (v === null || v === undefined || v === "") return "";
        var n = Number(v);
        if (!Number.isFinite(n)) return String(v);
        return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    }

    function fmtTime(iso) {
        if (!iso) return "";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        return d.toLocaleTimeString("th-TH", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function kindLabel(a) {
        var k = String(a.kind || "");
        if (k === "anomaly") {
            var z = Number(a.z);
            return Number.isFinite(z) ? "สถิติ z=" + z.toFixed(1) : "สถิติ";
        }
        if (k === "threshold") return "เกณฑ์";
        if (k === "lab_sample" || String(a.alarm_id || "").indexOf("lab:") === 0) return "แล็บ";
        return k || "alarm";
    }

    // test = value injected from LabVenture /config test mode (Ctrl+Shift+F10) — never a real event
    function isTest(a) { return !!(a && a.test === true); }

    function sorted(list) {
        return list.slice().sort(function (x, y) {
            var t = (isTest(x) ? 1 : 0) - (isTest(y) ? 1 : 0);   // real first, whatever the severity
            if (t) return t;
            var r = (SEV_RANK[sevOf(y)] || 0) - (SEV_RANK[sevOf(x)] || 0);
            if (r) return r;
            return String(x.since || "").localeCompare(String(y.since || ""));
        });
    }

    function current() {
        var out = [];
        alarms.forEach(function (v) { out.push(v.a); });
        return sorted(out);
    }

    function unacked() {
        return current().filter(function (a) { return !acked.has(a.alarm_id); });
    }

    // ---------------------------------------------------------------- feed
    function fetchJson(url) {
        var ctrl = window.AbortController ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS) : null;
        return fetch(url, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .finally(function () { if (timer) clearTimeout(timer); });
    }

    function poll() {
        fetchJson(FEED_URL).then(apply, function () {
            link.state = "unreachable";
            expireUnconfirmed();
            render();
        });
    }

    function apply(feed) {
        var now = Date.now();
        link.mode = feed && feed.alarm_mode ? String(feed.alarm_mode) : null;

        if (!feed || !feed.engine_online || feed.engine_stale) {
            // not authoritative: don't add / remove from the list, only age out by ttl
            link.state = feed && feed.engine_online ? "engine_stale" : "engine_offline";
            expireUnconfirmed();
            render();
            return;
        }
        link.state = "ok";

        var list = Array.isArray(feed.alarms) ? feed.alarms : [];
        var live = new Set();
        var fresh = [];

        list.forEach(function (a) {
            if (!a || !a.alarm_id || a.active !== true) return;
            var id = String(a.alarm_id);
            live.add(id);
            var prev = alarms.get(id);
            alarms.set(id, { a: a, confirmedAt: now });
            if (prev && isTest(prev.a) && !isTest(a)) {      // was a test, now a real value → new event
                if (acked.delete(id)) saveAcked();
                stopFor(id);
                fresh.push(a);
            } else if (!prev && !acked.has(id)) fresh.push(a);
        });

        // active:false or gone from the list → event over; a later re-activation is a new event
        Array.from(alarms.keys()).forEach(function (id) {
            if (!live.has(id)) {
                alarms.delete(id);
                stopFor(id);
            }
        });
        var ackChanged = false;
        Array.from(acked).forEach(function (id) {
            if (!live.has(id)) { acked.delete(id); ackChanged = true; }
        });
        if (ackChanged) saveAcked();

        if (fresh.length) {
            shownAt = now;
            sorted(fresh).forEach(announce);
        }
        render();
    }

    function expireUnconfirmed() {
        var now = Date.now();
        Array.from(alarms.entries()).forEach(function (e) {
            var ttl = Number(e[1].a.ttl_sec);
            var ttlMs = (Number.isFinite(ttl) && ttl > 0 ? ttl : 300) * 1000;
            if (now - e[1].confirmedAt > ttlMs) {
                alarms.delete(e[0]);
                stopFor(e[0]);
            }
        });
    }

    // ---------------------------------------------------------------- ack
    function ackAllShown() {
        var shown = unacked();
        if (!shown.length) return;
        if (Date.now() - shownAt < ACK_GRACE_MS) return;
        shown.forEach(function (a) { acked.add(a.alarm_id); });
        saveAcked();
        stopAll();
        render();
    }

    function onUserInput() {
        armAudio();
        ackAllShown();
    }

    // ---------------------------------------------------------------- sound
    var ctx = null;
    var queue = [];          // alarm objects waiting to be announced
    var playing = null;      // { id, sources: [] }
    // No clip cache on purpose: every announcement downloads its clips fresh and drops them once played.
    // Only the alarm text (cards, from the feed) stays while Uroboros still reports the alarm active, so a clip
    // regenerated in /Admin/AudioLibrary is heard the very next time without reloading the page.

    function audioCtx() {
        var C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        if (!ctx) {
            ctx = new C();
            // fires when the browser lets audio run (first click) or suspends it — redraw + play what is waiting
            ctx.onstatechange = function () { render(); pump(); };
        }
        return ctx;
    }

    function armAudio() {
        var c = audioCtx();
        if (c && c.state === "suspended") {
            c.resume().then(function () { render(); pump(); }, function () { });
        }
    }

    function audioBlocked() {
        var c = audioCtx();
        return !c || c.state !== "running";
    }

    // Fresh from the server every time (no-store: not even the browser HTTP cache). Failure → null → that clip is
    // skipped and the horn still plays.
    function loadClip(id) {
        return fetch(CLIP_URL + encodeURIComponent(id) + "?format=wav", { cache: "no-store" })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.arrayBuffer();
            })
            .then(function (buf) {
                return new Promise(function (res, rej) { audioCtx().decodeAudioData(buf, res, rej); });
            })
            .catch(function () { return null; });
    }

    // horn: square-wave two-tone, clearly different from the BBAlerts sine beep
    function scheduleHorn(c, t0, sev, sources) {
        var pulses = sev === "critical" ? 6 : sev === "warning" ? 3 : 1;
        var t = t0;
        for (var i = 0; i < pulses; i++) {
            var osc = c.createOscillator();
            var gain = c.createGain();
            osc.type = "square";
            osc.frequency.setValueAtTime(i % 2 ? 520 : 760, t);
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
            gain.gain.setValueAtTime(0.07, t + 0.30);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
            osc.connect(gain);
            gain.connect(c.destination);
            osc.start(t);
            osc.stop(t + 0.4);
            sources.push(osc);
            sources.last = osc;
            t += 0.42;
        }
        return t + 0.25;
    }

    function announce(a) {
        if (muted) return;
        queue = queue.filter(function (q) { return q.alarm_id !== a.alarm_id; });
        queue.push(a);
        queue = sorted(queue);
        if (!isTest(a) && playing && playing.test) finish(playing);   // real event cuts a test short
        pump();
    }

    function pump() {
        if (muted) { queue = []; return; }
        if (playing || !queue.length) return;
        if (audioBlocked()) { armAudio(); return; }   // may already be allowed (site setting / earlier click)
        var a = queue.shift();
        if (acked.has(a.alarm_id) || !alarms.has(a.alarm_id)) { pump(); return; }

        var c = audioCtx();
        var token = { id: a.alarm_id, test: isTest(a), sources: [], done: false };
        playing = token;

        var ids = Array.isArray(a.playlist) ? a.playlist.map(String) : [];
        Promise.all(ids.map(loadClip)).then(function (bufs) {
            if (token.done) return;
            var t = scheduleHorn(c, c.currentTime + 0.05, sevOf(a), token.sources);
            bufs.forEach(function (b) {
                if (!b) return;   // missing clip → skip (horn already played)
                var src = c.createBufferSource();
                src.buffer = b;
                src.connect(c.destination);
                src.start(t);
                token.sources.push(src);
                token.sources.last = src;
                t += b.duration;
            });
            // onended is an audio event, so it fires on time even in a hidden tab, where setTimeout
            // can be held back for up to a minute. The timer stays only as a safety net.
            var last = token.sources.last;
            if (last) last.onended = function () { finish(token); };
            var ms = Math.max(0, (t - c.currentTime) * 1000) + 300;
            token.timer = setTimeout(function () { finish(token); }, ms + 2000);
        });
    }

    function finish(token) {
        if (token.done) return;
        token.done = true;
        clearTimeout(token.timer);
        token.sources.forEach(function (s) {
            s.onended = null;
            try { s.stop(); } catch (e) { }
            try { s.disconnect(); } catch (e) { }
            if ("buffer" in s) { try { s.buffer = null; } catch (e) { } }   // drop the played audio
        });
        token.sources = [];
        if (playing === token) playing = null;
        pump();
    }

    function stopFor(id) {
        queue = queue.filter(function (q) { return q.alarm_id !== id; });
        if (playing && playing.id === id) finish(playing);
    }

    function stopAll() {
        queue = [];
        if (playing) finish(playing);
    }

    // ---------------------------------------------------------------- UI
    function ensureStyles() {
        if (document.getElementById("iotAlarmStyle")) return;
        var css = [
            ".iota-pop{position:fixed;left:50%;transform:translateX(-50%);top:56px;z-index:2147483647;",
            "  width:min(560px,calc(100vw - 32px));display:flex;flex-direction:column;gap:8px;pointer-events:none}",
            ".iota-card{pointer-events:auto;border-radius:14px;padding:10px 14px 10px 16px;color:#fff;",
            "  background:linear-gradient(135deg,rgba(28,34,44,.97),rgba(14,18,26,.98));",
            "  border:1px solid rgba(255,255,255,.14);border-left:6px solid var(--iota-c,#ffcc4d);",
            "  box-shadow:0 14px 40px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.25);animation:iota-in .18s ease-out}",
            ".iota-card.critical{--iota-c:var(--red,#ff5b5b);animation:iota-in .18s ease-out,iota-pulse 1.2s ease-in-out infinite}",
            ".iota-card.warning{--iota-c:var(--amber,#ffcc4d)}",
            ".iota-card.info{--iota-c:var(--cyan,#33d1ff)}",
            ".iota-card.test{--iota-c:#c084fc;animation:iota-in .18s ease-out;border-color:rgba(192,132,252,.55);",
            "  background:repeating-linear-gradient(135deg,rgba(40,22,58,.97) 0 14px,rgba(28,16,42,.98) 14px 28px)}",
            ".iota-testbar{margin:2px 0 4px;font-size:13px;font-weight:700;color:#f3e8ff;background:rgba(168,85,247,.28);",
            "  border-radius:8px;padding:3px 8px}",
            ".iota-tag{font-size:10px;font-weight:700;color:#1a0d27;background:#c084fc;border-radius:6px;padding:0 6px;margin-left:6px}",
            ".iota-row.test{--iota-c:#c084fc}",
            ".iota-top{display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,.7)}",
            ".iota-sev{font-weight:700;color:var(--iota-c);letter-spacing:.3px}",
            ".iota-kind{border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:0 8px}",
            ".iota-time{margin-left:auto}",
            ".iota-title{font-size:16px;font-weight:700;margin:4px 0 2px;line-height:1.3}",
            ".iota-val{font-size:20px;font-weight:800;color:var(--iota-c)}",
            ".iota-val small{font-size:13px;font-weight:600;color:rgba(255,255,255,.75);margin-left:6px}",
            ".iota-foot{pointer-events:auto;align-self:center;font-size:12px;color:rgba(255,255,255,.85);",
            "  background:rgba(0,0,0,.55);border-radius:999px;padding:3px 12px}",
            ".iota-mute{color:#ffe3a3}",
            "@keyframes iota-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}",
            "@keyframes iota-pulse{50%{box-shadow:0 14px 40px rgba(0,0,0,.55),0 0 0 3px rgba(255,91,91,.55)}}",
            "#btnIotAlarm{position:relative}",
            "#btnIotAlarm .iota-badge{position:absolute;top:-6px;right:-6px;min-width:16px;height:16px;padding:0 4px;",
            "  border-radius:999px;background:var(--red,#ff5b5b);color:#fff;font-size:10px;font-weight:700;",
            "  display:none;align-items:center;justify-content:center;line-height:16px}",
            "#btnIotAlarm .iota-badge.on{display:flex}",
            "#btnIotAlarm .iota-link{position:absolute;bottom:3px;right:3px;width:7px;height:7px;border-radius:50%;",
            "  background:#9aa4b2;display:none}",
            "#btnIotAlarm .iota-link.on{display:block}",
            ".iota-menu{position:fixed;z-index:2147483646;top:52px;right:12px;width:min(380px,calc(100vw - 32px));",
            "  max-height:60vh;overflow:auto;border-radius:14px;padding:10px;color:#fff;",
            "  background:linear-gradient(180deg,rgba(28,34,44,.98),rgba(14,18,26,.99));",
            "  border:1px solid rgba(255,255,255,.14);box-shadow:0 14px 40px rgba(0,0,0,.5)}",
            ".iota-menu[hidden]{display:none}",
            ".iota-menu h4{margin:0 0 6px;font-size:13px;font-weight:700}",
            ".iota-menu .st{font-size:12px;color:rgba(255,255,255,.7);margin-bottom:8px}",
            ".iota-row{display:flex;gap:8px;align-items:baseline;padding:6px 0;border-top:1px solid rgba(255,255,255,.08);font-size:13px}",
            ".iota-row .d{width:8px;height:8px;border-radius:50%;flex:none;background:var(--iota-c)}",
            ".iota-row.critical{--iota-c:var(--red,#ff5b5b)}.iota-row.warning{--iota-c:var(--amber,#ffcc4d)}.iota-row.info{--iota-c:var(--cyan,#33d1ff)}",
            ".iota-row .t{flex:1;min-width:0}.iota-row .v{color:var(--iota-c);font-weight:700;white-space:nowrap}",
            ".iota-row .k{font-size:11px;color:rgba(255,255,255,.6)}",
            ".iota-empty{font-size:13px;color:rgba(255,255,255,.6);padding:6px 0}",
            ".iota-mutebtn{display:flex;align-items:center;gap:8px;width:100%;margin:0 0 8px;padding:7px 10px;",
            "  border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);",
            "  color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer;text-align:left}",
            ".iota-mutebtn:hover{background:rgba(255,255,255,.14)}",
            ".iota-mutebtn.on{background:rgba(255,91,91,.18);border-color:rgba(255,91,91,.45)}",
            ".iota-mutebtn .s{margin-left:auto;font-size:11px;font-weight:600;color:rgba(255,255,255,.7)}",
            ".iota-snd{font-size:12px;color:#ffe3a3;margin:-4px 0 8px}"
        ].join("\n");
        var s = document.createElement("style");
        s.id = "iotAlarmStyle";
        s.textContent = css;
        document.head.appendChild(s);
    }

    function linkText() {
        switch (link.state) {
            case "ok": return "engine ปกติ" + (link.mode ? " · " + link.mode : "");
            case "engine_stale": return "engine ไม่อัปเดต (เกิน 120 วินาที) — ไม่ใช่สถานะปกติ";
            case "engine_offline": return "engine ไม่ได้เชื่อมต่อ — ไม่มีข้อมูล IoT alarm";
            case "unreachable": return "ติดต่อ BellBeast ไม่ได้";
            default: return "กำลังเชื่อมต่อ…";
        }
    }

    function buildUi() {
        ensureStyles();

        var pop = el("div", "iota-pop");
        pop.setAttribute("role", "alert");
        pop.setAttribute("aria-live", "assertive");
        document.body.appendChild(pop);   // last in body → above .bb-modal-backdrop (same z-index)

        var menu = el("div", "iota-menu");
        menu.hidden = true;
        document.body.appendChild(menu);

        var bell = document.getElementById("btnIotAlarm");
        var badge = null, dot = null, icon = null;
        if (bell) {
            icon = bell.querySelector("span");
            badge = el("i", "iota-badge");
            dot = el("i", "iota-link");
            bell.appendChild(badge);
            bell.appendChild(dot);
            bell.addEventListener("click", function (e) {
                e.stopPropagation();
                menu.hidden = !menu.hidden;
                render();
            });
            bell.addEventListener("keydown", function (e) {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bell.click(); }
            });
        }
        document.addEventListener("click", function (e) {
            if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
        });

        return { pop: pop, menu: menu, bell: bell, badge: badge, dot: dot, icon: icon };
    }

    function card(a, blocked) {
        var sev = sevOf(a);
        var test = isTest(a);
        var c = el("div", "iota-card " + (test ? "test" : sev));

        var top = el("div", "iota-top");
        top.appendChild(el("span", "iota-sev", test ? "สัญญาณทดสอบ · ไม่ใช่เหตุจริง" : "IoT ALARM · " + (SEV_TH[sev] || sev)));
        top.appendChild(el("span", "iota-kind", kindLabel(a)));
        if (a.zone) top.appendChild(el("span", null, String(a.zone)));
        top.appendChild(el("span", "iota-time", fmtTime(a.since)));
        c.appendChild(top);

        if (test) c.appendChild(el("div", "iota-testbar", "🧪 นี่เป็นสัญญาณทดสอบ จาก LabVenture (โหมดทดสอบ)"));
        c.appendChild(el("div", "iota-title", a.title || a.fallback_text || a.alarm_id));

        var v = fmtValue(a.value);
        if (v) {
            var val = el("div", "iota-val", v);
            if (a.unit) val.appendChild(el("small", null, String(a.unit)));
            c.appendChild(val);
        }
        if (muted) c.appendChild(el("div", "iota-top iota-mute", "🔕 ปิดเสียง IoT alarm ไว้ — เปิดได้ที่ปุ่มกระดิ่ง"));
        else if (blocked) c.appendChild(el("div", "iota-top iota-mute", "🔇 เบราว์เซอร์ยังไม่อนุญาตเสียง — คลิกหน้าเว็บหนึ่งครั้งหลังเปิด"));
        return c;
    }

    function render() {
        if (!ui) return;
        var all = current();
        var open = unacked();

        // popup
        ui.pop.textContent = "";
        if (open.length) {
            var blocked = audioBlocked();
            open.slice(0, MAX_CARDS).forEach(function (a) { ui.pop.appendChild(card(a, blocked)); });
            var foot = "แตะหน้าจอ / กดปุ่มใดก็ได้ เพื่อรับทราบ";
            if (open.length > MAX_CARDS) foot = "+" + (open.length - MAX_CARDS) + " รายการ · " + foot;
            if (link.state !== "ok") foot += " · " + linkText();
            ui.pop.appendChild(el("div", "iota-foot", foot));
        }
        placePopup();

        // bell
        var real = all.filter(function (a) { return !isTest(a); }).length;
        var tests = all.length - real;
        if (ui.badge) {
            ui.badge.textContent = real > 99 ? "99+" : real ? String(real) + (tests ? "+T" : "") : (tests ? "T" : "0");
            ui.badge.style.background = real ? "" : (tests ? "#a855f7" : "");
            ui.badge.classList.toggle("on", all.length > 0);
        }
        if (ui.dot) ui.dot.classList.toggle("on", link.state !== "ok" && link.state !== "init");
        // icon = red SVG bell in the markup; muted shows as a slash via #btnIotAlarm.is-muted
        if (ui.bell) {
            ui.bell.classList.toggle("is-muted", muted);
            ui.bell.title = "IoT alarm: " + (real ? real + " รายการ" : "ไม่มี")
                + (tests ? " · สัญญาณทดสอบ " + tests : "") + " · " + linkText()
                + (muted ? " · ปิดเสียงอยู่" : "");
        }

        // dropdown
        if (!ui.menu.hidden) {
            ui.menu.textContent = "";
            ui.menu.appendChild(el("h4", null, "IoT alarm (engine)"));

            var mb = el("button", "iota-mutebtn" + (muted ? " on" : ""), muted ? "🔕 ปิดเสียงอยู่" : "🔔 เสียงเปิดอยู่");
            mb.type = "button";
            mb.setAttribute("aria-pressed", muted ? "true" : "false");
            mb.appendChild(el("span", "s", muted ? "แตะเพื่อเปิดเสียง" : "แตะเพื่อปิดเสียง"));
            mb.addEventListener("click", function (e) {
                e.stopPropagation();   // render() rebuilds the menu; don't let the outside-click handler close it
                setMuted(!muted);
            });
            ui.menu.appendChild(mb);
            if (!muted && audioBlocked()) {
                ui.menu.appendChild(el("div", "iota-snd", "เบราว์เซอร์ยังไม่อนุญาตเสียง — คลิกหน้าเว็บหนึ่งครั้งหลังเปิด"));
            }

            ui.menu.appendChild(el("div", "st", linkText()));
            if (!all.length) {
                ui.menu.appendChild(el("div", "iota-empty", link.state === "ok" ? "ไม่มี alarm" : "ไม่มีข้อมูล"));
            }
            all.forEach(function (a) {
                var row = el("div", "iota-row " + (isTest(a) ? "test" : sevOf(a)));
                row.appendChild(el("span", "d"));
                var t = el("div", "t");
                var tt = el("div", null, a.title || a.alarm_id);
                if (isTest(a)) tt.appendChild(el("span", "iota-tag", "TEST"));
                t.appendChild(tt);
                t.appendChild(el("div", "k", kindLabel(a) + (a.zone ? " · " + a.zone : "") + " · ตั้งแต่ " + fmtTime(a.since)
                    + (acked.has(a.alarm_id) ? " · รับทราบแล้ว" : "")));
                row.appendChild(t);
                var v = fmtValue(a.value);
                if (v) row.appendChild(el("span", "v", v + (a.unit ? " " + a.unit : "")));
                ui.menu.appendChild(row);
            });
        }
    }

    // keep the popup just under the topbar while it is on screen, at the top edge once scrolled away
    var topbar = null;
    function placePopup() {
        if (!ui) return;
        if (!ui.menu.hidden && ui.bell) {
            ui.menu.style.top = Math.max(10, ui.bell.getBoundingClientRect().bottom + 8) + "px";
        }
        if (!ui.pop.firstChild) return;
        topbar = topbar || document.querySelector(".bb-topbar");
        var bottom = topbar ? topbar.getBoundingClientRect().bottom : 48;
        ui.pop.style.top = Math.max(10, bottom + 8) + "px";
    }

    // ---------------------------------------------------------------- start
    function start() {
        ui = buildUi();
        ["pointerdown", "keydown", "touchstart", "wheel"].forEach(function (ev) {
            window.addEventListener(ev, onUserInput, { capture: true, passive: true });
        });
        // the page scrolls on <body> (layout CSS), not window — element scroll events don't bubble, so capture
        document.addEventListener("scroll", placePopup, { capture: true, passive: true });
        window.addEventListener("resize", placePopup);

        // back in front → check right away instead of waiting for the next tick
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible") { armAudio(); poll(); }
        });

        armAudio();   // allowed without a click if the browser/site setting permits autoplay
        keepAwake();
        poll();
        startTicker(poll, POLL_MS);
    }

    // Main-thread timers in a hidden / minimized tab are slowed to once a minute (Chrome, Edge).
    // Timers inside a Worker are not, so the worker only ticks and the poll itself still runs here.
    function startTicker(fn, ms) {
        try {
            var src = "setInterval(function(){postMessage(0)}," + ms + ");";
            var url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
            var w = new Worker(url);
            w.onmessage = fn;
            w.onerror = function () { w.terminate(); setInterval(fn, ms); };
            return;
        } catch (e) { }
        setInterval(fn, ms);
    }

    // Best effort: a page that holds a Web Lock is skipped when the browser freezes background tabs.
    function keepAwake() {
        try {
            if (navigator.locks && navigator.locks.request) {
                navigator.locks.request("bb-iotalarm-keepalive", function () { return new Promise(function () { }); })
                    .catch(function () { });
            }
        } catch (e) { }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
})();
