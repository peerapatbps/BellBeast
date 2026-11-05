// /Admin/Annunciator — จอจำลอง annunciator 240×240 ด้วยข้อมูลจริง
// ใช้ endpoint และกฎเดียวกับ firmware ann-1.2.0 (iot\Re-plan\iot-device_scenario_home0511.md):
//   alarm   GET /api/alarm/active?zone=   ทุก 5 วิ (level-based: ใหม่ = ดัง, หาย/active:false = จบ)
//   สถานการณ์ GET /api/device/lab/scenario ทุก 30 วิ (rev เปลี่ยน = ดึงผลแล็บทันที + กรอบส้ม 10 วิ)
//   ผลแล็บ   GET /api/device/lab/glance    ทุก 5 นาที + ทันทีเมื่อ alarm แล็บใหม่ / เปิดหน้าแล็บ (เก่ากว่า 60 วิ)
// การรับทราบอยู่ในแท็บนี้เท่านั้น (sessionStorage) — ไม่ส่งไปไหน
(function () {
    "use strict";

    const FEED_MS = 5000, SCN_MS = 30000, LAB_MS = 300000, LAB_FRESH_MS = 60000, CACHE_WAIT_MS = 65000, FOLLOW_MAX = 3;
    const REMIND_MS = 60000, REMIND_LAB_MS = 300000, IDLE_HOME_MS = 60000, CHG_MS = 10000, SERVER_LOST_MS = 30000;
    const ROWS = ["CW T", "CW CL", "FW T", "TW CL"];
    const GROUP_NAMES = ["CW Turbid", "CW Pre CL", "FW Turbid", "TW Turbid", "TW Post CL"];
    const SEV = { critical: 3, warning: 2, info: 1 };
    const ACK_KEY = "bb.annsim.acked.v1", ZONE_KEY = "bb.annsim.zones.v1";

    const $ = (id) => document.getElementById(id);
    const S = $("anScr");
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const fmt = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? "--" : String(+Number(v).toFixed(2));
    const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("th-TH", { hour12: false, hour: "2-digit", minute: "2-digit" }); };
    const ls = { get(k, d) { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { } } };

    // ---------------------------------------------------------------- state
    const st = {
        page: "home", prevPage: "home", g: 4, u: 0, lastTap: Date.now(),
        link: "init", mode: "", feedAt: 0, feedOkAt: 0, engineAge: null,
        alarms: new Map(),        // id -> { a, acked, since, instance, nextSay }
        acked: new Set(ls.get(ACK_KEY, [])),
        lab: null, labAt: 0, labErr: "", nextLab: 0, follow: 0, baseSample: "",
        scn: null, scnAt: 0, scnStale: false, knownRev: -1,
        chg: new Set(), chgUntil: 0, prevStatus: "", prevRev: -1,
        sound: false, zones: localStorage.getItem(ZONE_KEY) || "",
    };

    function log(msg, cls) {
        const box = $("logBox");
        const line = document.createElement("div");
        if (cls) line.className = cls;
        line.innerHTML = `<span class="t">${new Date().toLocaleTimeString("th-TH", { hour12: false })}</span> ${esc(msg)}`;
        box.prepend(line);
        while (box.childNodes.length > 200) box.lastChild.remove();
    }

    async function getJson(url, timeoutMs = 15000) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
            if (!r.ok) throw new Error("HTTP " + r.status);
            return await r.json();
        } finally { clearTimeout(t); }
    }

    // ---------------------------------------------------------------- alarm feed (5 s)
    const isTest = (a) => a && a.test === true;
    const isLab = (a) => a && a.kind === "lab_sample";
    const sevOf = (a) => SEV[String(a.severity || a.horn || "warning").toLowerCase()] ? String(a.severity || a.horn).toLowerCase() : "warning";

    async function pollFeed() {
        const url = "/api/alarm/active" + (st.zones ? "?zone=" + encodeURIComponent(st.zones) : "");
        let feed = null;
        try { feed = await getJson(url, 4000); } catch (e) { /* below */ }
        const now = Date.now();
        st.feedAt = now;
        let labNew = false;
        if (!feed) {
            if (now - st.feedOkAt > SERVER_LOST_MS && st.link !== "unreachable") { st.link = "unreachable"; log("ติดต่อ BellBeast ไม่ได้", "e"); }
        } else {
            st.feedOkAt = now;
            const auth = feed.engine_online && !feed.engine_stale;
            const link = auth ? "ok" : (feed.engine_online ? "engine_stale" : "engine_offline");
            if (link !== st.link) log("ลิงก์ engine: " + link, link === "ok" ? null : "w");
            st.link = link; st.mode = feed.alarm_mode || ""; st.engineAge = feed.age_sec;
            if (auth) {
                const live = new Set();
                for (const a of (feed.alarms || [])) {
                    if (!a || !a.alarm_id || a.active !== true) continue;
                    const id = String(a.alarm_id);
                    live.add(id);
                    const prev = st.alarms.get(id);
                    if (!prev) {
                        st.alarms.set(id, { a, acked: st.acked.has(id), nextSay: 0, first: now });
                        log(`RAISE ${a.title || id}${isTest(a) ? " [TEST]" : ""}`, "w");
                        if (isLab(a) && !isTest(a)) labNew = true;
                    } else {
                        if (isTest(prev.a) && !isTest(a)) {             // ค่าทดสอบ -> ค่าจริง = เหตุการณ์ใหม่
                            prev.acked = false; st.acked.delete(id); prev.nextSay = 0;
                            log(`${a.title || id}: ค่าทดสอบ -> ค่าจริง (เหตุการณ์ใหม่)`, "w");
                            if (isLab(a)) labNew = true;
                        } else if (isLab(a) && !isTest(a) && a.value !== prev.a.value) labNew = true;   // ตัวอย่างแล็บรอบใหม่
                        prev.a = a;
                    }
                }
                for (const id of [...st.alarms.keys()]) {
                    if (!live.has(id)) { log(`CLEAR ${st.alarms.get(id).a.title || id}`); st.alarms.delete(id); st.acked.delete(id); }
                }
                ls.set(ACK_KEY, [...st.acked]);
            }
        }
        if (labNew) { log("alarm แล็บใหม่ -> ดึงผลแล็บทันที (ไม่รอ 5 นาที)"); st.follow = FOLLOW_MAX; st.baseSample = st.lab?.sample || ""; fetchLab("alarm"); }
        sayPending();
        render();
    }

    // ---------------------------------------------------------------- scenario (30 s)
    async function pollScenario() {
        try {
            const s = await getJson("/api/device/lab/scenario", 10000);
            if (!s.ok) throw new Error(s.error || "not ok");
            const changed = st.knownRev >= 0 && s.rev !== st.knownRev;
            st.scn = s; st.scnAt = Date.now(); st.scnStale = false;
            if (st.knownRev < 0) st.knownRev = s.rev;
            if (changed) {
                log(`สถานการณ์เปลี่ยน rev ${st.knownRev} -> ${s.rev}: ${s.name}${s.epidemic ? " · โรคระบาด" : ""} -> ดึงผลแล็บทันที`, "w");
                fetchLab("scenario");
            }
        } catch (e) {
            if (!st.scnStale) log("เช็กสถานการณ์ไม่ได้: " + e.message, "e");
            st.scnStale = true;
        }
        render();
    }

    // ---------------------------------------------------------------- lab glance (5 min + triggers)
    let labBusy = false;
    async function fetchLab(why) {
        if (labBusy) return;
        labBusy = true;
        try {
            const g = await getJson("/api/device/lab/glance", 90000);
            if (!g.ok) throw new Error("ok:false");
            // สถานการณ์เปลี่ยน -> จำช่องที่สีเปลี่ยน (กรอบส้ม 10 วิ)
            const status = (g.dots || []).map((d) => d.s).join("") || g.status || "";
            if (st.prevRev >= 0 && g.scenario_rev !== st.prevRev && st.prevStatus) {
                st.chg = new Set([...status].map((c, i) => c !== st.prevStatus[i] ? i : -1).filter((i) => i >= 0));
                st.chgUntil = Date.now() + CHG_MS;
                setTimeout(render, CHG_MS + 50);
            }
            st.prevRev = g.scenario_rev; st.prevStatus = status;
            st.lab = g; st.labAt = Date.now(); st.labErr = ""; st.knownRev = g.scenario_rev;
            let next = LAB_MS;
            if (st.follow > 0) {
                if (g.sample && g.sample > st.baseSample) st.follow = 0;
                else if (--st.follow > 0) { next = CACHE_WAIT_MS; log(`ผลแล็บยังเป็นรอบ ${g.hm} -> ดึงซ้ำใน 65 วิ`); }
            }
            st.nextLab = Date.now() + next;
            if (why !== "timer") log(`ผลแล็บ ${g.hm} · ${g.limits === "fallback" ? "เกณฑ์สำรอง" : g.scenario} rev ${g.scenario_rev} (${why})`);
        } catch (e) {
            st.labErr = e.message; st.nextLab = Date.now() + 30000;
            log("ดึงผลแล็บไม่ได้: " + e.message, "e");
        } finally { labBusy = false; }
        render();
    }

    // ---------------------------------------------------------------- sound (optional — like the device: horn + playlist, reminders)
    let ctx = null, speaking = null;
    function audio() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === "suspended") ctx.resume(); return ctx; }
    function horn(c, t0, sev) {
        const n = sev === "critical" ? 6 : sev === "warning" ? 3 : 1; let t = t0;
        for (let i = 0; i < n; i++) {
            const o = c.createOscillator(), g = c.createGain();
            o.type = "square"; o.frequency.setValueAtTime(i % 2 ? 520 : 760, t);
            g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.02); g.gain.setValueAtTime(0.06, t + 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
            o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.4); t += 0.42;
        }
        return t + 0.25;
    }
    async function speak(rec) {
        const a = rec.a, c = audio(), token = { stop: false, src: [] };
        speaking = token;
        const ids = Array.isArray(a.playlist) ? a.playlist : [];
        const bufs = await Promise.all(ids.map((id) => fetch("/api/audio/clip/" + encodeURIComponent(id) + "?format=wav", { cache: "no-store" })
            .then((r) => r.ok ? r.arrayBuffer() : null).then((b) => b ? c.decodeAudioData(b) : null).catch(() => null)));
        if (token.stop) return;
        let t = horn(c, c.currentTime + 0.05, sevOf(a));
        for (const b of bufs) { if (!b) continue; const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(t); token.src.push(s); t += b.duration; }
        setTimeout(() => { if (speaking === token) speaking = null; sayPending(); }, Math.max(0, (t - c.currentTime) * 1000) + 300);
    }
    function stopSound() { if (speaking) { speaking.stop = true; speaking.src.forEach((s) => { try { s.stop(); } catch { } }); speaking = null; } }
    function sayPending() {
        const now = Date.now();
        const due = ordered().filter((r) => !r.acked && r.nextSay <= now);
        if (!due.length) return;
        const r = due[0];
        r.nextSay = now + (isLab(r.a) ? REMIND_LAB_MS : REMIND_MS);
        $("sayBox").textContent = (isTest(r.a) ? "[สัญญาณทดสอบ]\n" : "") + "horn " + sevOf(r.a) + "\n" + (r.a.fallback_text || r.a.title || r.a.alarm_id) + "\nclip: " + (r.a.playlist || []).join(" · ");
        if (st.sound && !speaking) speak(r);
    }

    // ---------------------------------------------------------------- ordering / ack
    function ordered() {
        return [...st.alarms.values()].sort((x, y) =>
            (x.acked - y.acked) || (isTest(x.a) - isTest(y.a)) || (SEV[sevOf(y.a)] - SEV[sevOf(x.a)]) || String(x.a.since || "").localeCompare(String(y.a.since || "")));
    }
    function ack(all) {
        const list = ordered().filter((r) => !r.acked);
        (all ? list : list.slice(0, 1)).forEach((r) => { r.acked = true; st.acked.add(r.a.alarm_id); log("ACK " + (r.a.title || r.a.alarm_id)); });
        ls.set(ACK_KEY, [...st.acked]);
        stopSound();
        render();
    }

    // ---------------------------------------------------------------- drawing
    const linkShort = { engine_offline: "ENGINE OFF", engine_stale: "NOT UPDATING", unreachable: "NO SERVER", init: "CONNECTING" };
    const labTime = () => st.lab ? (st.lab.hm || "--") + (st.labErr ? " (ค้าง)" : "") : "--";
    const bars = (title, left, right) => `<div class="bar top">${left || ""}<div class="ttl">${title}</div>${right || ""}</div>`;
    const bot = (l, mid, r) => `<div class="bar bot"><span class="nav" data-a="${l?.[1] || ""}">${l?.[0] || ""}</span><span class="nav">${mid || ""}</span><span class="nav" data-a="${r?.[1] || ""}">${r?.[0] || ""}</span></div>`;

    function home() {
        const g = st.lab, have = !!g, s = st.scn;
        const name = st.scnStale ? `${esc(s?.name ?? g?.scenario ?? "--")} (ค้าง)` : esc(s?.name ?? g?.scenario ?? "--");
        const fallback = g && g.limits === "fallback";
        const epi = s ? s.epidemic : g?.epidemic;
        const test = s ? s.test : g?.scenario_test;
        const l1 = fallback ? `<span class="stale">เกณฑ์สำรอง</span>` : `${test ? "[ทดสอบ] " : ""}${name}`;
        const l2 = !have && !s ? "--" : (epi ? `<span class="on">ใช่</span>` : "ไม่ใช่");
        const dots = g?.dots || [];
        const now = Date.now();
        const table = ROWS.map((r, ri) => `<div class="r">${r}</div>` + [0, 1, 2, 3].map((c) => {
            const i = ri * 4 + c, d = dots[i] || { s: (g?.status || "")[i] || "n", v: null };
            const cls = d.s === "f" || d.s === "b" ? "out" : d.s === "o" ? "ok" : d.s === "-" ? "none" : "na";
            const chg = st.chg.has(i) && now < st.chgUntil ? "chg" : "";
            const tip = `${d.k || ""} ${d.v ?? "--"} · เกณฑ์ ${d.lcl ?? "–"}–${d.ucl ?? "–"}${d.epi ? " (โรคระบาด)" : ""}${d.ts ? " · " + d.ts : ""}`;
            return `<div class="v ${cls} ${chg}" title="${esc(tip)}">${d.v === null || d.v === undefined ? "--" : fmt(d.v)}</div>`;
        }).join("")).join("");
        const nAck = ordered().length;
        let foot;
        if (nAck) foot = `<span class="nav" data-a="list" style="color:var(--warn)">⚠ ${nAck} ALARM · LAB ${esc(labTime())}</span>`;
        else if (st.link !== "ok") foot = `<span class="nav" data-a="lab" style="color:#ff6b6b">⚠ ${linkShort[st.link] || "NO SERVER"} · LAB ${esc(labTime())}</span>`;
        else foot = `<span class="nav" data-a="lab">ผลแล็บ ${esc(labTime())} · แตะดูกราฟ</span>`;
        return `<div class="scn">
                <div class="l1" data-a="lab"><span class="k">สถานการณ์ :</span> ${l1}</div>
                <div class="l2" data-a="lab"><span class="k">โรคระบาด :</span> ${l2}</div>
                <span class="nav" data-a="system" style="position:absolute;right:8px;top:6px;font-size:14px">⚙</span></div>
            <div class="lt" data-a="lab"><div></div><div class="h">#1</div><div class="h">#2</div><div class="h">#3</div><div class="h">#4</div>${table}</div>
            <div class="bar bot" style="justify-content:center">${foot}</div>`;
    }

    const worst = (grp) => grp.units.some((u) => u.s === "b") ? "bad" : grp.units.some((u) => u.s === "f") ? "first" : "";
    function labMenu() {
        const g = st.lab;
        const head = !g ? "LAB" : g.limits === "fallback" ? "LAB · เกณฑ์สำรอง" : `LAB · เกณฑ์ ${esc(g.scenario)}${g.epidemic ? " · โรคระบาด" : ""}`;
        const cell = (a, l1, l2, extra) => `<div class="gbtn ${extra || ""}" data-a="${a}"><span class="g1">${l1}</span><span class="g2">${l2}</span></div>`;
        const btns = GROUP_NAMES.map((n, gi) => {
            const grp = g?.groups?.[gi];
            const [a, b] = (grp?.name || n).split(/ (?=[^ ]+$)/);
            return cell("grp:" + gi, esc(a), esc(b || ""), grp ? (grp.ok ? (worst(grp) && "is-" + worst(grp)) : "dim") : "");
        }).join("") + cell("home", "‹", "กลับ", "alt");
        return bars(head, "", "") + `<div class="body"><div class="g23">${btns}</div></div>` + bot(null, "ข้อมูล " + esc(labTime()), null);
    }

    function spark(u, w, h, big) {
        const pts = u.v.map((v, i) => [i, v]).filter((p) => p[1] !== null);
        if (!pts.length) return "";
        const all = pts.map((p) => p[1]).concat([u.lcl, u.ucl].filter((x) => x !== null && x !== undefined));
        let mn = Math.min(...all), mx = Math.max(...all); const pad = (mx - mn) * 0.12 || 0.5; mn -= pad; mx += pad;
        const n = Math.max(1, u.v.length - 1), X = (i) => i * w / n, Y = (v) => h - (v - mn) / (mx - mn) * h;
        let s = `<svg width="${w}" height="${h}" style="display:block;overflow:visible">`;
        [u.lcl, u.ucl].forEach((l) => { if (l !== null && l !== undefined) s += `<line x1="0" x2="${w}" y1="${Y(l)}" y2="${Y(l)}" stroke="#f87171" stroke-dasharray="3 3" stroke-width="1" opacity=".75"/>`; });
        s += `<polyline fill="none" stroke="#38bdf8" stroke-width="2" points="${pts.map((p) => X(p[0]) + "," + Y(p[1])).join(" ")}"/>`;
        if (big) pts.forEach((p) => { s += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="2.5" fill="#38bdf8"/>`; });
        return s + "</svg>";
    }
    function badge(u) {
        if (u.s === "o") return ["ok", "OK"]; if (u.s === "n") return ["", "--"]; if (u.s === "-") return ["", "-"];
        if (u.last !== null && u.ucl !== null && u.last > u.ucl) return [u.s, "HIGH"];
        if (u.last !== null && u.lcl !== null && u.last < u.lcl) return [u.s, "LOW"];
        return [u.s, u.s === "b" ? "BAD" : "1st"];
    }
    const lim = (u) => `${u?.lcl ?? "-"} – ${u?.ucl ?? "-"}`;

    function group() {
        const grp = st.lab?.groups?.[st.g];
        const head = grp ? `${esc(grp.name)} <span class="muted" style="font-weight:400">${esc(grp.unit)}</span>` : "LAB";
        let body = `<div class="muted" style="text-align:center;margin-top:60px">ยังไม่มีข้อมูลแล็บ</div>`;
        if (grp && grp.ok) body = `<div class="tiles">` + grp.units.map((u, i) => {
            const [bc, bt] = badge(u);
            return `<div class="tile ${u.s === "b" ? "bad" : u.s === "f" ? "first" : ""}" data-a="unit:${i}"><div class="n">#${i + 1}</div><span class="pill ${bc}">${bt}</span>
                <div class="val">${fmt(u.last)}</div>${spark(u, 96, 22, false)}</div>`;
        }).join("") + `</div>`;
        return bars(head, `<span class="nav" data-a="gprev" style="font-size:14px">‹</span>`, `<span class="nav" data-a="gnext" style="font-size:14px">›</span>`)
            + `<div class="body">${body}</div>` + bot(["‹ LAB", "lab"], `${st.g + 1}/5 · lim ${grp ? lim(grp.units[0]) : ""}`, null);
    }

    function unit() {
        const grp = st.lab?.groups?.[st.g], u = grp?.units?.[st.u];
        let body = `<div class="muted" style="text-align:center;margin-top:60px">ยังไม่มีข้อมูลแล็บ</div>`;
        if (u) {
            const [bc, bt] = badge(u);
            body = `<div style="display:flex;align-items:baseline;gap:6px"><span class="big">${fmt(u.last)}</span><span class="muted">${esc(grp.unit)}</span>
                <span class="pill ${bc}" style="position:static">${bt}</span></div>
                <div class="muted" style="margin:2px 0 6px">เกณฑ์ ${lim(u)} · เก็บ ${esc(labTime())}</div>${spark(u, 222, 86, true)}
                <div style="display:flex;justify-content:space-between" class="ann">${(u.t || []).map((t, i) => (u.t.length > 6 && i % 2) ? "" : `<span>${esc(t)}</span>`).join("")}</div>`;
        }
        return bars(`‹  ${esc(grp?.name || "LAB")} #${st.u + 1}`, "", "").replace('<div class="ttl">', '<div class="ttl" data-a="group">')
            + `<div class="body">${body}</div>` + bot(["‹ กลุ่ม", "group"], null, null);
    }

    function system() {
        const age = st.engineAge == null ? "-" : st.engineAge + "s";
        const rows = [["link", st.link], ["mode", `${st.mode || "-"} age ${age}`], ["zones", st.zones || "(all)"],
            ["lab", `${labTime()} rev ${st.lab?.scenario_rev ?? "-"}`], ["scn", st.scn ? `${st.scn.name} rev ${st.scn.rev}` : "-"], ["alarms", String(st.alarms.size)], ["fw", "sim (ann-1.2.0 rules)"]];
        return bars("⚙ SYSTEM", "", "") + `<div class="body" style="line-height:1.7;font-size:10.5px" data-a="home">${rows.map(([k, v]) => `<div><span class="muted" style="display:inline-block;width:56px">${k}</span>${esc(v)}</div>`).join("")}</div>`
            + bot(["‹ HOME", "home"], null, null);
    }

    function alarmView(r, n) {
        const a = r.a, test = isTest(a), sev = sevOf(a);
        const head = test ? "🧪 สัญญาณทดสอบ" : "⚠ " + sev.toUpperCase();
        const limit = a.ui && a.ui.limit !== undefined && a.ui.limit !== null ? `limit ${fmt(a.ui.limit)} ${esc(a.unit || "")}` : "";
        return `<div class="al ${test ? "test" : sev}">
            <div class="hd">${head} · ${esc(a.zone || "ALL")}${n > 1 ? `<span class="nav" data-a="list" style="float:right;color:#ffb020">+${n - 1}</span>` : ""}</div>
            ${test ? `<div class="say">นี่เป็นสัญญาณทดสอบ ไม่ใช่เหตุจริง</div>` : ""}
            <div class="t1">${esc(a.title || a.alarm_id)}</div>
            <div class="val">${a.value === undefined || a.value === null ? "" : fmt(a.value)}<small>${esc(a.unit || "")}</small></div>
            <div class="muted">${limit}${limit ? " · " : ""}${esc(a.kind || "")}${a.since ? " · ตั้งแต่ " + hhmm(a.since) : ""}</div>
            <div class="ft" data-a="ack">แตะเพื่อรับทราบ</div></div>`;
    }

    function list() {
        const rows = ordered().slice(0, 4).map((r) => `<div class="row" style="${r.acked ? "opacity:.55" : ""}">
                <span style="width:8px;height:8px;border-radius:50%;background:${isTest(r.a) ? "#a855f7" : sevOf(r.a) === "critical" ? "#ff3b30" : sevOf(r.a) === "warning" ? "#ffb020" : "#2ea8ff"}"></span>
                <div style="flex:1;min-width:0"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.a.title || r.a.alarm_id)}</div>
                <div class="ann">${isTest(r.a) ? "TEST · " : ""}${r.acked ? "ack'd · " : ""}${esc(r.a.zone || "")} ${fmt(r.a.value)} ${esc(r.a.unit || "")}</div></div></div>`).join("");
        return bars(`⚠ ALARMS ${st.alarms.size}`, "", "") + `<div class="body" data-a="back">${rows || '<div class="muted">ไม่มี alarm</div>'}</div>` + bot(["ACK ALL", "ackall"], null, ["‹ กลับ", "back"]);
    }

    function render() {
        const open = ordered().filter((r) => !r.acked);
        if (open.length && st.page !== "list") { S.innerHTML = alarmView(open[0], st.alarms.size); }
        else if (st.page === "list") S.innerHTML = st.alarms.size ? list() : (st.page = st.prevPage, render(), S.innerHTML);
        else S.innerHTML = ({ home, lab: labMenu, group, unit, system })[st.page]();
        state();
    }

    function state() {
        const feedChip = $("chipFeed"), scnChip = $("chipScn"), labChip = $("chipLab");
        feedChip.textContent = "alarm: " + (st.link === "ok" ? `${st.alarms.size} รายการ · ${st.mode}` : st.link);
        feedChip.className = "an-chip " + (st.link === "ok" ? "ok" : st.link === "init" ? "" : "bad");
        scnChip.textContent = "สถานการณ์: " + (st.scn ? `${st.scn.name}${st.scn.epidemic ? " · โรคระบาด" : ""} (rev ${st.scn.rev})` : "–") + (st.scnStale ? " · ค้าง" : "");
        scnChip.className = "an-chip " + (st.scnStale ? "warn" : st.scn ? "ok" : "");
        labChip.textContent = "ผลแล็บ: " + labTime() + (st.lab ? ` · ${st.lab.limits === "fallback" ? "เกณฑ์สำรอง" : "เกณฑ์สถานการณ์"}` : "");
        labChip.className = "an-chip " + (st.labErr ? "warn" : st.lab ? "ok" : "");
        const ago = (t) => t ? Math.round((Date.now() - t) / 1000) + " วิที่แล้ว" : "-";
        const rows = [
            ["alarm feed", `${st.link} · ${st.mode || "-"} · engine age ${st.engineAge ?? "-"}s · ดึงล่าสุด ${ago(st.feedAt)}`],
            ["สถานการณ์", st.scn ? `${st.scn.name} · โรคระบาด ${st.scn.epidemic ? "ใช่" : "ไม่ใช่"} · rev ${st.scn.rev}${st.scn.test ? " · [ทดสอบ]" : ""} · ตั้งแต่ ${st.scn.since ? new Date(st.scn.since).toLocaleString("th-TH") : "-"}` : "-"],
            ["ผลแล็บ", st.lab ? `รอบ ${st.lab.sample || st.lab.hm} · status ${st.lab.status} · ดึงล่าสุด ${ago(st.labAt)} · ครั้งถัดไป ${Math.max(0, Math.round((st.nextLab - Date.now()) / 1000))} วิ` : (st.labErr || "-")],
            ["รอบ", "alarm 5 วิ · สถานการณ์ 30 วิ · ผลแล็บ 300 วิ"],
        ];
        $("kvState").innerHTML = rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${esc(v)}</span>`).join("");
    }

    // ---------------------------------------------------------------- taps
    function go(a) {
        const open = ordered().filter((r) => !r.acked);
        if (open.length && st.page !== "list") { if (a === "list") { st.prevPage = st.page; st.page = "list"; render(); } else ack(false); return; }  // แตะได้แค่รับทราบ
        let openLab = false;
        if (!a) return;
        if (a === "ack") return ack(false);
        if (a === "ackall") return ack(true);
        if (a === "back") { st.page = st.prevPage || "home"; }
        else if (a === "list") { st.prevPage = st.page; st.page = "list"; }
        else if (a.startsWith("grp:")) { st.g = +a.slice(4); st.page = "group"; openLab = true; }
        else if (a.startsWith("unit:")) { st.u = +a.slice(5); st.page = "unit"; }
        else if (a === "gprev") st.g = (st.g + 4) % 5;
        else if (a === "gnext") st.g = (st.g + 1) % 5;
        else { st.page = a; if (a === "lab") openLab = true; }
        if (openLab && Date.now() - st.labAt > LAB_FRESH_MS) fetchLab("เปิดหน้าแล็บ");
        render();
    }
    S.addEventListener("click", (e) => {
        st.lastTap = Date.now();
        if (st.sound) audio();
        const t = e.target.closest("[data-a]");
        go(t ? t.dataset.a : (ordered().some((r) => !r.acked) ? "ack" : ""));
    });
    $("btnBoot").onclick = () => { st.lastTap = Date.now(); if (ordered().some((r) => !r.acked)) ack(false); else { st.page = "home"; render(); } };
    $("btnSound").onclick = () => {
        st.sound = !st.sound;
        $("btnSound").textContent = st.sound ? "🔊 เสียงเปิด" : "🔇 เสียงปิด";
        $("btnSound").classList.toggle("on", st.sound);
        if (st.sound) { audio(); ordered().forEach((r) => { if (!r.acked) r.nextSay = 0; }); sayPending(); } else stopSound();
    };
    $("btnRefresh").onclick = () => { pollFeed(); pollScenario(); fetchLab("กดดึงใหม่"); };
    $("btnClearLog").onclick = () => { $("logBox").textContent = ""; };
    const zin = $("inZones");
    zin.value = st.zones;
    zin.onchange = () => {
        st.zones = zin.value.toUpperCase().replace(/[^A-Z0-9,]/g, ""); zin.value = st.zones;
        try { localStorage.setItem(ZONE_KEY, st.zones); } catch { }
        st.alarms.clear(); log("zone -> " + (st.zones || "(all)")); pollFeed();
    };

    // ---------------------------------------------------------------- loops
    setInterval(pollFeed, FEED_MS);
    setInterval(pollScenario, SCN_MS);
    setInterval(() => { if (Date.now() >= st.nextLab) fetchLab("timer"); }, 5000);
    setInterval(() => {                                   // หน้าแล็บ/SYSTEM ไม่แตะ 60 วิ -> HOME ; อัปเดตตัวนับ
        if (["lab", "group", "unit", "system"].includes(st.page) && Date.now() - st.lastTap > IDLE_HOME_MS) { st.page = "home"; render(); }
        else state();
    }, 1000);
    log("เริ่มจอจำลอง — รอบดึงเหมือนเครื่อง ann-1.2.0");
    render();
    pollFeed(); pollScenario(); fetchLab("เริ่ม");
})();
