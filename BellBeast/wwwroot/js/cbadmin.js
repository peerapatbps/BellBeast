// Admin → Connector Box: edit the Uroboros cb_* registry through the same-origin /api/cb/* proxy (admin group).
// Forms are generated from the JSON Schema Uroboros serves (/api/cb/schema): cb_config.schema.json for every list,
// cb_schema/<slot_type>.schema.json for the params of sources / detectors / sinks. Nothing plant-specific lives here.
// Every edit is optimistic-concurrency checked with ?rev= and can be validated first with ?dry=1.
// Every string from the server goes through esc() before it reaches innerHTML.
(function () {
    "use strict";

    const API = "/api/cb";
    const $ = (s, r) => (r || document).querySelector(s);
    const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const h = (tag, attrs, html) => {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : v);
        }
        if (html !== undefined) e.innerHTML = html;
        return e;
    };

    // list name in cb_config.json → label (order = how the admin usually builds a registry)
    const ENTITIES = [
        { key: "params", label: "Params", hint: "งานที่ runner เฝ้า: PV ตัวไหน เทียบ SP ตัวไหน ใช้ detector / กฎ / sink อะไร" },
        { key: "signals", label: "Signals", hint: "tag แต่ละตัว: อ่านจาก source ไหน role อะไร หน่วยและ scale" },
        { key: "equipment", label: "Equipment", hint: "อุปกรณ์ (สาย, ปั๊ม, วาล์ว) ที่ signal และกลุ่มอ้างถึง" },
        { key: "groups", label: "Groups", hint: "รวมอุปกรณ์เป็นกลุ่ม (สายคู่ / ปั๊มสำรอง) และวิธีรวมค่า" },
        { key: "sources", label: "Sources", hint: "แหล่งค่า (aq2_latest, aq2_series, http, sqlite, const) และ tolerance (sigma, abs)" },
        { key: "detectors", label: "Detectors", hint: "ตัวจับการเปลี่ยน (fifo2) และค่าตั้ง" },
        { key: "sinks", label: "Sinks", hint: "ปลายทางของผล (log_only ตอน shadow)" },
        { key: "rulesets", label: "Rulesets", hint: "ชุดกฎ (แก้กฎแต่ละข้อที่แท็บ กฎ)" },
        { key: "slot_types", label: "Slot types", hint: "ชนิดกล่องที่ระบบรู้จัก และไฟล์ schema ของ params" },
    ];
    // property name → list its value refers to (only for the code picker; the server checks the FK)
    const REF = {
        pv_signal: "signals", sp_signal: "signals", equipment: "equipment", group: "groups", detector: "detectors",
        ruleset: "rulesets", sink: "sinks", tolerance_source: "sources", source: "sources", slot_type: "slot_types", seed_source: "sources",
    };
    // which slot kinds a slot instance list may use
    const SLOT_KINDS = { sources: ["value", "tolerance"], detectors: ["detector"], sinks: ["sink"] };
    // list columns shown next to code (fields that exist in the schema of that list)
    const COLS = {
        params: ["scope", "group", "equipment", "ruleset", "sink", "description"],
        signals: ["equipment", "source", "role", "tag", "unit", "scale"],
        equipment: ["name", "station", "kind"],
        groups: ["kind", "aggregate", "members"],
        sources: ["slot_type", "description"], detectors: ["slot_type", "params"], sinks: ["slot_type", "params"],
        rulesets: ["version", "rules", "description"], slot_types: ["kind", "schema_file", "description"],
    };

    const ERR = {
        engine_offline: "ติดต่อ Uroboros ไม่ได้ (engine ปิดอยู่หรือ cbApiPath / baseUrl ผิด)",
        rev_conflict: "มีคนแก้ registry ไปก่อนแล้ว — กดรีเฟรชแล้วแก้ใหม่",
        invalid: "ค่าไม่ผ่านการตรวจ ยังไม่ได้บันทึกอะไร",
        not_found: "ไม่พบรายการนี้แล้ว", code_mismatch: "code ใน body ไม่ตรงกับ URL (เปลี่ยนชื่อ = ลบแล้วเพิ่มใหม่)",
        bad_json: "JSON ไม่ถูกต้อง", empty_body: "ยังไม่ได้ใส่ข้อมูล", cb_error: "Uroboros แจ้งข้อผิดพลาด",
    };

    let cfg = null;          // whole registry (= cb_config.json)
    let rev = "";
    let schema = null;       // { config, slots: { code: { kind, schema } } }
    let view = "overview";
    let entity = "params";
    let selected = null;     // { kind: "entity"|"rule", list, code (null = new), ruleset }
    let editor = null;       // current editor: { get(), json: bool, dirty }
    let ruleset = null;
    let lastErrors = null;   // server errors for the open editor

    // ------------------------------------------------------------------ http

    async function call(url, opts) {
        const r = await fetch(url, Object.assign({ credentials: "same-origin", cache: "no-store" }, opts || {}));
        let j = null;
        try { j = await r.json(); } catch { /* non-JSON */ }
        if (r.status === 401 || r.status === 403) throw Object.assign(new Error("ต้อง login admin ใหม่ (session หมดอายุ)"), { data: j });
        if (!r.ok || (j && j.ok === false)) {
            const code = (j && j.error) || ("HTTP " + r.status);
            const text = (ERR[code] || code) + (j && j.message && code !== "invalid" ? " — " + j.message : "");
            throw Object.assign(new Error(text), { data: j, status: r.status });
        }
        clearError();
        return { j, r };
    }
    const send = (url, method, body) => call(url, {
        method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
    });
    const q = (dry) => "?rev=" + encodeURIComponent(rev) + (dry ? "&dry=1" : "");

    function toast(text) {
        const t = $("#toast");
        t.textContent = text; t.hidden = false;
        clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2800);
    }
    function showError(e) { const m = $("#msg"); m.textContent = e.message || String(e); m.hidden = false; }
    function clearError() { $("#msg").hidden = true; }
    const ts = (iso) => iso ? new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "medium" }) : "–";

    // ------------------------------------------------------------------ load

    async function loadConfig() {
        const { j, r } = await call(API + "/config");
        cfg = j;
        $$("datalist[id^='dl-']").forEach((d) => d.remove());   // code pickers are rebuilt from the new registry
        rev = ((r.headers.get("ETag") || "").replace(/^W\//, "").replace(/"/g, "")) || "";
        $("#rev").textContent = rev ? "rev " + rev : "";
    }

    async function load() {
        try {
            const [{ j: sc }] = await Promise.all([call(API + "/schema"), loadConfig()]);
            schema = { config: sc.config, slots: {} };
            for (const s of sc.slot_types || []) schema.slots[s.code] = { kind: s.kind, schema: s.schema, description: s.description };
            render();
        } catch (e) {
            showError(e);
        }
    }

    // ------------------------------------------------------------------ schema helpers

    function deref(s) {
        let n = 0;
        while (s && s.$ref && n++ < 10) s = schema.config.$defs[s.$ref.split("/").pop()];
        return s || {};
    }
    const types = (s) => Array.isArray(s.type) ? s.type : (s.type ? [s.type] : []);
    function kindOf(s) {
        if (s.enum) return "enum";
        if (s.const !== undefined) return "const";
        return types(s).find((t) => t !== "null") || "any";
    }
    const itemSchema = (list) => deref(schema.config.properties[list].items);
    const ruleSchema = () => deref({ $ref: "#/$defs/rule" });
    const codes = (list) => ((cfg && cfg[list]) || []).map((x) => x.code);

    // ------------------------------------------------------------------ form builder
    // field(...) → { el, get() }   get() returns undefined for "leave it out"

    function label(name, s, req) {
        const l = h("div", { class: "lbl" });
        l.append(h("b", { text: name }));
        if (req) l.append(h("span", { class: "req", text: "*" }));
        return l;
    }

    function field(name, s0, value, path, req, ctx) {
        const s = deref(s0);
        const k = kindOf(s);
        const wrap = h("div", { class: "cb-f", "data-path": path });
        const markDirty = () => { if (editor) editor.dirty = true; };
        wrap.addEventListener("input", markDirty);
        wrap.addEventListener("change", markDirty);

        const desc = s.description || s0.description;
        const addDesc = () => { if (desc) wrap.append(h("div", { class: "desc", text: desc })); };

        if (k === "object") {
            const props = s.properties;
            if (props) {
                wrap.classList.add("group");
                wrap.append(label(name, s, req));
                addDesc();
                const sub = objectForm(s, value && typeof value === "object" ? value : {}, path, ctx);
                wrap.append(sub.el);
                return { el: wrap, get: () => { const v = sub.get(); return v === undefined && req ? {} : v; } };
            }
            return jsonField(wrap, name, s, value, req, addDesc);
        }

        if (k === "array") {
            const it = deref(s.items || {});
            const ik = kindOf(it);
            if (ik === "object" && it.properties && Object.values(it.properties).every((p) => !["object", "array"].includes(kindOf(deref(p))))) {
                return rowsField(wrap, name, s, it, value, path, req, ctx, addDesc);
            }
            if (["string", "enum", "number", "integer"].includes(ik)) {
                wrap.append(label(name, s, req));
                const inp = h("input", { type: "text", placeholder: "คั่นด้วย ,", value: Array.isArray(value) ? value.join(", ") : "" });
                wrap.append(inp);
                addDesc();
                return {
                    el: wrap, get: () => {
                        const parts = inp.value.split(",").map((x) => x.trim()).filter(Boolean)
                            .map((x) => (ik === "number" || ik === "integer") ? Number(x) : x);
                        return parts.length ? parts : (req ? [] : undefined);
                    },
                };
            }
            return jsonField(wrap, name, s, value, req, addDesc);
        }

        wrap.append(label(name, s, req));
        let get;
        if (k === "enum" || (k === "boolean" && !req)) {
            const opts = k === "enum" ? s.enum.filter((x) => x !== null) : [true, false];
            const sel = h("select");
            if (!req || value === undefined || value === null) sel.append(h("option", { value: "", text: "—" }));
            opts.forEach((o, i) => sel.append(h("option", { value: String(i), text: String(o), selected: value === o })));
            wrap.append(sel);
            get = () => sel.value === "" ? undefined : opts[Number(sel.value)];
        } else if (k === "boolean") {
            const cb = h("input", { type: "checkbox", checked: value === true });
            wrap.append(cb);
            get = () => cb.checked;
        } else if (k === "integer" || k === "number") {
            const inp = h("input", { type: "number", step: k === "integer" ? "1" : "any", value: value ?? "" });
            if (s.minimum !== undefined) inp.min = s.minimum;
            if (s.maximum !== undefined) inp.max = s.maximum;
            if (s.default !== undefined) inp.placeholder = "ค่าเริ่ม " + s.default;
            wrap.append(inp);
            get = () => inp.value.trim() === "" ? undefined : Number(inp.value);
        } else if (k === "const") {
            wrap.append(h("input", { type: "text", value: String(s.const), readonly: true }));
            get = () => s.const;
        } else if (k === "string") {
            const inp = h("input", { type: "text", value: value ?? "", spellcheck: "false" });
            if (name === "code" && ctx.lockCode) inp.readOnly = true;
            const refList = ctx.refs && REF[name];
            if (refList) {
                const id = "dl-" + refList;
                inp.setAttribute("list", id);
                if (!document.getElementById(id)) {
                    const dl = h("datalist", { id });
                    codes(refList).forEach((c) => dl.append(h("option", { value: c })));
                    document.body.append(dl);
                }
            }
            if (s.pattern) inp.title = "รูปแบบ: " + s.pattern;
            wrap.append(inp);
            get = () => inp.value === "" ? undefined : inp.value;
        } else {
            return jsonField(wrap, name, s, value, req, () => { });
        }
        addDesc();
        return { el: wrap, get };
    }

    function jsonField(wrap, name, s, value, req, addDesc) {
        wrap.classList.add("group");
        wrap.append(label(name, s, req));
        const ta = h("textarea", { spellcheck: "false" });
        ta.value = value === undefined ? "" : JSON.stringify(value, null, 2);
        wrap.append(ta);
        addDesc();
        return {
            el: wrap, get: () => {
                if (ta.value.trim() === "") return req ? {} : undefined;
                try { return JSON.parse(ta.value); } catch { throw new Error(name + ": JSON ไม่ถูกต้อง"); }
            },
        };
    }

    function rowsField(wrap, name, s, it, value, path, req, ctx, addDesc) {
        wrap.classList.add("group");
        wrap.append(label(name, s, req));
        addDesc();
        const rows = h("div", { class: "cb-rows" });
        const items = [];
        const keys = Object.keys(it.properties);
        const required = new Set(it.required || []);
        function addRow(v) {
            const row = h("div", { class: "cb-row" });
            const fields = keys.map((kk) => {
                const f = field(kk, it.properties[kk], v ? v[kk] : undefined, path + "[" + items.length + "]." + kk, required.has(kk), ctx);
                row.append(f.el);
                return [kk, f];
            });
            const rm = h("button", { type: "button", class: "cb-btn bad sm", text: "ลบ" });
            const entry = { row, fields };
            rm.addEventListener("click", () => { row.remove(); items.splice(items.indexOf(entry), 1); if (editor) editor.dirty = true; });
            row.append(rm);
            rows.append(row);
            items.push(entry);
        }
        (Array.isArray(value) ? value : []).forEach(addRow);
        const add = h("button", { type: "button", class: "cb-btn sm", text: "+ เพิ่มแถว" });
        add.addEventListener("click", () => { addRow(null); if (editor) editor.dirty = true; });
        wrap.append(rows, add);
        return {
            el: wrap, get: () => {
                const out = items.map(({ fields }) => {
                    const o = {};
                    for (const [kk, f] of fields) { const v = f.get(); if (v !== undefined) o[kk] = v; }
                    return o;
                });
                return out.length ? out : (req ? [] : undefined);
            },
        };
    }

    /** Fields for every property of an object schema; skip = property names drawn elsewhere. */
    function objectForm(s, value, path, ctx, skip) {
        const grid = h("div", { class: "cb-form" });
        const req = new Set(s.required || []);
        const fields = [];
        for (const [name, ps] of Object.entries(s.properties || {})) {
            if (skip && skip.has(name)) continue;
            const f = field(name, ps, value[name], path + "." + name, req.has(name), ctx);
            grid.append(f.el);
            fields.push([name, f]);
        }
        return {
            el: grid, fields, get: () => {
                const o = {};
                let any = false;
                for (const [name, f] of fields) { const v = f.get(); if (v !== undefined) { o[name] = v; any = true; } }
                return any ? o : undefined;
            },
        };
    }

    /** Form for one list item; slot instances get their params form from the chosen slot type's schema. */
    function itemForm(list, value, isNew) {
        const s = itemSchema(list);
        const ctx = { lockCode: !isNew, refs: true };
        const skip = new Set(list === "rulesets" ? ["rules"] : []);
        if (SLOT_KINDS[list]) { skip.add("slot_type"); skip.add("params"); }
        const base = objectForm(s, value, "$", ctx, skip);
        const root = h("div");
        root.append(base.el);

        let slotSel = null, paramsBox = null, paramsForm = null;
        if (SLOT_KINDS[list]) {
            const allowed = Object.entries(schema.slots).filter(([, v]) => SLOT_KINDS[list].includes(v.kind)).map(([c]) => c);
            const f = h("div", { class: "cb-f", "data-path": "$.slot_type" });
            f.append(label("slot_type", {}, true));
            slotSel = h("select");
            if (!value.slot_type) slotSel.append(h("option", { value: "", text: "— เลือก —" }));
            allowed.forEach((c) => slotSel.append(h("option", { value: c, text: c + " (" + schema.slots[c].kind + ")", selected: value.slot_type === c })));
            f.append(slotSel);
            base.el.prepend(f);
            const codeField = base.el.querySelector('[data-path="$.code"]');
            if (codeField) base.el.prepend(codeField);
            paramsBox = h("div", { class: "cb-f group", "data-path": "$.params" });
            root.append(paramsBox);
            const drawParams = (keep) => {
                paramsBox.innerHTML = "";
                paramsBox.append(label("params", {}, true));
                const st = schema.slots[slotSel.value];
                if (!st) { paramsBox.append(h("div", { class: "desc", text: "เลือก slot_type ก่อน" })); paramsForm = null; return; }
                if (st.schema && st.schema.title) paramsBox.append(h("div", { class: "desc", text: st.schema.title }));
                const ps = st.schema && st.schema.properties ? st.schema : null;
                if (ps) { paramsForm = objectForm(ps, keep || {}, "$.params", { refs: true }); paramsBox.append(paramsForm.el); }
                else { const jf = jsonField(h("div", { class: "cb-f" }), "params", {}, keep || {}, true, () => { }); paramsForm = jf; paramsBox.append(jf.el); }
            };
            drawParams(value.params);
            slotSel.addEventListener("change", () => { if (editor) editor.dirty = true; drawParams(paramsForm ? safeGet(paramsForm) : {}); });
        }

        return {
            el: root, get: () => {
                const o = base.get() || {};
                if (slotSel) {
                    if (slotSel.value) o.slot_type = slotSel.value;
                    o.params = (paramsForm && paramsForm.get()) || {};
                    // keep property order like cb_config.json: code, slot_type, params, description
                    const { code, slot_type, params, ...rest } = o;
                    return Object.assign({ code, slot_type, params }, rest);
                }
                return o;
            },
        };
    }
    function safeGet(f) { try { return f.get() || {}; } catch { return {}; } }

    // ------------------------------------------------------------------ editor (entity item or rule)

    function editorPanel(title, value, buildForm, actions) {
        const box = h("div", { class: "cb-editor" });
        const head = h("div", { class: "cb-ed-head" });
        head.append(h("h3", { text: title }), h("span", { class: "sp" }));
        const jsonBtn = h("button", { type: "button", class: "cb-btn sm", text: "แก้เป็น JSON" });
        head.append(jsonBtn);
        box.append(head);
        const body = h("div");
        box.append(body);
        const foot = h("div", { class: "cb-toolbar", style: "margin:14px 0 0" });
        const dry = h("button", { type: "button", class: "cb-btn", text: "ตรวจสอบ (dry-run)" });
        const save = h("button", { type: "button", class: "cb-btn primary", text: "บันทึก" });
        const cancel = h("button", { type: "button", class: "cb-btn", text: "ปิด" });
        foot.append(dry, save, cancel, h("span", { class: "sp" }));
        if (actions.remove) {
            const del = h("button", { type: "button", class: "cb-btn bad", text: "ลบรายการนี้" });
            del.addEventListener("click", actions.remove);
            foot.append(del);
        }
        box.append(foot);
        const result = h("div");
        box.append(result);

        const ed = { json: false, dirty: false, form: null, ta: null };
        const draw = (v) => {
            body.innerHTML = "";
            if (ed.json) {
                ed.ta = h("textarea", { class: "cb-json", spellcheck: "false" });
                ed.ta.value = JSON.stringify(v, null, 2);
                ed.ta.addEventListener("input", () => { ed.dirty = true; });
                body.append(ed.ta);
            } else {
                ed.form = buildForm(v);
                body.append(ed.form.el);
            }
            jsonBtn.textContent = ed.json ? "แก้เป็นฟอร์ม" : "แก้เป็น JSON";
            showServerErrors(box, lastErrors);
        };
        ed.get = () => {
            if (ed.json) { try { return JSON.parse(ed.ta.value); } catch (e) { throw new Error("JSON ไม่ถูกต้อง: " + e.message); } }
            return ed.form.get();
        };
        jsonBtn.addEventListener("click", () => {
            let v;
            try { v = ed.get(); } catch (e) { showError(e); return; }
            ed.json = !ed.json;
            draw(v);
        });
        const run = async (isDry) => {
            let v;
            try { v = ed.get(); } catch (e) { showError(e); return; }
            dry.disabled = save.disabled = true;
            result.innerHTML = "";
            try {
                const { j } = await actions.submit(v, isDry);
                lastErrors = null;
                showServerErrors(box, null);
                if (isDry) result.append(h("div", { class: "cb-okbox", text: "ผ่านการตรวจ — ยังไม่ได้บันทึก" }));
                else { ed.dirty = false; toast("บันทึกแล้ว · runner จะใช้ค่าใหม่ภายใน ~1 นาที"); await actions.saved(j); }
            } catch (e) {
                if (e.data && e.data.error === "invalid") { lastErrors = e.data.errors || []; showServerErrors(box, lastErrors); }
                else showError(e);
            } finally { dry.disabled = save.disabled = false; }
        };
        dry.addEventListener("click", () => run(true));
        save.addEventListener("click", () => run(false));
        cancel.addEventListener("click", () => { if (confirmLeave()) { selected = null; editor = null; lastErrors = null; render(); } });
        draw(value);
        editor = ed;
        return box;
    }

    function showServerErrors(box, errs) {
        $$(".cb-f.err", box).forEach((f) => { f.classList.remove("err"); $$(".emsg", f).forEach((m) => m.remove()); });
        $$(".cb-errors", box).forEach((x) => x.remove());
        if (!errs || !errs.length) return;
        const list = h("div", { class: "cb-errors" });
        list.append(h("b", { text: ERR.invalid }));
        const ul = h("ul");
        for (const e of errs) {
            const p = e.item_path || e.path || "";
            ul.append(h("li", {}, "<code>" + esc(p) + "</code> " + esc(e.message)));
            // highlight the deepest field whose path is a prefix of the error path
            if (e.item_path) {
                const fs = $$(".cb-f[data-path]", box).filter((f) => e.item_path === f.dataset.path || e.item_path.startsWith(f.dataset.path + ".") || e.item_path.startsWith(f.dataset.path + "["));
                fs.sort((a, b) => b.dataset.path.length - a.dataset.path.length);
                if (fs[0]) { fs[0].classList.add("err"); fs[0].append(h("div", { class: "emsg", text: e.message })); }
            }
        }
        list.append(ul);
        box.append(list);
    }

    function confirmLeave() { return !(editor && editor.dirty) || confirm("มีการแก้ที่ยังไม่บันทึก ทิ้งไปเลยไหม?"); }

    // ------------------------------------------------------------------ views

    function render() {
        $$(".cb-tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.tab === view ? "true" : "false"));
        for (const v of ["overview", "registry", "rules", "tester", "io"]) $("#v-" + v).hidden = v !== view;
        if (!cfg || !schema) return;
        ({ overview: renderOverview, registry: renderRegistry, rules: renderRules, tester: renderTester, io: renderIo })[view]();
    }

    // ---- overview

    async function renderOverview() {
        const el = $("#v-overview");
        el.innerHTML = '<div class="cb-empty">กำลังโหลด…</div>';
        try {
            const [{ j: sum }, { j: mon }] = await Promise.all([call(API + "/summary"), call(API + "/monitor")]);
            const sev = (o) => Object.entries(o || {}).map(([k, v]) => esc(k) + " " + esc(v)).join(" · ") || "–";
            const running = mon.running
                ? '<span class="cb-badge ok">ทำงานอยู่</span>'
                : '<span class="cb-badge warn">ไม่มีข้อมูลจาก runner</span>';
            let html = '<div class="cb-cards">'
                + stat("Runner (cb.runner)", running, "ส่งค่าล่าสุด " + esc(ts(mon.last_publish)))
                + stat("Param ที่เปิด", esc(sum.params_enabled), esc((cfg.params || []).length) + " ทั้งหมด")
                + stat("Case เปิดอยู่", esc(sum.open_cases), sev(sum.open_cases_by_severity))
                + stat("Event ยังไม่ ack", esc(sum.unacked_events), sev(sum.unacked_by_severity))
                + stat("รอตัดสิน (settle)", esc(sum.pending_checks), "")
                + "</div>";
            if (!(cfg.params || []).length)
                html += '<div class="cb-card warn"><h3>registry ยังว่าง</h3>ไปที่แท็บ <b>นำเข้า / ส่งออก</b> แล้ววาง cb_config.json (ตรวจ dry-run ก่อน) หรือเพิ่มทีละรายการที่แท็บ <b>ตั้งค่า</b></div>';
            html += '<div class="cb-card"><h3>Param</h3><div class="cb-scroll"><table class="cb-table"><thead><tr><th>code</th><th>เปิด</th><th>detector มีค่า</th><th>ruleset</th><th>sink</th><th>คำอธิบาย</th></tr></thead><tbody>';
            const has = new Map((mon.params || []).map((p) => [p.code, p.has_samples]));
            for (const p of cfg.params || [])
                html += '<tr data-code="' + esc(p.code) + '" class="' + (p.enabled ? "" : "off") + '"><td class="code">' + esc(p.code) + "</td><td>"
                    + (p.enabled ? '<span class="cb-badge ok">เปิด</span>' : '<span class="cb-badge">ปิด</span>') + "</td><td>"
                    + (has.get(p.code) ? '<span class="cb-badge info">มี</span>' : '<span class="cb-faint">–</span>') + '</td><td class="code">'
                    + esc(p.ruleset) + '</td><td class="code">' + esc(p.sink) + "</td><td>" + esc(p.description) + "</td></tr>";
            html += "</tbody></table></div></div>";
            html += '<div class="cb-card"><h3>Event ล่าสุด</h3>' + eventsTable(sum.latest_events || []) + "</div>";
            el.innerHTML = html;
            $$("tbody tr[data-code]", el).forEach((tr) => tr.addEventListener("click", () => { view = "registry"; entity = "params"; openItem("params", tr.dataset.code); }));
        } catch (e) {
            el.innerHTML = "";
            showError(e);
        }
    }
    const stat = (k, v, s) => '<div class="cb-stat"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + s + "</div></div>";
    function eventsTable(items) {
        if (!items.length) return '<div class="cb-empty">ยังไม่มี event</div>';
        const sevCls = (s) => s === "critical" ? "bad" : s === "warning" ? "warn" : s ? "info" : "";
        return '<div class="cb-scroll"><table class="cb-table"><thead><tr><th>เวลา</th><th>param</th><th>ทิศ</th><th>status</th><th>severity</th><th>กฎ</th><th>case</th></tr></thead><tbody>'
            + items.map((e) => "<tr><td>" + esc(ts(e.t)) + '</td><td class="code">' + esc(e.param) + "</td><td>" + esc(e.dir) + "</td><td>" + esc(e.status ?? "รอ")
                + '</td><td><span class="cb-badge ' + sevCls(e.severity) + '">' + esc(e.severity ?? "–") + '</span></td><td class="code">' + esc(e.rule ?? "–")
                + '</td><td class="code">' + esc(e.case_action ?? "–") + "</td></tr>").join("")
            + "</tbody></table></div>";
    }

    // ---- registry

    function cell(list, item, col) {
        const v = item[col];
        if (v === undefined || v === null || v === "") return '<span class="cb-faint">–</span>';
        if (col === "members") return '<div class="cb-chips">' + v.map((m) => "<span>" + esc(m.position) + ":" + esc(m.equipment) + "</span>").join("") + "</div>";
        if (col === "rules") return esc(v.length) + " ข้อ";
        if (col === "params" && typeof v === "object") return '<div class="cb-chips">' + Object.entries(v).map(([k, x]) => "<span>" + esc(k) + "=" + esc(typeof x === "object" ? JSON.stringify(x) : x) + "</span>").join("") + "</div>";
        if (REF[col] || col === "role" || col === "scope" || col === "kind") return '<span class="cb-mono">' + esc(v) + "</span>";
        return esc(v);
    }

    function renderRegistry() {
        const el = $("#v-registry");
        el.innerHTML = "";
        const split = h("div", { class: "cb-split" });
        const nav = h("div", { class: "cb-ents" });
        for (const e of ENTITIES) {
            const b = h("button", { type: "button", class: "cb-ent", "aria-current": e.key === entity ? "true" : "false" },
                esc(e.label) + '<span class="n">' + esc((cfg[e.key] || []).length) + "</span>");
            b.addEventListener("click", () => { if (!confirmLeave()) return; entity = e.key; selected = null; editor = null; lastErrors = null; renderRegistry(); });
            nav.append(b);
        }
        const main = h("div");
        const meta = ENTITIES.find((x) => x.key === entity);
        const bar = h("div", { class: "cb-toolbar" });
        bar.append(h("p", { class: "cb-hint", style: "margin:0", text: meta.hint }), h("span", { class: "sp" }));
        const add = h("button", { type: "button", class: "cb-btn primary sm", text: "+ เพิ่ม" });
        add.addEventListener("click", () => { if (confirmLeave()) openItem(entity, null); });
        bar.append(add);
        main.append(bar);

        const cols = (COLS[entity] || []).filter((c) => itemSchema(entity).properties && c in itemSchema(entity).properties);
        const items = cfg[entity] || [];
        if (!items.length) main.append(h("div", { class: "cb-empty", text: "ยังไม่มีรายการ" }));
        else {
            let html = '<div class="cb-scroll"><table class="cb-table"><thead><tr><th>code</th>' + (entity === "params" ? "<th>เปิด</th>" : "")
                + cols.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>";
            for (const it of items) {
                const sel = selected && selected.kind === "entity" && selected.list === entity && selected.code === it.code;
                html += '<tr data-code="' + esc(it.code) + '" class="' + (sel ? "sel " : "") + (it.enabled === false ? "off" : "") + '"><td class="code">' + esc(it.code) + "</td>"
                    + (entity === "params" ? '<td><button type="button" class="cb-switch" role="switch" aria-checked="' + (it.enabled ? "true" : "false") + '" aria-label="เปิด/ปิด ' + esc(it.code) + '"></button></td>' : "")
                    + cols.map((c) => "<td>" + cell(entity, it, c) + "</td>").join("") + "</tr>";
            }
            html += "</tbody></table></div>";
            const wrap = h("div", {}, html);
            $$("tbody tr", wrap).forEach((tr) => tr.addEventListener("click", (ev) => {
                if (ev.target.closest(".cb-switch")) return;
                if (confirmLeave()) openItem(entity, tr.dataset.code);
            }));
            $$(".cb-switch", wrap).forEach((sw) => sw.addEventListener("click", () => toggleParam(sw.closest("tr").dataset.code)));
            main.append(wrap);
        }

        if (selected && selected.kind === "entity" && selected.list === entity) main.append(entityEditor(entity, selected.code));
        split.append(nav, main);
        el.append(split);
    }

    function openItem(list, code) {
        entity = list;
        selected = { kind: "entity", list, code };
        editor = null;
        lastErrors = null;
        render();
        const ed = $(".cb-editor");
        if (ed) ed.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function entityEditor(list, code) {
        const isNew = code === null;
        const current = isNew ? {} : (cfg[list] || []).find((x) => x.code === code);
        if (!isNew && !current) { selected = null; return h("div"); }
        const label = (ENTITIES.find((x) => x.key === list) || {}).label || list;
        return editorPanel(isNew ? "เพิ่ม " + label : label + " · " + code, current, (v) => itemForm(list, v, isNew), {
            submit: (v, dry) => {
                const c = isNew ? v.code : code;
                if (!c) throw Object.assign(new Error("ต้องใส่ code"), {});
                return send(API + "/" + list + "/" + encodeURIComponent(c) + q(dry), "PUT", v);
            },
            saved: async (j) => {
                await loadConfig();
                selected = { kind: "entity", list, code: (j && j.item && j.item.code) || code };
                editor = null;
                render();
            },
            remove: isNew ? null : async () => {
                if (!confirm("ลบ " + list + " '" + code + "' ?\nถ้ามีรายการอื่นหรือ log อ้างถึงอยู่ Uroboros จะไม่ยอมลบ")) return;
                try {
                    await send(API + "/" + list + "/" + encodeURIComponent(code) + q(false), "DELETE");
                    toast("ลบแล้ว");
                    await loadConfig();
                    selected = null; editor = null; lastErrors = null;
                    render();
                } catch (e) {
                    if (e.data && e.data.error === "invalid") { lastErrors = e.data.errors || []; showServerErrors($(".cb-editor"), lastErrors); }
                    else showError(e);
                }
            },
        });
    }

    async function toggleParam(code) {
        const p = (cfg.params || []).find((x) => x.code === code);
        if (!p) return;
        const next = Object.assign({}, p, { enabled: !p.enabled });
        try {
            await send(API + "/params/" + encodeURIComponent(code) + q(false), "PUT", next);
            toast((next.enabled ? "เปิด " : "ปิด ") + code + " แล้ว");
            await loadConfig();
            render();
        } catch (e) {
            if (e.data && e.data.error === "invalid") showError(new Error(ERR.invalid + "\n" + (e.data.errors || []).map((x) => x.path + " " + x.message).join("\n")));
            else showError(e);
        }
    }

    // ---- rules

    function renderRules() {
        const el = $("#v-rules");
        el.innerHTML = "";
        const sets = cfg.rulesets || [];
        if (!sets.length) { el.append(h("div", { class: "cb-empty", text: "ยังไม่มี ruleset — เพิ่มที่แท็บ ตั้งค่า → Rulesets" })); return; }
        if (!ruleset || !sets.some((s) => s.code === ruleset)) ruleset = sets[0].code;
        const rs = sets.find((s) => s.code === ruleset);

        const bar = h("div", { class: "cb-toolbar" });
        const sel = h("select", { class: "cb-in", style: "width:auto" });
        sets.forEach((s) => sel.append(h("option", { value: s.code, text: s.code + " (v" + s.version + ")", selected: s.code === ruleset })));
        sel.addEventListener("change", () => { if (!confirmLeave()) { sel.value = ruleset; return; } ruleset = sel.value; selected = null; editor = null; renderRules(); });
        bar.append(sel, h("span", { class: "cb-hint", style: "margin:0", text: "ตรวจจาก ord น้อยไปมาก · กฎแรกที่ทุกเงื่อนไขใน when เป็นจริงชนะ · fact ที่เป็น null ไม่ตรงกฎไหน" }), h("span", { class: "sp" }));
        const add = h("button", { type: "button", class: "cb-btn primary sm", text: "+ เพิ่มกฎ" });
        add.addEventListener("click", () => { if (!confirmLeave()) return; selected = { kind: "rule", ruleset, code: null }; editor = null; lastErrors = null; renderRules(); });
        bar.append(add);
        el.append(bar);
        if (rs.description) el.append(h("p", { class: "cb-hint", text: rs.description }));

        const chips = (o) => '<div class="cb-chips">' + (Object.entries(o || {}).map(([k, v]) => "<span>" + esc(k) + "=" + esc(v) + "</span>").join("") || '<span>(ทุกกรณี)</span>') + "</div>";
        const rules = (rs.rules || []).slice().sort((a, b) => a.ord - b.ord);
        if (!rules.length) el.append(h("div", { class: "cb-empty", text: "ruleset นี้ยังไม่มีกฎ" }));
        else {
            const wrap = h("div", { class: "cb-scroll" }, '<table class="cb-table"><thead><tr><th>ord</th><th>code</th><th>เปิด</th><th>when</th><th>then</th><th>คำอธิบาย</th></tr></thead><tbody>'
                + rules.map((r) => '<tr data-code="' + esc(r.code) + '" class="' + (selected && selected.kind === "rule" && selected.code === r.code ? "sel " : "") + (r.enabled ? "" : "off") + '"><td>' + esc(r.ord) + '</td><td class="code">' + esc(r.code)
                    + "</td><td>" + (r.enabled ? '<span class="cb-badge ok">เปิด</span>' : '<span class="cb-badge">ปิด</span>') + "</td><td>" + chips(r.when) + "</td><td>" + chips(r.then)
                    + "</td><td>" + esc(r.description) + "</td></tr>").join("")
                + "</tbody></table>");
            $$("tbody tr", wrap).forEach((tr) => tr.addEventListener("click", () => {
                if (!confirmLeave()) return;
                selected = { kind: "rule", ruleset, code: tr.dataset.code }; editor = null; lastErrors = null; renderRules();
                const ed = $(".cb-editor"); if (ed) ed.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }));
            el.append(wrap);
        }

        if (selected && selected.kind === "rule" && selected.ruleset === ruleset) {
            const isNew = selected.code === null;
            const cur = isNew ? { ord: (rules.length ? rules[rules.length - 1].ord + 1 : 1), enabled: true, when: {}, then: { case: "none" } }
                : rules.find((r) => r.code === selected.code);
            if (cur) el.append(editorPanel(isNew ? "เพิ่มกฎใน " + ruleset : "กฎ " + ruleset + " / " + selected.code, cur,
                (v) => { const f = objectForm(ruleSchema(), v, "$", { lockCode: !isNew }); const root = h("div"); root.append(f.el); return { el: root, get: () => f.get() || {} }; }, {
                    submit: (v, dry) => {
                        const c = isNew ? v.code : selected.code;
                        if (!c) throw new Error("ต้องใส่ code");
                        return send(API + "/rules/" + encodeURIComponent(ruleset) + "/" + encodeURIComponent(c) + q(dry), "PUT", v);
                    },
                    saved: async (j) => { await loadConfig(); selected = { kind: "rule", ruleset, code: (j && j.item && j.item.code) || selected.code }; editor = null; renderRules(); },
                    remove: isNew ? null : async () => {
                        if (!confirm("ลบกฎ " + ruleset + " / " + selected.code + " ?")) return;
                        try {
                            await send(API + "/rules/" + encodeURIComponent(ruleset) + "/" + encodeURIComponent(selected.code) + q(false), "DELETE");
                            toast("ลบกฎแล้ว"); await loadConfig(); selected = null; editor = null; renderRules();
                        } catch (e) { showError(e); }
                    },
                }));
        }
    }

    // ---- tester

    function renderTester() {
        const el = $("#v-tester");
        el.innerHTML = "";
        const card = h("div", { class: "cb-card" });
        card.append(h("h3", { text: "ทดสอบว่ากฎข้อไหนจะชนะ (ไม่เขียน log)" }));
        card.append(h("p", { class: "cb-hint", text: "เลือก param (ใช้ ruleset และ severity ของ param นั้น) หรือเลือก ruleset ตรง ๆ แล้วตั้งค่า fact · ช่องที่เป็น — = ไม่รู้ / ไม่เกี่ยว (null)" }));
        const row = h("div", { class: "cb-form" });
        const mk = (name, sel) => { const f = h("div", { class: "cb-f" }); f.append(label(name, {}, false), sel); row.append(f); return sel; };
        const pSel = mk("param", h("select"));
        pSel.append(h("option", { value: "", text: "—" }));
        (cfg.params || []).forEach((p) => pSel.append(h("option", { value: p.code, text: p.code })));
        const rSel = mk("ruleset", h("select"));
        rSel.append(h("option", { value: "", text: "— (ใช้ของ param)" }));
        (cfg.rulesets || []).forEach((r) => rSel.append(h("option", { value: r.code, text: r.code })));
        const dSel = mk("dir", h("select"));
        dSel.append(h("option", { value: "-", text: "- (ค่าลด)" }), h("option", { value: "+", text: "+ (ค่าเพิ่ม)" }));
        card.append(row);

        card.append(h("div", { class: "lbl cb-muted", style: "margin-top:12px;font-size:12px", text: "facts (ตามคำศัพท์ใน rule.when ของ schema)" }));
        const factsBox = h("div", { class: "cb-facts" });
        const when = deref(ruleSchema().properties.when);
        const factFields = Object.entries(when.properties || {}).map(([name, s]) => { const f = field(name, s, undefined, "$." + name, false, {}); factsBox.append(f.el); return [name, f]; });
        card.append(factsBox);
        const go = h("button", { type: "button", class: "cb-btn primary", text: "ทดสอบ" });
        card.append(go);
        const out = h("div", { style: "margin-top:14px" });
        card.append(out);
        el.append(card);

        go.addEventListener("click", async () => {
            const body = { dir: dSel.value, facts: {} };
            if (pSel.value) body.param = pSel.value;
            if (rSel.value) body.ruleset = rSel.value;
            for (const [n, f] of factFields) { const v = f.get(); if (v !== undefined) body.facts[n] = v; }
            if (!body.param && !body.ruleset) { showError(new Error("เลือก param หรือ ruleset ก่อน")); return; }
            go.disabled = true;
            try {
                const { j } = await send(API + "/rules/test", "POST", body);
                const v = j.verdict || {};
                let html = '<dl class="cb-verdict"><dt>ruleset</dt><dd>' + esc(j.ruleset) + " v" + esc(j.ruleset_version) + "</dd><dt>กฎที่ชนะ</dt><dd>" + esc(j.matched_rule ?? "ไม่มี (unmatched)")
                    + "</dd><dt>status</dt><dd>" + esc(v.status ?? "–") + "</dd><dt>severity</dt><dd>" + esc(v.severity ?? "–") + "</dd><dt>check</dt><dd>" + esc(v.check ?? "–")
                    + "</dd><dt>cause</dt><dd>" + esc(v.cause ?? "–") + "</dd><dt>case</dt><dd>" + esc(v.case) + "</dd><dt>retry</dt><dd>" + esc(v.retry) + "</dd>"
                    + ((v.unresolved || []).length ? "<dt>template ไม่มีค่า</dt><dd>" + esc(v.unresolved.join(", ")) + "</dd>" : "") + "</dl>";
                html += '<div class="cb-scroll"><table class="cb-table"><thead><tr><th>ord</th><th>กฎ</th><th>เปิด</th><th>ผล</th><th>ตกที่ fact</th></tr></thead><tbody>'
                    + (j.trace || []).map((t) => '<tr class="' + (t.chosen ? "sel" : "") + '"><td>' + esc(t.ord) + '</td><td class="code">' + esc(t.rule) + "</td><td>" + (t.enabled ? "เปิด" : "ปิด") + "</td><td>"
                        + (t.chosen ? '<span class="cb-badge ok">ชนะ</span>' : t.holds ? '<span class="cb-badge info">ตรง (แต่มีกฎก่อนหน้าชนะ / ปิดอยู่)</span>' : '<span class="cb-faint">ไม่ตรง</span>')
                        + '</td><td class="cb-mono">' + esc((t.failed_on || []).join(", ")) + "</td></tr>").join("")
                    + "</tbody></table></div>";
                out.innerHTML = html;
            } catch (e) { showError(e); } finally { go.disabled = false; }
        });
    }

    // ---- import / export

    function renderIo() {
        const el = $("#v-io");
        el.innerHTML = "";
        const exp = h("div", { class: "cb-card" });
        exp.append(h("h3", { text: "ส่งออก" }), h("p", { class: "cb-hint", text: "registry ทั้งชุดในรูปแบบเดียวกับ cb_config.json (rev " + rev + ")" }));
        const dl = h("button", { type: "button", class: "cb-btn", text: "ดาวน์โหลด cb_config.json" });
        dl.addEventListener("click", () => {
            const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
            const a = h("a", { href: URL.createObjectURL(blob), download: "cb_config." + (rev || "export") + ".json" });
            document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });
        exp.append(dl);

        const imp = h("div", { class: "cb-card" });
        imp.append(h("h3", { text: "นำเข้าทั้งชุด" }),
            h("p", { class: "cb-hint", text: "แทนที่ registry ทั้งหมดด้วยไฟล์นี้ในครั้งเดียว · ตรวจ (dry-run) ก่อนเสมอ · ถ้า log ยังอ้าง param / signal ที่หายไป Uroboros จะไม่ยอม" }));
        const file = h("input", { type: "file", accept: ".json,application/json", class: "cb-in", style: "width:auto;margin-bottom:8px" });
        const ta = h("textarea", { class: "cb-json", spellcheck: "false", placeholder: "วาง cb_config.json ที่นี่ หรือเลือกไฟล์" });
        file.addEventListener("change", async () => { if (file.files[0]) ta.value = await file.files[0].text(); });
        const fill = h("button", { type: "button", class: "cb-btn sm", text: "ใส่ค่าปัจจุบันเพื่อแก้" });
        fill.addEventListener("click", () => { ta.value = JSON.stringify(cfg, null, 2); });
        const bar = h("div", { class: "cb-toolbar", style: "margin:10px 0 0" });
        const dry = h("button", { type: "button", class: "cb-btn", text: "ตรวจสอบ (dry-run)" });
        const go = h("button", { type: "button", class: "cb-btn primary", text: "นำเข้า" });
        bar.append(dry, go);
        const out = h("div");
        imp.append(file, fill, h("div", { style: "height:8px" }), ta, bar, out);

        const run = async (isDry) => {
            out.innerHTML = "";
            let body = ta.value.trim();
            if (!body) { showError(new Error("ยังไม่ได้ใส่ข้อมูล")); return; }
            try { JSON.parse(body); } catch (e) { showError(new Error("JSON ไม่ถูกต้อง: " + e.message)); return; }
            if (!isDry && !confirm("แทนที่ registry ทั้งชุด?")) return;
            dry.disabled = go.disabled = true;
            try {
                const { j } = await send(API + "/config/import" + q(isDry), "POST", body);
                const counts = Object.entries(j.counts || {}).map(([k, v]) => k + " " + v).join(" · ");
                out.append(h("div", { class: "cb-okbox", text: (isDry ? "ผ่านการตรวจ — ยังไม่ได้นำเข้า · " : "นำเข้าแล้ว · ") + counts }));
                if (!isDry) { toast("นำเข้าแล้ว · runner จะใช้ค่าใหม่ภายใน ~1 นาที"); await loadConfig(); }
            } catch (e) {
                if (e.data && e.data.error === "invalid") {
                    const box = h("div", { class: "cb-errors" }, "<b>" + esc(ERR.invalid) + "</b><ul>" + (e.data.errors || []).map((x) => "<li><code>" + esc(x.path) + "</code> " + esc(x.message) + "</li>").join("") + "</ul>");
                    out.append(box);
                } else showError(e);
            } finally { dry.disabled = go.disabled = false; }
        };
        dry.addEventListener("click", () => run(true));
        go.addEventListener("click", () => run(false));
        el.append(exp, imp);
    }

    // ------------------------------------------------------------------ wiring

    $$(".cb-tab").forEach((t) => t.addEventListener("click", () => {
        if (t.dataset.tab === view || !confirmLeave()) return;
        view = t.dataset.tab; selected = null; editor = null; lastErrors = null;
        try { history.replaceState(null, "", "#" + view); } catch { /* ignore */ }
        render();
    }));
    $("#reload").addEventListener("click", async () => { if (!confirmLeave()) return; editor = null; lastErrors = null; await load(); });
    window.addEventListener("beforeunload", (e) => { if (editor && editor.dirty) { e.preventDefault(); e.returnValue = ""; } });

    const fromHash = (location.hash || "").slice(1);
    if (["overview", "registry", "rules", "tester", "io"].includes(fromHash)) view = fromHash;
    render();
    load();
})();
