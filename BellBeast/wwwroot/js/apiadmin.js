// Admin → API Access: per-API enable switch + note (APIs tab), API clients with keys / grants / limits (Clients tab).
// Every string from the server goes through esc() before it reaches innerHTML.
(function () {
    "use strict";

    const $ = (s, r) => (r || document).querySelector(s);
    const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    let apis = [];
    let clients = [];
    let view = "apis";
    let query = "";
    let access = "all";       // all | public | user | admin | off
    let freshKey = null;      // { id, key } — shown once after create / rotate
    let ipInfo = { your_ip: "", activity: [], bans: [], viewers: [], rejected: [] };
    let passInfo = { passes: [], fleet_routes: [], fleet_devices: [], page_routes: [], fleet_window_min: 10 };
    let ipDirty = false;      // admin is editing a form on the IP tab → the 15 s refresh must not wipe it
    let datasets = [];

    const ERR = {
        bad_name: "ต้องใส่ชื่อ (ไม่เกิน 60 ตัว)", bad_rate: "จำนวนครั้งต่อนาทีต้องอยู่ระหว่าง 1–6000",
        bad_expires_at: "วันหมดอายุไม่ถูกต้อง",
        note_too_long: "หมายเหตุยาวเกิน 200 ตัว", api_locked: "API ของหน้านี้ปิดไม่ได้", unknown_api: "ไม่พบ API นี้แล้ว",
        unknown_client: "ไม่พบ client นี้แล้ว",
        bad_ip: "IP ไม่ถูกต้อง", cannot_ban_self: "แบน IP ที่คุณใช้อยู่ไม่ได้", cannot_ban_loopback: "แบน 127.0.0.1 / ::1 ไม่ได้ (ตัวเครื่องเองและ Cloudflare tunnel)",
        bad_id: "ID ต้องเป็น a-z, 0-9, - ยาว 2–40 ตัว", bad_title: "ต้องใส่ชื่อ (ไม่เกิน 80 ตัว)", description_too_long: "คำอธิบายยาวเกิน 500 ตัว",
        bad_max_history: "ย้อนหลังสูงสุดต้องอยู่ระหว่าง 1–1440", bad_fields: "รายการ field ไม่ถูกต้อง", bad_field_count: "ต้องมี 1–40 field",
        bad_field_name: "ชื่อ field ต้องขึ้นต้นด้วย a-z และใช้ได้แค่ a-z 0-9 _", duplicate_field: "ชื่อ field ซ้ำ", unknown_metric: "Uroboros ไม่มี metric นี้",
        bad_field_text: "หน่วย/คำอธิบายยาวเกินไป", upstream_unavailable: "ติดต่อ Uroboros ไม่ได้", unknown_dataset: "ไม่พบ dataset นี้แล้ว",
        unknown_rejection: "IP นี้ไม่อยู่ในรายการถูกปฏิเสธแล้ว", bad_duration: "ระยะเวลาไม่ถูกต้อง", reason_too_long: "เหตุผลยาวเกิน 200 ตัว", not_banned: "IP นี้ไม่ได้ถูกแบนแล้ว",
        no_routes: "เลือก API อย่างน้อย 1 ตัว", bad_routes: "รายการ API ไม่ถูกต้อง", not_page_api: "ให้ตั๋วได้เฉพาะ API ของหน้าเว็บ (hash)",
        too_many_passes: "ตั๋วผ่านเต็มแล้ว (200 IP)", unknown_pass: "ไม่พบตั๋วของ IP นี้แล้ว",
    };
    function errText(code) {
        if (!code) return code;
        if (code.startsWith("not_grantable:")) return "ให้สิทธิ์ API นี้ไม่ได้: " + code.slice(14);
        const i = code.indexOf(":");
        return i > 0 && ERR[code.slice(0, i)] ? ERR[code.slice(0, i)] + ": " + code.slice(i + 1) : (ERR[code] || code);
    }

    async function call(url, opts) {
        const r = await fetch(url, Object.assign({ credentials: "same-origin", cache: "no-store" }, opts || {}));
        let j = null;
        try { j = await r.json(); } catch { /* non-JSON */ }
        if (r.status === 401 || r.status === 403) throw new Error("ต้อง login admin ใหม่ (session หมดอายุ)");
        if (!r.ok || (j && j.ok === false)) throw new Error(errText((j && j.error) || ("HTTP " + r.status)));
        clearError();   // a successful call clears the previous error banner
        return j;
    }
    const send = (url, method, body) => call(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const clientUrl = (id) => "/api/admin/api/clients/" + encodeURIComponent(id);

    const ts = (iso) => iso ? new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "–";
    function toast(text) {
        const t = $("#toast");
        t.textContent = text; t.hidden = false;
        clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
    }
    function showError(e) { const m = $("#msg"); m.textContent = e.message || String(e); m.hidden = false; }
    function clearError() { $("#msg").hidden = true; }

    async function load() {
        try {
            const [a, c, act, bans] = await Promise.all([call("/api/admin/api/catalog"), call("/api/admin/api/clients"),
                call("/api/admin/ip/activity"), call("/api/admin/ip/bans")]);
            datasets = (await call("/api/admin/datasets")).datasets || [];
            const [vw, ps] = await Promise.all([call("/api/admin/ip/viewers"), call("/api/admin/ip/passes")]);
            ipInfo = { your_ip: act.your_ip, activity: act.activity || [], bans: bans.bans || [], viewers: vw.viewers || [], rejected: vw.rejected || [], idle_sec: vw.idle_sec };
            setPasses(ps);
            ipDirty = false;
            apis = a.apis || [];
            clients = c.clients || [];
            clearError();
            render();
        } catch (e) { showError(e); }
    }

    // ── tabs ──
    function setView(v) {
        view = v;
        $$(".ap-tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === v)));
        ["apis", "datasets", "clients", "ip"].forEach((k) => { $("#v-" + k).hidden = v !== k; });
        render();
    }

    function render() {
        const off = apis.filter((a) => !a.enabled).length;
        $('.ap-tab[data-tab="apis"]').innerHTML = "APIs" + (off ? ` <span class="cnt">ปิด ${off}</span>` : "");
        const banned = ipInfo.bans.length;
        $('.ap-tab[data-tab="ip"]').innerHTML = "IP" + (banned ? ` <span class="cnt">แบน ${banned}</span>` : "");
        if (view === "apis") renderApis();
        else if (view === "datasets") renderDatasets();
        else if (view === "clients") renderClients();
        else renderIp();
    }

    // ── APIs tab ──
    const ACCESS_LABEL = { public: "สาธารณะ", page: "หน้าเว็บ (hash)", user: "ต้อง login", admin: "admin" };

    function renderApis() {
        const q = query.toLowerCase();
        const rows = apis.filter((a) =>
            (access === "all" || (access === "off" ? !a.enabled : a.access === access)) &&
            (!q || a.id.toLowerCase().includes(q) || (a.note || "").toLowerCase().includes(q)));

        const chip = (k, label) => `<button class="ap-chip" type="button" data-access="${k}" aria-pressed="${access === k}">${label}</button>`;
        $("#v-apis").innerHTML = `
            <div class="ap-toolbar">
                <input class="ap-search" id="q" type="search" placeholder="ค้นหา route / หมายเหตุ" value="${esc(query)}">
                ${chip("all", "ทั้งหมด " + apis.length)}${chip("public", "สาธารณะ")}${chip("page", "หน้าเว็บ (hash)")}${chip("user", "ต้อง login")}${chip("admin", "admin")}${chip("off", "ที่ปิดอยู่")}
            </div>
            <table class="ap-table">
                <thead><tr><th style="width:56px">เปิด</th><th style="width:90px">Method</th><th>Route</th><th style="width:110px">สิทธิ์</th><th style="width:30%">หมายเหตุ</th></tr></thead>
                <tbody>${rows.map((a) => `
                    <tr class="${a.enabled ? "" : "off"}" data-id="${esc(a.id)}">
                        <td><button class="ap-switch" type="button" role="switch" aria-checked="${a.enabled}" ${a.locked ? 'disabled title="API ของหน้านี้ปิดไม่ได้"' : ""} aria-label="เปิด/ปิด ${esc(a.id)}"></button></td>
                        <td class="ap-mono ap-muted">${esc(a.methods)}</td>
                        <td class="ap-mono">${esc(a.route)}</td>
                        <td><span class="ap-badge ${esc(a.access)}">${esc(ACCESS_LABEL[a.access] || a.access)}</span></td>
                        <td><input class="ap-note" value="${esc(a.note || "")}" placeholder="${a.changed_at ? "แก้ไขล่าสุด " + esc(ts(a.changed_at)) : ""}" maxlength="200"></td>
                    </tr>`).join("") || `<tr><td colspan="5" class="ap-empty">ไม่มี API ที่ตรงเงื่อนไข</td></tr>`}
                </tbody>
            </table>`;

        const qi = $("#q");
        qi.addEventListener("input", () => { query = qi.value; renderApis(); const n = $("#q"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
        $$("#v-apis [data-access]").forEach((b) => b.addEventListener("click", () => { access = b.dataset.access; renderApis(); }));
        $$("#v-apis tr[data-id]").forEach((tr) => {
            const id = tr.dataset.id;
            tr.querySelector(".ap-switch").addEventListener("click", (ev) => setApi(id, { enabled: ev.currentTarget.getAttribute("aria-checked") !== "true" }));
            const note = tr.querySelector(".ap-note");
            note.addEventListener("change", () => setApi(id, { note: note.value }));
        });
    }

    async function setApi(id, patch) {
        const a = apis.find((x) => x.id === id);
        if (patch.enabled === false && a && a.access === "public" &&
            !confirm(`ปิด ${id} ?\nหน้าเว็บสาธารณะหรืออุปกรณ์ที่เรียก API นี้จะได้ 404 ทันที`)) return;
        try {
            const r = await send("/api/admin/api/catalog", "POST", Object.assign({ id }, patch));
            apis[apis.indexOf(a)] = r.api;
            render();
            toast(patch.enabled === undefined ? "บันทึกหมายเหตุแล้ว" : (patch.enabled ? "เปิด " : "ปิด ") + id);
        } catch (e) { showError(e); }
    }

    // ── Clients tab ──
    const grantable = () => apis.filter((a) => a.access === "user" && !a.route.startsWith("/api/v1/"));

    function grantBoxes(selected, name) {
        const box = (value, label) => `<label><input type="checkbox" name="${name}" value="${esc(value)}" ${selected.includes(value) ? "checked" : ""}> ${label}</label>`;
        const ds = datasets.map((d) => box("dataset:" + d.id, `dataset: ${esc(d.id)} <span class="ap-faint">(${esc(d.title)})</span>`));
        const routes = grantable().map((a) => box(a.id, esc(a.id)));
        return `<div class="ap-faint" style="margin-top:6px">Datasets (/api/v1)</div>
            <div class="ap-grants">${ds.join("") || '<span class="ap-faint">ยังไม่มี dataset</span>'}</div>
            <div class="ap-faint">API ภายในที่ต้อง login</div>
            <div class="ap-grants">${routes.join("") || '<span class="ap-faint">ไม่มี</span>'}</div>`;
    }

    function keyBox(id) {
        if (!freshKey || freshKey.id !== id) return "";
        return `<div class="ap-key"><code id="fresh-key">${esc(freshKey.key)}</code>
            <button class="ap-btn sm" type="button" data-copy>คัดลอก</button>
            <span class="ap-muted" style="flex-basis:100%">เก็บ key นี้ไว้ตอนนี้เลย — ระบบเก็บแค่ค่า hash และจะไม่แสดง key นี้อีก</span></div>`;
    }

    function renderClients() {
        const createCard = `
            <form class="ap-card" id="create">
                <h3>สร้าง API client ใหม่</h3>
                <div class="ap-grid">
                    <label class="ap-field">ชื่อระบบที่เรียก<input name="name" maxlength="60" required placeholder="เช่น ระบบ SCADA, รายงานภายนอก"></label>
                    <label class="ap-field">จำกัดครั้ง/นาที<input name="rate" type="number" min="1" max="6000" value="120"></label>
                    <label class="ap-field">หมดอายุ (ว่าง = ไม่หมด)<input name="expires" type="date"></label>
                </div>
                <div class="ap-muted">API ที่อนุญาต (API สาธารณะใช้ได้อยู่แล้ว, API admin ใช้ key ไม่ได้)</div>
                ${grantBoxes([], "grant")}
                <label class="ap-field" style="margin-bottom:10px">หมายเหตุ<input name="note" maxlength="200"></label>
                <button class="ap-btn primary" type="submit">สร้าง client + key</button>
                ${keyBox("__new")}
            </form>`;

        const list = clients.map((c) => `
            <div class="ap-card" data-client="${esc(c.id)}">
                <div class="ap-row">
                    <button class="ap-switch" type="button" role="switch" aria-checked="${c.enabled}" aria-label="เปิด/ปิด ${esc(c.name)}"></button>
                    <strong>${esc(c.name)}</strong>
                    ${c.enabled ? "" : '<span class="ap-badge off">ปิดอยู่</span>'}
                    ${c.expires_at && new Date(c.expires_at) <= new Date() ? '<span class="ap-badge off">หมดอายุ</span>' : ""}
                    <span class="grow"></span>
                    <button class="ap-btn sm" type="button" data-act="rotate">ออก key ใหม่</button>
                    <button class="ap-btn sm ghost-bad" type="button" data-act="delete">ลบ</button>
                </div>
                <div class="ap-meta">
                    <span class="ap-mono">${esc(c.id)}</span><span class="ap-mono">${esc(c.key_hint)}</span>
                    <span>สร้าง ${esc(ts(c.created_at))}</span><span>ใช้ล่าสุด ${esc(ts(c.last_used_at))}</span>
                    ${c.key_rotated_at ? `<span>เปลี่ยน key ${esc(ts(c.key_rotated_at))}</span>` : ""}
                </div>
                <div class="ap-grid">
                    <label class="ap-field">จำกัดครั้ง/นาที<input name="rate" type="number" min="1" max="6000" value="${esc(c.rate_per_minute)}"></label>
                    <label class="ap-field">หมดอายุ<input name="expires" type="date" value="${esc(c.expires_at ? c.expires_at.slice(0, 10) : "")}"></label>
                    <label class="ap-field">หมายเหตุ<input name="note" maxlength="200" value="${esc(c.note || "")}"></label>
                </div>
                ${grantBoxes(c.grants || [], "grant-" + c.id)}
                <button class="ap-btn sm primary" type="button" data-act="save">บันทึก</button>
                ${keyBox(c.id)}
            </div>`).join("");

        $("#v-clients").innerHTML = createCard + (list || `<div class="ap-card ap-empty">ยังไม่มี API client</div>`);

        $("#create").addEventListener("submit", createClient);
        $$("#v-clients [data-copy]").forEach((b) => b.addEventListener("click", copyKey));
        $$("#v-clients [data-client]").forEach((card) => {
            const id = card.dataset.client;
            card.querySelector(".ap-switch").addEventListener("click", (ev) =>
                updateClient(id, { enabled: ev.currentTarget.getAttribute("aria-checked") !== "true" }));
            card.querySelector('[data-act="save"]').addEventListener("click", () => updateClient(id, formValues(card, "grant-" + id)));
            card.querySelector('[data-act="rotate"]').addEventListener("click", () => rotate(id));
            card.querySelector('[data-act="delete"]').addEventListener("click", () => removeClient(id));
        });
    }

    function formValues(root, grantName) {
        const v = (n) => root.querySelector(`[name="${n}"]`).value.trim();
        const exp = v("expires");
        return {
            rate_per_minute: Number(v("rate")) || 120,
            expires_at: exp ? new Date(exp + "T23:59:59").toISOString() : null,
            note: v("note"),
            grants: $$(`input[name="${grantName}"]:checked`, root).map((i) => i.value),
        };
    }

    async function createClient(ev) {
        ev.preventDefault();
        const form = ev.currentTarget;
        const body = Object.assign({ name: form.querySelector('[name="name"]').value.trim() }, formValues(form, "grant"));
        try {
            const r = await send("/api/admin/api/clients", "POST", body);
            clients.push(r.client);
            freshKey = { id: r.client.id, key: r.key };
            render();
            toast("สร้าง " + r.client.name + " แล้ว — คัดลอก key ไว้ก่อนออกจากหน้า");
        } catch (e) { showError(e); }
    }

    async function updateClient(id, patch) {
        try {
            const r = await send(clientUrl(id), "POST", patch);
            clients = clients.map((c) => c.id === id ? r.client : c);
            render();
            toast("บันทึก " + r.client.name + " แล้ว");
        } catch (e) { showError(e); }
    }

    async function rotate(id) {
        const c = clients.find((x) => x.id === id);
        if (!confirm(`ออก key ใหม่ให้ ${c.name}?\nkey เดิมจะใช้ไม่ได้ทันที`)) return;
        try {
            const r = await send(clientUrl(id) + "/rotate", "POST");
            freshKey = { id, key: r.key };
            await load();
            toast("ออก key ใหม่แล้ว");
        } catch (e) { showError(e); }
    }

    async function removeClient(id) {
        const c = clients.find((x) => x.id === id);
        if (!confirm(`ลบ ${c.name}?\nระบบที่ใช้ key นี้จะเรียก API ไม่ได้อีก (ย้อนกลับไม่ได้)`)) return;
        try {
            await send(clientUrl(id), "DELETE");
            clients = clients.filter((x) => x.id !== id);
            if (freshKey && freshKey.id === id) freshKey = null;
            render();
            toast("ลบ " + c.name + " แล้ว");
        } catch (e) { showError(e); }
    }

    async function copyKey() {
        try { await navigator.clipboard.writeText($("#fresh-key").textContent); toast("คัดลอก key แล้ว"); }
        catch { toast("คัดลอกไม่ได้ — เลือกข้อความแล้วกด Ctrl+C"); }
    }

    // ── Datasets tab (/api/v1) ──
    let metrics = null;        // Uroboros realtime metrics [{stream, param, unit, last_ts}]
    let editing = null;        // dataset being edited (object) or null
    let preview = {};          // id -> JSON text

    async function loadMetrics(refresh) {
        try {
            const r = await call("/api/admin/datasets/metrics" + (refresh ? "?refresh=1" : ""));
            metrics = r.realtime || [];
        } catch (e) { metrics = []; showError(e); }
    }

    const streams = () => Array.from(new Set((metrics || []).map((m) => m.stream))).sort();
    const paramsOf = (stream) => (metrics || []).filter((m) => m.stream === stream);
    const unitOf = (stream, param) => ((metrics || []).find((m) => m.stream === stream && m.param === param) || {}).unit || "";

    function fieldRow(f, i) {
        const st = f.stream || streams()[0] || "";
        return `<tr data-row="${i}">
            <td><select name="stream">${streams().map((s) => `<option ${s === st ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></td>
            <td><select name="param">${paramsOf(st).map((m) => `<option ${m.param === f.param ? "selected" : ""}>${esc(m.param)}</option>`).join("")}</select></td>
            <td><input name="name" value="${esc(f.name || "")}" placeholder="ชื่อที่เปิดออกไป เช่น raw_water_flow" class="ap-mono"></td>
            <td><input name="unit" value="${esc(f.unit || "")}" maxlength="20"></td>
            <td><input name="label" value="${esc(f.label || "")}" maxlength="80"></td>
            <td><button class="ap-btn sm ghost-bad" type="button" data-del-row>ลบ</button></td></tr>`;
    }

    function editorHtml(d) {
        const isNew = !d.id;
        return `<form class="ap-card" id="ds-form">
            <h3>${isNew ? "สร้าง dataset ใหม่" : "แก้ไข " + esc(d.id)}</h3>
            <div class="ap-grid">
                <label class="ap-field">ID (ใช้ใน URL)<input name="id" value="${esc(d.id || "")}" ${isNew ? "" : "readonly"} placeholder="เช่น raw-water" class="ap-mono"></label>
                <label class="ap-field">ชื่อ<input name="title" value="${esc(d.title || "")}" maxlength="80"></label>
                <label class="ap-field">ย้อนหลังสูงสุด (จุด, 60 วิ/จุด)<input name="max_history" type="number" min="1" max="1440" value="${esc(d.max_history || 60)}"></label>
                <label class="ap-field">สถานะ<select name="enabled"><option value="true" ${d.enabled !== false ? "selected" : ""}>เปิด</option><option value="false" ${d.enabled === false ? "selected" : ""}>ปิด</option></select></label>
            </div>
            <label class="ap-field" style="margin-bottom:8px">คำอธิบาย<input name="description" value="${esc(d.description || "")}" maxlength="500"></label>
            <table class="ap-fields"><thead><tr><th>Stream</th><th>Param (Uroboros)</th><th>ชื่อ field ที่เปิดออกไป</th><th>หน่วย</th><th>คำอธิบาย</th><th></th></tr></thead>
                <tbody id="ds-rows">${(d.fields && d.fields.length ? d.fields : [{}]).map(fieldRow).join("")}</tbody></table>
            <div class="ap-row">
                <button class="ap-btn sm" type="button" id="ds-add">+ เพิ่ม field</button>
                <span class="grow"></span>
                <button class="ap-btn sm" type="button" id="ds-cancel">ยกเลิก</button>
                <button class="ap-btn primary" type="submit">บันทึก</button>
            </div>
            <div class="ap-meta">ระบบภายนอกจะเห็นแค่ชื่อ field ไม่เห็นชื่อ tag ของ Uroboros · เปลี่ยน field เมื่อไหร่ version จะเพิ่มขึ้นเอง</div>
        </form>`;
    }

    function renderDatasets() {
        const root = $("#v-datasets");
        if (metrics === null) { root.innerHTML = `<div class="ap-card ap-empty">กำลังโหลดรายการ metric จาก Uroboros…</div>`; loadMetrics().then(renderDatasets); return; }

        const list = datasets.map((d) => `
            <div class="ap-card" data-ds="${esc(d.id)}">
                <div class="ap-row">
                    <strong>${esc(d.title)}</strong><span class="ap-mono ap-muted">${esc(d.id)} · v${esc(d.version)}</span>
                    ${d.enabled ? "" : '<span class="ap-badge off">ปิดอยู่</span>'}
                    <span class="grow"></span>
                    <button class="ap-btn sm" type="button" data-act="try">ลองเรียก</button>
                    <button class="ap-btn sm" type="button" data-act="edit">แก้ไข</button>
                    <button class="ap-btn sm ghost-bad" type="button" data-act="delete">ลบ</button>
                </div>
                ${d.description ? `<div class="ap-muted">${esc(d.description)}</div>` : ""}
                <div class="ap-ds-fields">${d.fields.map((f) => `<span><b>${esc(f.name)}</b> ← ${esc(f.stream)}.${esc(f.param)}${f.unit ? " [" + esc(f.unit) + "]" : ""}</span>`).join("")}</div>
                <div class="ap-meta"><span class="ap-mono">GET /api/v1/datasets/${esc(d.id)}</span><span class="ap-mono">GET /api/v1/datasets/${esc(d.id)}/history?n=60</span><span>ย้อนหลังสูงสุด ${esc(d.max_history)} จุด</span><span>แก้ไขล่าสุด ${esc(ts(d.updated_at))}</span></div>
                ${preview[d.id] ? `<div class="ap-pre">${esc(preview[d.id])}</div>` : ""}
            </div>`).join("");

        root.innerHTML = (editing ? editorHtml(editing) : `<div class="ap-row" style="margin-bottom:12px"><button class="ap-btn primary" type="button" id="ds-new">+ สร้าง dataset</button>
                <span class="ap-muted">เอกสาร API: <a href="/api/v1/openapi.json" target="_blank" rel="noopener" class="ap-mono" style="color:var(--ap-accent)">/api/v1/openapi.json</a></span></div>`)
            + (list || `<div class="ap-card ap-empty">ยังไม่มี dataset — /api/v1 ยังไม่เปิดข้อมูลอะไรออกไป</div>`);

        if (editing) wireEditor();
        else $("#ds-new").addEventListener("click", () => { editing = { fields: [{}] }; renderDatasets(); });

        $$("#v-datasets [data-ds]").forEach((card) => {
            const id = card.dataset.ds;
            card.querySelector('[data-act="edit"]').addEventListener("click", () => { editing = JSON.parse(JSON.stringify(datasets.find((d) => d.id === id))); renderDatasets(); window.scrollTo({ top: 0, behavior: "smooth" }); });
            card.querySelector('[data-act="delete"]').addEventListener("click", () => deleteDataset(id));
            card.querySelector('[data-act="try"]').addEventListener("click", () => tryDataset(id));
        });
    }

    function readRows() {
        return $$("#ds-rows tr").map((tr) => ({
            stream: tr.querySelector('[name="stream"]').value, param: tr.querySelector('[name="param"]').value,
            name: tr.querySelector('[name="name"]').value.trim(), unit: tr.querySelector('[name="unit"]').value.trim(),
            label: tr.querySelector('[name="label"]').value.trim(),
        }));
    }

    function wireEditor() {
        const form = $("#ds-form");
        const rerenderRows = (rows) => { $("#ds-rows").innerHTML = rows.map(fieldRow).join(""); wireRows(); };
        function wireRows() {
            $$("#ds-rows tr").forEach((tr, i) => {
                const st = tr.querySelector('[name="stream"]'), pa = tr.querySelector('[name="param"]');
                const autofill = () => {
                    const name = tr.querySelector('[name="name"]'), unit = tr.querySelector('[name="unit"]');
                    if (!name.value) name.value = pa.value.toLowerCase().replace(/[^a-z0-9_]/g, "_");
                    if (!unit.value) unit.value = unitOf(st.value, pa.value);
                };
                st.addEventListener("change", () => { const rows = readRows(); rows[i] = { stream: st.value }; rerenderRows(rows); });
                pa.addEventListener("change", autofill);
                tr.querySelector("[data-del-row]").addEventListener("click", () => { const rows = readRows(); rows.splice(i, 1); rerenderRows(rows.length ? rows : [{}]); });
            });
        }
        wireRows();
        $("#ds-add").addEventListener("click", () => rerenderRows(readRows().concat([{}])));
        $("#ds-cancel").addEventListener("click", () => { editing = null; renderDatasets(); });
        form.addEventListener("submit", async (ev) => {
            ev.preventDefault();
            const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
            const body = { id: v("id"), title: v("title"), description: v("description"), max_history: Number(v("max_history")) || 60, enabled: v("enabled") === "true", fields: readRows() };
            try {
                const r = await send("/api/admin/datasets", "POST", body);
                datasets = datasets.filter((d) => d.id !== r.dataset.id).concat([r.dataset]).sort((a, b) => a.id.localeCompare(b.id));
                editing = null;
                render();
                toast(`บันทึก ${r.dataset.id} (v${r.dataset.version}) แล้ว`);
            } catch (e) { showError(e); }
        });
    }

    async function deleteDataset(id) {
        if (!confirm(`ลบ dataset ${id}?\nระบบภายนอกที่เรียก /api/v1/datasets/${id} จะได้ 404 ทันที`)) return;
        try {
            await send("/api/admin/datasets/" + encodeURIComponent(id), "DELETE");
            datasets = datasets.filter((d) => d.id !== id);
            delete preview[id];
            render();
            toast("ลบ " + id + " แล้ว");
        } catch (e) { showError(e); }
    }

    async function tryDataset(id) {
        const r = await fetch("/api/v1/datasets/" + encodeURIComponent(id), { credentials: "same-origin", cache: "no-store" });
        const text = await r.text();
        try { preview[id] = `HTTP ${r.status}\n` + JSON.stringify(JSON.parse(text), null, 2); } catch { preview[id] = `HTTP ${r.status}\n` + text; }
        renderDatasets();
    }

    // ── IP tab ──
    const DURATIONS = [["60", "1 ชั่วโมง"], ["1440", "1 วัน"], ["10080", "7 วัน"], ["", "ถาวร"]];

    function banForm() {
        return `<form class="ap-card" id="ban-form">
            <h3>แบน IP</h3>
            <div class="ap-form-row">
                <label class="ap-field">IP<input name="ip" required placeholder="เช่น 192.168.1.50" class="ap-mono"></label>
                <label class="ap-field">ระยะเวลา<select name="minutes">${DURATIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
                <label class="ap-field" style="flex:1">เหตุผล<input name="reason" maxlength="200" placeholder="เช่น ส่ง alarm ปลอมในชื่อ uroboros-alarm"></label>
                <button class="ap-btn primary" type="submit">แบน</button>
            </div>
            <div class="ap-meta">IP ของคุณ: <span class="ap-mono">${esc(ipInfo.your_ip)}</span> (แบนตัวเองไม่ได้) · IP ที่ถูกแบนจะได้ 403 ทั้งเว็บ ทั้งหน้าเว็บและ API</div>
        </form>`;
    }

    // banned → "ปลดแบน" right there; otherwise "แบน…" (never for the admin's own IP)
    const banButton = (ip) => ipInfo.bans.some((b) => b.ip === ip)
        ? `<button class="ap-btn sm" type="button" data-unban="${esc(ip)}">ปลดแบน</button>`
        : ip === ipInfo.your_ip ? "" : `<button class="ap-btn sm ghost-bad" type="button" data-ban="${esc(ip)}">แบน…</button>`;

    function renderIp() {
        const views = ipInfo.viewers.length ? `
            <table class="ap-table">
                <thead><tr><th>IP</th><th>หน้าที่เปิดอยู่</th><th>จำนวนแท็บ</th><th>เริ่มเปิด</th><th>ล่าสุด</th><th>request</th><th></th></tr></thead>
                <tbody>${ipInfo.viewers.map((v) => `
                    <tr><td class="ap-mono">${esc(v.ip)}${v.ip === ipInfo.your_ip ? ' <span class="ap-badge user">คุณ</span>' : ""}</td>
                        <td><div class="ap-devs">${(v.pages || []).map((p) => `<span>${esc(p)}</span>`).join("")}</div></td>
                        <td>${esc(v.sessions)}</td><td>${esc(ts(v.first_seen))}</td><td>${esc(ts(v.last_seen))}</td><td>${esc(v.requests)}</td>
                        <td>${banButton(v.ip)}</td></tr>`).join("")}
                </tbody></table>` : `<div class="ap-card ap-empty">ไม่มีใครเปิดหน้าเว็บอยู่ตอนนี้</div>`;

        const REASON = { view_token_missing: "ไม่มี hash (ยิงตรง)", view_token_expired: "hash หมดอายุ/เก่า", view_token_wrong_ip: "hash ของ IP อื่น", view_refresh_expired: "ต่ออายุไม่ได้" };
        const rejected = ipInfo.rejected.length ? `
            <table class="ap-table">
                <thead><tr><th>IP</th><th>ครั้ง</th><th>ล่าสุด</th><th>เหตุผลล่าสุด</th><th>path ล่าสุด</th><th></th></tr></thead>
                <tbody>${ipInfo.rejected.map((r) => `
                    <tr><td class="ap-mono">${esc(r.ip)}${r.ip === ipInfo.your_ip ? ' <span class="ap-badge user">คุณ</span>' : ""}</td>
                        <td>${esc(r.count)}</td><td>${esc(ts(r.last_at))}</td><td>${esc(REASON[r.last_reason] || r.last_reason)}</td>
                        <td class="ap-mono ap-muted">${esc(r.last_path)}</td>
                        <td style="white-space:nowrap">${passButton(r.ip, r.last_path)} ${banButton(r.ip)}
                            <button class="ap-btn sm" type="button" data-clear="${esc(r.ip)}" title="ลบแถวนี้ออกจากรายการ (ถ้าถูกปฏิเสธอีกจะกลับมา)">ล้าง</button></td></tr>`).join("")}
                </tbody></table>` : `<div class="ap-card ap-empty">ยังไม่มีใครถูกปฏิเสธ</div>`;

        const bans = ipInfo.bans.length ? `
            <table class="ap-table">
                <thead><tr><th>IP</th><th>เหตุผล</th><th>แบนเมื่อ</th><th>หมดเวลา</th><th>โดย</th><th></th></tr></thead>
                <tbody>${ipInfo.bans.map((b) => `
                    <tr><td class="ap-mono">${esc(b.ip)}</td><td>${esc(b.reason || "–")}</td><td>${esc(ts(b.created_at))}</td>
                        <td>${b.expires_at ? esc(ts(b.expires_at)) : '<span class="ap-badge off">ถาวร</span>'}</td><td class="ap-muted">${esc(b.created_by || "–")}</td>
                        <td><button class="ap-btn sm" type="button" data-unban="${esc(b.ip)}">ยกเลิกแบน</button></td></tr>`).join("")}
                </tbody></table>` : `<div class="ap-card ap-empty">ยังไม่มี IP ที่ถูกแบน</div>`;

        const act = ipInfo.activity.length ? `
            <table class="ap-table">
                <thead><tr><th>IP</th><th>ล่าสุด</th><th>ครั้ง</th><th>ทำล่าสุด</th><th>ชื่ออุปกรณ์ที่ใช้</th><th></th></tr></thead>
                <tbody>${ipInfo.activity.map((a) => `
                    <tr class="${a.banned ? "off" : ""}"><td class="ap-mono">${esc(a.ip)}${a.ip === ipInfo.your_ip ? ' <span class="ap-badge user">คุณ</span>' : ""}</td>
                        <td>${esc(ts(a.last_seen))}</td><td>${esc(a.count)}</td><td class="ap-mono ap-muted">${esc(a.last_action)}</td>
                        <td><div class="ap-devs">${(a.devices || []).map((d) => `<span>${esc(d)}</span>`).join("")}</div></td>
                        <td>${banButton(a.ip)}</td></tr>`).join("")}
                </tbody></table>` : `<div class="ap-card ap-empty">ยังไม่มีใครเขียนเข้า IoT room ตั้งแต่ BellBeast เริ่มทำงาน</div>`;

        $("#v-ip").innerHTML = banForm() +
            `<div class="ap-section-title">IP ที่ถูกแบน</div>${bans}` +
            passSection() +
            `<div class="ap-section-title">ถูกปฏิเสธ — เรียก API ของหน้าเว็บโดยไม่มี hash หรือใช้ hash เก่า</div>
             <div class="ap-meta">นับตั้งแต่ BellBeast เริ่มทำงานรอบนี้ · แถวที่ตัวเลขเพิ่มเรื่อยๆ = มีคนยิง endpoint ตรง</div>${rejected}` +
            `<div class="ap-section-title">กำลังเปิดหน้าเว็บอยู่</div>
             <div class="ap-meta">hash ที่ยังใช้งานอยู่ (ไม่ได้เรียกนานเกิน ${esc(ipInfo.idle_sec || 10)} วิ = หมดอายุ)</div>${views}` +
            `<div class="ap-section-title">ใครเขียนเข้า IoT room (join / data / command)</div>
             <div class="ap-meta">นับตั้งแต่ BellBeast เริ่มทำงานรอบนี้ · ถ้าชื่อ uroboros-alarm มาจาก IP ที่ไม่ใช่เครื่อง Uroboros แปลว่ามีคนส่ง alarm ปลอม</div>${act}`;

        $("#ban-form").addEventListener("submit", banIp);
        $$("#v-ip [data-unban]").forEach((b) => b.addEventListener("click", () => unbanIp(b.dataset.unban)));
        $$("#v-ip [data-clear]").forEach((b) => b.addEventListener("click", () => clearRejected(b.dataset.clear)));
        $$("#v-ip [data-ban]").forEach((b) => b.addEventListener("click", () => {
            const f = $("#ban-form");
            f.querySelector('[name="ip"]').value = b.dataset.ban;
            f.scrollIntoView({ behavior: "smooth", block: "center" });
            f.querySelector('[name="reason"]').focus();
        }));
        wirePasses();
    }

    // ── IP passes: page APIs without a hash for machines that cannot open our pages ──
    function setPasses(ps) {
        passInfo = {
            passes: ps.passes || [], fleet_routes: ps.fleet_routes || [], fleet_devices: ps.fleet_devices || [],
            page_routes: ps.page_routes || [], fleet_window_min: ps.fleet_window_min || 10,
        };
    }

    const routeOfPath = (path) => passInfo.page_routes.find((id) => id.slice(id.indexOf(" ") + 1) === path);

    const passButton = (ip, path) => ip === ipInfo.your_ip ? "" :
        `<button class="ap-btn sm" type="button" data-pass="${esc(ip)}" data-pass-route="${esc(routeOfPath(path) || "")}">ให้ตั๋ว…</button>`;

    function routeBoxes(name, selected) {
        return passInfo.page_routes.map((id) =>
            `<label><input type="checkbox" name="${name}" value="${esc(id)}" ${selected.includes(id) ? "checked" : ""}> ${esc(id)}</label>`).join("")
            || '<span class="ap-faint">ไม่มี API ของหน้าเว็บ</span>';
    }

    const used = (hits, at) => hits ? `${esc(hits)} ครั้ง · ${esc(ts(at))}` : '<span class="ap-faint">ยังไม่ใช้</span>';

    function passSection() {
        const rows = passInfo.passes.length ? `
            <table class="ap-table">
                <thead><tr><th>IP</th><th>API ที่เรียกได้</th><th>หมายเหตุ</th><th>ใช้ตั๋ว (รอบนี้)</th><th>โดย</th><th></th></tr></thead>
                <tbody>${passInfo.passes.map((p) => `
                    <tr><td class="ap-mono">${esc(p.ip)}</td>
                        <td><div class="ap-devs">${p.routes.map((r) => `<span>${esc(r)}</span>`).join("")}</div></td>
                        <td>${esc(p.note || "–")}</td><td>${used(p.hits, p.last_used)}</td>
                        <td class="ap-muted">${esc(p.created_by || "–")}<div class="ap-faint">${esc(ts(p.updated_at || p.created_at))}</div></td>
                        <td style="white-space:nowrap"><button class="ap-btn sm" type="button" data-pass-edit="${esc(p.ip)}">แก้</button>
                            <button class="ap-btn sm ghost-bad" type="button" data-pass-del="${esc(p.ip)}">ลบ</button></td></tr>`).join("")}
                </tbody></table>` : `<div class="ap-card ap-empty">ยังไม่มี IP ที่ได้ตั๋ว</div>`;

        const devs = passInfo.fleet_devices.length ? `
            <table class="ap-table">
                <thead><tr><th>อุปกรณ์</th><th>IP ล่าสุด (จาก connection)</th><th>report ล่าสุด</th><th>ตั๋ว</th><th>ใช้ตั๋ว (รอบนี้)</th></tr></thead>
                <tbody>${passInfo.fleet_devices.map((d) => `
                    <tr><td class="ap-mono">${esc(d.id)}${d.name ? ` <span class="ap-faint">${esc(d.name)}</span>` : ""}</td>
                        <td class="ap-mono">${esc(d.seen_ip || "–")}</td><td>${esc(ts(d.seen_at))}</td>
                        <td>${d.active ? '<span class="ap-badge public">ได้ตั๋ว</span>' : '<span class="ap-badge off">หมดเวลา</span>'}</td>
                        <td>${used(d.hits, d.last_used)}</td></tr>`).join("")}
                </tbody></table>` : `<div class="ap-empty ap-faint">ยังไม่มีอุปกรณ์ที่อนุมัติแล้ว</div>`;

        return `<div class="ap-section-title">ตั๋วผ่าน — เรียก API ของหน้าเว็บได้โดยไม่ต้องมี hash</div>
            <div class="ap-meta">สำหรับเครื่องที่เปิดหน้าเว็บไม่ได้ เช่น TruckSidecar ที่เครื่องชั่ง และ annunciator · ได้แค่ API ที่ติ๊กไว้ · IP ที่ถูกแบนยังโดนแบนเหมือนเดิม</div>
            <form class="ap-card" id="pass-form">
                <h3>ให้ตั๋วกับ IP</h3>
                <div class="ap-form-row">
                    <label class="ap-field">IP<input name="ip" required placeholder="เช่น 172.16.198.60" class="ap-mono"></label>
                    <label class="ap-field" style="flex:1">หมายเหตุ<input name="note" maxlength="200" placeholder="เช่น TruckSidecar เครื่องชั่ง"></label>
                    <button class="ap-btn primary" type="submit">บันทึก</button>
                </div>
                <div class="ap-faint" style="margin-top:8px">API ของหน้าเว็บที่ IP นี้เรียกได้</div>
                <div class="ap-grants">${routeBoxes("pass-route", [])}</div>
                <div class="ap-meta">ควรจอง IP นี้ใน DHCP ไว้ ถ้า IP เปลี่ยน เครื่องอื่นที่ได้ IP นี้ไปจะได้ตั๋วแทน · บันทึก IP เดิมซ้ำ = แก้รายการ API</div>
            </form>
            ${rows}
            <form class="ap-card" id="fleet-form" style="margin-top:12px">
                <h3>ตั๋วอัตโนมัติสำหรับอุปกรณ์ใน Fleet</h3>
                <div class="ap-meta">อุปกรณ์ที่อนุมัติแล้วใน Fleet ได้ตั๋วจาก IP ที่ device key ตรวจผ่านครั้งล่าสุด (ไม่ใช่ IP ที่อุปกรณ์รายงานเอง) · ใช้ได้ ${esc(passInfo.fleet_window_min)} นาทีหลัง report ล่าสุด · ถอนการอนุมัติ = ตั๋วหายทันที</div>
                <div class="ap-grants">${routeBoxes("fleet-route", passInfo.fleet_routes)}</div>
                <button class="ap-btn primary" type="submit">บันทึก API ของ Fleet</button>
                <div style="margin-top:10px">${devs}</div>
            </form>`;
    }

    function wirePasses() {
        const pf = $("#pass-form"), ff = $("#fleet-form");
        [pf, ff].forEach((f) => ["input", "change"].forEach((t) => f.addEventListener(t, () => { ipDirty = true; })));
        pf.addEventListener("submit", savePass);
        ff.addEventListener("submit", saveFleetRoutes);
        const fill = (ip, routes, note) => {
            pf.querySelector('[name="ip"]').value = ip;
            pf.querySelector('[name="note"]').value = note || "";
            $$('[name="pass-route"]', pf).forEach((c) => { c.checked = routes.includes(c.value); });
            ipDirty = true;
            pf.scrollIntoView({ behavior: "smooth", block: "center" });
            pf.querySelector('[name="note"]').focus();
        };
        $$("#v-ip [data-pass]").forEach((b) => b.addEventListener("click", () => {
            const cur = passInfo.passes.find((p) => p.ip === b.dataset.pass);
            const routes = cur ? cur.routes.slice() : [];
            if (b.dataset.passRoute && !routes.includes(b.dataset.passRoute)) routes.push(b.dataset.passRoute);
            fill(b.dataset.pass, routes, cur && cur.note);
        }));
        $$("#v-ip [data-pass-edit]").forEach((b) => b.addEventListener("click", () => {
            const p = passInfo.passes.find((x) => x.ip === b.dataset.passEdit);
            if (p) fill(p.ip, p.routes, p.note);
        }));
        $$("#v-ip [data-pass-del]").forEach((b) => b.addEventListener("click", () => removePass(b.dataset.passDel)));
    }

    const checked = (root, name) => $$(`[name="${name}"]:checked`, root).map((c) => c.value);

    async function savePass(ev) {
        ev.preventDefault();
        const f = ev.currentTarget;
        const ip = f.querySelector('[name="ip"]').value.trim();
        try {
            setPasses(await send("/api/admin/ip/passes", "POST", { ip, routes: checked(f, "pass-route"), note: f.querySelector('[name="note"]').value }));
            ipDirty = false;
            render();
            toast("ให้ตั๋ว " + ip + " แล้ว");
        } catch (e) { showError(e); }
    }

    async function removePass(ip) {
        if (!confirm(`ลบตั๋วของ ${ip} ?\nเครื่องนี้จะเรียก API ของหน้าเว็บไม่ได้อีก`)) return;
        try {
            setPasses(await send("/api/admin/ip/passes/" + encodeURIComponent(ip), "DELETE"));
            render();
            toast("ลบตั๋วของ " + ip + " แล้ว");
        } catch (e) { showError(e); }
    }

    async function saveFleetRoutes(ev) {
        ev.preventDefault();
        try {
            setPasses(await send("/api/admin/ip/passes/fleet", "POST", { routes: checked(ev.currentTarget, "fleet-route") }));
            ipDirty = false;
            render();
            toast("บันทึก API ของ Fleet แล้ว");
        } catch (e) { showError(e); }
    }

    async function banIp(ev) {
        ev.preventDefault();
        const f = ev.currentTarget;
        const ip = f.querySelector('[name="ip"]').value.trim();
        const minutes = f.querySelector('[name="minutes"]').value;
        if (!confirm(`แบน ${ip} ?\nIP นี้จะเข้าเว็บและเรียก API ไม่ได้ทั้งหมด`)) return;
        try {
            const r = await send("/api/admin/ip/bans", "POST", { ip, minutes: minutes ? Number(minutes) : null, reason: f.querySelector('[name="reason"]').value });
            ipInfo.bans = r.bans || [];
            ipInfo.activity = ipInfo.activity.map((a) => Object.assign({}, a, { banned: a.banned || a.ip === ip }));
            render();
            toast("แบน " + ip + " แล้ว");
        } catch (e) { showError(e); }
    }

    async function clearRejected(ip) {
        try {
            const r = await send("/api/admin/ip/rejected/" + encodeURIComponent(ip), "DELETE");
            ipInfo.rejected = r.rejected || [];
            render();
            toast("ล้าง " + ip + " ออกจากรายการแล้ว");
        } catch (e) { showError(e); }
    }

    async function unbanIp(ip) {
        try {
            const r = await send("/api/admin/ip/bans/" + encodeURIComponent(ip), "DELETE");
            ipInfo.bans = r.bans || [];
            ipInfo.activity = ipInfo.activity.map((a) => a.ip === ip ? Object.assign({}, a, { banned: false }) : a);
            render();
            toast("ยกเลิกแบน " + ip + " แล้ว");
        } catch (e) { showError(e); }
    }

    // keep the IP tab fresh while it is open (not while the admin is typing in a form there)
    setInterval(async () => {
        if (view !== "ip" || document.hidden || ipDirty || (document.activeElement && document.activeElement.closest("#ban-form"))) return;
        try {
            const [act, vw, ps] = await Promise.all([call("/api/admin/ip/activity"), call("/api/admin/ip/viewers"), call("/api/admin/ip/passes")]);
            if (ipDirty) return;
            ipInfo.activity = act.activity || [];
            ipInfo.viewers = vw.viewers || [];
            ipInfo.rejected = vw.rejected || [];
            ipInfo.idle_sec = vw.idle_sec;
            setPasses(ps);
            renderIp();
        } catch { /* next tick */ }
    }, 15000);

    $$(".ap-tab").forEach((b) => b.addEventListener("click", () => setView(b.dataset.tab)));
    $("#reload").addEventListener("click", load);
    setView("apis");
    load();
})();
