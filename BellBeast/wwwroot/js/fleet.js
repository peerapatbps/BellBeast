// Annunciator Fleet admin page — devices / defaults / WiFi / OTA / device log.
// Every string from the server or a device goes through textContent.
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    let data = null;

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }

    function msg(text, ok) {
        const m = $("msg");
        m.textContent = text || "";
        m.className = "fl-msg" + (text ? (ok ? " ok" : " err") : "");
    }

    async function api(url, opts) {
        const r = await fetch(url, Object.assign({ credentials: "same-origin" }, opts || {}));
        let j = null;
        try { j = await r.json(); } catch { /* non-JSON */ }
        if (r.status === 401 || r.status === 403) throw new Error("ต้อง login admin ใหม่ (session หมดอายุ)");
        if (!r.ok || (j && j.ok === false)) throw new Error((j && (j.detail || j.error)) || ("HTTP " + r.status));
        return j;
    }

    const send = (url, method, body) => api(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    function ago(iso) {
        if (!iso) return "–";
        const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
        if (s < 60) return s + "s ago";
        if (s < 3600) return Math.round(s / 60) + "m ago";
        if (s < 86400) return Math.round(s / 3600) + "h ago";
        return new Date(iso).toLocaleString("th-TH");
    }
    const ts = (iso) => iso ? new Date(iso).toLocaleString("th-TH") : "–";

    function liveness(iso) {
        if (!iso) return "off";
        const s = (Date.now() - new Date(iso).getTime()) / 1000;
        return s < 180 ? "on" : s < 900 ? "late" : "off";
    }

    function numOrNull(v) {
        const t = String(v).trim();
        return t === "" ? null : Number(t);
    }

    function deviceRow(d) {
        const tr = el("tr");
        const id = el("td", "mono");
        id.appendChild(el("span", "fl-dot " + liveness(d.last_seen)));
        id.appendChild(document.createTextNode(d.id));
        tr.appendChild(id);

        const st = el("td");
        st.appendChild(el("span", "fl-tag " + (d.approved ? "ok" : "pending"), d.approved ? "approved" : (d.has_key ? "pending" : "key reset")));
        tr.appendChild(st);

        const inp = (val, cls, ph) => { const i = el("input", "fl-in " + cls); i.value = val ?? ""; if (ph) i.placeholder = ph; return i; };
        const name = inp(d.name, "w-m", "–");
        const zones = inp(d.zones, "w-m", "(ค่ากลาง)");
        const chan = el("select", "fl-in");
        [["", "(ค่ากลาง)"], ["stable", "stable"], ["beta", "beta"], ["none", "none"]].forEach(([v, t]) => {
            const o = el("option", null, t); o.value = v; if ((d.channel ?? "") === v) o.selected = true; chan.appendChild(o);
        });
        const poll = inp(d.poll_sec, "w-s", "-"), remind = inp(d.remind_sec, "w-s", "-"), vol = inp(d.volume, "w-s", "-");
        const lab = inp(d.lab_sec, "w-s", "-"), scn = inp(d.scn_sec, "w-s", "-");
        [name, zones, chan].forEach((x) => { const td = el("td"); td.appendChild(x); tr.appendChild(td); });
        const nums = el("td"); [poll, remind, vol, lab, scn].forEach((x) => { nums.appendChild(x); nums.appendChild(document.createTextNode(" ")); }); tr.appendChild(nums);

        tr.appendChild(el("td", "mono", (d.fw || "–") + (d.partition ? " · " + d.partition : "")));
        tr.appendChild(el("td", "mono", d.ip || "–"));
        tr.appendChild(el("td", null, (d.wifi_tier || "–") + (d.rssi != null ? " " + d.rssi + "dBm" : "")));
        tr.appendChild(el("td", null, d.last_played_at ? ago(d.last_played_at) + " · " + (d.last_played_alarm || "") : "–"));
        tr.appendChild(el("td", null, d.last_ack_at ? ago(d.last_ack_at) + " · " + (d.last_ack_alarm || "") : "–"));
        tr.appendChild(el("td", null, ago(d.last_seen)));

        const act = el("td");
        const save = el("button", "fl-btn", "บันทึก");
        save.onclick = () => run(() => send("/api/admin/fleet/device/" + encodeURIComponent(d.id), "POST", {
            name: name.value, zones: zones.value.trim() === "" ? null : zones.value,
            channel: chan.value === "" ? null : chan.value,
            poll_sec: numOrNull(poll.value), remind_sec: numOrNull(remind.value), volume: numOrNull(vol.value),
            lab_sec: numOrNull(lab.value), scn_sec: numOrNull(scn.value),
        }), "บันทึก " + d.id + " แล้ว");
        act.appendChild(save);
        if (!d.approved && d.has_key) {
            const ok = el("button", "fl-btn ok", "อนุมัติ");
            ok.onclick = () => run(() => send("/api/admin/fleet/device/" + encodeURIComponent(d.id), "POST", { approved: true }), "อนุมัติ " + d.id + " แล้ว");
            act.appendChild(ok);
        }
        const reset = el("button", "fl-btn del", "reset key");
        reset.onclick = () => { if (confirm("reset key ของ " + d.id + "? เครื่องต้องอนุมัติใหม่")) run(() => send("/api/admin/fleet/device/" + encodeURIComponent(d.id), "POST", { reset_key: true }), "reset key แล้ว"); };
        const del = el("button", "fl-btn del", "ลบ");
        del.onclick = () => { if (confirm("ลบ " + d.id + " ออกจาก registry?")) run(() => api("/api/admin/fleet/device/" + encodeURIComponent(d.id), { method: "DELETE" }), "ลบแล้ว"); };
        act.appendChild(reset); act.appendChild(del);
        tr.appendChild(act);
        return tr;
    }

    function render() {
        const devs = data.devices || [];
        const rows = $("rows");
        rows.replaceChildren();
        if (!devs.length) {
            const tr = el("tr"); const td = el("td", "fl-muted", "ยังไม่มีเครื่องรายงานเข้ามา"); td.colSpan = 13; tr.appendChild(td); rows.appendChild(tr);
        }
        devs.forEach((d) => rows.appendChild(deviceRow(d)));

        const online = devs.filter((d) => liveness(d.last_seen) === "on").length;
        const pending = devs.filter((d) => !d.approved).length;
        $("chipOnline").textContent = "online: " + online + "/" + devs.length;
        $("chipOnline").className = "fl-chip " + (online === devs.length && devs.length ? "ok" : "warn");
        $("chipPending").textContent = "pending: " + pending;
        $("chipPending").className = "fl-chip " + (pending ? "warn" : "ok");
        const chans = (data.ota && data.ota.channels) || {};
        $("chipFw").textContent = "stable: " + (chans.stable || "–") + " · beta: " + (chans.beta || "–");

        const def = data.defaults || {};
        $("dZones").value = def.zones || "";
        $("dPoll").value = def.poll_sec ?? 5;
        $("dRemind").value = def.remind_sec ?? 60;
        $("dLab").value = def.lab_sec ?? 300;
        $("dScn").value = def.scn_sec ?? 30;
        $("dVol").value = def.volume ?? "";
        $("dChannel").value = def.channel || "stable";

        const w = data.wifi;
        if (w) { $("wSsid").value = w.ssid || ""; $("wIdentity").value = w.identity || ""; }
        else if (!$("wSsid").value) { $("wSsid").value = ".@MWA WiFi"; }
        $("wifiNow").textContent = w
            ? "ตอนนี้: " + w.ssid + " · current " + (w.current || "–") + " · next " + (w.next || "–") +
              (w.next_valid_from ? " ตั้งแต่ " + ts(w.next_valid_from) : "") + " · แก้ล่าสุด " + ts(w.updated_at)
            : "ยังไม่ได้ตั้ง — เครื่องใช้ bootstrap tier อย่างเดียว";

        const fw = $("fwRows");
        fw.replaceChildren();
        ((data.ota && data.ota.firmware) || []).forEach((f) => {
            const tr = el("tr");
            tr.appendChild(el("td", "mono", f.version));
            tr.appendChild(el("td", "mono", (f.size / 1024 / 1024).toFixed(2) + " MB"));
            tr.appendChild(el("td", "mono", (f.sha256 || "").slice(0, 16) + "…"));
            tr.appendChild(el("td", null, ts(f.uploaded_at)));
            tr.appendChild(el("td", null, f.note || ""));
            const on = Object.entries(chans).filter(([, v]) => v === f.version).map(([k]) => k).join(", ");
            tr.appendChild(el("td", null, on || "–"));
            const act = el("td");
            ["beta", "stable"].forEach((ch) => {
                const b = el("button", "fl-btn", "→ " + ch);
                b.onclick = () => run(() => send("/api/admin/ota/channel", "POST", { channel: ch, version: f.version }), ch + " = " + f.version);
                act.appendChild(b); act.appendChild(document.createTextNode(" "));
            });
            const del = el("button", "fl-btn del", "ลบ");
            del.onclick = () => run(() => api("/api/admin/ota/firmware/" + encodeURIComponent(f.version), { method: "DELETE" }), "ลบ " + f.version);
            act.appendChild(del);
            tr.appendChild(act);
            fw.appendChild(tr);
        });
        const sel = $("evDevice"), cur = sel.value;
        sel.replaceChildren(el("option", null, "ทุกเครื่อง"));
        sel.firstChild.value = "";
        devs.forEach((d) => { const o = el("option", null, d.id); o.value = d.id; sel.appendChild(o); });
        sel.value = cur;
    }

    async function loadEvents() {
        const dev = $("evDevice").value;
        const j = await api("/api/admin/fleet/events?n=200" + (dev ? "&device=" + encodeURIComponent(dev) : ""));
        const rows = $("evRows");
        rows.replaceChildren();
        (j.events || []).forEach((e) => {
            const tr = el("tr");
            tr.appendChild(el("td", null, ts(e.rx)));
            tr.appendChild(el("td", null, e.ts ? ts(e.ts) : "–"));
            tr.appendChild(el("td", "mono", e.device));
            tr.appendChild(el("td", null, e.type));
            tr.appendChild(el("td", "mono", e.alarm_id || ""));
            tr.appendChild(el("td", null, e.detail || ""));
            rows.appendChild(tr);
        });
    }

    async function load() {
        data = await api("/api/admin/fleet");
        render();
        await loadEvents();
    }

    async function run(fn, okText) {
        try { await fn(); msg(okText, true); await load(); }
        catch (e) { msg(e.message, false); }
    }

    $("reload").onclick = () => run(async () => { }, "");
    $("evDevice").onchange = () => loadEvents().catch((e) => msg(e.message, false));
    $("saveDefaults").onclick = () => run(() => send("/api/admin/fleet/defaults", "PUT", {
        zones: $("dZones").value, poll_sec: Number($("dPoll").value), remind_sec: Number($("dRemind").value),
        lab_sec: Number($("dLab").value), scn_sec: Number($("dScn").value),
        volume: numOrNull($("dVol").value), channel: $("dChannel").value,
    }), "บันทึกค่ากลางแล้ว");
    $("saveWifi").onclick = () => {
        const body = { ssid: $("wSsid").value, identity: $("wIdentity").value };
        if ($("wCurrent").value) body.current = $("wCurrent").value;
        if ($("wNext").value) body.next = $("wNext").value;
        if ($("wFrom").value) body.next_valid_from = new Date($("wFrom").value).toISOString();
        run(() => send("/api/admin/fleet/wifi", "PUT", body), "บันทึก WiFi แล้ว (เครื่องจะดึงรอบ config ถัดไป)")
            .then(() => { $("wCurrent").value = ""; $("wNext").value = ""; });
    };
    $("clearWifi").onclick = () => { if (confirm("ลบรหัส WiFi ทั้งหมด? เครื่องจะเหลือ bootstrap tier")) run(() => send("/api/admin/fleet/wifi", "PUT", { clear: true }), "ลบแล้ว"); };
    $("fwUpload").onclick = () => {
        const f = $("fwFile").files[0];
        if (!f) { msg("เลือกไฟล์ .bin", false); return; }
        const fd = new FormData();
        fd.append("version", $("fwVersion").value.trim());
        fd.append("note", $("fwNote").value);
        fd.append("file", f);
        run(() => api("/api/admin/ota/firmware", { method: "POST", body: fd }), "อัปโหลดแล้ว");
    };

    load().catch((e) => msg(e.message, false));
    setInterval(() => { if (document.visibilityState === "visible") load().catch(() => { }); }, 30000);
})();
