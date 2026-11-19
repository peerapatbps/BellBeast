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
    let gfilter = "";         // devices list: "" all | "__none" ungrouped | group id
    let grouping = false;     // bulk "จัดกลุ่ม" panel open
    const grpSel = new Set(); // device ids ticked in that panel
    let grpTo = null;         // group picked in that panel (kept across the 30 s refresh)
    let grpNew = "";          // new group name being typed there
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
        firmware_in_use: "มีกลุ่มที่เลือกไฟล์นี้อยู่", firmware_pinned: "มีเครื่องที่ระบุไฟล์นี้เองอยู่", firmware_released: "ไฟล์นี้ปล่อยให้ Auto patcher อยู่ เลิกปล่อยก่อนจึงลบได้",
        bad_wifi: "ค่า WiFi ไม่ถูกต้อง", fw_board_mismatch: "ไฟล์นี้เป็นของบอร์ดอื่น ใช้กับเครื่องนี้ไม่ได้", bad_fw_mode: "ตัวเลือก firmware ไม่ถูกต้อง",
        group_not_found: "ไม่พบกลุ่มนี้แล้ว", bad_group_name: "ชื่อกลุ่มต้องมี 1–40 ตัวอักษร", group_name_taken: "มีกลุ่มชื่อนี้แล้ว",
        too_many_groups: "สร้างกลุ่มได้ไม่เกิน 50 กลุ่ม", auto_group_has_no_target: "Auto patcher เลือกไฟล์เองไม่ได้ (ใช้ “ปล่อย” ที่รายการไฟล์)",
        auto_group_is_built_in: "กลุ่ม Auto patcher ลบไม่ได้", no_devices: "เลือกเครื่องก่อน",
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
    const firmware = () => (data && data.ota && data.ota.firmware) || [];
    const released = () => (data && data.ota && data.ota.released) || {};
    const groups = () => (data && data.groups) || [];
    const groupOf = (id) => groups().find((g) => g.id === id) || null;
    const gname = (id) => (groupOf(id) || {}).name || "ยังไม่จัดกลุ่ม";
    // board = firmware label suffix: "183" = Spotpear 1.83, "" = MUMA 1.54, null = not known yet
    const bname = (b) => b === null || b === undefined ? "ยังไม่รู้บอร์ด" : b === "" ? "MUMA (ไม่มี suffix)" : b === "183" ? "1.83 (-183)" : "-" + b;
    const boardTag = (b) => `<span class="fl-badge plain fl-mono" title="บอร์ดจาก suffix ของ firmware">${esc(b === null || b === undefined ? "?" : b === "" ? "MUMA" : b)}</span>`;
    const fwFor = (b) => firmware().filter((f) => b === null || b === undefined || f.board === b);   // images a device may take
    const dname = (d) => d.name || "ยังไม่ได้ตั้งชื่อ";
    const zlist = (s) => (s || "").split(",").map((z) => z.trim()).filter(Boolean);

    // device value vs fleet default
    const FIELDS = [
        { k: "zones", label: "Zone ที่ให้ดัง", help: "เครื่องจะดังเฉพาะ alarm ของ zone ที่เลือก (alarm ที่ไม่มี zone ดังทุกเครื่อง)", kind: "zones" },
        { k: "volume", label: "ระดับเสียง", help: "0–100 · ว่าง = ใช้ค่าที่ตั้งไว้ในเครื่อง", unit: "%", min: 0, max: 100, nullable: true },
        { k: "remind_sec", label: "ดังซ้ำถ้ายังไม่มีคนรับทราบ ทุก", help: "0 = ดังครั้งเดียว", unit: "วินาที", min: 0, max: 3600 },
        { k: "poll_sec", label: "เช็ก alarm ใหม่ทุก", help: "ยิ่งถี่ยิ่งดังเร็ว แต่ใช้เครือข่ายมากขึ้น", unit: "วินาที", min: 1, max: 60, adv: true },
        { k: "lab_sec", label: "ดึงผลแล็บมาแสดงทุก", help: "ดึงทันทีอยู่แล้วเมื่อมี alarm แล็บใหม่หรือสถานการณ์เปลี่ยน", unit: "วินาที", min: 60, max: 3600, adv: true },
        { k: "scn_sec", label: "เช็กสถานการณ์/โรคระบาดทุก", help: "จาก LabVenture", unit: "วินาที", min: 10, max: 600, adv: true },
    ];
    const isCustom = (d, k) => d[k] !== null && d[k] !== undefined;
    const eff = (d, k) => isCustom(d, k) ? d[k] : defs()[k];
    const customList = (d) => FIELDS.filter((f) => isCustom(d, f.k)).map((f) => f.label)
        .concat(d.wifi ? ["รหัส WiFi"] : [], d.fw_mode === "override" ? ["ระบุ firmware เอง"] : [], d.fw_mode === "hold" ? ["ไม่อัปเดต firmware"] : []);
    const customCount = (d) => customList(d).length;
    const target = (d) => d.target_fw || null;                         // server resolves group / auto / override
    const behind = (d) => { const t = target(d); return !!t && d.fw !== t; };
    const NOTE = {
        board_mismatch: "ไฟล์คนละบอร์ด — ไม่ส่ง", not_released: "ยังไม่ได้ปล่อยไฟล์ของบอร์ดนี้", no_target: "ยังไม่เลือกไฟล์",
        unknown_board: "ยังไม่รู้บอร์ด (รอเครื่องรายงานตัว)", missing: "ไฟล์ถูกลบไปแล้ว",
    };
    // where the device's firmware comes from, in words: "กลุ่ม A → ann-1.4.0-183"
    function fwPlan(d) {
        const to = d.target_fw || NOTE[d.target_note] || "–";
        switch (d.target_source) {
            case "hold": return "ไม่อัปเดต (คงรุ่นเดิม)";
            case "override": return `ระบุเอง → ${to}`;
            case "auto": return `Auto patcher → ${to}`;
            case "group": return `กลุ่ม ${gname(d.group)} → ${to}`;
            default: return "ยังไม่จัดกลุ่ม → ไม่อัปเดต";
        }
    }
    function fmt(f, v) {
        if (f.kind === "zones") return zlist(v).length ? zlist(v).join(", ") : "ทุก zone";
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
        const grp = `<div class="fl-faint fl-small">${d.target_source === "override" ? "ระบุเอง" : d.target_source === "hold" ? "ไม่อัปเดต" : esc(gname(d.group))}</div>`;
        if (!d.fw) return '<span class="fl-faint">–</span>' + grp;
        const tag = d.target_source === "hold" ? '<span class="fl-badge plain">ไม่อัปเดต</span>'
            : behind(d) ? `<span class="fl-badge warn">รอ ${esc(target(d))}</span>` : "";
        return `<span class="fl-mono">${esc(d.fw)}</span> ${tag}${grp}`;
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
        const ungrouped = ok.filter((d) => !d.group).length;
        const tiles = [
            ["all", "", '<span class="fl-dot on"></span>ทำงานปกติ', `${on} <small>/ ${ok.length}</small>`, "ติดต่อได้ใน 3 นาที"],
            ["lost", lost ? "t-bad" : "", '<span class="fl-dot off"></span>ขาดการติดต่อ', lost, lost ? "กดเพื่อดูเครื่อง" : "ไม่มี"],
            ["pending", pend ? "t-warn" : "", '<span class="fl-dot pend"></span>รออนุมัติ', pend, pend ? "เครื่องใหม่" : "ไม่มี"],
            ["behind", beh ? "t-warn" : "", "รออัปเดต firmware", beh, ungrouped ? `ยังไม่จัดกลุ่ม ${ungrouped} เครื่อง` : `${groups().length} กลุ่ม`],
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
                    <input class="fl-search" id="q" placeholder="ค้นหาชื่อ, รหัสเครื่อง, zone, IP, firmware" autocomplete="off">
                    <select class="fl-search" id="gfilter" style="max-width:220px" title="กรองตามกลุ่ม"></select>
                    <div class="fl-chipset" id="fchips"></div>
                    <span style="flex:1"></span>
                    <button type="button" class="fl-btn" id="grpToggle">จัดกลุ่ม…</button>
                </div>
                <div id="grpbox"></div>
                <div class="fl-list" id="devlist"></div>
                <p class="fl-note" style="margin-top:10px">กดที่เครื่องเพื่อดูรายละเอียด แก้ชื่อ/zone/เสียง หรือจัดการเครื่อง · ข้อมูลรีเฟรชเองทุก 30 วินาที</p>`;
            $("#q").oninput = (e) => { query = e.target.value.trim().toLowerCase(); renderDeviceList(); };
            $("#gfilter").onchange = (e) => { gfilter = e.target.value; renderDeviceList(); };
            $("#grpToggle").onclick = () => { grouping = !grouping; renderDeviceList(); };
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

        const fchips = [["all", "ทั้งหมด"], ["lost", "ขาดการติดต่อ"], ["behind", "รออัปเดต firmware"]];
        $("#fchips").innerHTML = fchips.map(([f, l]) => `<button type="button" class="fl-chip" aria-pressed="${filter === f}" data-f="${f}">${l}</button>`).join("");
        $$("#fchips .fl-chip").forEach((b) => b.onclick = () => { filter = b.dataset.f; renderStrip(); renderDeviceList(); });
        const ok = approved();
        if (gfilter && gfilter !== "__none" && !groupOf(gfilter)) gfilter = "";
        $("#gfilter").innerHTML = `<option value="">ทุกกลุ่ม</option><option value="__none" ${gfilter === "__none" ? "selected" : ""}>ยังไม่จัดกลุ่ม (${ok.filter((d) => !d.group).length})</option>` +
            groups().map((g) => `<option value="${esc(g.id)}" ${gfilter === g.id ? "selected" : ""}>${esc(g.name)} (${g.members.length})</option>`).join("");
        renderGrouping();

        let list = ok;
        if (filter === "lost") list = list.filter((d) => live(d) !== "on");
        if (filter === "behind") list = list.filter(behind);
        if (gfilter) list = list.filter((d) => gfilter === "__none" ? !d.group : d.group === gfilter);
        if (query) list = list.filter((d) => [d.id, d.name, eff(d, "zones"), d.ip, d.fw, gname(d.group)].join(" ").toLowerCase().includes(query));

        const empty = !approved().length ? "ยังไม่มีเครื่องที่อนุมัติแล้ว" : "ไม่มีเครื่องตรงกับตัวกรอง";
        $("#devlist").innerHTML = `<div class="fl-lrow hd"><span>เครื่อง</span><span>Zone ที่ดัง</span><span>Firmware · กลุ่ม</span><span>สัญญาณ</span><span>Alarm ที่ดังล่าสุด</span><span>ติดต่อล่าสุด</span><span></span></div>` +
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
    // bulk: tick devices → pick a group → move (the selection survives the 30 s refresh)
    function renderGrouping() {
        const box = $("#grpbox");
        $("#grpToggle").setAttribute("aria-pressed", String(grouping));
        if (!grouping) { box.innerHTML = ""; return; }
        const ok = approved();
        [...grpSel].forEach((id) => { if (!ok.some((d) => d.id === id)) grpSel.delete(id); });
        box.innerHTML = `<div class="fl-panel" style="margin-bottom:12px"><h2>จัดกลุ่มอุปกรณ์</h2>
            <p class="fl-lead">ระบบไม่รู้ว่าเครื่องไหนติดตั้งที่ไหนหรือควรได้ firmware ตัวไหน — เลือกเครื่องแล้วย้ายเข้ากลุ่ม · เครื่องที่ยังไม่จัดกลุ่มจะไม่อัปเดต firmware
                · กลุ่ม <b style="color:var(--fl-fg)">Auto patcher</b> ได้ไฟล์ล่าสุดที่ปล่อยของบอร์ดตัวเองเสมอ</p>
            <div class="fl-toolbar"><button type="button" class="fl-link" data-sel="all">เลือกทั้งหมด</button> ·
                <button type="button" class="fl-link" data-sel="none">ที่ยังไม่จัดกลุ่ม</button> ·
                <button type="button" class="fl-link" data-sel="clear">ล้างที่เลือก</button></div>
            <div class="fl-list" style="max-height:320px;overflow:auto">${ok.length ? ok.map((d) => `<label class="fl-ov" style="grid-template-columns:24px minmax(0,2fr) minmax(0,1fr) minmax(0,1.4fr) minmax(0,1.4fr);cursor:pointer">
                <input type="checkbox" data-gsel="${esc(d.id)}" ${grpSel.has(d.id) ? "checked" : ""}>
                <span class="fl-nm"><span class="fl-dot ${live(d)}"></span><span style="min-width:0"><b>${esc(dname(d))}</b><span class="fl-mono">${esc(d.id)}</span></span></span>
                <span>${boardTag(d.board)}</span><span class="fl-mono fl-small">${esc(d.fw || "–")}</span>
                <span class="fl-small ${d.group ? "" : "c-warn"}">${esc(gname(d.group))}</span></label>`).join("")
                : '<div class="fl-ov"><span class="fl-muted">ยังไม่มีเครื่องที่อนุมัติแล้ว</span></div>'}</div>
            <div class="fl-toolbar" style="margin-top:12px">
                <span class="fl-note">เลือก <b style="color:var(--fl-fg)" id="gselN">${grpSel.size}</b> เครื่อง → ย้ายเข้า</span>
                <select class="fl-search" id="gto" style="max-width:240px"><option value="">— เลือกกลุ่ม —</option>${groups().map((g) =>
                    `<option value="${esc(g.id)}" ${grpTo === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}<option value="none" ${grpTo === "none" ? "selected" : ""}>— เอาออกจากกลุ่ม —</option></select>
                <button type="button" class="fl-btn primary" id="gmove">ย้าย</button>
                <span style="flex:1"></span>
                <input class="fl-finput" id="gnew" maxlength="40" placeholder="ชื่อกลุ่มใหม่ เช่น 1.83 อาคาร A" style="max-width:240px" value="${esc(grpNew)}">
                <button type="button" class="fl-btn" id="gcreate">สร้างกลุ่ม</button>
            </div></div>`;
        $$("[data-gsel]", box).forEach((cb) => cb.onchange = () => { cb.checked ? grpSel.add(cb.dataset.gsel) : grpSel.delete(cb.dataset.gsel); $("#gselN").textContent = grpSel.size; });
        $$("[data-sel]", box).forEach((b) => b.onclick = () => {
            if (b.dataset.sel === "clear") grpSel.clear();
            else ok.filter((d) => b.dataset.sel === "all" || !d.group).forEach((d) => grpSel.add(d.id));
            renderGrouping();
        });
        $("#gto").onchange = (e) => { grpTo = e.target.value || null; };
        $("#gnew").oninput = (e) => { grpNew = e.target.value; };
        $("#gmove").onclick = () => {
            if (!grpSel.size) { toast("เลือกเครื่องก่อน", true); return; }
            const to = $("#gto").value, n = grpSel.size;
            if (!to) { toast("เลือกกลุ่มปลายทางก่อน", true); return; }
            run(() => send("/api/admin/fleet/groups/" + encodeURIComponent(to) + "/devices", "POST", { devices: [...grpSel] }),
                to === "none" ? `เอา ${n} เครื่องออกจากกลุ่มแล้ว` : `ย้าย ${n} เครื่องเข้า ${gname(to)} แล้ว · เครื่องจะเช็ก firmware ในรอบถัดไป`, () => { grpSel.clear(); grpTo = null; });
        };
        $("#gcreate").onclick = async () => {
            const name = $("#gnew").value.trim();
            if (!name) { toast("ใส่ชื่อกลุ่มก่อน", true); return; }
            // the new group becomes the move target, so "สร้าง → ติ๊ก → ย้าย" needs no extra pick
            run(async () => { const j = await send("/api/admin/fleet/groups", "POST", { name }); grpTo = j.id; grpNew = ""; }, "สร้างกลุ่ม " + name + " แล้ว");
        };
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
    // per-device WiFi password (no fleet-wide set). Without one the device uses the password list built into the
    // firmware ("bypass": it tries them in turn). SSID / identity are kept for later firmware — ann-1.4.0 uses its own.
    function wifiFields(p, w) {
        return `<div class="fl-form">
            <label><b>รหัสปัจจุบัน</b><input class="fl-finput" id="${p}Current" type="password" autocomplete="new-password" placeholder="${w ? "เว้นว่าง = ไม่เปลี่ยน (" + esc(w.current || "") + ")" : "เว้นว่าง = ไม่ตั้ง (ใช้ bypass)"}"></label>
            <label><b>รหัสถัดไป</b><input class="fl-finput" id="${p}Next" type="password" autocomplete="new-password" placeholder="${w && w.next ? "เว้นว่าง = ไม่เปลี่ยน (" + esc(w.next) + ")" : "ไม่บังคับ"}"></label>
            <label><b>เริ่มใช้รหัสถัดไปเมื่อ</b><input class="fl-finput" id="${p}From" type="datetime-local" value="${localDT(w && w.next_valid_from)}"></label>
        </div>
        <details class="fl-adv"><summary>SSID / identity</summary><div class="fl-form">
            <label><b>ชื่อ WiFi (SSID)</b><input class="fl-finput" id="${p}Ssid" maxlength="32" value="${esc(w ? w.ssid : ".@MWA WiFi")}"></label>
            <label><b>Identity (ชื่อผู้ใช้)</b><input class="fl-finput" id="${p}Identity" maxlength="64" value="${esc(w ? w.identity || "" : "")}"></label>
        </div><p class="fl-note" style="margin:6px 0 0">firmware ann-1.4.0 ใช้ SSID / identity ที่ฝังในเครื่อง — เก็บไว้สำหรับ firmware รุ่นถัดไป</p></details>`;
    }
    /** null = nothing typed and nothing set yet (leave the device on bypass). */
    function readWifi(p, w) {
        const cur = $(`#${p}Current`).value, nx = $(`#${p}Next`).value;
        if (!w && !cur && !nx) return null;
        const body = { ssid: $(`#${p}Ssid`).value.trim(), identity: $(`#${p}Identity`).value };
        if (!body.ssid) throw new Error(ERR.bad_ssid);
        if (cur) body.current = cur; else if (!w) throw new Error(ERR.bad_current);
        if (nx) body.next = nx;
        body.next_valid_from = $(`#${p}From`).value ? new Date($(`#${p}From`).value).toISOString() : null;
        return body;
    }
    const nextIn = (w) => {
        if (!w || !w.next) return "ไม่มีรหัสถัดไป";
        if (!w.next_valid_from) return "รหัสถัดไป: ใช้ได้ทันที";
        const dn = Math.ceil((new Date(w.next_valid_from).getTime() - Date.now()) / 86400000);
        return dn > 0 ? `รหัสถัดไป: อีก ${dn} วัน` : "รหัสถัดไป: ถึงเวลาแล้ว";
    };
    const tierCell = (d) => d.wifi_tier === "known" ? '<span class="c-ok">รหัสที่ตั้งไว้</span>'
        : d.wifi_tier === "bootstrap" ? '<span class="c-warn">bypass</span>' : '<span class="fl-faint">–</span>';

    // what a group would give this device, in words (for the drawer's "ตามกลุ่ม" option)
    function groupGives(gid, board) {
        const g = groupOf(gid);
        if (!g) return "ยังไม่จัดกลุ่ม → ไม่อัปเดต";
        if (g.auto) return board === null || board === undefined ? "Auto patcher → รอรู้บอร์ด" : `Auto patcher → ${released()[board] || "ยังไม่ปล่อยไฟล์ของบอร์ดนี้"}`;
        if (!g.target) return `${g.name} → ยังไม่เลือกไฟล์`;
        const f = firmware().find((x) => x.version === g.target);
        return `${g.name} → ${g.target}${f && board !== null && board !== undefined && f.board !== board ? " (คนละบอร์ด — ไม่ส่ง)" : ""}`;
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
                    <p class="fl-note" style="margin:0 0 6px">บอร์ด ${boardTag(d.board)} ${esc(bname(d.board))} (จาก firmware ที่เครื่องรัน) · ตอนนี้: <b style="color:var(--fl-fg)">${esc(fwPlan(d))}</b></p>
                    <div class="fl-field" style="border-top:0"><div class="fl-fl"><b>กลุ่ม</b><span>กลุ่มเลือกไฟล์ให้ทุกเครื่องในกลุ่ม · จัดหลายเครื่องพร้อมกันได้ที่แท็บอุปกรณ์ → จัดกลุ่ม</span></div>
                        <div class="fl-fctl"><span class="fl-inp"><select id="c-group" style="max-width:300px"><option value="">— ยังไม่จัดกลุ่ม —</option>${groups().map((g) =>
                            `<option value="${esc(g.id)}" ${d.group === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></span></div></div>
                    <div class="fl-field"><div class="fl-fl"><b>Firmware ของเครื่องนี้</b><span>ตามกลุ่ม หรือ override เฉพาะเครื่อง (เลือกได้เฉพาะไฟล์ของบอร์ดเดียวกัน)</span></div>
                        <div class="fl-fctl"><div class="fl-seg" id="c-fwmode">${[["group", "ตามกลุ่ม"], ["override", "ระบุไฟล์เอง"], ["hold", "ไม่อัปเดต"]].map(([k, l]) =>
                            `<button type="button" data-m="${k}" aria-pressed="${(d.fw_mode || "group") === k}">${l}</button>`).join("")}</div>
                        <span class="fl-note" id="c-fwgroup"></span>
                        <span class="fl-inp" id="c-fwov" hidden><select id="c-fwfile" style="max-width:300px">${fwFor(d.board).map((f) =>
                            `<option value="${esc(f.version)}" ${d.fw_override === f.version ? "selected" : ""}>${esc(f.version)}${f.note ? " · " + esc(f.note) : ""}</option>`).join("") ||
                            '<option value="">ยังไม่มีไฟล์ของบอร์ดนี้ (อัปโหลดที่แท็บอัปเดต Firmware)</option>'}</select></span></div></div>
                </div>
                <div class="fl-dr-sec"><h3>WiFi</h3>
                    <p class="fl-note" style="margin:0 0 10px">${d.wifi ? `ตั้งรหัสไว้แล้ว · ${esc(nextIn(d.wifi))} · แก้ล่าสุด ${esc(ts(d.wifi.updated_at))}`
                        : "ยังไม่ได้ตั้งรหัส — เครื่องใช้ <b>bypass</b> (ไล่ลองรหัสที่ฝังใน firmware)"} · ตอนนี้ต่อด้วย ${tierCell(d)}</p>
                    <div id="c-wifi">${wifiFields("dw", d.wifi)}
                        ${d.wifi ? '<label class="fl-note" style="display:flex;gap:6px;align-items:center;margin-top:10px"><input type="checkbox" id="c-wifi-clear"> ล้างรหัสของเครื่องนี้ (กลับไปใช้ bypass)</label>' : ""}</div>
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
        const fwMode = () => ($('#c-fwmode [aria-pressed="true"]') || {}).dataset?.m || "group";
        const syncFw = () => {
            const m = fwMode();
            $("#c-fwov").hidden = m !== "override";
            $("#c-fwgroup").hidden = m !== "group";
            $("#c-fwgroup").textContent = "จะได้: " + groupGives($("#c-group").value || null, d.board);
        };
        $$("#c-fwmode button").forEach((b) => b.onclick = () => {
            $$("#c-fwmode button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
            syncFw(); dirty();
        });
        $("#c-group").onchange = syncFw;
        syncFw();

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
                patch.group = $("#c-group").value || null;
                patch.fw_mode = fwMode();
                if (patch.fw_mode === "override") {
                    if (!$("#c-fwfile").value) throw new Error("ยังไม่มีไฟล์ของบอร์ดนี้ให้เลือก");
                    patch.fw_override = $("#c-fwfile").value;
                }
                if ($("#c-wifi-clear") && $("#c-wifi-clear").checked) patch.wifi = null;
                else { const w = readWifi("dw", d.wifi); if (w) patch.wifi = w; }
            } catch (e) { toast(e.message, true); return; }
            const save = () => run(() => send(devUrl(d.id), "POST", patch), "บันทึก " + (patch.name.trim() || d.id) + " แล้ว · เครื่องจะรับค่าใหม่ในรอบถัดไป", closeDrawer);
            const fwChanged = patch.group !== (d.group || null) || patch.fw_mode !== (d.fw_mode || "group") ||
                (patch.fw_mode === "override" && patch.fw_override !== d.fw_override);
            if (!fwChanged) return save();
            // firmware plan changes → confirm first (the device installs it on its next OTA check)
            const gives = patch.fw_mode === "hold" ? "ไม่อัปเดต (คงรุ่นเดิม)" : patch.fw_mode === "override" ? "ระบุเอง → " + patch.fw_override : groupGives(patch.group, d.board);
            $("#dstate").innerHTML = `<span class="c-warn">ยืนยัน firmware: <b>${esc(gives)}</b> · ถ้าเป็นรุ่นใหม่ เครื่องจะติดตั้งในรอบเช็กถัดไป (≤ 30 นาที)</span>`;
            $("#dsave").textContent = "ยืนยันและบันทึก";
            $("#dsave").onclick = save;
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
        const ownWifi = ok.filter((d) => d.wifi).length, own = ok.filter((d) => d.fw_mode && d.fw_mode !== "group").length;
        v.innerHTML = `<div class="fl-panel"><h2>ค่าตั้งกลาง</h2>
            <p class="fl-lead">ทุกเครื่องใช้ค่ากลางเป็นพื้นฐาน แล้ว “กำหนดเอง” ทับได้รายเครื่องที่แผงตั้งค่าของเครื่อง ลำดับที่เครื่องได้รับ:</p>
            <div class="fl-stages">
                <div class="fl-stage"><span class="k"><span class="fl-stepn">1</span>ค่าเสียง / zone / รอบดึงข้อมูล</span><div class="s" style="margin-top:4px">ค่ากลางในหน้านี้ → ทับได้รายเครื่อง</div></div>
                <div class="fl-stage"><span class="k"><span class="fl-stepn">2</span>WiFi</span><div class="s" style="margin-top:4px">รหัสรายเครื่องเท่านั้น (ไม่มีค่ากลาง) → ไม่ได้ตั้ง = bypass · ตั้งแล้ว ${ownWifi}/${ok.length} เครื่อง</div></div>
                <div class="fl-stage"><span class="k"><span class="fl-stepn">3</span>Firmware</span><div class="s" style="margin-top:4px">กลุ่มของเครื่อง (แท็บอัปเดต Firmware) → override รายเครื่อง ${own} เครื่อง · ไม่จัดกลุ่ม = ไม่อัปเดต</div></div>
            </div>
            <div class="fl-fields">${FIELDS.filter((f) => !f.adv).map(row).join("")}</div>
            <details class="fl-adv"><summary>ตั้งค่าขั้นสูง (รอบการดึงข้อมูล)</summary><div class="fl-fields">${FIELDS.filter((f) => f.adv).map(row).join("")}</div></details>
            <div style="display:flex;gap:10px;align-items:center;margin-top:14px"><button type="button" class="fl-btn primary" id="dsaveall">บันทึกค่ากลาง</button>
            <span class="fl-note" id="ddirty"></span></div></div>
            <div class="fl-panel"><h2>ภาพรวมรายเครื่อง</h2>
                <p class="fl-lead">แต่ละเครื่องได้ค่าอะไรจริง · กดที่แถวเพื่อแก้</p>
                <div class="fl-list">
                    <div class="fl-ov hd"><span>เครื่อง</span><span>บอร์ด · กลุ่ม</span><span>WiFi</span><span>Firmware ที่จะได้</span><span>ตั้งเองต่างจากค่ากลาง</span></div>
                    ${ok.length ? ok.map((d) => `<button type="button" class="fl-ov" data-open="${esc(d.id)}">
                        <span class="fl-nm"><span class="fl-dot ${live(d)}"></span><span style="min-width:0"><b>${esc(dname(d))}</b><span class="fl-mono">${esc(d.id)}</span></span></span>
                        <span>${boardTag(d.board)} <span class="fl-small ${d.group ? "" : "c-warn"}">${esc(gname(d.group))}</span></span>
                        <span>${d.wifi ? '<span class="fl-badge info">ตั้งรหัสแล้ว</span>' : '<span class="fl-badge warn">bypass</span>'}</span>
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

    // ── wifi (per device only; no password set = bypass) ──
    function renderWifi() {
        const ok = approved();
        const set = ok.filter((d) => d.wifi);
        const onKnown = ok.filter((d) => d.wifi_tier === "known").length;
        const onBypass = ok.filter((d) => d.wifi_tier === "bootstrap");
        const v = $("#v-wifi");
        v.innerHTML = `<div class="fl-panel"><h2>รหัส WiFi รายเครื่อง</h2>
            <p class="fl-lead">ไม่มีรหัสกลาง — ตั้งรหัสให้แต่ละเครื่องที่แผงตั้งค่าของเครื่อง · เครื่องที่ไม่ได้ตั้ง หรือรหัสที่ตั้งต่อไม่ได้ จะใช้ <b style="color:var(--fl-fg)">bypass</b>
                (ไล่ลองรายการรหัสที่ฝังใน firmware) · ส่งให้เฉพาะเครื่องที่อนุมัติแล้ว</p>
            <div class="fl-flow">
                <div class="fl-step now"><span class="k">① รหัสปัจจุบันของเครื่อง</span><span class="v">ตั้งรายเครื่อง</span>
                    <span class="fl-note">ตั้งแล้ว ${set.length} จาก ${ok.length} เครื่อง</span></div>
                <span class="fl-arrow">→</span>
                <div class="fl-step"><span class="k">② รหัสถัดไปของเครื่อง</span><span class="v">ตั้งล่วงหน้าได้</span>
                    <span class="fl-note">เครื่องสลับไปใช้เองตามวันเวลาที่กำหนด ก่อน IT เปลี่ยนรหัส</span></div>
                <span class="fl-arrow">→</span>
                <div class="fl-step"><span class="k">③ bypass</span><span class="v">รายการรหัสใน firmware</span>
                    <span class="fl-note">ใช้เมื่อไม่ได้ตั้ง หรือ ① ② ต่อไม่ได้ · แก้จากหน้านี้ไม่ได้</span></div>
            </div>
            <p class="fl-note">ตอนนี้ <b style="color:var(--fl-fg)">${onKnown} จาก ${ok.length}</b> เครื่องต่อด้วยรหัสที่ตั้งไว้ ·
                ${onBypass.length ? `<span class="c-warn">${onBypass.length} เครื่องต่อด้วย bypass (${onBypass.map((d) => esc(dname(d))).join(", ")})</span>` : "ไม่มีเครื่องที่ต่อด้วย bypass"}</p>
            <div class="fl-list">
                <div class="fl-ov hd" style="grid-template-columns:minmax(0,2fr) minmax(0,1.3fr) minmax(0,1.6fr) minmax(0,1.2fr) minmax(0,1fr)"><span>เครื่อง</span><span>รหัสที่ตั้ง</span><span>รหัสถัดไป</span><span>ตอนนี้ต่อด้วย</span><span>แก้ล่าสุด</span></div>
                ${ok.length ? ok.map((d) => `<button type="button" class="fl-ov" data-open="${esc(d.id)}" style="grid-template-columns:minmax(0,2fr) minmax(0,1.3fr) minmax(0,1.6fr) minmax(0,1.2fr) minmax(0,1fr)">
                    <span class="fl-nm"><span class="fl-dot ${live(d)}"></span><span style="min-width:0"><b>${esc(dname(d))}</b><span class="fl-mono">${esc(d.id)}</span></span></span>
                    <span>${d.wifi ? `<span class="fl-mono fl-muted">${esc(d.wifi.current || "–")}</span>` : '<span class="fl-badge warn">ไม่ได้ตั้ง → bypass</span>'}</span>
                    <span class="fl-small fl-muted">${d.wifi ? esc(nextIn(d.wifi)) : "–"}</span>
                    <span class="fl-small">${tierCell(d)}</span>
                    <span class="fl-small fl-muted">${d.wifi ? esc(ago(d.wifi.updated_at)) : "–"}</span></button>`).join("")
                    : '<div class="fl-ov"><span class="fl-muted" style="grid-column:1/-1">ยังไม่มีเครื่องที่อนุมัติแล้ว</span></div>'}
            </div>
            <p class="fl-note" style="margin-top:10px">กดที่เครื่องเพื่อตั้ง / เปลี่ยน / ล้างรหัส</p>
            <details class="fl-warnbox"><summary>ข้อควรระวัง</summary>
                <p style="margin:8px 0 0">BellBeast ยังไม่มี TLS รหัสจึงส่งผ่าน LAN แบบไม่เข้ารหัส · ทุกเครื่องยังใช้ username พนักงานคนเดียว (ฝังใน firmware)
                    ซึ่งจำกัดจำนวนเครื่องที่ต่อพร้อมกัน — ระยะยาวควรขอบัญชี IoT แยก หรือ SSID เฉพาะอุปกรณ์จาก IT</p></details>
        </div>`;
        $$("[data-open]", v).forEach((b) => b.onclick = () => openDrawer(b.dataset.open));
    }

    // ── firmware: groups (top) + uploaded images (bottom) ──
    // A group points at one image; "ยืนยัน" applies it to every member at once (no rolling). Auto patcher follows
    // the newest image released for each board. A device's own override / hold is set in its drawer.
    function renderFirmware() {
        const ok = approved(), fws = firmware(), rel = released();
        const membersOf = (g) => ok.filter((d) => d.group === g.id);
        const v = $("#v-firmware");
        const confirmIn = (host, html, label, go) => {
            host.innerHTML = `<div class="fl-confirm" style="margin-top:8px"><span>${html}</span><button type="button" class="fl-btn sm">ยกเลิก</button><button type="button" class="fl-btn primary sm">${label}</button></div>`;
            host.querySelectorAll("button")[0].onclick = () => { host.innerHTML = ""; viewDirty = false; };
            host.querySelectorAll("button")[1].onclick = go;
            viewDirty = true;
        };
        const status = (mem) => {
            const want = mem.filter((d) => d.target_fw);
            const done = want.filter((d) => d.fw === d.target_fw).length;
            return want.length ? `อัปเดตแล้ว ${done}/${want.length} เครื่อง` : "ไม่มีเครื่องที่ต้องอัปเดต";
        };
        const groupRow = (g) => {
            const mem = membersOf(g);
            const boards = [...new Set(mem.map((d) => d.board))];
            const names = mem.map((d) => esc(dname(d))).join(", ") || '<span class="fl-faint">ยังไม่มีเครื่อง</span>';
            if (g.auto) {
                const relTxt = Object.keys(rel).length ? Object.entries(rel).map(([b, ver]) => `${boardTag(b)} <span class="fl-mono">${esc(ver)}</span>`).join(" · ")
                    : '<span class="fl-faint">ยังไม่ได้ปล่อยไฟล์ใด (ปล่อยได้ที่รายการไฟล์ด้านล่าง)</span>';
                return `<div class="fl-fwrow"><div><div class="ver" style="font-family:inherit">Auto patcher <span class="fl-badge info">อัตโนมัติ</span></div>
                        <div class="fl-faint fl-small">${mem.length} เครื่อง</div></div>
                    <div><div>ได้ไฟล์ล่าสุดที่ปล่อยของบอร์ดตัวเอง: ${relTxt}</div><div class="fl-note">${names} · ${status(mem)}</div></div>
                    <div class="acts"></div></div>`;
            }
            const opts = `<option value="">— ไม่อัปเดต —</option>` + fws.map((f) => {
                const off = mem.filter((d) => d.board !== null && d.board !== undefined && d.board !== f.board).length;
                return `<option value="${esc(f.version)}" ${g.target === f.version ? "selected" : ""}>${esc(f.version)} · ${esc(bname(f.board))}${off ? ` (คนละบอร์ดกับ ${off} เครื่อง)` : ""}</option>`;
            }).join("");
            return `<div class="fl-fwrow" data-g="${esc(g.id)}"><div><div class="ver" style="font-family:inherit">${esc(g.name)}</div>
                    <div class="fl-faint fl-small">${mem.length} เครื่อง${boards.length ? " · บอร์ด " + boards.map(boardTag).join(" ") : ""}</div></div>
                <div><div>ไฟล์: ${g.target ? `<span class="fl-mono">${esc(g.target)}</span>` : '<span class="fl-faint">ไม่อัปเดต</span>'}
                    ${g.updated_at ? `<span class="fl-faint fl-small"> · ตั้งเมื่อ ${esc(ago(g.updated_at))}${g.updated_by ? " โดย " + esc(g.updated_by) : ""}</span>` : ""}</div>
                    <div class="fl-note">${names} · ${status(mem)}</div><div class="gconfirm" style="grid-column:1/-1"></div></div>
                <div class="acts"><span class="fl-inp"><select class="gtarget" style="max-width:260px">${opts}</select></span>
                    <button type="button" class="fl-btn primary sm" data-gapply>ยืนยัน…</button>
                    <button type="button" class="fl-btn ghost-bad sm" data-gdel>ลบ…</button></div></div>`;
        };
        const fileRow = (f) => {
            const isRel = rel[f.board] === f.version;
            const inGroups = groups().filter((g) => !g.auto && g.target === f.version).map((g) => esc(g.name));
            const ovr = ok.filter((d) => d.fw_mode === "override" && d.fw_override === f.version);
            const running = ok.filter((d) => d.fw === f.version);
            const used = [inGroups.length ? "กลุ่ม " + inGroups.join(", ") : "", ovr.length ? `ระบุเอง ${ovr.length} เครื่อง` : "", isRel ? "Auto patcher" : ""].filter(Boolean).join(" · ");
            return `<div class="fl-fwrow" data-f="${esc(f.version)}"><div><div class="ver">${esc(f.version)} ${boardTag(f.board)}</div>
                    <div class="fl-faint fl-small">${esc(ts(f.uploaded_at))} · ${(f.size / 1048576).toFixed(2)} MB · <span class="fl-mono" title="sha256">${esc((f.sha256 || "").slice(0, 12))}…</span></div></div>
                <div><div>${f.note ? esc(f.note) : '<span class="fl-faint">ไม่มีหมายเหตุ</span>'}</div>
                    <div class="fl-note">${used ? "ใช้โดย: " + used : "ยังไม่มีใครใช้"} · รันอยู่ ${running.length} เครื่อง</div><div class="fconfirm"></div></div>
                <div class="acts">${isRel ? '<span class="fl-badge ok">Auto patcher ใช้อยู่</span><button type="button" class="fl-btn sm" data-unrel>เลิกปล่อย</button>'
                    : '<button type="button" class="fl-btn sm" data-rel>ปล่อยให้ Auto patcher…</button>'}
                    ${!used ? '<button type="button" class="fl-btn ghost-bad sm" data-fdel>ลบ…</button>' : ""}</div></div>`;
        };
        v.innerHTML = `<div class="fl-panel"><h2>กลุ่ม Firmware</h2>
            <p class="fl-lead">เลือกไฟล์ให้กลุ่ม แล้วกด <b style="color:var(--fl-fg)">ยืนยัน</b> — ทุกเครื่องในกลุ่มจะอัปเดตพร้อมกันในรอบเช็กถัดไป (2 นาทีหลังบูต แล้วทุก 30 นาที) ·
                เครื่องจะไม่ได้ไฟล์ของบอร์ดอื่น · เครื่องที่ตั้ง “ระบุไฟล์เอง” หรือ “ไม่อัปเดต” ในแผงเครื่องจะไม่ตามกลุ่ม · จัดเครื่องเข้ากลุ่มได้ที่แท็บอุปกรณ์ → จัดกลุ่ม</p>
            <div>${groups().map(groupRow).join("")}</div>
            <div class="fl-toolbar" style="margin-top:12px"><input class="fl-finput" id="fwgnew" maxlength="40" placeholder="ชื่อกลุ่มใหม่ เช่น 1.83 อาคาร A" style="max-width:260px">
                <button type="button" class="fl-btn" id="fwgcreate">สร้างกลุ่ม</button>
                <span class="fl-note">ยังไม่จัดกลุ่ม ${ok.filter((d) => !d.group).length} เครื่อง (ไม่อัปเดต)</span></div>
        </div>
        <div class="fl-panel"><h2>ไฟล์ Firmware</h2>
            <p class="fl-lead">บอร์ดอ่านจาก suffix ของเลขรุ่นในไฟล์: <span class="fl-mono">ann-1.4.0-183</span> = 1.83 · <span class="fl-mono">ann-1.4.0</span> = MUMA ·
                “ปล่อยให้ Auto patcher” = เครื่องในกลุ่ม Auto patcher ที่เป็นบอร์ดนี้จะอัปเดตเป็นไฟล์นี้ทันที</p>
            <div class="fl-drop"><div class="grow"><b>อัปโหลดไฟล์ใหม่</b>
                <div class="fl-note">ไฟล์ <span class="fl-mono">build/xiaozhi.bin</span> · ระบบอ่านเลขรุ่นจากไฟล์ให้เอง</div></div>
                <input type="file" id="fwFile" accept=".bin">
                <input class="fl-finput" id="fwNote" placeholder="หมายเหตุ เช่น แก้อะไร" style="max-width:240px">
                <details style="font-size:13px"><summary class="fl-muted" style="cursor:pointer">ระบุเลขรุ่นเอง</summary>
                    <input class="fl-finput" id="fwVersion" placeholder="ต้องตรงกับ PROJECT_VER" style="max-width:200px;margin-top:6px"></details>
                <button type="button" class="fl-btn primary" id="fwUpload">อัปโหลด</button></div>
            <p class="fl-note" style="margin:0 0 6px">เครื่องจะไม่อัปเดตระหว่างมี alarm ที่ยังไม่รับทราบ · ถ้ารุ่นใหม่ดึง alarm ไม่สำเร็จใน 5 นาที เครื่องจะย้อนกลับรุ่นเดิมเอง</p>
            <div>${fws.length ? fws.map(fileRow).join("") : '<p class="fl-note">ยังไม่มีไฟล์ firmware</p>'}</div>
        </div>`;
        v.oninput = () => (viewDirty = true);
        v.onchange = () => (viewDirty = true);

        $$("[data-g]", v).forEach((row) => {
            const g = groupOf(row.dataset.g), mem = membersOf(g);
            $("[data-gapply]", row).onclick = () => {
                const ver = $(".gtarget", row).value || null;
                const f = fws.find((x) => x.version === ver);
                const off = f ? mem.filter((d) => d.board !== null && d.board !== undefined && d.board !== f.board) : [];
                const follow = mem.filter((d) => (d.fw_mode || "group") === "group");
                const will = follow.filter((d) => !off.includes(d) && ver && d.fw !== ver).length;
                const html = !ver ? `กลุ่ม <b>${esc(g.name)}</b>: หยุดอัปเดต (เครื่องคงรุ่นที่มีอยู่)`
                    : `กลุ่ม <b>${esc(g.name)}</b> → <b class="fl-mono">${esc(ver)}</b>: ${will} เครื่องจะอัปเดตพร้อมกัน` +
                      (off.length ? ` · <span class="c-warn">${off.length} เครื่องคนละบอร์ด จะไม่ได้รับ</span>` : "") +
                      (mem.length - follow.length ? ` · ${mem.length - follow.length} เครื่องตั้งเองไว้ ไม่ตาม` : "");
                confirmIn($(".gconfirm", row), html, "ยืนยันอัปเดต", () =>
                    run(() => send("/api/admin/fleet/groups/" + encodeURIComponent(g.id), "PUT", { target: ver }),
                        ver ? `กลุ่ม ${g.name} → ${ver} แล้ว · เครื่องจะติดตั้งในรอบเช็กถัดไป` : `กลุ่ม ${g.name} หยุดอัปเดตแล้ว`));
            };
            $("[data-gdel]", row).onclick = () => confirmIn($(".gconfirm", row),
                `ลบกลุ่ม <b>${esc(g.name)}</b>? ${mem.length} เครื่องจะกลายเป็น “ยังไม่จัดกลุ่ม” (ไม่อัปเดต)`, "ลบกลุ่ม",
                () => run(() => api("/api/admin/fleet/groups/" + encodeURIComponent(g.id), { method: "DELETE" }), "ลบกลุ่ม " + g.name + " แล้ว"));
        });
        $$("[data-f]", v).forEach((row) => {
            const f = fws.find((x) => x.version === row.dataset.f);
            const auto = groupOf("auto");
            const autoMem = auto ? membersOf(auto).filter((d) => (d.fw_mode || "group") === "group" && d.board === f.board) : [];
            if ($("[data-rel]", row)) $("[data-rel]", row).onclick = () => confirmIn($(".fconfirm", row),
                `ปล่อย <b class="fl-mono">${esc(f.version)}</b> ให้ Auto patcher บอร์ด ${esc(bname(f.board))}: ${autoMem.filter((d) => d.fw !== f.version).length} เครื่องจะอัปเดตพร้อมกัน`,
                "ยืนยันปล่อย", () => run(() => send("/api/admin/ota/release", "POST", { version: f.version, released: true }), "ปล่อย " + f.version + " ให้ Auto patcher แล้ว"));
            if ($("[data-unrel]", row)) $("[data-unrel]", row).onclick = () =>
                run(() => send("/api/admin/ota/release", "POST", { version: f.version, released: false }), "เลิกปล่อย " + f.version + " แล้ว · Auto patcher บอร์ดนี้จะไม่อัปเดต");
            if ($("[data-fdel]", row)) $("[data-fdel]", row).onclick = () => confirmIn($(".fconfirm", row),
                `ลบไฟล์ <b class="fl-mono">${esc(f.version)}</b>?`, "ลบไฟล์",
                () => run(() => api("/api/admin/ota/firmware/" + encodeURIComponent(f.version), { method: "DELETE" }), "ลบ " + f.version + " แล้ว"));
        });
        $("#fwgcreate").onclick = () => {
            const name = $("#fwgnew").value.trim();
            if (!name) { toast("ใส่ชื่อกลุ่มก่อน", true); return; }
            run(() => send("/api/admin/fleet/groups", "POST", { name }), "สร้างกลุ่ม " + name + " แล้ว");
        };
        $("#fwUpload").onclick = () => {
            const file = $("#fwFile").files[0];
            if (!file) { toast("เลือกไฟล์ .bin ก่อน", true); return; }
            const fd = new FormData();
            fd.append("version", $("#fwVersion").value.trim());
            fd.append("note", $("#fwNote").value);
            fd.append("file", file);
            $("#fwUpload").disabled = true; $("#fwUpload").textContent = "กำลังอัปโหลด…";
            run(() => api("/api/admin/ota/firmware", { method: "POST", body: fd }), "อัปโหลดแล้ว").finally(() => {
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
