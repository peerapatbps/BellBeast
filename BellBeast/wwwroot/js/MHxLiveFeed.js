// MHxView ← LabVenture live feed (GET /labventure/api/scenarios/live ผ่าน proxy)
//  1) แถบข่าวที่ topbar: [ ข้อความวิ่ง ←←← | สถานการณ์ระบบผลิต · โรคระบาด ]
//     ข้อความวิ่ง 📢 ข้อความ1 📢 ข้อความ2 📢 … เริ่มจากช่องว่างข้างป้ายสถานะ แล้วเลื่อนไปซ้ายจนหายสุดขอบ แล้ววนใหม่
//     (ตั้งจำนวน/ข้อความที่ LabVenture → Config)
//  2) rev ของเกณฑ์เปลี่ยน (เปลี่ยนสถานการณ์ / โรคระบาด / แก้เกณฑ์) → LAB block ดึงเกณฑ์ใหม่เองทันที ไม่ต้องกด F5
//     และยิง event "lv:limits-changed" ให้ block อื่นที่สนใจฟังได้
(function () {
    "use strict";

    const URL = "/labventure/api/scenarios/live";
    const POLL_MS = 15000;
    const PX_PER_SEC = 70; // ความเร็ววิ่ง

    let lastRev = null;
    let lastText = null;
    let lastStatus = null;
    let inFlight = false;
    let ui = null;

    function buildUi() {
        const host = document.getElementById("lvMarquee");
        if (!host) return null;
        host.textContent = "";

        const view = document.createElement("div");
        view.className = "lv-mq-view";
        const track = document.createElement("div");
        track.className = "lv-mq-track";
        view.append(track);

        const status = document.createElement("div");
        status.className = "lv-mq-status";
        const scen = chip("lv-chip-scen");
        const epi = chip("lv-chip-epi");
        status.append(scen.el, epi.el);

        host.append(view, status);
        return { host, view, track, scen, epi };
    }

    function chip(cls) {
        const el = document.createElement("span");
        el.className = "lv-chip " + cls;
        const dot = document.createElement("i");
        const txt = document.createElement("span");
        el.append(dot, txt);
        return { el, txt };
    }

    // สีตามชื่อสถานการณ์: ปกติ = เขียว · เฝ้าระวัง = เหลือง · วิกฤต/ฉุกเฉิน = แดง · อื่น ๆ = ฟ้า
    function scenarioTone(name) {
        const n = String(name || "");
        if (!n) return "off";
        if (/วิกฤต|ฉุกเฉิน|crisis/i.test(n)) return "bad";
        if (/เฝ้าระวัง|watch/i.test(n)) return "warn";
        if (/ปกติ|normal/i.test(n)) return "ok";
        return "info";
    }

    function renderStatus(scenario, epidemic) {
        const name = scenario?.name || "";
        const key = name + "|" + !!epidemic;
        if (key === lastStatus) return;
        lastStatus = key;
        ui.scen.el.dataset.tone = scenarioTone(name);
        ui.scen.txt.textContent = "สถานการณ์: " + (name || "–");
        ui.scen.el.title = "สถานการณ์ระบบผลิต (LabVenture)";
        ui.epi.el.dataset.tone = epidemic ? "bad" : "off";
        ui.epi.txt.textContent = "โรคระบาด: " + (epidemic ? "ใช่" : "ไม่ใช่");
        ui.epi.el.title = "โหมดโรคระบาด (LabVenture)";
    }

    function renderMarquee(items) {
        const list = (Array.isArray(items) ? items : []).map((t) => String(t ?? "").trim()).filter(Boolean);
        const key = JSON.stringify(list);
        if (key === lastText) return;
        lastText = key;

        const track = ui.track;
        track.textContent = "";
        ui.view.title = list.join("  ·  ");
        if (!list.length) { track.style.animation = "none"; return; }

        // 📢 msg1 📢 msg2 📢 … (โทรโข่งหน้า กลาง หลัง)
        list.forEach((t) => {
            const horn = document.createElement("span");
            horn.className = "lv-mq-horn";
            horn.textContent = "📢";
            const msg = document.createElement("span");
            msg.className = "lv-mq-msg";
            msg.textContent = t;
            track.append(horn, msg);
        });
        const tail = document.createElement("span");
        tail.className = "lv-mq-horn";
        tail.textContent = "📢";
        track.append(tail);

        requestAnimationFrame(layoutRun);
    }

    // วิ่งจาก "ขอบขวาของช่อง" (ยังมองไม่เห็น) → จนหลุดขอบซ้ายทั้งก้อน แล้วเริ่มใหม่จากความว่างเปล่า
    function layoutRun() {
        const track = ui.track;
        if (!track.firstChild) return;
        const vw = ui.view.clientWidth;
        const tw = track.scrollWidth;
        if (!vw || !tw) return;
        track.style.setProperty("--lv-from", vw + "px");
        track.style.setProperty("--lv-to", -tw + "px");
        track.style.animation = "none";
        void track.offsetWidth; // restart animation
        track.style.animation = `lv-mq-run ${Math.max(6, (vw + tw) / PX_PER_SEC)}s linear infinite`;
    }

    function onLimitsChanged(data) {
        try { window.LABView?.tick?.(); } catch (err) { console.warn("[MHxLiveFeed] LAB refresh failed:", err); }
        window.dispatchEvent(new CustomEvent("lv:limits-changed", { detail: data }));
        console.info("[MHxLiveFeed] เกณฑ์เปลี่ยน →", data?.scenario?.name || "–", data?.epidemic ? "(โรคระบาด)" : "");
    }

    async function poll() {
        if (inFlight || !ui) return;
        inFlight = true;
        try {
            const r = await fetch(URL, { cache: "no-store", credentials: "same-origin" });
            if (!r.ok) throw new Error("HTTP " + r.status);
            const j = await r.json();
            ui.host.hidden = false;
            renderStatus(j.scenario, j.epidemic);
            renderMarquee(j.marquee);
            if (j.rev) {
                if (lastRev !== null && j.rev !== lastRev) onLimitsChanged(j);
                lastRev = j.rev;
            }
        } catch (err) {
            // LabVenture ปิด / ยังไม่ restart → เงียบไว้ แสดงค่าล่าสุดต่อ
        } finally {
            inFlight = false;
        }
    }

    function start() {
        ui = buildUi();
        if (!ui) return;
        let rt = 0;
        window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(layoutRun, 200); });
        poll();
        setInterval(poll, POLL_MS);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
})();
