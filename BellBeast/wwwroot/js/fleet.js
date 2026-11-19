// Annunciator Fleet admin page — status strip, tabs (devices / defaults / WiFi / firmware / log), device drawer.
// Every string from the server or a device goes through esc() before it reaches innerHTML.
(function () {
    "use strict";

    const $ = (s, r) => (r || document).querySelector(s);
    const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    let data = null;          // /api/admin/fleet
    let events = [];          // /api/admin/fleet/events
    let view = "devices";
    let filter = "all";       // devices filter: all | lost | behind
    let query = "";
    let logDev = "";
    const logTypes = new Set();
    let viewDirty = false;    // user is editing a form in the current tab → background refresh leaves it alone
    let drawerId = null;

    // ── api ──
    async function api(url, opts) {
        const r = await fetch(url, Object.assign({ credentials: "same-origin" }, opts || {}));
        let j = null;
        try { j = await r.json(); } catch { /* non-JSON */ }
        if (r.status === 401 || r.status === 403) throw new Error("ต้อง login admin ใหม่ (session หมดอายุ)");
        if (!r.ok || (j && j.ok === false)) throw new Error(errText((j && (j.detail || j.error)) || ("HTTP " + r.status)));
        return j;
    }
    const send = (url, method, body) => api(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const devUrl = (id) => "/api/admin/fleet/device/" + encodeURIComponent(id);

    const ERR = {
        bad_zones: "zone ไม่ถูกต้อง (ใช้ A–Z, 0–9, _ ไม่เกิน 16 ตัว)", bad_volume: "ระดับเสียงต้องอยู่ระหว่าง 0–100",
        bad_remind_sec: "รอบดังซ้ำต้องอยู่ระหว่าง 0–3600 วินาที", bad_poll_sec: "รอบเช็ก alarm ต้องอยู่ระหว่าง 1–60 วินาที",
        bad_lab_sec: "รอบดึงผลแล็บต้องอยู่ระหว่าง 60–3600 วินาที", bad_scn_sec: "รอบเช็กสถานการณ์ต้องอยู่ระหว่าง 10–600 วินาที",
        bad_channel: "กลุ่มรับอัปเดตไม่ถูกต้อง", bad_ssid: "ต้องใส่ชื่อ WiFi (ไม่เกิน 32 ตัว)", bad_current: "ต้องใส่รหัสปัจจุบัน (ไม่เกิน 63 ตัว)",
        bad_next: "รหัสถัดไปยาวเกิน 63 ตัว", bad_next_valid_from: "วันเวลาเริ่มใช้รหัสถัดไปไม่ถูกต้อง",
        device_not_found: "ไม่พบเครื่องนี้ในระบบแล้ว", firmware_not_found: "ไม่พบไฟล์ firmware รุ่นนี้",
        bad_model: "ชื่อรุ่นใช้ได้เฉพาะ a–z, 0–9, . _ - ไม่เกิน 32 ตัว", fw_model_mismatch: "ไฟล์นี้เป็นของรุ่นอื่น ล็อกให้เครื่องนี้ไม่ได้",
        firmware_in_use: "ไฟล์นี้ยังตั้งเป็นใช้จริง/ทดสอบอยู่", firmware_pinned: "มีเครื่องล็อกไฟล์นี้อยู่ ปลดล็อกก่อนจึงลบได้", bad_wifi: "ค่า WiFi ไม่ถูกต้อง",
    };
    const errText = (code) => ERR[code] || code;

    // ── formatting ──
    const mins = (iso) => iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity;
    function ago(iso) {
        if (!iso) return "ไม่เคย";
        const m = mins(iso);
        if (m < 1) return "เมื่อสักครู่";
        if (m < 60) return Math.round(m) + " นาทีที่แล้ว";
        if (m < 1440) return Math.round(m / 60) + " ชม.ที่แล้ว";
        if (m < 1440 * 7) return Math.round(m / 1440) + " วันที่แล้ว";
        return ts(iso);
    }
    const ts = (iso) => iso ? new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "–";
    const tsSec = (iso) => iso ? new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "–";
    const live = (d) => { const m = mins(d.last_seen); return m < 3 ? "on" : m < 15 ? "late" : "off"; };
    const liveColor = { on: "ok", late: "warn", off: "bad" };

    const devs = () => (data && data.devices) || [];
    const approved = () => devs().filter((d) => d.approved);
    const pending = () => devs().filter((d) => !d.approved);
    const defs = () => (data && data.defaults) || {};
    const tracks = () => (data && data.ota && data.ota.tracks) || {};
    const chans = (m) => tracks()[m || ""] || {};                      // stable/beta of one model
    const firmware = () => (data && data.ota && data.ota.firmware) || [];
    const models = () => (data && data.ota && data.ota.models) || [];
    const mname = (m) => m || "ไม่ระบุรุ่น";
    const fwOf = (m) => firmware().filter((f) => (f.model || "") === (m || ""));
    const dname = (d) => d.name || "ยังไม่ได้ตั้งชื่อ";
    const zlist = (s) => (s || "").split(",").map((z) => z.trim()).filter(Boolean);

    // device value vs fleet default
    const FIELDS = [
        { k: "zones", label: "Zone ที่ให้ดัง", help: "เครื่องจะดังเฉพาะ alarm ของ zone ที่เลือก (alarm ที่ไม่มี zone ดังทุกเครื่อง)", kind: "zones" },
        { k: "volume", label: "ระดับเสียง", help: "0–100 · ว่าง = ใช้ค่าที่ตั้งไว้ในเครื่อง", unit: "%", min: 0, max: 100, nullable: true },
        { k: "remind_sec", label: "ดังซ้ำถ้ายังไม่มีคนรับทราบ ทุก", help: "0 = ดังครั้งเดียว", unit: "วินาที", min: 0, max: 3600 },
        { k: "channel", label: "รับอัปเดต firmware", help: "เครื่องในกลุ่มทดสอบจะได้รุ่นใหม่ก่อน · ไฟล์ที่ได้จริงเลือกตามรุ่นของเครื่อง", kind: "channel", dev: false },
        { k: "poll_sec", label: "เช็ก alarm ใหม่ทุก", help: "ยิ่งถี่ยิ่งดังเร็ว แต่ใช้เครือข่ายมากขึ้น", unit: "วินาที", min: 1, max: 60, adv: true },
        { k: "lab_sec", label: "ดึงผลแล็บมาแสดงทุก", help: "ดึงทันทีอยู่แล้วเมื่อมี alarm แล็บใหม่หรือสถานการณ์เปลี่ยน", unit: "วินาที", min: 60, max: 3600, adv: true },
        { k: "scn_sec", label: "เช็กสถานการณ์/โรคระบาดทุก", help: "จาก LabVenture", unit: "วินาที", min: 10, max: 600, adv: true },
    ];
    const isCustom = (d, k) => d[k] !== null && d[k] !== undefined;
    const eff = (d, k) => isCustom(d, k) ? d[k] : defs()[k];
    const customList = (d) => FIELDS.filter((f) => isCustom(d, f.k)).map((f) => f.label)
        .concat(d.wifi ? ["WiFi ของตัวเอง"] : [], d.fw_pin ? ["ล็อก firmware"] : []);
    const customCount = (d) => customList(d).length;
    const chanLabel = { stable: "ใช้จริง", beta: "ทดสอบ", none: "ไม่อัปเดต", pin: "ล็อกไฟล์" };
    const target = (d) => d.target_fw || null;                         // server resolves pin / model track
    const behind = (d) => { const t = target(d); return !!t && d.fw !== t; };
    const pinVer = (d) => d.fw_pin ? d.fw_pin.split("/").pop() : null;
    // "ตามกลุ่มใช้จริง → 3.0.0" etc.
    function fwPlan(d) {
        if (d.fw_pin) return d.target_fw ? `ล็อก ${d.target_fw}` : `ล็อก ${pinVer(d)} (คนละรุ่น ไม่ส่ง)`;
        const ch = eff(d, "channel") || "stable";
        if (ch === "none") return "ไม่อัปเดต";
        return `${chanLabel[ch]} → ${d.target_fw || "ยังไม่ได้ตั้ง"}`;
    }
    function fmt(f, v) {
        if (f.kind === "zones") return zlist(v).length ? zlist(v).join(", ") : "ทุก zone";
        if (f.kind === "channel") return chanLabel[v] || v || "–";
        return v === null || v === undefined || v === "" ? "ค่าในเครื่อง" : v + " " + f.unit;
    }

    // ── ui helpers ──
    function toast(text, err) {
        const t = $("#toast");
        t.textContent = text; t.className = "fl-toast" + (err ? " err" : ""); t.hidden = false;
        clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
    }
    function showErr(text) { const m = $("#msg"); m.textContent = text || ""; m.hidden = !text; }

    async function run(fn, okText, after) {
        try {
            await fn();
            if (okText) toast(okText);
            viewDirty = false;
            if (after) after();
            await load();
        } catch (e) { toast(e.message, true); }
    }

    function bars(rssi) {
        if (rssi === null || rssi === undefined) return '<span class="fl-faint">–</span>';
        const n = rssi > -55 ? 4 : rssi > -67 ? 3 : rssi > -78 ? 2 : 1;
        return `<span class="fl-bars" title="${esc(rssi)} dBm">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? "f" : ""}"></i>`).join("")}</span>` +
            `<span class="fl-muted">${["", "อ่อน", "พอใช้", "ดี", "ดีมาก"][n]}</span>`;
    }
    const zoneChips = (s) => zlist(s).length ? zlist(s).map((z) => `<span class="fl-z">${esc(z)}</span>`).join("") : '<span class="fl-z all">ทุก zone</span>';
    function fwCell(d) {
        const mdl = d.eff_model ? `<div class="fl-faint fl-small fl-mono">${esc(d.eff_model)}</div>` : "";
        if (!d.fw) return '<span class="fl-faint">–</span>' + mdl;
        const t = target(d), ch = d.target_channel;
        const tag = ch === "none" ? '<span class="fl-badge plain">ปิดอัปเดต</span>' : behind(d) ? `<span class="fl-badge warn">รอ ${esc(t)}</span>` : "";
        const kind = ch === "pin" ? '<span class="fl-badge info" title="ล็อกไฟล์ firmware เฉพาะเครื่อง">ล็อก</span>'
            : ch === "beta" ? '<span class="fl-badge info">ทดสอบ</span>' : "";
        return `<span class="fl-mono">${esc(d.fw)}</span> ${kind} ${tag}${mdl}`;
    }
    function acked(d) {
        return !!(d.last_ack_at && d.last_played_at && d.last_ack_alarm === d.last_played_alarm &&
            new Date(d.last_ack_at) >= new Date(d.last_played_at));
    }
    function alarmCell(d) {
        if (!d.last_played_at) return '<span class="fl-faint">ยังไม่เคยดัง</span>';
        return `<div class="fl-mono">${esc(d.last_played_alarm || "–")}</div><div class="fl-faint fl-small">${esc(ago(d.last_played_at))} · ` +
            (acked(d) ? '<span class="c-ok">รับทราบที่เครื่องแล้ว</span>' : '<span class="c-warn">ไม่ได้กดรับทราบที่เครื่อง</span>') + "</div>";
    }
    const seenCell = (d) => `<span class="c-${liveColor[live(d)]}">${esc(ago(d.last_seen))}</span>`;

    // ── status strip ──
    function renderStrip() {
        const ok = approved();
        const on = ok.filter((d) => live(d) === "on").length;
        const lost = ok.length - on;
        const pend = pending().length;
        const beh = ok.filter(behind).length;
        const nm = models().length;
        const tiles = [
            ["all", "", '<span class="fl-dot on"></span>ทำงานปกติ', `${on} <small>/ ${ok.length}</small>`, "ติดต่อได้ใน 3 นาที"],
            ["lost", lost ? "t-bad" : "", '<span class="fl-dot off"></span>ขาดการติดต่อ', lost, lost ? "กดเพื่อดูเครื่อง" : "ไม่มี"],
            ["pending", pend ? "t-warn" : "", '<span class="fl-dot pend"></span>รออนุมัติ', pend, pend ? "เครื่องใหม่" : "ไม่มี"],
            ["behind", beh ? "t-warn" : "", "firmware ไม่ตรงเป้าหมาย", beh, nm > 1 ? `${nm} รุ่นฮาร์ดแวร์` : `ใช้จริง ${esc(chans(models()[0]).stable || "–")}`],
        ];
        $("#strip").innerHTML = tiles.map(([f, cls, l, n, s]) =>
            `<button type="button" class="fl-tile ${cls} ${view === "devices" && filter === f && f !== "all" ? "sel" : ""}" data-f="${f}">` +
            `<span class="lbl">${l}</span><span class="num">${n}</span><span class="sub">${s}</span></button>`).join("");
        $$("#strip .fl-tile").forEach((b) => b.onclick = () => {
            const f = b.dataset.f === "pending" ? "all" : b.dataset.f;
            filter = filter === f ? "all" : f;
            go("devices");
        });
        const tab = $('.fl-tab[data-tab="devices"]');
        tab.innerHTML = "อุปกรณ์" + (pend ? `<span class="cnt">${pend} รออนุมัติ</span>` : "");
    }

    // ── devices ──
    function renderDevices() {
        const v = $("#v-devices");
        if (!$("#devlist", v)) {
            v.innerHTML = `<div id="pendbox"></div>
                <div class="fl-toolbar">
                    <input class="fl-search" id="q" placeholder="ค้นหาชื่อ, รหัสเครื่อง, zone, IP, รุ่น" autocomplete="off">
                    <div class="fl-chipset" id="fchips"></div>
                </div>
                <div class="fl-list" id="devlist"></div>
                <p class="fl-note" style="margin-top:10px">กดที่เครื่องเพื่อดูรายละเอียด แก้ชื่อ/zone/เสียง หรือจัดการเครื่อง · ข้อมูลรีเฟรชเองทุก 30 วินาที</p>`;
            $("#q").oninput = (e) => { query = e.target.value.trim().toLowerCase(); renderDeviceList(); };
        }
        $("#q").value = query;
        renderDeviceList();
    }
    function renderDeviceList() {
        const pend = pending();
        $("#pendbox").innerHTML = pend.length ? `<div class="fl-pending"><h3><span class="fl-dot pend"></span>มีเครื่องใหม่ ${pend.length} เครื่องรออนุมัติ</h3>` +
            pend.map((d) => `<div class="fl-pend-row"><div class="grow"><b class="fl-mono">${esc(d.id)}</b>
                <div class="fl-note">IP ${esc(d.ip || "–")} · firmware ${esc(d.fw || "–")} · รายงานตัว${esc(ago(d.last_seen))}
                ${d.has_key ? " · เครื่องจะยังไม่ได้รหัส WiFi จนกว่าจะอนุมัติ" : " · <span class='c-warn'>ถูกรีเซ็ตกุญแจ รอเครื่องรายงานตัวใหม่</span>"}</div></div>
                <div class="acts">${d.has_key ? `<button type="button" class="fl-btn ok" data-approve="${esc(d.id)}">อนุมัติ</button>` : ""}
                <button type="button" class="fl-btn" data-open="${esc(d.id)}">ดูรายละเอียด</button></div></div>`).join("") + "</div>" : "";

        const fchips = [["all", "ทั้งหมด"], ["lost", "ขาดการติดต่อ"], ["behind", "firmware ไม่ล่าสุด"]];
        $("#fchips").innerHTML = fchips.map(([f, l]) => `<button type="button" class="fl-chip" aria-pressed="${filter === f}" data-f="${f}">${l}</button>`).join("");
        $$("#fchips .fl-chip").forEach((b) => b.onclick = () => { filter = b.dataset.f; renderStrip(); renderDeviceList(); });

        let list = approved();
        if (filter === "lost") list = list.filter((d) => live(d) !== "on");
        if (filter === "behind") list = list.filter(behind);
        if (query) list = list.filter((d) => [d.id, d.name, eff(d, "zones"), d.ip, d.eff_model, d.fw].join(" ").toLowerCase().includes(query));

        const empty = !approved().length ? "ยังไม่มีเครื่องที่อนุมัติแล้ว" : "ไม่มีเครื่องตรงกับตัวกรอง";
        $("#devlist").innerHTML = `<div class="fl-lrow hd"><span>เครื่อง</span><span>Zone ที่ดัง</span><span>Firmware</span><span>สัญญาณ</span><span>Alarm ที่ดังล่าสุด</span><span>ติดต่อล่าสุด</span><span></span></div>` +
            (list.length ? list.map((d) => `<button type="button" class="fl-lrow" data-open="${esc(d.id)}">
                <span class="fl-nm"><span class="fl-dot ${live(d)}"></span><span style="min-width:0"><b>${esc(dname(d))}</b><span class="fl-mono">${esc(d.id)}</span>
                    ${customCount(d) ? ` <span class="fl-badge plain" title="${esc("ตั้งเอง: " + customList(d).join(", "))}">ตั้งเอง ${customCount(d)}</span>` : ""}</span></span>
                <span><span class="fl-cl">Zone</span><span class="fl-zones">${zoneChips(eff(d, "zones"))}</span></span>
                <span><span class="fl-cl">Firmware</span>${fwCell(d)}</span>
                <span><span class="fl-cl">สัญญาณ</span>${bars(d.rssi)}</span>
                <span class="fl-alarm"><span class="fl-cl">Alarm ล่าสุด</span>${alarmCell(d)}</span>
                <span><span class="fl-cl">ติดต่อล่าสุด</span>${seenCell(d)}</span>
                <span class="fl-chev">›</span></button>`).join("")
                : `<div class="fl-lrow"><span class="fl-muted" style="grid-column:1/-1">${empty}</span></div>`);

        $$("#v-devices [data-open]").forEach((b) => b.onclick = () => openDrawer(b.dataset.open));
        $$("#v-devices [data-approve]").forEach((b) => b.onclick = () => approve(b.dataset.approve));
    }
    function approve(id) {
        run(() => send(devUrl(id), "POST", { approved: true }), "อนุมัติ " + id + " แล้ว · เครื่องจะได้รหัส WiFi และค่าตั้งในรอบถัดไป",
            () => { if (drawerId === id) closeDrawer(); });
    }

    // ── shared setting controls ──
    function knownZones() {
        const s = new Set(zlist(defs().zones));
        devs().forEach((d) => zlist(d.zones).forEach((z) => s.add(z)));
        return Array.from(s).sort();
    }
    function control(f, v, idp) {
        if (f.kind === "zones") {
            const sel = zlist(v);
            const all = Array.from(new Set(knownZones().concat(sel))).sort();
            return `<div class="fl-zpick" id="${idp}-zones"><button type="button" aria-pressed="${!sel.length}" data-zv="">ทุก zone</button>` +
                all.map((z) => `<button type="button" aria-pressed="${sel.includes(z)}" data-zv="${esc(z)}">${esc(z)}</button>`).join("") +
                `<input placeholder="+ zone" maxlength="16" title="พิมพ์ชื่อ zone แล้วกด Enter"></div>`;
        }
        if (f.kind === "channel") {
            return `<span class="fl-inp"><select id="${idp}-channel">` + ["stable", "beta", "none"].map((k) =>
                `<option value="${k}" ${k === v ? "selected" : ""}>${chanLabel[k]}</option>`).join("") + "</select></span>";
        }
        return `<span class="fl-inp"><input id="${idp}-${f.k}" type="number" min="${f.min}" max="${f.max}" value="${esc(v ?? "")}"><span class="unit">${f.unit}</span></span>`;
    }
    function wireZones(root, onChange) {
        $$(".fl-zpick", root).forEach((zp) => {
            const sync = () => {
                const any = $$("button[data-zv]", zp).some((x) => x.dataset.zv && x.getAttribute("aria-pressed") === "true");
                $("button[data-zv='']", zp).setAttribute("aria-pressed", String(!any));
            };
            const wire = (b) => b.onclick = () => {
                if (!b.dataset.zv) $$("button", zp).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
                else { b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")); sync(); }
                onChange();
            };
            $$("button", zp).forEach(wire);
            const inp = $("input", zp);
            inp.onkeydown = (e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const z = inp.value.trim().toUpperCase();
                if (!/^[A-Z0-9_]{1,16}$/.test(z)) { toast("zone ใช้ได้เฉพาะ A–Z, 0–9, _ ไม่เกิน 16 ตัว", true); return; }
                let b = $$("button", zp).find((x) => x.dataset.zv === z);
                if (!b) { b = document.createElement("button"); b.type = "button"; b.dataset.zv = z; b.textContent = z; zp.insertBefore(b, inp); wire(b); }
                b.setAttribute("aria-pressed", "true"); sync(); inp.value = ""; onChange();
            };
        });
    }
    function readControl(f, idp) {
        if (f.kind === "zones") return $$(`#${idp}-zones button[data-zv]`).filter((b) => b.dataset.zv && b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.zv).join(",");
        if (f.kind === "channel") return $(`#${idp}-channel`).value;
        const raw = $(`#${idp}-${f.k}`).value.trim();
        if (raw === "") { if (f.nullable) return null; throw new Error(`ต้องใส่ค่า “${f.label}”`); }
        const n = Number(raw);
        if (!Number.isInteger(n) || n < f.min || n > f.max) throw new Error(`“${f.label}” ต้องเป็นจำนวนเต็ม ${f.min}–${f.max}`);
        return n;
    }

    // ── wifi form (fleet tab + device drawer) ──
    const pad2 = (n) => String(n).padStart(2, "0");
    function localDT(iso) {
        if (!iso) return "";
        const t = new Date(iso);
        return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}T${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
    }
    function wifiFields(p, w) {
        return `<div class="fl-form">
            <label><b>ชื่อ WiFi (SSID)</b><input class="fl-finput" id="${p}Ssid" maxlength="32" value="${esc(w ? w.ssid : ".@MWA WiFi")}"></label>
            <label><b>Identity (ชื่อผู้ใช้)</b><input class="fl-finput" id="${p}Identity" maxlength="64" value="${esc(w ? w.identity || "" : "")}"></label>
            <label><b>รหัสปัจจุบัน</b><input class="fl-finput" id="${p}Current" type="password" autocomplete="new-password" placeholder="${w ? "เว้นว่าง = ไม่เปลี่ยน (" + esc(w.current || "") + ")" : "จำเป็น"}"></label>
            <label><b>รหัสถัดไป</b><input class="fl-finput" id="${p}Next" type="password" autocomplete="new-password" placeholder="${w && w.next ? "เว้นว่าง = ไม่เปลี่ยน (" + esc(w.next) + ")" : "ไม่บังคับ"}"></label>
            <label><b>เริ่มใช้รหัสถัดไปเมื่อ</b><input class="fl-finput" id="${p}From" type="datetime-local" value="${localDT(w && w.next_valid_from)}"></label>
        </div>`;
    }
    function readWifi(p, w) {
        const body = { ssid: $(`#${p}Ssid`).value.trim(), identity: $(`#${p}Identity`).value };
        if (!body.ssid) throw new Error(ERR.bad_ssid);
        const cur = $(`#${p}Current`).value, nx = $(`#${p}Next`).value;
        if (cur) body.current = cur; else if (!w) throw new Error(ERR.bad_current);
        if (nx) body.next = nx;
        body.next_valid_from = $(`#${p}From`).value ? new Date($(`#${p}From`).value).toISOString() : null;
        return body;
    }
    const wifiLabel = (w) => w ? `${esc(w.ssid)}${w.identity ? " · " + esc(w.identity) : ""}` : "ยังไม่ได้ตั้ง";

    // firmware choice for one device: def | ch:stable | ch:beta | ch:none | pin:<key>
    function fwChoice(d, model) {
        const c = chans(model), defCh = defs().channel || "stable";
        const to = (ch) => ch === "none" ? "" : " → " + (c[ch] || "ยังไม่ได้ตั้ง");
        const opts = [["def", `ใช้ค่ากลาง · ${chanLabel[defCh]}${to(defCh)}`], ["ch:stable", "ใช้จริง" + to("stable")],
            ["ch:beta", "ทดสอบ" + to("beta")], ["ch:none", "ไม่อัปเดต (คงรุ่นที่มีอยู่)"]]
            .concat(fwOf(model).map((f) => ["pin:" + f.key, `ล็อกไฟล์ ${f.version}${f.note ? " · " + f.note : ""}`]));
        const cur = d.fw_pin ? "pin:" + d.fw_pin : d.channel ? "ch:" + d.channel : "def";
        if (!opts.some(([v]) => v === cur)) opts.push([cur, `ล็อก ${pinVer(d)} (ไฟล์ของรุ่นอื่น — จะไม่ถูกส่ง)`]);
        return opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("");
    }

    // ── device drawer ──
    function openDrawer(id) {
        const d = devs().find((x) => x.id === id);
        if (!d) return;
        drawerId = id;
        const dr = $("#drawer"), l = live(d);
        const def = defs();
        const row = (f) => {
            const custom = isCustom(d, f.k);
            return `<div class="fl-field" data-k="${f.k}"><div class="fl-fl"><b>${f.label}</b><span>${f.help}</span></div>
                <div class="fl-fctl"><div class="fl-seg"><button type="button" aria-pressed="${!custom}" data-mode="def">ใช้ค่ากลาง · ${esc(fmt(f, def[f.k]))}</button>` +
                `<button type="button" aria-pressed="${custom}" data-mode="own">กำหนดเอง</button></div>
                <div class="own" ${custom ? "" : "hidden"}>${control(f, custom ? d[f.k] : def[f.k], "c")}</div></div></div>`;
        };
        const tier = d.wifi_tier === "known" ? "ใช้รหัสจากระบบ" : d.wifi_tier === "bootstrap" ? '<span class="c-warn">ใช้รหัสสำรองในเครื่อง</span>' : esc(d.wifi_tier || "–");
        dr.innerHTML = `
            <div class="fl-dr-head"><span class="fl-dot ${d.approved ? l : "pend"}" style="margin-top:9px"></span>
                <div><h2>${esc(dname(d))}</h2><div class="fl-mono fl-faint">${esc(d.id)}</div></div>
                <button type="button" class="x" id="dx" aria-label="ปิด">×</button></div>
            <div class="fl-dr-body">
                ${!d.approved ? `<div class="fl-dr-sec"><div class="fl-pending" style="margin:0"><h3>เครื่องนี้ยังไม่ได้รับอนุมัติ</h3>
                    <div class="fl-note">${d.has_key ? "ตรวจว่าเป็นเครื่องของเรา (ดู IP และเวลาที่รายงานตัว) แล้วกดอนุมัติ เครื่องจึงจะได้รหัส WiFi และค่าตั้ง"
                        : "กุญแจถูกรีเซ็ตแล้ว รอเครื่องรายงานตัวครั้งถัดไปเพื่อลงทะเบียนกุญแจใหม่ แล้วจึงอนุมัติได้"}</div>
                    ${d.has_key ? '<div><button type="button" class="fl-btn ok" id="dapprove">อนุมัติเครื่องนี้</button></div>' : ""}</div></div>` : ""}
                <div class="fl-dr-sec"><h3>สถานะตอนนี้</h3><dl class="fl-kv">
                    <dt>ติดต่อล่าสุด</dt><dd>${seenCell(d)} <span class="fl-faint fl-small">${esc(ts(d.last_seen))}</span></dd>
                    <dt>Alarm ที่ดังล่าสุด</dt><dd>${alarmCell(d)}</dd>
                    <dt>รับทราบล่าสุด</dt><dd>${d.last_ack_at ? `<span class="fl-mono">${esc(d.last_ack_alarm || "–")}</span> <span class="fl-faint fl-small">${esc(ago(d.last_ack_at))}</span>` : '<span class="fl-faint">–</span>'}</dd>
                    <dt>Firmware</dt><dd>${fwCell(d)} <span class="fl-faint fl-mono">${esc(d.partition || "")}</span></dd>
                    <dt>WiFi</dt><dd>${bars(d.rssi)} ${d.rssi !== null && d.rssi !== undefined ? `<span class="fl-faint">${esc(d.rssi)} dBm</span>` : ""} · ${tier}</dd>
                    <dt>IP</dt><dd class="fl-mono">${esc(d.ip || "–")}</dd>
                    <dt>เริ่มลงทะเบียน</dt><dd>${esc(ts(d.created_at))}</dd></dl>
                    <p class="fl-note" style="margin:10px 0 0"><button type="button" class="fl-link" id="dlog">ดูบันทึกเหตุการณ์ของเครื่องนี้ ›</button></p></div>
                <div class="fl-dr-sec"><h3>ตั้งค่า</h3>
                    <div class="fl-field" style="border-top:0"><div class="fl-fl"><b>ชื่อเครื่อง</b><span>ชื่อที่คนในโรงงานเรียก เช่น ตำแหน่งที่ติดตั้ง</span></div>
                        <div class="fl-fctl"><input class="fl-finput" id="c-name" maxlength="60" value="${esc(d.name || "")}" placeholder="เช่น ห้องควบคุมกลาง"></div></div>
                    <div class="fl-fields">${FIELDS.filter((f) => !f.adv && f.dev !== false).map(row).join("")}</div>
                    <details class="fl-adv"><summary>ตั้งค่าขั้นสูง (รอบการดึงข้อมูล)</summary><div class="fl-fields">${FIELDS.filter((f) => f.adv).map(row).join("")}</div></details>
                </div>
                <div class="fl-dr-sec"><h3>Firmware</h3>
                    <div class="fl-field" style="border-top:0"><div class="fl-fl"><b>รุ่นฮาร์ดแวร์</b><span>เครื่องจะได้เฉพาะไฟล์ของรุ่นนี้ · เว้นว่าง = ${d.reported_model ? "ตามที่เครื่องแจ้ง (" + esc(d.reported_model) + ")" : "ไม่ระบุรุ่น"}</span></div>
                        <div class="fl-fctl"><input class="fl-finput" id="c-model" list="c-models" maxlength="32" autocomplete="off" value="${esc(d.model || "")}" placeholder="${esc(d.reported_model || "ไม่ระบุรุ่น")}">
                        <datalist id="c-models">${models().filter(Boolean).map((m) => `<option value="${esc(m)}">`).join("")}</datalist></div></div>
                    <div class="fl-field"><div class="fl-fl"><b>ไฟล์ที่จะส่งให้เครื่องนี้</b><span>ตามกลุ่ม (ใช้จริง/ทดสอบของรุ่นนี้) หรือล็อกไฟล์เฉพาะเครื่อง</span></div>
                        <div class="fl-fctl"><span class="fl-inp"><select id="c-fw" style="max-width:320px">${fwChoice(d, d.eff_model)}</select></span>
                        <span class="fl-note">ตอนนี้: ${esc(fwPlan(d))}</span></div></div>
                </div>
                <div class="fl-dr-sec"><h3>WiFi</h3>
                    <div class="fl-fctl" id="c-wifi"><div class="fl-seg"><button type="button" aria-pressed="${!d.wifi}" data-wm="def">ใช้ WiFi กลาง · ${wifiLabel(data.wifi)}</button>` +
                    `<button type="button" aria-pressed="${!!d.wifi}" data-wm="own">กำหนดเฉพาะเครื่องนี้</button></div></div>
                    <div id="c-wifi-own" ${d.wifi ? "" : "hidden"}>${wifiFields("dw", d.wifi)}
                        ${d.wifi ? `<p class="fl-note" style="margin:8px 0 0">แก้ล่าสุด ${esc(ts(d.wifi.updated_at))}</p>` : ""}</div>
                </div>
                <div class="fl-dr-sec"><h3>จัดการเครื่อง</h3><div class="fl-danger">
                    <div class="fl-danger-row"><div class="grow"><b>รีเซ็ตกุญแจเครื่อง</b>ใช้เมื่อเปลี่ยนบอร์ดหรือล้างหน่วยความจำเครื่อง (NVS) เครื่องจะต้องอนุมัติใหม่</div>
                        <button type="button" class="fl-btn ghost-bad" data-dz="reset">รีเซ็ต…</button></div>
                    <div class="fl-danger-row"><div class="grow"><b>ลบออกจากระบบ</b>ถ้าเครื่องยังเปิดอยู่ จะกลับมาเป็นเครื่องรออนุมัติ</div>
                        <button type="button" class="fl-btn ghost-bad" data-dz="del">ลบ…</button></div>
                </div></div>
            </div>
            <div class="fl-dr-foot"><span class="grow" id="dstate">ยังไม่มีการเปลี่ยนแปลง</span>
                <button type="button" class="fl-btn" id="dcancel">ปิด</button><button type="button" class="fl-btn primary" id="dsave" disabled>บันทึก</button></div>`;

        const body = $(".fl-dr-body", dr);
        const dirty = () => { $("#dstate").textContent = "มีการแก้ไขที่ยังไม่บันทึก"; $("#dsave").disabled = false; };
        body.addEventListener("input", (e) => { if (!e.target.closest(".fl-zpick")) dirty(); });
        body.addEventListener("change", (e) => { if (!e.target.closest(".fl-zpick")) dirty(); });
        $$(".fl-field[data-k]", body).forEach((fe) => $$(".fl-seg button", fe).forEach((b) => b.onclick = () => {
            $$(".fl-seg button", fe).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
            $(".own", fe).hidden = b.dataset.mode === "def";
            dirty();
        }));
        wireZones(body, dirty);
        $("#c-model").onchange = () => {
            const m = $("#c-model").value.trim().toLowerCase() || d.reported_model || "";
            const keep = $("#c-fw").value;
            $("#c-fw").innerHTML = fwChoice(Object.assign({}, d, { fw_pin: null }), m);
            if ($$("#c-fw option").some((o) => o.value === keep)) $("#c-fw").value = keep;
        };
        $$("#c-wifi .fl-seg button").forEach((b) => b.onclick = () => {
            $$("#c-wifi .fl-seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
            $("#c-wifi-own").hidden = b.dataset.wm === "def";
            dirty();
        });

        $$("[data-dz]", body).forEach((b) => b.onclick = () => {
            const rowEl = b.closest(".fl-danger-row");
            if ($(".fl-confirm", rowEl)) return;
            const del = b.dataset.dz === "del";
            const c = document.createElement("div");
            c.className = "fl-confirm";
            c.innerHTML = `<span>${del ? "ลบ" : "รีเซ็ตกุญแจของ"} <b class="fl-mono">${esc(d.id)}</b> ใช่ไหม?</span>` +
                `<button type="button" class="fl-btn sm">ยกเลิก</button><button type="button" class="fl-btn bad sm">${del ? "ลบเครื่อง" : "รีเซ็ตกุญแจ"}</button>`;
            rowEl.appendChild(c);
            c.children[1].onclick = () => c.remove();
            c.children[2].onclick = () => del
                ? run(() => api(devUrl(d.id), { method: "DELETE" }), "ลบ " + d.id + " แล้ว", closeDrawer)
                : run(() => send(devUrl(d.id), "POST", { reset_key: true }), "รีเซ็ตกุญแจ " + d.id + " แล้ว · รอเครื่องรายงานตัวแล้วอนุมัติใหม่", closeDrawer);
        });

        $("#dx").onclick = closeDrawer;
        $("#dcancel").onclick = closeDrawer;
        $("#dlog").onclick = () => { closeDrawer(); logDev = d.id; go("log"); };
        if ($("#dapprove")) $("#dapprove").onclick = () => approve(d.id);
        $("#dsave").onclick = () => {
            let patch;
            try {
                patch = { name: $("#c-name").value };
                $$(".fl-field[data-k]", body).forEach((fe) => {
                    const f = FIELDS.find((x) => x.k === fe.dataset.k);
                    const own = $('.fl-seg [data-mode="own"]', fe).getAttribute("aria-pressed") === "true";
                    patch[f.k] = own ? readControl(f, "c") : null;
                });
                patch.model = $("#c-model").value.trim();
                const fw = $("#c-fw").value;
                if (fw.startsWith("pin:")) patch.fw_pin = fw.slice(4);
                else { patch.fw_pin = null; patch.channel = fw === "def" ? null : fw.slice(3); }
                const ownWifi = $('#c-wifi [data-wm="own"]').getAttribute("aria-pressed") === "true";
                if (ownWifi) patch.wifi = readWifi("dw", d.wifi);
                else if (d.wifi) patch.wifi = null;
            } catch (e) { toast(e.message, true); return; }
            run(() => send(devUrl(d.id), "POST", patch), "บันทึก " + (patch.name.trim() || d.id) + " แล้ว · เครื่องจะรับค่าใหม่ในรอบถัดไป", closeDrawer);
        };

        $("#scrim").hidden = false;
        dr.hidden = false;
        $("#dx").focus();
    }
    function closeDrawer() { drawerId = null; $("#drawer").hidden = true; $("#scrim").hidden = true; }
    $("#scrim").onclick = closeDrawer;
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawerId) closeDrawer(); });

    // ── defaults ──
    function renderDefaults() {
        const ok = approved(), def = defs();
        const row = (f) => {
            const using = ok.filter((d) => !isCustom(d, f.k)).length;
            return `<div class="fl-field"><div class="fl-fl"><b>${f.label}</b><span>${f.help}</span><div class="fl-uses">ใช้อยู่ ${using} จาก ${ok.length} เครื่อง</div></div>
                <div class="fl-fctl">${control(f, def[f.k], "d")}</div></div>`;
        };
        const v = $("#v-defaults");
        const ownWifi = ok.filter((d) => d.wifi).length, pinned = ok.filter((d) => d.fw_pin).length;
        v.innerHTML = `<div class="fl-panel"><h2>ค่าตั้งกลาง</h2>
            <p class="fl-lead">ทุกเครื่องใช้ค่ากลางเป็นพื้นฐาน แล้ว “กำหนดเอง” ทับได้รายเครื่องที่แผงตั้งค่าของเครื่อง ลำดับที่เครื่องได้รับ:</p>
            <div class="fl-stages">
                <div class="fl-stage"><span class="k"><span class="fl-stepn">1</span>ค่าเสียง / zone / รอบดึงข้อมูล</span><div class="s" style="margin-top:4px">ค่ากลางในหน้านี้ → ทับได้รายเครื่อง</div></div>
                <div class="fl-stage"><span class="k"><span class="fl-stepn">2</span>WiFi</span><div class="s" style="margin-top:4px">WiFi กลาง (แท็บรหัส WiFi) → ${ownWifi} เครื่องใช้ WiFi ของตัวเอง</div></div>
                <div class="fl-stage"><span class="k"><span class="fl-stepn">3</span>Firmware</span><div class="s" style="margin-top:4px">รุ่นของเครื่อง → กลุ่มใช้จริง/ทดสอบของรุ่นนั้น → ${pinned} เครื่องล็อกไฟล์เอง</div></div>
            </div>
            <div class="fl-fields">${FIELDS.filter((f) => !f.adv).map(row).join("")}</div>
            <details class="fl-adv"><summary>ตั้งค่าขั้นสูง (รอบการดึงข้อมูล)</summary><div class="fl-fields">${FIELDS.filter((f) => f.adv).map(row).join("")}</div></details>
            <div style="display:flex;gap:10px;align-items:center;margin-top:14px"><button type="button" class="fl-btn primary" id="dsaveall">บันทึกค่ากลาง</button>
            <span class="fl-note" id="ddirty"></span></div></div>
            <div class="fl-panel"><h2>ภาพรวมรายเครื่อง</h2>
                <p class="fl-lead">แต่ละเครื่องได้ค่าอะไรจริง · กดที่แถวเพื่อแก้</p>
                <div class="fl-list">
                    <div class="fl-ov hd"><span>เครื่อง</span><span>รุ่น</span><span>WiFi</span><span>Firmware ที่จะได้</span><span>ตั้งเองต่างจากค่ากลาง</span></div>
                    ${ok.length ? ok.map((d) => `<button type="button" class="fl-ov" data-open="${esc(d.id)}">
                        <span class="fl-nm"><span class="fl-dot ${live(d)}"></span><span style="min-width:0"><b>${esc(dname(d))}</b><span class="fl-mono">${esc(d.id)}</span></span></span>
                        <span class="fl-mono">${esc(mname(d.eff_model))}${!d.model && d.reported_model ? ' <span class="fl-faint">(เครื่องแจ้ง)</span>' : ""}</span>
                        <span>${d.wifi ? `<span class="fl-badge info">เฉพาะเครื่อง</span> ${esc(d.wifi.ssid)}` : '<span class="fl-muted">กลาง</span>'}</span>
                        <span><span class="fl-mono">${esc(d.fw || "–")}</span> <span class="fl-muted">· ${esc(fwPlan(d))}</span></span>
                        <span class="fl-small fl-muted">${customList(d).map(esc).join(", ") || "–"}</span></button>`).join("")
                        : '<div class="fl-ov"><span class="fl-muted" style="grid-column:1/-1">ยังไม่มีเครื่องที่อนุมัติแล้ว</span></div>'}
                </div></div>`;
        $$("[data-open]", v).forEach((b) => b.onclick = () => openDrawer(b.dataset.open));
        const mark = () => { viewDirty = true; $("#ddirty").textContent = "มีการแก้ไขที่ยังไม่บันทึก"; };
        v.oninput = mark; v.onchange = mark;
        wireZones(v, mark);
        $("#dsaveall").onclick = () => {
            let body = {};
            try { FIELDS.forEach((f) => (body[f.k] = readControl(f, "d"))); } catch (e) { toast(e.message, true); return; }
            run(() => send("/api/admin/fleet/defaults", "PUT", body), "บันทึกค่ากลางแล้ว · เครื่องจะรับค่าใหม่ในรอบถัดไป");
        };
    }

    // ── wifi ──
    function renderWifi() {
        const w = data.wifi;
        const ok = approved();
        const known = ok.filter((d) => d.wifi_tier === "known").length;
        const boot = ok.filter((d) => d.wifi_tier === "bootstrap");
        const nvf = w && w.next_valid_from ? new Date(w.next_valid_from) : null;
        const days = nvf ? Math.ceil((nvf.getTime() - Date.now()) / 86400000) : null;
        const nextState = !w || !w.next ? "ยังไม่ได้ตั้ง" : !nvf ? "ใช้ได้ทันที (ลองต่อจากรหัสปัจจุบัน)" : days > 0 ? `อีก ${days} วัน` : "ถึงเวลาแล้ว เครื่องใช้รหัสนี้ก่อน";
        const v = $("#v-wifi");
        const own = ok.filter((d) => d.wifi);
        v.innerHTML = `<div class="fl-panel"><h2>WiFi กลาง</h2>
            <p class="fl-lead">ใช้กับทุกเครื่องที่ไม่ได้กำหนด WiFi เฉพาะเครื่องไว้ · ตั้งรหัสถัดไปไว้ล่วงหน้าก่อนฝ่าย IT เปลี่ยนรหัส เครื่องจะสลับไปใช้เองตามวันเวลาที่กำหนด · ส่งให้เฉพาะเครื่องที่อนุมัติแล้ว</p>
            <div class="fl-flow">
                <div class="fl-step ${w ? "now" : "off"}"><span class="k">① รหัสปัจจุบัน</span><span class="v">${w ? esc(w.ssid) : "ยังไม่ได้ตั้ง"}</span>
                    ${w ? `<span class="fl-mono fl-muted">${esc(w.current || "–")}</span><span class="fl-note">identity: ${esc(w.identity || "–")}</span>` : ""}</div>
                <span class="fl-arrow">→</span>
                <div class="fl-step ${w && w.next ? "" : "off"}"><span class="k">② รหัสถัดไป</span>
                    <span class="v">${nvf ? "เริ่ม " + esc(ts(w.next_valid_from)) : w && w.next ? "ไม่ได้กำหนดวัน" : "ยังไม่ได้ตั้ง"}</span>
                    ${w && w.next ? `<span class="fl-mono fl-muted">${esc(w.next)}</span>` : ""}<span class="fl-note">${esc(nextState)}</span></div>
                <span class="fl-arrow">→</span>
                <div class="fl-step"><span class="k">③ รหัสสำรองในเครื่อง</span><span class="v">ฝังใน firmware</span>
                    <span class="fl-note">ใช้เมื่อ ① และ ② ต่อไม่ได้ · แก้จากหน้านี้ไม่ได้</span></div>
            </div>
            <p class="fl-note">ตอนนี้ <b style="color:var(--fl-fg)">${known} จาก ${ok.length}</b> เครื่องต่อด้วยรหัสจากระบบ ·
                ${boot.length ? `<span class="c-warn">${boot.length} เครื่องใช้รหัสสำรอง (${boot.map((d) => esc(dname(d))).join(", ")})</span>` : "ไม่มีเครื่องใช้รหัสสำรอง"}
                ${w ? " · แก้ล่าสุด " + esc(ts(w.updated_at)) : ""}</p>
            <div style="margin:14px 0"><button type="button" class="fl-btn primary" id="wedit">${w ? "แก้ไข WiFi กลาง" : "ตั้ง WiFi กลาง"}</button></div>
            <form id="wform" hidden autocomplete="off">${wifiFields("w", w)}
            <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:14px"><button type="submit" class="fl-btn primary">บันทึก</button>
                <button type="button" class="fl-btn" id="wcancel">ยกเลิก</button><span style="flex:1"></span>
                ${w ? '<button type="button" class="fl-btn ghost-bad" id="wclear">ล้างรหัสทั้งหมด…</button>' : ""}</div>
            <div id="wclearbox"></div></form>
            <details class="fl-warnbox"><summary>ข้อควรระวังด้านความปลอดภัย</summary>
                <p style="margin:8px 0 0">BellBeast ยังไม่มี TLS รหัสจึงส่งผ่าน LAN โรงงานแบบไม่เข้ารหัส ระยะยาวควรย้ายไป SSID เฉพาะอุปกรณ์ IoT หรือ EAP-TLS (Overview §3.4)</p></details>
        </div>`;
        v.insertAdjacentHTML("beforeend", `<div class="fl-panel"><h2>เครื่องที่ใช้ WiFi เฉพาะเครื่อง</h2>
            <p class="fl-lead">เช่น เครื่องที่ติดตั้งในอาคารที่ใช้ SSID อื่น · ตั้งได้ที่แผงตั้งค่าของเครื่อง → WiFi → “กำหนดเฉพาะเครื่องนี้”</p>
            ${own.length ? `<div class="fl-list">${own.map((d) => {
                const dn = d.wifi.next_valid_from ? Math.ceil((new Date(d.wifi.next_valid_from).getTime() - Date.now()) / 86400000) : null;
                return `<button type="button" class="fl-ov" data-open="${esc(d.id)}" style="grid-template-columns:minmax(0,2fr) minmax(0,2fr) minmax(0,2fr) minmax(0,1.4fr)">
                    <span class="fl-nm"><span class="fl-dot ${live(d)}"></span><span style="min-width:0"><b>${esc(dname(d))}</b><span class="fl-mono">${esc(d.id)}</span></span></span>
                    <span>${wifiLabel(d.wifi)}</span>
                    <span class="fl-small fl-muted">${d.wifi.next ? "รหัสถัดไป " + (dn === null ? "ใช้ได้ทันที" : dn > 0 ? `อีก ${dn} วัน` : "ถึงเวลาแล้ว") : "ไม่มีรหัสถัดไป"}</span>
                    <span class="fl-small">${d.wifi_tier === "known" ? '<span class="c-ok">ต่อด้วยรหัสจากระบบ</span>' : d.wifi_tier === "bootstrap" ? '<span class="c-warn">ใช้รหัสสำรอง</span>' : "–"}</span></button>`;
            }).join("")}</div>` : '<p class="fl-note">ไม่มี — ทุกเครื่องใช้ WiFi กลาง</p>'}</div>`);
        $$("[data-open]", v).forEach((b) => b.onclick = () => openDrawer(b.dataset.open));
        const f = $("#wform");
        $("#wedit").onclick = () => { f.hidden = false; $("#wedit").hidden = true; viewDirty = true; };
        $("#wcancel").onclick = () => { f.hidden = true; $("#wedit").hidden = false; viewDirty = false; };
        f.onsubmit = (e) => {
            e.preventDefault();
            let body;
            try { body = readWifi("w", w); } catch (x) { toast(x.message, true); return; }
            run(() => send("/api/admin/fleet/wifi", "PUT", body), "บันทึก WiFi กลางแล้ว · เครื่องจะรับค่าในรอบถัดไป");
        };
        if ($("#wclear")) $("#wclear").onclick = () => {
            $("#wclearbox").innerHTML = `<div class="fl-confirm" style="margin-top:10px"><span>ล้างรหัส ① และ ② ? เครื่องจะเหลือแค่รหัสสำรองในเครื่อง</span>` +
                `<button type="button" class="fl-btn sm" id="wc0">ยกเลิก</button><button type="button" class="fl-btn bad sm" id="wc1">ล้างรหัส</button></div>`;
            $("#wc0").onclick = () => ($("#wclearbox").innerHTML = "");
            $("#wc1").onclick = () => run(() => send("/api/admin/fleet/wifi", "PUT", { clear: true }), "ล้างรหัส WiFi แล้ว");
        };
    }

    // ── firmware (per hardware model) ──
    let fwModel = null;        // model shown in the firmware tab ("" = not specified)
    function renderFirmware() {
        const ok = approved(), ms = models();
        if (fwModel === null || !ms.includes(fwModel)) fwModel = ms[0] ?? "";
        const m = fwModel, c = chans(m), fws = fwOf(m);
        const mine = ok.filter((d) => (d.eff_model || "") === m);
        const on = (ver) => mine.filter((d) => d.fw === ver);
        const inCh = (ch) => mine.filter((d) => !d.fw_pin && (eff(d, "channel") || "stable") === ch);
        const pinned = mine.filter((d) => d.fw_pin);
        const done = (ch) => inCh(ch).filter((d) => c[ch] && d.fw === c[ch]).length;
        const latest = fws[0];
        const q = (ver) => "/api/admin/ota/firmware/" + encodeURIComponent(ver) + (m ? "?model=" + encodeURIComponent(m) : "");
        const v = $("#v-firmware");
        v.innerHTML = `<div class="fl-panel"><h2>อัปเดต Firmware</h2>
            <p class="fl-lead">แยกตามรุ่นฮาร์ดแวร์ — ไฟล์ของรุ่นหนึ่งจะไม่ถูกส่งให้อีกรุ่น · อัปโหลด → ส่งให้กลุ่มทดสอบของรุ่นนั้นก่อน → ปล่อยให้ทุกเครื่องของรุ่นนั้น ·
                เครื่องไหนต้องใช้ไฟล์เฉพาะ ให้ “ล็อกไฟล์” ที่แผงตั้งค่าของเครื่อง</p>
            <div class="fl-toolbar"><span class="fl-muted fl-small">รุ่น</span><div class="fl-chipset" id="fwModels">${ms.map((x) =>
                `<button type="button" class="fl-chip" aria-pressed="${x === m}" data-m="${esc(x)}">${esc(mname(x))} <span class="fl-faint">${ok.filter((d) => (d.eff_model || "") === x).length}</span></button>`).join("")}</div></div>
            <div class="fl-stages">
                <div class="fl-stage"><span class="k"><span class="fl-stepn">1</span>อัปโหลดล่าสุด · ${esc(mname(m))}</span><div class="v">${esc(latest ? latest.version : "–")}</div>
                    <div class="s">${latest ? esc(ts(latest.uploaded_at)) : "ยังไม่มีไฟล์ของรุ่นนี้"}</div></div>
                <div class="fl-stage"><span class="k"><span class="fl-stepn">2</span>กลุ่มทดสอบ</span><div class="v">${esc(c.beta || "–")}</div>
                    <div class="s">${inCh("beta").length ? `อัปเดตแล้ว ${done("beta")}/${inCh("beta").length} เครื่อง` : "ยังไม่มีเครื่องรุ่นนี้ในกลุ่มทดสอบ"}</div></div>
                <div class="fl-stage"><span class="k"><span class="fl-stepn">3</span>ใช้จริงทุกเครื่องของรุ่นนี้</span><div class="v">${esc(c.stable || "–")}</div>
                    <div class="s">อัปเดตแล้ว ${done("stable")}/${inCh("stable").length} เครื่อง${pinned.length ? ` · ล็อกไฟล์เอง ${pinned.length} เครื่อง` : ""}</div></div>
            </div>
            <div class="fl-drop"><div class="grow"><b>อัปโหลดไฟล์ใหม่</b>
                <div class="fl-note">ไฟล์ <span class="fl-mono">build/xiaozhi.bin</span> · ระบบอ่านเลขรุ่น firmware จากไฟล์ให้เอง</div></div>
                <input type="file" id="fwFile" accept=".bin">
                <label class="fl-note" style="display:grid;gap:2px">รุ่นฮาร์ดแวร์<input class="fl-finput" id="fwModel" list="fwModelList" maxlength="32" autocomplete="off" value="${esc(m)}" placeholder="ไม่ระบุรุ่น" style="max-width:180px"></label>
                <datalist id="fwModelList">${ms.filter(Boolean).map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
                <input class="fl-finput" id="fwNote" placeholder="หมายเหตุ เช่น แก้อะไร" style="max-width:220px">
                <details style="font-size:13px"><summary class="fl-muted" style="cursor:pointer">ระบุเลข firmware เอง</summary>
                    <input class="fl-finput" id="fwVersion" placeholder="ต้องตรงกับ PROJECT_VER" style="max-width:200px;margin-top:6px"></details>
                <button type="button" class="fl-btn primary" id="fwUpload">อัปโหลด</button></div>
            <p class="fl-note" style="margin:0 0 6px">เครื่องจะไม่อัปเดตระหว่างมี alarm ที่ยังไม่รับทราบ · ถ้ารุ่นใหม่ดึง alarm ไม่สำเร็จใน 5 นาที เครื่องจะย้อนกลับรุ่นเดิมเอง</p>
            <div>${fws.length ? fws.map((f) => {
                const isB = c.beta === f.version, isS = c.stable === f.version, n = on(f.version);
                const pins = ok.filter((d) => d.fw_pin === f.key);
                const acts = (isS ? '<span class="fl-badge ok">ใช้จริงอยู่</span>' : "") +
                    (isB ? '<span class="fl-badge info">กำลังทดสอบ</span>' : "") +
                    (pins.length ? `<span class="fl-badge plain" title="${esc(pins.map(dname).join(", "))}">ล็อก ${pins.length} เครื่อง</span>` : "") +
                    (!isB && !isS ? `<button type="button" class="fl-btn sm" data-ch="beta" data-v="${esc(f.version)}">ส่งให้กลุ่มทดสอบ</button>` : "") +
                    (!isS ? `<button type="button" class="fl-btn ${isB ? "primary" : ""} sm" data-ch="stable" data-v="${esc(f.version)}">ปล่อยให้ทุกเครื่องรุ่นนี้</button>` : "") +
                    (!isB && !isS && !pins.length ? `<button type="button" class="fl-btn ghost-bad sm" data-del="${esc(f.version)}">ลบ…</button>` : "");
                return `<div class="fl-fwrow"><div><div class="ver">${esc(f.version)}</div>
                    <div class="fl-faint fl-small">${esc(ts(f.uploaded_at))} · ${(f.size / 1048576).toFixed(2)} MB</div>
                    <div class="fl-faint fl-small fl-mono" title="sha256">${esc((f.sha256 || "").slice(0, 12))}…</div></div>
                    <div><div>${f.note ? esc(f.note) : '<span class="fl-faint">ไม่มีหมายเหตุ</span>'}</div>
                    <div class="fl-note">${n.length ? "ใช้อยู่ " + n.length + " เครื่อง: " + n.map((d) => esc(dname(d))).join(", ") : "ไม่มีเครื่องใช้รุ่นนี้"}</div></div>
                    <div class="acts">${acts}</div></div>`;
            }).join("") : '<p class="fl-note">ยังไม่มีไฟล์ firmware ของรุ่นนี้</p>'}</div>
            <p class="fl-note">กลุ่มทดสอบของรุ่นนี้: ${inCh("beta").map((d) => esc(dname(d))).join(", ") || "ไม่มี"} ·
                ล็อกไฟล์: ${pinned.map((d) => `${esc(dname(d))} (${esc(pinVer(d))})`).join(", ") || "ไม่มี"} · ตั้งกลุ่ม/ล็อกไฟล์ได้ที่แผงตั้งค่าของเครื่อง</p>
        </div>`;
        v.oninput = () => (viewDirty = true);
        v.onchange = () => (viewDirty = true);
        $$("#fwModels .fl-chip").forEach((b) => b.onclick = () => { fwModel = b.dataset.m; viewDirty = false; renderFirmware(); });
        $$("[data-ch]", v).forEach((b) => b.onclick = () => {
            const ch = b.dataset.ch, ver = b.dataset.v;
            run(() => send("/api/admin/ota/channel", "POST", { model: m, channel: ch, version: ver }),
                (ch === "beta" ? "ส่ง " + ver + " ให้กลุ่มทดสอบ" : "ปล่อย " + ver + " ให้ทุกเครื่อง") + "ของรุ่น " + mname(m) + " แล้ว");
        });
        $$("[data-del]", v).forEach((b) => b.onclick = () => {
            const ver = b.dataset.del, acts = b.parentElement;
            if ($(".fl-confirm", acts.parentElement)) return;
            const c2 = document.createElement("div");
            c2.className = "fl-confirm"; c2.style.gridColumn = "1 / -1";
            c2.innerHTML = `<span>ลบไฟล์ firmware <b class="fl-mono">${esc(ver)}</b> ของรุ่น ${esc(mname(m))} ใช่ไหม?</span><button type="button" class="fl-btn sm">ยกเลิก</button><button type="button" class="fl-btn bad sm">ลบไฟล์</button>`;
            acts.parentElement.appendChild(c2);
            c2.children[1].onclick = () => c2.remove();
            c2.children[2].onclick = () => run(() => api(q(ver), { method: "DELETE" }), "ลบ " + ver + " แล้ว");
        });
        $("#fwUpload").onclick = () => {
            const file = $("#fwFile").files[0];
            if (!file) { toast("เลือกไฟล์ .bin ก่อน", true); return; }
            const model = $("#fwModel").value.trim().toLowerCase();
            if (model && !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(model)) { toast(ERR.bad_model, true); return; }
            const fd = new FormData();
            fd.append("version", $("#fwVersion").value.trim());
            fd.append("note", $("#fwNote").value);
            fd.append("model", model);
            fd.append("file", file);
            $("#fwUpload").disabled = true; $("#fwUpload").textContent = "กำลังอัปโหลด…";
            run(() => api("/api/admin/ota/firmware", { method: "POST", body: fd }), "อัปโหลดแล้ว (รุ่น " + mname(model) + ")", () => (fwModel = model)).finally(() => {
                const b = $("#fwUpload"); if (b) { b.disabled = false; b.textContent = "อัปโหลด"; }
            });
        };
    }

    // ── log ──
    const EVTYPE = {
        played: ["เล่นเสียง", "info"], ack: ["รับทราบ", "ok"], clear: ["alarm หาย", "ok"], fallback: ["เสียงสำรอง", "warn"],
        boot: ["เปิดเครื่อง", "plain"], wifi: ["WiFi", "plain"], ota: ["อัปเดต", "plain"], health: ["สุขภาพเครื่อง", "plain"],
    };
    async function loadEvents() {
        const j = await api("/api/admin/fleet/events?n=" + (logDev ? 100 : 500) + (logDev ? "&device=" + encodeURIComponent(logDev) : ""));
        events = j.events || [];
    }
    function renderLog() {
        const v = $("#v-log");
        const byId = Object.fromEntries(devs().map((d) => [d.id, d]));
        const types = Array.from(new Set(Object.keys(EVTYPE).concat(events.map((e) => e.type)))).filter(Boolean);
        const list = events.filter((e) => !logTypes.size || logTypes.has(e.type));
        v.innerHTML = `<div class="fl-toolbar">
                <select class="fl-search" id="evDevice" style="max-width:260px"><option value="">ทุกเครื่อง</option>${devs().map((d) =>
                    `<option value="${esc(d.id)}" ${logDev === d.id ? "selected" : ""}>${esc(dname(d))} · ${esc(d.id)}</option>`).join("")}</select>
                <div class="fl-chipset">${types.map((t) => `<button type="button" class="fl-chip" aria-pressed="${logTypes.has(t)}" data-t="${esc(t)}">${esc((EVTYPE[t] || [t])[0])}</button>`).join("")}</div>
            </div>
            <div class="fl-log">${list.length ? list.map((e) => {
                const [lbl, cls] = EVTYPE[e.type] || [e.type, "plain"];
                const dev = byId[e.device];
                const devTime = e.ts && Math.abs(new Date(e.ts) - new Date(e.rx)) > 120000 ? ` title="เวลาเครื่อง ${esc(tsSec(e.ts))}"` : "";
                const text = [e.alarm_id ? `<span class="fl-mono">${esc(e.alarm_id)}</span>` : "", esc(e.detail || "")].filter(Boolean).join(" · ");
                return `<div class="fl-ev"><span class="t"${devTime}>${esc(tsSec(e.rx))}</span><span>${esc(dev ? dname(dev) : e.device)}</span>` +
                    `<span><span class="fl-badge ${cls}">${esc(lbl)}</span></span><span class="tx">${text || '<span class="fl-faint">–</span>'}</span></div>`;
            }).join("") : '<div class="fl-ev"><span class="fl-muted">ไม่มีเหตุการณ์ตรงกับตัวกรอง</span></div>'}</div>
            <p class="fl-note" style="margin-top:8px">ระบบเก็บ 100 เหตุการณ์ล่าสุดต่อเครื่อง (เก่ากว่านั้นถูกลบอัตโนมัติ) · ทุกเครื่องรวมกันแสดงสูงสุด 500 รายการ · ชี้ที่เวลาเพื่อดูเวลาของเครื่อง (ถ้านาฬิกาเครื่องต่างจากเซิร์ฟเวอร์)</p>`;
        $("#evDevice").onchange = (e) => { logDev = e.target.value; loadEvents().then(renderLog).catch((x) => toast(x.message, true)); };
        $$(".fl-chip", v).forEach((b) => b.onclick = () => { const t = b.dataset.t; logTypes.has(t) ? logTypes.delete(t) : logTypes.add(t); renderLog(); });
    }

    // ── device API access (shadow / enforce, key vs IP pass) ──
    let access = null;        // /api/admin/fleet/access
    async function loadAccess() { access = await api("/api/admin/fleet/access"); }
    const VIA = { key: ["กุญแจเครื่อง", "ok"], ip_pass: ["IP pass (firmware เก่า)", "warn"] };
    const MISS = { no_device_key: "ไม่มีกุญแจเครื่อง / token", device_key_invalid: "กุญแจไม่ถูกต้อง หรือเครื่องยังไม่อนุมัติ" };
    function renderAccess() {
        const v = $("#v-access");
        if (!access) { v.innerHTML = '<div class="fl-panel"><p class="fl-note">กำลังโหลด…</p></div>'; return; }
        const a = access, ok = approved();
        const enforce = a.mode === "enforce";
        // newest way each approved device came in (the in-memory record starts when BellBeast starts)
        const viaOf = (id) => (a.callers || []).filter((c) => c.device === id).sort((x, y) => new Date(y.last_at) - new Date(x.last_at))[0] || null;
        const onKey = ok.filter((d) => (viaOf(d.id) || {}).via === "key").length;
        const onIp = ok.filter((d) => (viaOf(d.id) || {}).via === "ip_pass");
        const misses = a.misses || [];
        v.innerHTML = `<div class="fl-panel"><h2>การเข้าถึง API ของอุปกรณ์</h2>
            <p class="fl-lead">API ที่อุปกรณ์ใช้ (alarm, เสียง, ผลแล็บ, คลอรีน, IoT room, ไฟล์ firmware) เปิดให้เฉพาะ: หน้าเว็บของเรา (view token), คนที่ login,
                ตัวเซิร์ฟเวอร์เอง (Uroboros) และ <b style="color:var(--fl-fg)">เครื่องที่อนุมัติแล้ว</b> — ด้วยกุญแจเครื่อง หรือ IP pass ระหว่างที่ยังมีเครื่อง firmware เก่า</p>
            <div class="fl-stages">
                <div class="fl-stage"><span class="k"><span class="fl-stepn">1</span>โหมด</span><div class="v">${enforce ? "บล็อกจริง" : "เฝ้าดู (shadow)"}</div>
                    <div class="s">${enforce ? "คนที่ไม่มีสิทธิ์ได้ 401" : "ยังไม่บล็อกใคร แค่บันทึกว่าใครจะโดนบล็อก"}</div></div>
                <div class="fl-stage"><span class="k"><span class="fl-stepn">2</span>เครื่องที่ส่งกุญแจแล้ว</span><div class="v">${onKey} <small class="fl-muted">/ ${ok.length}</small></div>
                    <div class="s">${onIp.length ? `ยังใช้ IP pass ${onIp.length} เครื่อง` : "ไม่มีเครื่องที่ยังพึ่ง IP pass"}</div></div>
                <div class="fl-stage"><span class="k"><span class="fl-stepn">3</span>${enforce ? "ถูกบล็อก" : "จะโดนบล็อก"}</span><div class="v">${misses.length} <small class="fl-muted">IP</small></div>
                    <div class="s">${misses.length ? "ดูรายการด้านล่างก่อนเปิดบล็อกจริง" : "ยังไม่เจอผู้เรียกที่ไม่มีสิทธิ์"}</div></div>
            </div>
            <div class="fl-fields">
                <div class="fl-field"><div class="fl-fl"><b>โหมด</b><span>เริ่มจากเฝ้าดู 1–2 วัน ถ้ารายการ “จะโดนบล็อก” มีแต่สิ่งที่ไม่ใช่ของเรา ค่อยเปลี่ยนเป็นบล็อกจริง</span></div>
                    <div class="fl-fctl"><div class="fl-seg" id="axMode"><button type="button" aria-pressed="${!enforce}" data-v="shadow">เฝ้าดู (shadow)</button>` +
                    `<button type="button" aria-pressed="${enforce}" data-v="enforce">บล็อกจริง</button></div><div id="axModeConfirm"></div></div></div>
                <div class="fl-field"><div class="fl-fl"><b>IP pass สำหรับ firmware เก่า</b>
                    <span>เครื่องที่อนุมัติแล้วเข้าได้จาก IP ที่รายงานตัวล่าสุด (${esc(a.window_min)} นาที) · ปิดได้เมื่อทุกเครื่องส่งกุญแจแล้ว (ช่อง ② = ${ok.length}/${ok.length})</span></div>
                    <div class="fl-fctl"><div class="fl-seg" id="axIp"><button type="button" aria-pressed="${a.allow_ip_pass}" data-v="1">เปิด</button>` +
                    `<button type="button" aria-pressed="${!a.allow_ip_pass}" data-v="0">ปิด</button></div><div id="axIpConfirm"></div></div></div>
            </div>
            ${a.updated_at ? `<p class="fl-note">แก้ล่าสุด ${esc(ts(a.updated_at))}${a.updated_by ? " โดย " + esc(a.updated_by) : ""}</p>` : ""}
        </div>
        <div class="fl-panel"><h2>เครื่องที่อนุมัติแล้ว เข้ามาด้วยวิธีไหน</h2>
            <p class="fl-lead">นับตั้งแต่ BellBeast เริ่มทำงานครั้งล่าสุด</p>
            <div class="fl-list"><div class="fl-ov hd"><span>เครื่อง</span><span>Firmware</span><span>เข้าด้วย</span><span>ครั้ง · API ล่าสุด</span><span>ล่าสุด</span></div>
            ${ok.length ? ok.map((d) => {
                const c = viaOf(d.id), [lbl, cls] = c ? VIA[c.via] || [c.via, "plain"] : ["ยังไม่เห็นเรียก API", "plain"];
                return `<button type="button" class="fl-ov" data-open="${esc(d.id)}">
                    <span class="fl-nm"><span class="fl-dot ${live(d)}"></span><span style="min-width:0"><b>${esc(dname(d))}</b><span class="fl-mono">${esc(d.id)}</span></span></span>
                    <span class="fl-mono">${esc(d.fw || "–")}</span><span><span class="fl-badge ${cls}">${esc(lbl)}</span></span>
                    <span class="fl-small fl-muted">${c ? `${esc(c.hits)} ครั้ง · <span class="fl-mono">${esc(c.last_route)}</span>` : "–"}</span>
                    <span class="fl-small">${c ? esc(ago(c.last_at)) : "–"}</span></button>`;
            }).join("") : '<div class="fl-ov"><span class="fl-muted" style="grid-column:1/-1">ยังไม่มีเครื่องที่อนุมัติแล้ว</span></div>'}</div></div>
        <div class="fl-panel"><h2>${enforce ? "ถูกบล็อก" : "จะโดนบล็อกถ้าเปิดบล็อกจริง"}</h2>
            <p class="fl-lead">IP ที่เรียก API ของอุปกรณ์โดยไม่มีสิทธิ์ — ถ้าเป็นของเราเอง (เช่น PC จอแสดงผล) ให้เพิ่ม IP pass ที่หน้า API Access แท็บ IP หรืออนุมัติเครื่องนั้นในแท็บอุปกรณ์</p>
            <div class="fl-list"><div class="fl-ov hd"><span>IP</span><span>ครั้ง</span><span>เหตุผล</span><span>API ล่าสุด</span><span>ล่าสุด</span></div>
            ${misses.length ? misses.map((m) => `<div class="fl-ov"><span class="fl-mono">${esc(m.ip)}</span><span>${esc(m.count)}</span>
                <span class="fl-small">${esc(MISS[m.reason] || m.reason)}</span><span class="fl-mono fl-small">${esc(m.last_route)}</span>
                <span class="fl-small">${esc(ago(m.last_at))} <button type="button" class="fl-btn sm" data-clear="${esc(m.ip)}" style="margin-left:6px">ล้าง</button></span></div>`).join("")
                : '<div class="fl-ov"><span class="fl-muted" style="grid-column:1/-1">ไม่มี</span></div>'}</div></div>`;

        const put = (body, msg) => run(async () => { access = await send("/api/admin/fleet/access", "PUT", body); }, msg);
        const confirmBox = (box, text, label, go) => {
            box.innerHTML = `<div class="fl-confirm" style="margin-top:8px"><span>${text}</span><button type="button" class="fl-btn sm">ยกเลิก</button><button type="button" class="fl-btn bad sm">${label}</button></div>`;
            box.querySelectorAll("button")[0].onclick = () => (box.innerHTML = "");
            box.querySelectorAll("button")[1].onclick = go;
        };
        $$("#axMode button").forEach((b) => b.onclick = () => {
            if ((b.dataset.v === "enforce") === enforce) return;
            if (b.dataset.v === "shadow") return put({ mode: "shadow" }, "กลับเป็นโหมดเฝ้าดูแล้ว · ไม่บล็อกใคร");
            confirmBox($("#axModeConfirm"), `เปิดบล็อกจริง? ${misses.length ? `<b>${misses.length} IP</b> ในรายการด้านล่างจะเรียก API ไม่ได้ทันที` : "ยังไม่พบผู้เรียกที่จะโดนบล็อก"}`,
                "เปิดบล็อกจริง", () => put({ mode: "enforce" }, "เปิดบล็อกจริงแล้ว"));
        });
        $$("#axIp button").forEach((b) => b.onclick = () => {
            const on = b.dataset.v === "1";
            if (on === a.allow_ip_pass) return;
            if (on) return put({ allow_ip_pass: true }, "เปิด IP pass แล้ว");
            confirmBox($("#axIpConfirm"), onIp.length ? `ยังมี <b>${onIp.length} เครื่อง</b> ที่ใช้ IP pass (${onIp.map((d) => esc(dname(d))).join(", ")}) ${enforce ? "จะเรียก API ไม่ได้ทันที" : "จะเข้ารายการ “จะโดนบล็อก”"}`
                : "ปิด IP pass? เครื่องต้องส่งกุญแจเครื่องเท่านั้น", "ปิด IP pass", () => put({ allow_ip_pass: false }, "ปิด IP pass แล้ว"));
        });
        $$("[data-clear]", v).forEach((b) => b.onclick = () =>
            run(async () => { access = await api("/api/admin/fleet/access/miss/" + encodeURIComponent(b.dataset.clear), { method: "DELETE" }); }, "ล้างแล้ว"));
        $$("[data-open]", v).forEach((b) => b.onclick = () => openDrawer(b.dataset.open));
    }

    // ── routing / loading ──
    const VIEWS = { devices: renderDevices, defaults: renderDefaults, wifi: renderWifi, firmware: renderFirmware, access: renderAccess, log: renderLog };
    function renderAll(force) {
        if (!data) return;
        renderStrip();
        $$(".fl-tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === view)));
        Object.keys(VIEWS).forEach((k) => ($("#v-" + k).hidden = k !== view));
        if (force || !viewDirty || view === "devices") VIEWS[view]();
    }
    function go(name) {
        if (!VIEWS[name]) name = "devices";
        if (name !== view) viewDirty = false;
        view = name;
        try { if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name); } catch { /* ignore */ }
        if (name === "log") loadEvents().then(() => renderAll(true)).catch((e) => toast(e.message, true));
        if (name === "access") loadAccess().then(() => renderAll(true)).catch((e) => toast(e.message, true));
        renderAll(true);
    }

    async function load() {
        data = await api("/api/admin/fleet");
        if (view === "log") await loadEvents();
        if (view === "access") await loadAccess();
        showErr("");
        $("#updated").textContent = "อัปเดต " + new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        renderAll(false);
    }

    $$(".fl-tab").forEach((t) => t.onclick = () => { if (t.dataset.tab === "devices") filter = "all"; go(t.dataset.tab); });
    $("#reload").onclick = () => load().catch((e) => showErr(e.message));
    window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (h !== view) go(h); });

    view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "devices";
    load().then(() => go(view)).catch((e) => showErr(e.message));
    setInterval(() => { if (document.visibilityState === "visible" && !drawerId) load().catch(() => { }); }, 30000);
})();
