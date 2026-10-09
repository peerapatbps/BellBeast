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

    async function load() {
        try {
            data = await api("/api/audio/clips");
            render();
        } catch (e) {
            msg("โหลดรายการไม่ได้: " + e.message, false);
        }
    }

    function setChip(id, text, cls) {
        const c = $(id);
        c.textContent = text;
        c.className = "al-chip" + (cls ? " " + cls : "");
    }

    function render() {
        const clips = new Map(data.clips.map((c) => [c.id, c]));
        const vocab = new Map(data.vocabulary.map((v) => [v.id, v]));

        setChip("chipClips", "clips: " + data.clips.length, "");
        setChip("chipMissing", "missing: " + data.missing.length, data.missing.length ? "bad" : "ok");
        setChip("chipTts", data.tts_configured ? "TTS: พร้อม" : "TTS: ยังไม่ตั้งคีย์", data.tts_configured ? "ok" : "warn");

        const miss = $("missing");
        miss.replaceChildren();
        if (!data.missing.length) miss.appendChild(el("span", "al-none", "ครบแล้ว ✓"));
        data.missing.forEach((id) => miss.appendChild(el("code", null, id)));

        // vocabulary first (in its declared order), then clips not in the vocabulary, then engine-referenced unknown ids
        const ids = [...vocab.keys()];
        data.clips.forEach((c) => { if (!vocab.has(c.id)) ids.push(c.id); });
        data.missing.forEach((id) => { if (!ids.includes(id)) ids.push(id); });

        const filter = $("fGroup").value;
        const tbody = $("rows");
        tbody.replaceChildren();
        ids.forEach((id) => {
            const c = clips.get(id) || null;
            const v = vocab.get(id) || null;
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
            msg(clip ? `${label}: ${clip.id} v${clip.version} (${(clip.duration_ms / 1000).toFixed(1)}s)${r.cached ? " — ใช้ของเดิมใน cache" : ""}` : label + " เสร็จ", true);
            await load();
        } catch (e) {
            msg(label + " ไม่สำเร็จ: " + e.message, false);
        } finally {
            busy = false;
        }
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
