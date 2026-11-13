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
    let ipInfo = { your_ip: "", activity: [], bans: [] };

    const ERR = {
        bad_name: "ต้องใส่ชื่อ (ไม่เกิน 60 ตัว)", bad_rate: "จำนวนครั้งต่อนาทีต้องอยู่ระหว่าง 1–6000",
        bad_expires_at: "วันหมดอายุไม่ถูกต้อง",
        note_too_long: "หมายเหตุยาวเกิน 200 ตัว", api_locked: "API ของหน้านี้ปิดไม่ได้", unknown_api: "ไม่พบ API นี้แล้ว",
        unknown_client: "ไม่พบ client นี้แล้ว",
        bad_ip: "IP ไม่ถูกต้อง", cannot_ban_self: "แบน IP ที่คุณใช้อยู่ไม่ได้", cannot_ban_loopback: "แบน 127.0.0.1 / ::1 ไม่ได้ (ตัวเครื่องเองและ Cloudflare tunnel)",
        bad_duration: "ระยะเวลาไม่ถูกต้อง", reason_too_long: "เหตุผลยาวเกิน 200 ตัว", not_banned: "IP นี้ไม่ได้ถูกแบนแล้ว",
    };
    const errText = (code) => code && code.startsWith("not_grantable:") ? "ให้สิทธิ์ API นี้ไม่ได้: " + code.slice(14) : (ERR[code] || code);

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
            ipInfo = { your_ip: act.your_ip, activity: act.activity || [], bans: bans.bans || [] };
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
        ["apis", "clients", "ip"].forEach((k) => { $("#v-" + k).hidden = v !== k; });
        render();
    }

    function render() {
        const off = apis.filter((a) => !a.enabled).length;
        $('.ap-tab[data-tab="apis"]').innerHTML = "APIs" + (off ? ` <span class="cnt">ปิด ${off}</span>` : "");
        const banned = ipInfo.bans.length;
        $('.ap-tab[data-tab="ip"]').innerHTML = "IP" + (banned ? ` <span class="cnt">แบน ${banned}</span>` : "");
        if (view === "apis") renderApis(); else if (view === "clients") renderClients(); else renderIp();
    }

    // ── APIs tab ──
    const ACCESS_LABEL = { public: "สาธารณะ", user: "ต้อง login", admin: "admin" };

    function renderApis() {
        const q = query.toLowerCase();
        const rows = apis.filter((a) =>
            (access === "all" || (access === "off" ? !a.enabled : a.access === access)) &&
            (!q || a.id.toLowerCase().includes(q) || (a.note || "").toLowerCase().includes(q)));

        const chip = (k, label) => `<button class="ap-chip" type="button" data-access="${k}" aria-pressed="${access === k}">${label}</button>`;
        $("#v-apis").innerHTML = `
            <div class="ap-toolbar">
                <input class="ap-search" id="q" type="search" placeholder="ค้นหา route / หมายเหตุ" value="${esc(query)}">
                ${chip("all", "ทั้งหมด " + apis.length)}${chip("public", "สาธารณะ")}${chip("user", "ต้อง login")}${chip("admin", "admin")}${chip("off", "ที่ปิดอยู่")}
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
    const grantable = () => apis.filter((a) => a.access === "user");

    function grantBoxes(selected, name) {
        const list = grantable();
        if (!list.length) return `<div class="ap-faint">ยังไม่มี API ระดับ "ต้อง login" ให้เลือก</div>`;
        return `<div class="ap-grants">${list.map((a) => `
            <label><input type="checkbox" name="${name}" value="${esc(a.id)}" ${selected.includes(a.id) ? "checked" : ""}> ${esc(a.id)}</label>`).join("")}</div>`;
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

    function renderIp() {
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
                        <td>${a.banned ? '<span class="ap-badge off">แบนอยู่</span>' : a.ip === ipInfo.your_ip ? "" : `<button class="ap-btn sm ghost-bad" type="button" data-ban="${esc(a.ip)}">แบน…</button>`}</td></tr>`).join("")}
                </tbody></table>` : `<div class="ap-card ap-empty">ยังไม่มีใครเขียนเข้า IoT room ตั้งแต่ BellBeast เริ่มทำงาน</div>`;

        $("#v-ip").innerHTML = banForm() +
            `<div class="ap-section-title">IP ที่ถูกแบน</div>${bans}` +
            `<div class="ap-section-title">ใครเขียนเข้า IoT room (join / data / command)</div>
             <div class="ap-meta">นับตั้งแต่ BellBeast เริ่มทำงานรอบนี้ · ถ้าชื่อ uroboros-alarm มาจาก IP ที่ไม่ใช่เครื่อง Uroboros แปลว่ามีคนส่ง alarm ปลอม</div>${act}`;

        $("#ban-form").addEventListener("submit", banIp);
        $$("#v-ip [data-unban]").forEach((b) => b.addEventListener("click", () => unbanIp(b.dataset.unban)));
        $$("#v-ip [data-ban]").forEach((b) => b.addEventListener("click", () => {
            const f = $("#ban-form");
            f.querySelector('[name="ip"]').value = b.dataset.ban;
            f.scrollIntoView({ behavior: "smooth", block: "center" });
            f.querySelector('[name="reason"]').focus();
        }));
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

    async function unbanIp(ip) {
        try {
            const r = await send("/api/admin/ip/bans/" + encodeURIComponent(ip), "DELETE");
            ipInfo.bans = r.bans || [];
            ipInfo.activity = ipInfo.activity.map((a) => a.ip === ip ? Object.assign({}, a, { banned: false }) : a);
            render();
            toast("ยกเลิกแบน " + ip + " แล้ว");
        } catch (e) { showError(e); }
    }

    // keep the IP tab fresh while it is open (not while the admin is typing in the ban form)
    setInterval(async () => {
        if (view !== "ip" || document.hidden || (document.activeElement && document.activeElement.closest("#ban-form"))) return;
        try {
            const act = await call("/api/admin/ip/activity");
            ipInfo.activity = act.activity || [];
            renderIp();
        } catch { /* next tick */ }
    }, 15000);

    $$(".ap-tab").forEach((b) => b.addEventListener("click", () => setView(b.dataset.tab)));
    $("#reload").addEventListener("click", load);
    setView("apis");
    load();
})();
