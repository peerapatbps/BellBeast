// ============================
// MHxView ⚙️ Settings → Config tab
// Edits the deploy config files of BellBeast / Uroboros / Wayfarer (ConfigEditorService.cs):
//   GET  /api/config/files                          (metadata, open)
//   POST /api/config/read     {pin,id}              → {text,sha}
//   POST /api/config/save     {pin,id,text,baseSha} → {sha}      409 file_changed / 400 invalid_json|invalid_ini
//   POST /api/config/links    {pin}                 → {root,shas,links,checks}
//   POST /api/config/links/apply {pin,id,key,value,baseSha}
//   POST /api/config/backups  {pin,id}  ·  POST /api/config/restore {pin,id,name,baseSha}
// The PIN (same as Engine tab) is kept in memory only while the Config tab is open.
// ============================
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    let el = null;
    let pin = "";
    let files = [];        // registry from /api/config/files
    let current = null;    // { id, text, sha } loaded in the editor
    let wired = false;

    const PROJECTS = ["BellBeast", "Uroboros", "Wayfarer"];
    const LINK_ICON = { ok: "✅", missing: "⚠️", mismatch: "⚠️", info: "🌐" };
    const LINK_ORDER = { mismatch: 0, missing: 1, ok: 2, info: 3 };

    function els() {
        return {
            lock: $("cfgLock"), main: $("cfgMain"), pin: $("cfgPin"), unlock: $("cfgUnlock"),
            root: $("cfgRoot"), checks: $("cfgChecks"), links: $("cfgLinks"), rescan: $("cfgLinksRefresh"),
            files: $("cfgFiles"), path: $("cfgPath"), restart: $("cfgRestart"), warn: $("cfgWarn"),
            text: $("cfgText"), backups: $("cfgBackups"), restore: $("cfgRestore"),
            reload: $("cfgReload"), validate: $("cfgValidate"), save: $("cfgSave"), status: $("cfgStatus")
        };
    }

    function setStatus(msg, kind) {
        el.status.textContent = msg || "";
        el.status.className = "bb-feedback-status" + (msg ? " is-open" : "") + (kind ? " " + kind : "");
    }

    const dirty = () => !!current && el.text.value !== current.text;

    async function post(url, body) {
        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify(Object.assign({ pin }, body || {}))
        });
        let data = {};
        try { data = await r.json(); } catch { }
        if (r.ok) return data;

        const err = new Error(errorText(r.status, data));
        err.status = r.status;
        err.code = data.error;
        throw err;
    }

    function errorText(status, b) {
        if (status === 401) return "PIN ไม่ถูกต้อง";
        if (status === 429) return "ใส่ PIN ผิดหลายครั้ง — รอ 5 นาทีแล้วลองใหม่";
        switch (b.error) {
            case "pin_not_configured": return "ยังไม่ได้ตั้ง PIN ใน appsettings (EngineControl:PinPbkdf2)";
            case "root_not_found": return "หา Fullscale root ไม่เจอ — ตั้ง ConfigEditor:FullscaleRoot ใน appsettings";
            case "file_changed": return "ไฟล์ถูกเปลี่ยนบน disk หลังจากเปิดอ่าน (โปรแกรมอาจเขียน token/password ใหม่) — กด Reload แล้วแก้ใหม่";
            case "invalid_json": return `JSON ไม่ถูกต้อง${b.line ? " (บรรทัด " + b.line + ")" : ""}: ${b.detail || ""}`;
            case "invalid_ini": return `INI ไม่ถูกต้อง${b.line ? " (บรรทัด " + b.line + ")" : ""}: ${b.detail || ""}`;
            case "file_missing": return "ไม่พบไฟล์: " + (b.detail || "");
            default: return (b.error || "HTTP " + status) + (b.detail ? ": " + b.detail : "");
        }
    }

    // ── lock / unlock ──────────────────────────────────────────────

    function lock() {
        pin = "";
        current = null;
        el.text.value = "";
        el.main.hidden = true;
        el.lock.hidden = false;
    }

    async function unlock() {
        pin = el.pin.value;
        if (!pin) { setStatus("กรุณาใส่ PIN", "warn"); el.pin.focus(); return; }
        el.unlock.disabled = true;
        try {
            const links = await post("/api/config/links");   // doubles as PIN check
            el.pin.value = "";
            el.lock.hidden = true;
            el.main.hidden = false;
            setStatus("");
            await loadFiles();
            renderLinks(links);
            const first = files.find(f => f.exists);
            if (first) await openFile(first.id);
        } catch (e) {
            pin = "";
            setStatus(e.message, "warn");
        } finally {
            el.unlock.disabled = false;
        }
    }

    // ── links ("auto search") ──────────────────────────────────────

    let linkShas = {};

    async function scanLinks() {
        try {
            renderLinks(await post("/api/config/links"));
        } catch (e) {
            setStatus("Scan ไม่สำเร็จ: " + e.message, "warn");
        }
    }

    function fileLabel(id) {
        const f = files.find(x => x.id === id);
        return f ? f.relPath.split("\\").slice(-1)[0] : id;
    }

    function renderLinks(data) {
        linkShas = data.shas || {};
        el.root.textContent = "Fullscale root: " + (data.root || "-");

        el.checks.innerHTML = "";
        for (const c of data.checks || []) {
            const row = document.createElement("div");
            row.className = "bb-cfg-check" + (c.ok ? "" : " bad");
            const i = document.createElement("span"); i.className = "i"; i.textContent = c.ok ? "✅" : "⚠️";
            const n = document.createElement("span"); n.className = "k"; n.textContent = c.name;
            const d = document.createElement("span"); d.className = "d"; d.textContent = c.detail;
            row.append(i, n, document.createElement("span"), d);
            el.checks.appendChild(row);
        }

        const links = (data.links || []).slice().sort((a, b) => LINK_ORDER[a.status] - LINK_ORDER[b.status]);
        el.links.innerHTML = "";
        if (!links.length) {
            el.links.textContent = "ไม่พบ path / URL ในไฟล์ config";
            return;
        }

        for (const l of links) {
            const row = document.createElement("div");
            row.className = "bb-cfg-link " + l.status;

            const i = document.createElement("span"); i.className = "i"; i.textContent = LINK_ICON[l.status] || "?";
            const k = document.createElement("span"); k.className = "k";
            k.textContent = l.key;
            const src = document.createElement("small"); src.textContent = `${l.project} · ${fileLabel(l.fileId)}`;
            k.appendChild(src);

            const act = document.createElement("span");
            if (l.suggestion) {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "bb-btn primary";
                b.textContent = "Use suggestion";
                b.addEventListener("click", () => applySuggestion(l, b));
                act.appendChild(b);
            }

            const v = document.createElement("span"); v.className = "v"; v.textContent = l.value;
            row.append(i, k, act, v);

            if (l.resolved && l.resolved !== l.value) {
                const r = document.createElement("span"); r.className = "r";
                r.textContent = "→ " + l.resolved + (l.landsIn ? `  [${l.landsIn}]` : "") + (l.exists ? (l.isDir ? "  (folder)" : "") : "  (ไม่พบ)");
                row.appendChild(r);
            }
            if (l.note) {
                const n = document.createElement("span"); n.className = "n"; n.textContent = l.note;
                row.appendChild(n);
            }
            if (l.suggestion) {
                const s = document.createElement("span"); s.className = "s"; s.textContent = "แนะนำ: " + l.suggestion;
                row.appendChild(s);
            }
            el.links.appendChild(row);
        }
    }

    async function applySuggestion(l, btn) {
        if (current && current.id === l.fileId && dirty()) {
            setStatus("ไฟล์นี้มีการแก้ไขที่ยังไม่ save — Save หรือ Reload ก่อน", "warn");
            return;
        }
        if (!confirm(`เปลี่ยน ${l.key} ใน ${fileLabel(l.fileId)}\n\nจาก: ${l.value}\nเป็น: ${l.suggestion}`)) return;

        btn.disabled = true;
        try {
            await post("/api/config/links/apply", { id: l.fileId, key: l.key, value: l.suggestion, baseSha: linkShas[l.fileId] });
            setStatus(`บันทึก ${l.key} แล้ว ✔ (backup ไฟล์เดิมแล้ว)`, "ok");
            if (current && current.id === l.fileId) await openFile(l.fileId, true);
            await scanLinks();
        } catch (e) {
            setStatus(e.message, "warn");
            btn.disabled = false;
        }
    }

    // ── file list + editor ─────────────────────────────────────────

    async function loadFiles() {
        const r = await fetch("/api/config/files", { cache: "no-store" });
        const data = await r.json();
        files = data.files || [];

        el.files.innerHTML = "";
        for (const p of PROJECTS) {
            const g = document.createElement("div"); g.className = "g"; g.textContent = p;
            el.files.appendChild(g);
            for (const f of files.filter(x => x.project === p)) {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "bb-cfg-file";
                b.dataset.id = f.id;
                b.dataset.project = p;
                b.title = f.relPath + (f.exists ? "" : " (ไม่พบไฟล์)");
                b.textContent = f.relPath.split("\\").slice(-1)[0];
                b.disabled = !f.exists;
                b.addEventListener("click", () => openFile(f.id));
                el.files.appendChild(b);
            }
        }
    }

    function markActive() {
        el.files.querySelectorAll(".bb-cfg-file").forEach(b => {
            b.classList.toggle("is-active", !!current && b.dataset.id === current.id);
            b.classList.toggle("is-dirty", !!current && b.dataset.id === current.id && dirty());
        });
    }

    async function openFile(id, force) {
        if (!force && current && current.id !== id && dirty()
            && !confirm("มีการแก้ไขที่ยังไม่ save — ทิ้งการแก้ไขแล้วเปิดไฟล์อื่น?")) return;

        try {
            const r = await post("/api/config/read", { id });
            const f = files.find(x => x.id === id) || {};
            // <textarea> normalises CRLF → LF; the server restores the file's own line endings on save
            const text = r.text.replace(/\r\n/g, "\n");
            current = { id, text, sha: r.sha, format: f.format };
            el.text.value = text;
            el.path.textContent = f.relPath || id;
            el.restart.textContent = f.restart || "";
            el.restart.className = "bb-cfg-badge " + (f.restart === "live" ? "live" : f.restart && f.restart.startsWith("restart") ? "restart" : "");
            el.warn.hidden = !f.runtimeWrites;
            markActive();
            await loadBackups();
        } catch (e) {
            setStatus(e.message, "warn");
        }
    }

    async function loadBackups() {
        el.backups.innerHTML = "";
        const head = document.createElement("option");
        head.value = "";
        head.textContent = "Backups…";
        el.backups.appendChild(head);
        if (!current) return;
        try {
            const r = await post("/api/config/backups", { id: current.id });
            for (const b of r.items || []) {
                const o = document.createElement("option");
                o.value = b.name;
                o.textContent = new Date(b.lastWriteUtc).toLocaleString("th-TH", { hour12: false });
                el.backups.appendChild(o);
            }
            head.textContent = (r.items || []).length ? `Backups (${r.items.length})…` : "ยังไม่มี backup";
        } catch { }
    }

    // client-side mirror of ConfigEditorService.Validate (server validates again on save)
    function validateLocal() {
        const text = el.text.value;
        if (current.format === "json") {
            try { JSON.parse(text); return null; }
            catch (e) { return "JSON ไม่ถูกต้อง: " + e.message; }
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].trim();
            if (!t || t[0] === ";" || t[0] === "#") continue;
            if (t[0] === "[") {
                if (!t.endsWith("]") || t.length < 3) return `INI ไม่ถูกต้อง (บรรทัด ${i + 1}): section ต้องเป็น [Name]`;
                continue;
            }
            if (t.indexOf("=") <= 0) return `INI ไม่ถูกต้อง (บรรทัด ${i + 1}): ต้องเป็น key=value`;
        }
        return null;
    }

    async function save() {
        if (!current) return;
        const err = validateLocal();
        if (err) { setStatus(err, "warn"); return; }
        if (!dirty()) { setStatus("ไม่มีการเปลี่ยนแปลง", null); return; }

        el.save.disabled = true;
        try {
            const r = await post("/api/config/save", { id: current.id, text: el.text.value, baseSha: current.sha });
            current.text = el.text.value;
            current.sha = r.sha;
            markActive();
            const f = files.find(x => x.id === current.id) || {};
            setStatus(`บันทึกแล้ว ✔ — ${f.restart === "live" ? "มีผลทันที" : "มีผลเมื่อ " + f.restart}`, "ok");
            await loadBackups();
            await scanLinks();
        } catch (e) {
            setStatus(e.message, "warn");
        } finally {
            el.save.disabled = false;
        }
    }

    async function restore() {
        const name = el.backups.value;
        if (!current || !name) { setStatus("เลือก backup ก่อน", "warn"); return; }
        if (dirty() && !confirm("มีการแก้ไขที่ยังไม่ save — ทิ้งแล้ว restore?")) return;
        if (!confirm(`Restore ${fileLabel(current.id)} จาก backup\n${el.backups.selectedOptions[0].textContent} ?\n(ไฟล์ปัจจุบันจะถูก backup ไว้ก่อน)`)) return;

        try {
            await post("/api/config/restore", { id: current.id, name, baseSha: current.sha });
            setStatus("Restore แล้ว ✔", "ok");
            await openFile(current.id, true);
            await scanLinks();
        } catch (e) {
            setStatus(e.message, "warn");
        }
    }

    function wire() {
        if (wired) return;
        wired = true;
        el.unlock.addEventListener("click", unlock);
        el.pin.addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
        el.rescan.addEventListener("click", scanLinks);
        el.text.addEventListener("input", markActive);
        el.text.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
        });
        el.save.addEventListener("click", save);
        el.reload.addEventListener("click", () => {
            if (current && (!dirty() || confirm("ทิ้งการแก้ไขแล้วโหลดไฟล์ใหม่?"))) openFile(current.id, true);
        });
        el.validate.addEventListener("click", () => {
            if (!current) return;
            const err = validateLocal();
            setStatus(err || "รูปแบบถูกต้อง ✔", err ? "warn" : "ok");
        });
        el.restore.addEventListener("click", restore);
    }

    window.MHxConfigEditor = {
        onShow() {
            el = el || els();
            if (!el.lock) return;
            wire();
            setStatus("");
            if (!pin) { lock(); el.pin.focus(); }
        },
        // leaving the tab (or reopening ⚙️, which lands on Layout) drops the PIN and loaded secrets
        onHide() {
            if (!el || !pin) return;
            lock();
        }
    };
})();
