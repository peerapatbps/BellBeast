// Audio Library admin page — list / preview / upload / TTS / delete clips.
// Every string from the server goes through textContent (clip text is user-entered).
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    let data = null;
    let busy = false;

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }

    function msg(text, ok) {
        const m = $("msg");
        m.textContent = text || "";
        m.className = "al-msg" + (text ? (ok ? " ok" : " err") : "");
    }

    async function api(url, opts) {
        const r = await fetch(url, Object.assign({ credentials: "same-origin" }, opts || {}));
        let j = null;
        try { j = await r.json(); } catch { /* non-JSON */ }
        if (r.status === 401 || r.status === 403) throw new Error("ต้อง login admin ใหม่ (session หมดอายุ)");
        if (!r.ok || (j && j.ok === false)) throw new Error((j && (j.detail || j.error)) || ("HTTP " + r.status));
        return j;
    }

    // LabVenture Event Class clip-ids that are not in this library yet ({id, text, used_by}) — same origin via the
    // /labventure reverse proxy. Best-effort: LabVenture down → just the library's own missing list.
    const LABVENTURE_NEEDED = "/labventure/api/eventclass/clips-needed";
    let lvNeeded = [];

    async function load() {
        try {
            const [clips, lv] = await Promise.all([
                api("/api/audio/clips"),
                fetch(LABVENTURE_NEEDED, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
            ]);
            data = clips;
            lvNeeded = (lv && Array.isArray(lv.needed)) ? lv.needed : [];
            render();
        } catch (e) {
            msg("โหลดรายการไม่ได้: " + e.message, false);
        }
    }

    // everything still missing: [{ id, text, from: "vocab" | "engine" | "labventure" }] (text "" = can't TTS)
    function missingItems() {
        const have = new Set(data.clips.map((c) => c.id));
        const vocab = new Map(data.vocabulary.map((v) => [v.id, v]));
        const out = new Map();
        data.missing.forEach((id) => out.set(id, { id, text: (vocab.get(id) && vocab.get(id).text) || "", from: vocab.has(id) ? "vocab" : "engine" }));
        lvNeeded.forEach((n) => {
            if (!n || !idOk(n.id) || have.has(n.id)) return;
            const prev = out.get(n.id);
            if (prev) { if (!prev.text && n.text) prev.text = n.text; return; }
            out.set(n.id, { id: n.id, text: (n.text || "").trim(), from: "labventure", used_by: n.used_by || [] });
        });
        return [...out.values()];
    }

    function setChip(id, text, cls) {
        const c = $(id);
        c.textContent = text;
        c.className = "al-chip" + (cls ? " " + cls : "");
    }

    function render() {
        const clips = new Map(data.clips.map((c) => [c.id, c]));
        const vocab = new Map(data.vocabulary.map((v) => [v.id, v]));

        const missing = missingItems();
        const ttsable = missing.filter((m) => m.text);
        setChip("chipClips", "clips: " + data.clips.length, "");
        setChip("chipMissing", "missing: " + missing.length, missing.length ? "bad" : "ok");
        setChip("chipTts", data.tts_configured ? "TTS: พร้อม" : "TTS: ยังไม่ตั้งคีย์", data.tts_configured ? "ok" : "warn");

        const miss = $("missing");
        miss.replaceChildren();
        if (!missing.length) miss.appendChild(el("span", "al-none", "ครบแล้ว ✓"));
        missing.forEach((m) => {
            const code = el("code", (m.from === "labventure" ? "lv" : "") + (m.text ? "" : " notext"), m.id);
            code.title = (m.text || "(ไม่มีข้อความ — TTS ไม่ได้ ใส่ข้อความในตารางด้านล่างก่อน)")
                + (m.from === "labventure" ? "\nใช้ใน LabVenture: " + (m.used_by || []).join(", ") : "");
            miss.appendChild(code);
        });
        const lvCount = missing.filter((m) => m.from === "labventure").length;
        const noText = missing.length - ttsable.length;
        $("missingNote").textContent = [
            lvCount ? `สีเหลือง = Event Class ของ LabVenture ใช้อยู่ (${lvCount})` : "",
            noText ? `จางลง = ไม่มีข้อความ TTS ไม่ได้ (${noText}) — ใส่ข้อความในตารางแล้วกด TTS ทีละแถว` : "",
        ].filter(Boolean).join(" · ");

        const all = $("ttsAll");
        all.textContent = ttsable.length ? `TTS ทั้งหมดที่ขาด (${ttsable.length})` : "TTS ทั้งหมดที่ขาด";
        all.disabled = busy || !data.tts_configured || !ttsable.length;
        all.title = data.tts_configured ? "สร้างเสียงจากข้อความให้ทุก clip ที่ขาดและมีข้อความ" : "ยังไม่ได้ตั้ง Audio:OpenRouterApiKey บน server";

        // vocabulary first (in its declared order), then clips not in the vocabulary, then missing ids (engine / LabVenture)
        const ids = [...vocab.keys()];
        data.clips.forEach((c) => { if (!vocab.has(c.id)) ids.push(c.id); });
        missing.forEach((m) => { if (!ids.includes(m.id)) ids.push(m.id); });
        const lvText = new Map(missing.filter((m) => m.from === "labventure").map((m) => [m.id, m]));

        const filter = $("fGroup").value;
        const tbody = $("rows");
        tbody.replaceChildren();
        ids.forEach((id) => {
            const c = clips.get(id) || null;
            const lv = lvText.get(id);
            const v = vocab.get(id) || (lv ? { id, text: lv.text, group: "labventure" } : null);
            const group = v ? v.group : "other";
            if (filter === "missing" && c) return;
            if (filter && filter !== "missing" && filter !== group) return;
            tbody.appendChild(row(id, c, v, group));
        });
    }

    function row(id, c, v, group) {
        const tr = el("tr", c ? "" : "missing");

        const tdDot = el("td");
        tdDot.appendChild(el("span", "al-dot" + (c ? " on" : "")));
        tr.appendChild(tdDot);

        const tdId = el("td", "id", id);
        tdId.appendChild(el("div", "al-grp", group));
        tr.appendChild(tdId);

        const tdText = el("td");
        const input = el("input", "al-in text");
        input.maxLength = 500;
        input.value = (c && c.text) || (v && v.text) || "";
        tdText.appendChild(input);
        tr.appendChild(tdText);

        tr.appendChild(el("td", "num", c ? "v" + c.version : "–"));
        tr.appendChild(el("td", "num", c ? (c.duration_ms / 1000).toFixed(1) + "s" : "–"));
        const tdSrc = el("td");
        if (c) tdSrc.appendChild(el("span", "al-src", c.source));
        tr.appendChild(tdSrc);

        const tdAct = el("td", "act");
        const play = el("button", "al-btn", "▶");
        play.type = "button";
        play.title = "ฟัง";
        play.disabled = !c;
        play.addEventListener("click", () => preview(c));
        tdAct.appendChild(play);

        const ttsBtn = el("button", "al-btn", c ? "TTS ใหม่" : "TTS");
        ttsBtn.type = "button";
        ttsBtn.disabled = !data.tts_configured;
        ttsBtn.title = data.tts_configured ? "สร้างเสียงจากข้อความ" : "ยังไม่ได้ตั้ง Audio:OpenRouterApiKey บน server";
        ttsBtn.addEventListener("click", () => {
            if (c && c.source === "upload" && !confirm("clip นี้เป็นเสียงที่อัปโหลด (อาจเป็นเสียงคนจริง) — แทนที่ด้วย TTS?")) return;
            tts(id, input.value);
        });
        tdAct.appendChild(ttsBtn);

        const file = el("input", "al-file");
        file.type = "file";
        file.accept = ".wav,.pcm,audio/wav";
        file.addEventListener("change", () => { if (file.files[0]) upload(id, file.files[0], input.value); file.value = ""; });
        const up = el("button", "al-btn", "อัปโหลด");
        up.type = "button";
        up.addEventListener("click", () => file.click());
        tdAct.appendChild(up);
        tdAct.appendChild(file);

        if (c) {
            const del = el("button", "al-btn del", "ลบ");
            del.type = "button";
            del.addEventListener("click", () => remove(id));
            tdAct.appendChild(del);
        }
        tr.appendChild(tdAct);
        return tr;
    }

    let player = null;
    function preview(c) {
        if (player) player.pause();
        player = new Audio("/api/audio/clip/" + encodeURIComponent(c.id) + "?format=wav&sha=" + c.sha256);
        player.play().catch((e) => msg("เล่นไม่ได้: " + e.message, false));
    }

    async function guarded(label, fn) {
        if (busy) return;
        busy = true;
        msg(label + "…", true);
        try {
            const r = await fn();
            const clip = r && r.clip;
            const ms = clip && (clip.duration_ms ?? clip.durationMs);
            const dur = Number.isFinite(ms) ? ` (${(ms / 1000).toFixed(1)}s)` : "";
            msg(clip ? `${label}: ${clip.id} v${clip.version ?? clip.Version ?? "?"}${dur}${r.cached ? " — ใช้ของเดิมใน cache" : ""}` : label + " เสร็จ", true);
        } catch (e) {
            msg(label + " ไม่สำเร็จ: " + e.message, false);
            return;
        } finally {
            busy = false;
        }
        await load();   // after busy is cleared, so the re-render enables the buttons again
    }

    function tts(id, text) {
        text = (text || "").trim();
        if (!text) { msg("ใส่ข้อความก่อนสร้าง TTS", false); return; }
        return guarded("สร้าง TTS", () => api("/api/audio/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(id ? { id, text } : { text }),
        }));
    }

    function upload(id, file, text) {
        const fd = new FormData();
        fd.append("id", id);
        fd.append("file", file);
        fd.append("text", (text || "").trim());
        return guarded("อัปโหลด", () => api("/api/audio/clip", { method: "POST", body: fd }));
    }

    function remove(id) {
        if (!confirm("ลบ clip " + id + " ? device ที่ยังไม่มีใน cache จะเล่นคำนี้ไม่ได้ (fallback เป็น horn + ข้อความ)")) return;
        return guarded("ลบ", () => api("/api/audio/clip/" + encodeURIComponent(id), { method: "DELETE" }));
    }

    const idOk = (s) => /^[a-z0-9_]{1,64}$/.test(s);

    // one TTS call at a time (provider rate limits; each call is billed) — stops on an auth error
    async function ttsAll() {
        if (busy || !data) return;
        const todo = missingItems().filter((m) => m.text);
        if (!todo.length) return;
        if (!confirm(`สร้างเสียง TTS ${todo.length} clip?\n\n` + todo.slice(0, 12).map((m) => `${m.id} — ${m.text}`).join("\n")
            + (todo.length > 12 ? `\n… และอีก ${todo.length - 12}` : ""))) return;
        busy = true;
        $("ttsAll").disabled = true;
        const failed = [];
        let done = 0;
        try {
            for (const m of todo) {
                msg(`สร้าง TTS ${done + failed.length + 1}/${todo.length}: ${m.id} — ${m.text}`, true);
                try {
                    await api("/api/audio/tts", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: m.id, text: m.text }),
                    });
                    done++;
                } catch (e) {
                    failed.push(`${m.id}: ${e.message}`);
                    if (/login admin/.test(e.message)) break;
                }
            }
        } finally {
            busy = false;
        }
        await load();
        msg(failed.length
            ? `TTS สำเร็จ ${done}/${todo.length} · ไม่สำเร็จ ${failed.length} — ${failed.join(" · ")}`
            : `TTS สำเร็จครบ ${done} clip ✓`, !failed.length);
    }

    $("ttsAll").addEventListener("click", ttsAll);
    $("fGroup").addEventListener("change", () => data && render());
    $("newTts").addEventListener("click", () => {
        const id = $("newId").value.trim().toLowerCase();
        if (id && !idOk(id)) { msg("id ใช้ได้เฉพาะ a-z 0-9 _ (ไม่เกิน 64 ตัว)", false); return; }
        tts(id, $("newText").value); // empty id → sentence clip tts_<hash>
    });
    $("newUpload").addEventListener("click", () => {
        const id = $("newId").value.trim().toLowerCase();
        if (!idOk(id)) { msg("ใส่ id ก่อนอัปโหลด (a-z 0-9 _)", false); return; }
        $("newFile").click();
    });
    $("newFile").addEventListener("change", () => {
        const f = $("newFile").files[0];
        if (f) upload($("newId").value.trim().toLowerCase(), f, $("newText").value);
        $("newFile").value = "";
    });

    load();
})();
