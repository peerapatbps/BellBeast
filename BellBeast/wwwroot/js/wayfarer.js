(() => {
    const root = document.getElementById("wayfarerApp");
    if (!root) return;

    const apiBase = root.dataset.apiBase || "/api/wayfarer";
    const els = {
        rows: document.getElementById("wfRows"),
        search: document.getElementById("wfSearch"),
        from: document.getElementById("wfFrom"),
        to: document.getElementById("wfTo"),
        status: document.getElementById("wfStatus"),
        type: document.getElementById("wfType"),
        dept: document.getElementById("wfDept"),
        sort: document.getElementById("wfSort"),
        dir: document.getElementById("wfDir"),
        pageSize: document.getElementById("wfPageSize"),
        refresh: document.getElementById("wfRefreshBtn"),
        reset: document.getElementById("wfResetBtn"),
        export: document.getElementById("wfExportBtn"),
        prev: document.getElementById("wfPrevBtn"),
        next: document.getElementById("wfNextBtn"),
        pageLabel: document.getElementById("wfPageLabel"),
        resultMeta: document.getElementById("wfResultMeta"),
        lastUpdated: document.getElementById("wfLastUpdated"),
        kpiTotal: document.getElementById("wfKpiTotal"),
        kpiWaiting: document.getElementById("wfKpiWaiting"),
        kpiScheduled: document.getElementById("wfKpiScheduled"),
        kpiProgress: document.getElementById("wfKpiProgress"),
        kpiDone: document.getElementById("wfKpiDone"),
        selectedCount: document.getElementById("wfSelectedCount"),
        selectAll: document.getElementById("wfSelectAll"),
        drawer: document.getElementById("wfDrawer"),
        drawerTitle: document.getElementById("wfDrawerTitle"),
        drawerSub: document.getElementById("wfDrawerSub"),
        drawerBody: document.getElementById("wfDrawerBody")
    };

    const state = {
        page: 1,
        pageSize: 25,
        total: 0,
        currentRows: [],
        selected: new Map(),
        aborter: null
    };

    const escapeHtml = (v) => String(v ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

    const compact = (v, fallback = "-") => {
        if (v === null || v === undefined || v === "") return fallback;
        return String(v);
    };

    const asDate = (v) => {
        if (!v) return "-";
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
        return d.toLocaleDateString("th-TH", { year: "numeric", month: "2-digit", day: "2-digit" });
    };

    const asDateTime = (v) => {
        if (!v) return "-";
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return String(v);
        return d.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
    };

    const asMinutes = (v) => {
        if (v === null || v === undefined || v === "") return "-";
        const n = Number(v);
        if (!Number.isFinite(n)) return String(v);
        if (n < 60) return `${n} min`;
        const hr = Math.floor(n / 60);
        const min = n % 60;
        return min ? `${hr}h ${min}m` : `${hr}h`;
    };

    const statusClass = (code) => `wf-chip wf-chip-status-${String(code || "").replace(/[^0-9]/g, "")}`;
    const sameText = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

    function formatDateInput(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    function getDefaultDateRange(today = new Date()) {
        const currentYear = today.getFullYear();
        const currentMonth = today.getMonth();
        const usePreviousFullMonths = today.getDate() < 10;

        const endMonth = usePreviousFullMonths ? currentMonth - 1 : currentMonth;
        const startMonth = endMonth - 1;

        const from = new Date(currentYear, startMonth, 1);
        const to = new Date(currentYear, endMonth + 1, 0);

        return {
            from: formatDateInput(from),
            to: formatDateInput(to)
        };
    }

    function applyDefaultDateRange() {
        const range = getDefaultDateRange();
        els.from.value = range.from;
        els.to.value = range.to;
    }

    function buildQuery() {
        const q = new URLSearchParams();
        q.set("page", state.page);
        q.set("pageSize", els.pageSize.value || state.pageSize);
        q.set("sort", els.sort.value || "wo_date");
        q.set("dir", els.dir.value || "desc");

        if (els.search.value.trim()) q.set("q", els.search.value.trim());
        if (els.from.value) q.set("from", els.from.value);
        if (els.to.value) q.set("to", els.to.value);
        if (els.status.value) q.set("status", els.status.value);
        if (els.type.value) q.set("type", els.type.value);
        if (els.dept.value) q.set("dept", els.dept.value);
        return q;
    }

    async function fetchJson(url, options) {
        const res = await fetch(url, options);
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
        }
        return res.json();
    }

    async function loadFilters() {
        const data = await fetchJson(`${apiBase}/filters`, { headers: { Accept: "application/json" } });
        fillSelect(els.status, data.statuses || [], "All status", (x) => x.code, (x) => `${x.code} - ${x.name || "Unknown"}`);
        fillSelect(els.type, data.types || [], "All type", (x) => x, (x) => x);
        fillSelect(els.dept, data.departments || [], "All dept", (x) => x.code, (x) => `${x.code}${x.name ? ` - ${x.name}` : ""}`);
    }

    function fillSelect(select, items, firstText, valueFn, textFn) {
        const old = select.value;
        select.innerHTML = `<option value="">${escapeHtml(firstText)}</option>`;
        for (const item of items) {
            const opt = document.createElement("option");
            opt.value = valueFn(item) ?? "";
            opt.textContent = textFn(item) ?? "";
            select.appendChild(opt);
        }
        select.value = old;
    }

    async function loadWorkOrders() {
        if (state.aborter) state.aborter.abort();
        state.aborter = new AbortController();

        els.rows.innerHTML = `<tr><td colspan="9" class="wf-empty">Loading...</td></tr>`;
        try {
            const q = buildQuery();
            const res = await fetch(`${apiBase}/workorders?${q}`, {
                headers: { Accept: "application/json" },
                signal: state.aborter.signal
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
            }
            const data = await res.json();
            state.currentRows = data.items || [];
            state.total = data.total || 0;
            state.page = data.page || 1;
            state.pageSize = data.pageSize || 25;
            renderKpis(data.summary || {});
            renderTable(state.currentRows);
            renderPager(data);
            updateSelectionUi();
            els.lastUpdated.textContent = `Loaded ${new Date().toLocaleTimeString("th-TH")}`;
        } catch (err) {
            if (err.name === "AbortError") return;
            console.error(err);
            els.rows.innerHTML = `<tr><td colspan="9" class="wf-empty">Load failed: ${escapeHtml(err.message)}</td></tr>`;
            els.selectAll.checked = false;
            els.selectAll.indeterminate = false;
        }
    }

    function renderKpis(summary) {
        els.kpiTotal.textContent = summary.total ?? 0;
        els.kpiWaiting.textContent = summary.waiting ?? 0;
        els.kpiScheduled.textContent = summary.scheduled ?? 0;
        els.kpiProgress.textContent = summary.inProgress ?? 0;
        els.kpiDone.textContent = summary.completed ?? 0;
    }

    function renderTable(rows) {
        if (!rows.length) {
            els.rows.innerHTML = `<tr><td colspan="9" class="wf-empty">No work orders found.</td></tr>`;
            return;
        }

        els.rows.innerHTML = rows.map((row) => {
            const selected = state.selected.has(String(row.woNo));
            const taskText = row.taskName && !sameText(row.taskName, row.woProblem) ? row.taskName : "";
            return `
                <tr data-wo-no="${escapeHtml(row.woNo)}" class="${selected ? "is-selected" : ""}">
                    <td class="wf-check-cell">
                        <input type="checkbox" class="wf-row-check" data-wo-no="${escapeHtml(row.woNo)}" ${selected ? "checked" : ""} aria-label="Select work order ${escapeHtml(row.woNo)}" />
                    </td>
                    <td>
                        <strong>${escapeHtml(row.woNo)}</strong>
                        <span class="wf-wo-code">${escapeHtml(row.woCode)}</span>
                    </td>
                    <td>${escapeHtml(asDate(row.woDate))}</td>
                    <td><span class="wf-chip">${escapeHtml(row.woTypeCode || "-")}</span></td>
                    <td><span class="${statusClass(row.woStatusCode)}">${escapeHtml(row.woStatusCode || "-")} - ${escapeHtml(row.woStatusName || "-")}</span></td>
                    <td class="wf-problem">
                        <strong>${escapeHtml(row.woProblem || "-")}</strong>
                        ${taskText ? `<div class="wf-muted">${escapeHtml(taskText)}</div>` : ""}
                    </td>
                    <td>
                        <div>${escapeHtml(row.puName || row.puNo || "-")}</div>
                        <small class="wf-muted">${escapeHtml(row.eqName || row.eqNo || "-")}</small>
                    </td>
                    <td>
                        <div>${escapeHtml(row.deptCode || "-")}</div>
                        <small class="wf-muted">${escapeHtml(row.maintenanceDeptName || "")}</small>
                    </td>
                    <td>${escapeHtml(asMinutes(row.workDuration ?? row.actualDuration ?? row.scheduledDuration))}</td>
                </tr>
            `;
        }).join("");

        els.rows.querySelectorAll("tr[data-wo-no]").forEach((tr) => {
            tr.addEventListener("click", (ev) => {
                if (ev.target.closest(".wf-row-check")) return;
                openDetail(tr.dataset.woNo);
            });
        });

        els.rows.querySelectorAll(".wf-row-check").forEach((checkbox) => {
            checkbox.addEventListener("click", (ev) => ev.stopPropagation());
            checkbox.addEventListener("change", () => toggleSelection(checkbox.dataset.woNo, checkbox.checked));
        });

        syncSelectAll();
    }

    function renderPager(data) {
        const total = data.total || 0;
        const page = data.page || 1;
        const pageSize = data.pageSize || 25;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        els.pageLabel.textContent = `Page ${page} / ${totalPages}`;
        els.resultMeta.textContent = `${total.toLocaleString()} records`;
        els.prev.disabled = page <= 1;
        els.next.disabled = page >= totalPages;
    }

    function toggleSelection(woNo, checked) {
        const key = String(woNo);
        const row = state.currentRows.find((item) => String(item.woNo) === key);
        if (!row) return;

        if (checked) state.selected.set(key, row);
        else state.selected.delete(key);

        const tr = els.rows.querySelector(`tr[data-wo-no="${CSS.escape(key)}"]`);
        if (tr) tr.classList.toggle("is-selected", checked);
        updateSelectionUi();
        syncSelectAll();
    }

    function syncSelectAll() {
        const pageKeys = state.currentRows.map((row) => String(row.woNo));
        const selectedOnPage = pageKeys.filter((key) => state.selected.has(key)).length;
        els.selectAll.checked = pageKeys.length > 0 && selectedOnPage === pageKeys.length;
        els.selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageKeys.length;
    }

    function updateSelectionUi() {
        const count = state.selected.size;
        els.selectedCount.textContent = `${count} selected`;
        els.export.disabled = count === 0;
    }

    async function openDetail(woNo) {
        els.drawer.classList.add("is-open");
        els.drawer.setAttribute("aria-hidden", "false");
        els.drawerTitle.textContent = `WO ${woNo}`;
        els.drawerSub.textContent = "Loading detail...";
        els.drawerBody.innerHTML = "";

        try {
            const data = await fetchJson(`${apiBase}/workorders/${encodeURIComponent(woNo)}`, { headers: { Accept: "application/json" } });
            const o = data.overview || {};
            els.drawerTitle.textContent = `${o.woNo || woNo}${o.woCode ? ` - ${o.woCode}` : ""}`;
            els.drawerSub.textContent = `${o.woTypeCode || "-"} - ${o.woStatusName || "-"} - ${asDate(o.woDate)}`;
            els.drawerBody.innerHTML = renderDetail(data);
        } catch (err) {
            console.error(err);
            els.drawerSub.textContent = "Load failed";
            els.drawerBody.innerHTML = `<p class="wf-empty">${escapeHtml(err.message)}</p>`;
        }
    }

    function closeDetail() {
        els.drawer.classList.remove("is-open");
        els.drawer.setAttribute("aria-hidden", "true");
    }

    function renderDetail(data) {
        const o = data.overview || {};
        return `
            <div class="wf-detail-grid">
                <section class="wf-detail-card">
                    <h3>Overview</h3>
                    ${kv({
                        "WO No": o.woNo,
                        "WO Code": o.woCode,
                        "Type": o.woTypeCode,
                        "Status": `${o.woStatusCode || "-"} - ${o.woStatusName || "-"}`,
                        "WO Date": asDateTime(o.woDate),
                        "Fetched": asDateTime(o.fetchedAtUtc),
                        "Detail URL": o.detailUrl ? `<a href="${escapeHtml(o.detailUrl)}" target="_blank" rel="noreferrer">Open WebPM</a>` : "-"
                    })}
                </section>

                <section class="wf-detail-card">
                    <h3>Schedule / Actual</h3>
                    ${kv({
                        "Scheduled start": asDateTime(o.scheduledStart),
                        "Scheduled finish": asDateTime(o.scheduledFinish),
                        "Actual start": asDateTime(o.actualStart),
                        "Actual finish": asDateTime(o.actualFinish),
                        "Complete": asDateTime(o.completeDate),
                        "Work duration": asMinutes(o.workDuration),
                        "Downtime": asMinutes(o.downtimeDuration)
                    })}
                </section>

                <section class="wf-detail-card">
                    <h3>Problem</h3>
                    <p>${escapeHtml(o.woProblem || "-")}</p>
                </section>

                <section class="wf-detail-card">
                    <h3>Equipment</h3>
                    ${kv({
                        "PU": o.puName || o.puNo,
                        "EQ": o.eqName || o.eqNo,
                        "Dept": o.deptCode,
                        "Maintenance": o.maintenanceDeptName,
                        "Request person": o.requestPersonName
                    })}
                </section>
            </div>

            ${recordBlock("Tasks", data.tasks, "Task")}
            ${tableBlock("People / Departments", data.people)}
            ${tableBlock("History", data.history)}
            ${tableBlock("Damage / Failure", data.damageFailure)}
            ${tableBlock("Actual Manhours", data.actualManhrs)}
            ${tableBlock("Meta Flags", data.flags ? [data.flags] : [])}
        `;
    }

    function kv(obj) {
        const rows = Object.entries(obj).map(([k, v]) => `
            <dt>${escapeHtml(k)}</dt>
            <dd>${typeof v === "string" && v.includes("<a ") ? v : escapeHtml(compact(v))}</dd>
        `).join("");
        return `<dl class="wf-kv">${rows}</dl>`;
    }

    function tableBlock(title, rows) {
        rows = rows || [];
        if (!rows.length) return "";
        const keys = Object.keys(rows[0]).filter((k) => !["fetched_at_utc", "fetchedAtUtc"].includes(k));
        const head = keys.map((k) => `<th>${escapeHtml(labelize(k))}</th>`).join("");
        const body = rows.map((r) => `<tr>${keys.map((k) => `<td>${escapeHtml(formatCell(k, r[k]))}</td>`).join("")}</tr>`).join("");
        return `
            <section class="wf-detail-card" style="margin-top:12px;">
                <h3>${escapeHtml(title)}</h3>
                <div class="wf-table-wrap">
                    <table class="wf-subtable">
                        <thead><tr>${head}</tr></thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>
            </section>
        `;
    }

    function recordBlock(title, rows, itemLabel) {
        rows = rows || [];
        if (!rows.length) return "";

        const body = rows.map((row, index) => {
            const pairs = Object.entries(row)
                .filter(([key]) => !["fetched_at_utc", "fetchedAtUtc"].includes(key))
                .map(([key, value]) => `
                    <dt>${escapeHtml(labelize(key))}</dt>
                    <dd>${escapeHtml(compact(formatCell(key, value)))}</dd>
                `)
                .join("");

            const titleText = row.task_name || row.taskName || `${itemLabel} ${index + 1}`;
            return `
                <article class="wf-record">
                    <h4 class="wf-record-title">${escapeHtml(titleText)}</h4>
                    <dl class="wf-kv">${pairs}</dl>
                </article>
            `;
        }).join("");

        return `
            <section class="wf-detail-card" style="margin-top:12px;">
                <h3>${escapeHtml(title)}</h3>
                <div class="wf-record-list">${body}</div>
            </section>
        `;
    }

    function labelize(k) {
        return String(k).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
    }

    function formatCell(k, v) {
        if (v === null || v === undefined || v === "") return "-";
        if (/date|time|timestamp/i.test(k) && String(v).includes("T")) return asDateTime(v);
        if (/duration|hours/i.test(k) && Number.isFinite(Number(v))) return asMinutes(v);
        return v;
    }

    async function exportWorkbook() {
        const woNos = Array.from(state.selected.keys()).map((v) => Number(v)).filter((v) => Number.isFinite(v));
        if (!woNos.length) return;

        els.export.disabled = true;
        const oldText = els.export.textContent;
        els.export.textContent = "Exporting...";

        try {
            const res = await fetch(`${apiBase}/export`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                },
                body: JSON.stringify({ woNos })
            });

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
            }

            const blob = await res.blob();
            const disposition = res.headers.get("Content-Disposition") || "";
            const match = disposition.match(/filename="?([^"]+)"?/i);
            const fileName = match?.[1] || `wayfarer-export-${new Date().toISOString().slice(0, 10)}.xlsx`;

            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error(err);
            window.alert(`Export failed: ${err.message}`);
        } finally {
            els.export.textContent = oldText;
            updateSelectionUi();
        }
    }

    function debounce(fn, ms) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    function resetFilters() {
        const activeMode = document.getElementById("wfActiveFilterMode")?.value || "og";

        applyDefaultDateRange();
        els.sort.value = "wo_date";
        els.dir.value = "desc";
        els.pageSize.value = "25";
        state.page = 1;

        if (activeMode === "og") {
            els.search.value = "";
            els.status.value = "";
            els.type.value = "";
            els.dept.value = "";
            loadWorkOrders();
        }
    }

    const reloadFromFirstPage = () => {
        state.page = 1;
        loadWorkOrders();
    };

    els.search.addEventListener("input", debounce(reloadFromFirstPage, 350));
    [els.from, els.to, els.status, els.type, els.dept, els.sort, els.dir, els.pageSize].forEach((el) => {
        el.addEventListener("change", reloadFromFirstPage);
    });
    els.refresh.addEventListener("click", loadWorkOrders);
    els.reset.addEventListener("click", resetFilters);
    els.export.addEventListener("click", exportWorkbook);
    els.prev.addEventListener("click", () => {
        if (state.page > 1) {
            state.page--;
            loadWorkOrders();
        }
    });
    els.next.addEventListener("click", () => {
        state.page++;
        loadWorkOrders();
    });
    els.selectAll.addEventListener("change", () => {
        state.currentRows.forEach((row) => {
            const checked = els.selectAll.checked;
            const key = String(row.woNo);
            if (checked) state.selected.set(key, row);
            else state.selected.delete(key);
        });
        renderTable(state.currentRows);
        updateSelectionUi();
    });

    root.querySelectorAll("[data-close-drawer]").forEach((el) => el.addEventListener("click", closeDetail));
    document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") closeDetail();
    });

    window.WayfarerOpenDetail = openDetail;

    (async function init() {
        applyDefaultDateRange();
        try {
            await loadFilters();
        } catch (err) {
            console.warn("Wayfarer filters failed:", err);
        }
        await loadWorkOrders();
    })();
})();



/* MH Map branch selector extension.
   This module keeps the map as a visual selector:
   marker = branch, badge = WO count, hover = summary, click = filter result panel.
*/
(() => {
    const root = document.getElementById("wayfarerApp");
    if (!root) return;

    const apiBase = root.dataset.apiBase || "/api/wayfarer";
    const modeInput = document.getElementById("wfActiveFilterMode");
    const tabs = Array.from(document.querySelectorAll("[data-wf-mode]"));
    const ogFilter = document.getElementById("wfOgFilterTab");
    const mhFilter = document.getElementById("wfMhMapFilterTab");
    const ogResult = document.getElementById("wfOgResultView");
    const mhResult = document.getElementById("wfMhMapResultView");

    const shell = document.getElementById("mhMapShell");
    const tooltip = document.getElementById("mhMapTooltip");
    const tipName = document.getElementById("mhMapTipName");
    const tipCode = document.getElementById("mhMapTipCode");
    const tipMeta = document.getElementById("mhMapTipMeta");
    const tipStatus = document.getElementById("mhMapTipStatus");
    const selectionHint = document.getElementById("mhMapSelectionHint");

    const mhBranchPuNo = document.getElementById("mhMapBranchPuNo");
    const mhBranchCode = document.getElementById("mhMapBranchCode");
    const mhBranchName = document.getElementById("mhMapBranchName");
    const mhSelectedBranch = document.getElementById("mhMapSelectedBranch");
    const mhResultTitle = document.getElementById("mhMapResultTitle");
    const mhResultSub = document.getElementById("mhMapResultSub");
    const mhRows = document.getElementById("mhMapRows");
    const mhStatusFilters = document.getElementById("mhMapStatusFilters");
    const mhStatusButtons = Array.from(document.querySelectorAll("[data-map-status]"));
    const kpis = {
        total: document.getElementById("wfKpiTotal"),
        waiting: document.getElementById("wfKpiWaiting"),
        scheduled: document.getElementById("wfKpiScheduled"),
        progress: document.getElementById("wfKpiProgress"),
        completed: document.getElementById("wfKpiDone")
    };

    if (!modeInput || !shell || !mhRows) return;

    const markers = Array.from(shell.querySelectorAll(".wf-mh-marker, .wf-mh-unmapped-item"));

    const state = {
        mode: modeInput.value || "og",
        selectedMarker: null,
        markerStats: new Map(),
        activeStatusBuckets: new Set(["all"]),
        aborter: null
    };

    const escapeHtml = (v) => String(v ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

    const compact = (v, fallback = "-") => {
        if (v === null || v === undefined || v === "") return fallback;
        return String(v);
    };

    const asDate = (v) => {
        if (!v) return "-";
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
        return d.toLocaleDateString("th-TH", { year: "numeric", month: "2-digit", day: "2-digit" });
    };

    const statusClass = (code) => `wf-chip wf-chip-status-${String(code || "").replace(/[^0-9]/g, "")}`;

    function normalize(v) {
        return String(v ?? "").trim().toLowerCase();
    }

    function syncMapStatusToggleUi() {
        mhStatusButtons.forEach((button) => {
            const key = button.dataset.mapStatus;
            const active = state.activeStatusBuckets.has(key);
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
    }

    function resetMapStatusFilters() {
        state.activeStatusBuckets = new Set(["all"]);
        syncMapStatusToggleUi();
    }

    function toggleMapStatusFilter(key) {
        if (key === "all") {
            resetMapStatusFilters();
        } else {
            state.activeStatusBuckets.delete("all");
            if (state.activeStatusBuckets.has(key)) state.activeStatusBuckets.delete(key);
            else state.activeStatusBuckets.add(key);

            if (state.activeStatusBuckets.size === 0) state.activeStatusBuckets.add("all");
            syncMapStatusToggleUi();
        }

        clearMhMapFilter();
        refreshMapSummary();
    }

    function severityClass(item) {
        const waiting = Number(item?.waiting || 0);
        const scheduled = Number(item?.scheduled || 0);
        const progress = Number(item?.inProgress || 0);
        const completed = Number(item?.completed || 0);
        const total = waiting + scheduled + progress + completed;

        if (total <= 0) return "no-wo";
        if (waiting > 0) return "has-open";
        if (progress > 0) return "has-progress";
        if (scheduled > 0) return "has-scheduled";
        if (completed === total) return "all-completed";
        return "is-mixed";
    }

    function setKpis(summary) {
        if (kpis.total) kpis.total.textContent = summary.total ?? 0;
        if (kpis.waiting) kpis.waiting.textContent = summary.waiting ?? 0;
        if (kpis.scheduled) kpis.scheduled.textContent = summary.scheduled ?? 0;
        if (kpis.progress) kpis.progress.textContent = summary.inProgress ?? 0;
        if (kpis.completed) kpis.completed.textContent = summary.completed ?? 0;
    }

    function summarizeItems(items) {
        return (items || []).reduce((acc, item) => {
            acc.total += Number(item?.total || 0);
            acc.waiting += Number(item?.waiting || 0);
            acc.scheduled += Number(item?.scheduled || 0);
            acc.inProgress += Number(item?.inProgress || 0);
            acc.completed += Number(item?.completed || 0);
            return acc;
        }, {
            total: 0,
            waiting: 0,
            scheduled: 0,
            inProgress: 0,
            completed: 0
        });
    }

    function getMapQuery() {
        const q = new URLSearchParams();
        const from = document.getElementById("wfFrom")?.value;
        const to = document.getElementById("wfTo")?.value;

        if (from) q.set("from", from);
        if (to) q.set("to", to);

        Array.from(state.activeStatusBuckets).forEach((group) => q.append("statusGroup", group));
        return q;
    }

    async function fetchJson(url, options) {
        const res = await fetch(url, options);
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
        }
        return res.json();
    }

    function applyMarkerStats(stats) {
        state.markerStats = stats;

        for (const marker of markers) {
            const code = marker.dataset.code;
            const item = stats.get(code) || {
                puCode: code,
                total: 0,
                waiting: 0,
                scheduled: 0,
                inProgress: 0,
                completed: 0
            };
            const total = item.total || 0;
            const badge = marker.querySelector(".wf-mh-marker-badge");

            marker.dataset.wo = String(total);
            marker.dataset.statusCounts = JSON.stringify({
                waiting: item.waiting || 0,
                scheduled: item.scheduled || 0,
                inProgress: item.inProgress || 0,
                completed: item.completed || 0
            });
            marker.classList.toggle("has-wo", total > 0);
            marker.classList.toggle("no-wo", total <= 0);

            marker.classList.remove("has-open", "has-progress", "has-scheduled", "all-completed", "is-mixed");
            if (total > 0) marker.classList.add(severityClass(item));

            if (badge) badge.textContent = total > 0 ? String(total) : "";
        }
    }

    async function refreshMapSummary() {
        if (state.mode !== "mhmap") return;

        if (state.aborter) state.aborter.abort();
        state.aborter = new AbortController();

        try {
            const q = getMapQuery();
            const data = await fetchJson(`${apiBase}/map-summary?${q}`, {
                headers: { Accept: "application/json" },
                signal: state.aborter.signal
            });
            const stats = new Map((data.items || []).map((item) => [item.puCode, item]));
            applyMarkerStats(stats);
            setKpis(summarizeItems(data.items || []));
            if (selectionHint) selectionHint.textContent = "Hover = preview · Click = select branch · Badge = WO count";

            if (state.selectedMarker) renderSelectedBranch(state.selectedMarker);
        } catch (err) {
            if (err.name === "AbortError") return;
            console.warn("MH map summary failed:", err);
            if (selectionHint) selectionHint.textContent = `Map summary failed: ${err.message}`;
        }
    }

    function clearOgFilterInputs() {
        ["wfSearch", "wfStatus", "wfType", "wfDept"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = "";
        });

        const sort = document.getElementById("wfSort");
        const dir = document.getElementById("wfDir");
        const pageSize = document.getElementById("wfPageSize");
        if (sort) sort.value = "wo_date";
        if (dir) dir.value = "desc";
        if (pageSize) pageSize.value = "25";
    }

    function clearMhMapFilter() {
        if (state.selectedMarker) state.selectedMarker.classList.remove("is-selected");
        state.selectedMarker = null;

        mhBranchPuNo.value = "";
        mhBranchCode.value = "";
        mhBranchName.value = "";
        mhSelectedBranch.textContent = "No branch selected";
        mhResultTitle.textContent = "MH Map filtered result";
        mhResultSub.textContent = "Click a branch marker to show matching work orders.";
        mhRows.innerHTML = `<tr><td colspan="6" class="wf-empty">No branch selected from the map.</td></tr>`;
        setKpis(summarizeItems(Array.from(state.markerStats.values())));
    }

    function setMode(mode) {
        const previousMode = modeInput.value;
        state.mode = mode;
        modeInput.value = mode;

        for (const tab of tabs) {
            const active = tab.dataset.wfMode === mode;
            tab.classList.toggle("is-active", active);
            tab.setAttribute("aria-selected", active ? "true" : "false");
        }

        ogFilter.hidden = mode !== "og";
        mhFilter.hidden = mode !== "mhmap";
        ogFilter.classList.toggle("is-active", mode === "og");
        mhFilter.classList.toggle("is-active", mode === "mhmap");
        ogResult.hidden = mode !== "og";
        mhResult.hidden = mode !== "mhmap";

        if (previousMode !== mode) {
            clearOgFilterInputs();
            clearMhMapFilter();
        }

        if (mode === "mhmap") refreshMapSummary();
    }

    function statusBreakdownHtml(marker) {
        let counts = {};
        try { counts = JSON.parse(marker.dataset.statusCounts || "{}"); }
        catch { counts = {}; }

        const rows = [
            ["Waiting / Open", counts.waiting || 0],
            ["Scheduled", counts.scheduled || 0],
            ["In progress", counts.inProgress || 0],
            ["Completed", counts.completed || 0]
        ].filter(([, count]) => Number(count) > 0);

        if (!rows.length) return `<em>No WO in current filter</em>`;

        return rows
            .map(([label, count]) => `<span class="wf-mh-tip-status-row"><b>${escapeHtml(label)}</b>: ${escapeHtml(count)}</span>`)
            .join("");
    }

    function branchStatusText(status) {
        return {
            real: "มีสถานที่จริง / mark ตามตำแหน่งจริง",
            unmapped: "มีสถานที่จริง / ใช้ตำแหน่ง map ที่กำหนด",
            demolished: "รื้อถอนแล้ว",
            future: "ยังไม่มีสถานที่จริง / future construction"
        }[status] || "unknown";
    }

    function showMapTip(marker, evt) {
        tipName.textContent = marker.dataset.name || "-";
        tipCode.textContent = marker.dataset.code || "-";
        tipMeta.textContent = `${branchStatusText(marker.dataset.branchStatus)} · puNo ${marker.dataset.puno || "-"} · child ${marker.dataset.child || "0"} · WO ${marker.dataset.wo || "0"}`;
        tipStatus.innerHTML = statusBreakdownHtml(marker);
        tooltip.hidden = false;
        moveMapTip(evt);
    }

    function moveMapTip(evt) {
        if (!tooltip || tooltip.hidden) return;
        const rect = shell.getBoundingClientRect();
        const x = evt.clientX - rect.left + 16;
        const y = evt.clientY - rect.top + 16;
        tooltip.style.left = `${Math.max(8, Math.min(x, rect.width - 308))}px`;
        tooltip.style.top = `${Math.max(8, Math.min(y, rect.height - 150))}px`;
    }

    function hideMapTip() {
        tooltip.hidden = true;
    }

    function renderBranchRows(rows, marker, note = "") {
        if (!rows.length) {
            mhRows.innerHTML = `<tr><td colspan="6" class="wf-empty">${escapeHtml(note || "ไม่พบ WO ของ branch นี้ใน filter ปัจจุบัน")}</td></tr>`;
            return;
        }

        mhRows.innerHTML = rows.map((row) => {
            const taskText = row.taskName && normalize(row.taskName) !== normalize(row.woProblem) ? row.taskName : "";
            return `
                <tr data-wo-no="${escapeHtml(row.woNo)}">
                    <td><strong>${escapeHtml(row.woNo)}</strong><span class="wf-wo-code">${escapeHtml(row.woCode || "")}</span></td>
                    <td>${escapeHtml(asDate(row.woDate))}</td>
                    <td><span class="${statusClass(row.woStatusCode)}">${escapeHtml(row.woStatusCode || "-")} - ${escapeHtml(row.woStatusName || "-")}</span></td>
                    <td><div>${escapeHtml(row.puName || row.puNo || "-")}</div><small class="wf-muted">${escapeHtml(row.eqName || row.eqNo || "-")}</small></td>
                    <td class="wf-problem"><strong>${escapeHtml(row.woProblem || "-")}</strong>${taskText ? `<div class="wf-muted">${escapeHtml(taskText)}</div>` : ""}</td>
                    <td><div>${escapeHtml(row.deptCode || "-")}</div><small class="wf-muted">${escapeHtml(row.maintenanceDeptName || "")}</small></td>
                </tr>
            `;
        }).join("");

        mhRows.querySelectorAll("tr[data-wo-no]").forEach((tr) => {
            tr.addEventListener("click", () => {
                if (typeof window.WayfarerOpenDetail === "function") window.WayfarerOpenDetail(tr.dataset.woNo);
            });
        });
    }

    async function renderSelectedBranch(marker) {
        const code = marker.dataset.code;
        const branchPuNo = marker.dataset.puno;
        const name = marker.dataset.name;
        const stats = state.markerStats.get(code) || {
            total: 0,
            waiting: 0,
            scheduled: 0,
            inProgress: 0,
            completed: 0
        };

        mhBranchPuNo.value = branchPuNo || "";
        mhBranchCode.value = code || "";
        mhBranchName.value = name || "";

        mhSelectedBranch.textContent = `${marker.dataset.no} | ${code}`;
        mhResultTitle.textContent = name || code;
        mhResultSub.textContent = `${code} | puNo ${branchPuNo || "-"} | ${branchStatusText(marker.dataset.branchStatus)} | WO ${stats.total || 0}`;

        renderBranchRows([], marker, "Loading branch work orders...");

        try {
            const q = getMapQuery();
            q.set("puCode", code);
            const data = await fetchJson(`${apiBase}/map-branch-workorders?${q}`, { headers: { Accept: "application/json" } });
            mhResultSub.textContent = `${code} | puNo ${branchPuNo || "-"} | ${branchStatusText(marker.dataset.branchStatus)} | WO ${data.total ?? 0}`;
            setKpis(data.summary || {
                total: data.total ?? 0,
                waiting: 0,
                scheduled: 0,
                inProgress: 0,
                completed: 0
            });
            renderBranchRows(data.items || [], marker);
        } catch (err) {
            renderBranchRows([], marker, `Branch query failed: ${err.message}`);
        }

        window.dispatchEvent(new CustomEvent("webpm:mhmap-branch-selected", {
            detail: {
                mode: "mhmap",
                branchPuNo,
                puCode: code,
                puName: name,
                childCount: marker.dataset.child,
                woTotal: stats.total || 0,
                statusCounts: {
                    waiting: stats.waiting || 0,
                    scheduled: stats.scheduled || 0,
                    inProgress: stats.inProgress || 0,
                    completed: stats.completed || 0
                }
            }
        }));
    }

    function selectMapBranch(marker) {
        if (state.selectedMarker === marker) {
            clearMhMapFilter();
            return;
        }

        if (state.selectedMarker) state.selectedMarker.classList.remove("is-selected");
        state.selectedMarker = marker;
        marker.classList.add("is-selected");
        renderSelectedBranch(marker);
    }

    tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.wfMode)));

    markers.forEach((marker) => {
        marker.addEventListener("mouseenter", (e) => showMapTip(marker, e));
        marker.addEventListener("mousemove", moveMapTip);
        marker.addEventListener("mouseleave", hideMapTip);
        marker.addEventListener("click", () => selectMapBranch(marker));
        marker.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                selectMapBranch(marker);
            }
        });
    });

    shell.addEventListener("click", (e) => {
        if (!e.target.closest(".wf-mh-marker, .wf-mh-unmapped-item")) clearMhMapFilter();
    });

    ["wfFrom", "wfTo"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("change", refreshMapSummary);
    });

    mhStatusButtons.forEach((button) => {
        button.addEventListener("click", () => toggleMapStatusFilter(button.dataset.mapStatus));
    });

    const reset = document.getElementById("wfResetBtn");
    if (reset) reset.addEventListener("click", () => {
        if (modeInput.value === "mhmap") {
            resetMapStatusFilters();
            clearMhMapFilter();
            refreshMapSummary();
        }
    });

    window.getWebPmActiveFilterMode = () => modeInput.value;
    window.getWebPmActiveFilters = () => modeInput.value === "mhmap"
        ? {
            mode: "mhmap",
            branchPuNo: mhBranchPuNo.value,
            puCode: mhBranchCode.value,
            puName: mhBranchName.value,
            from: document.getElementById("wfFrom")?.value || "",
            to: document.getElementById("wfTo")?.value || "",
            statusBuckets: Array.from(state.activeStatusBuckets)
        }
        : {
            mode: "og",
            search: document.getElementById("wfSearch")?.value || "",
            status: document.getElementById("wfStatus")?.value || "",
            type: document.getElementById("wfType")?.value || "",
            dept: document.getElementById("wfDept")?.value || "",
            from: document.getElementById("wfFrom")?.value || "",
            to: document.getElementById("wfTo")?.value || ""
        };

    syncMapStatusToggleUi();
    setMode(modeInput.value || "og");
})();
