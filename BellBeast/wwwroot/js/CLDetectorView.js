(function () {
    const DEFAULT_ENDPOINT = "/api/cldetector/summary";
    const DEFAULT_REFRESH_MS = 5000;

    let poller = null;

    function numOrNull(v) {
        if (v === null || v === undefined) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function formatValue(v) {
        const n = numOrNull(v);
        if (n === null) return "--";
        return n.toFixed(1);
    }

    function getSeverity(v) {
        const n = numOrNull(v);
        if (n === null) return "na";
        if (n < 0.8) return "normal";
        if (n < 2.0) return "alarm1";
        return "alarm2";
    }

    function clearClasses(el, classes) {
        if (!el) return;
        classes.forEach(c => el.classList.remove(c));
    }

    function applySeverity(detEl, value) {
        if (!detEl) return;

        const dot = detEl.querySelector('[data-role="dot"]');
        const pill = detEl.querySelector('[data-role="value"]');
        const severity = getSeverity(value);

        if (pill) {
            pill.textContent = formatValue(value);
        }

        if (dot) {
            clearClasses(dot, ["normal", "alarm1", "alarm2"]);
        }
        if (pill) {
            clearClasses(pill, ["value-normal", "value-alarm1", "value-alarm2", "value-na"]);
        }

        switch (severity) {
            case "normal":
                if (dot) dot.classList.add("normal");
                if (pill) pill.classList.add("value-normal");
                break;
            case "alarm1":
                if (dot) dot.classList.add("alarm1");
                if (pill) pill.classList.add("value-alarm1");
                break;
            case "alarm2":
                if (dot) dot.classList.add("alarm2");
                if (pill) pill.classList.add("value-alarm2");
                break;
            default:
                if (pill) pill.classList.add("value-na");
                break;
        }
    }

    function getValueFromPayload(payload, stream, param) {
        if (!payload) return null;

        if (payload.flat) {
            const key = `${stream}.${param}`;
            if (Object.prototype.hasOwnProperty.call(payload.flat, key)) {
                return payload.flat[key];
            }
        }

        if (payload.metrics_current &&
            payload.metrics_current[stream] &&
            Object.prototype.hasOwnProperty.call(payload.metrics_current[stream], param)) {
            return payload.metrics_current[stream][param];
        }

        return null;
    }

    function renderRoot(root, payload) {
        const dets = root.querySelectorAll(".cldetector-block .det[data-stream][data-param]");
        dets.forEach(det => {
            const stream = det.getAttribute("data-stream");
            const param = det.getAttribute("data-param");
            const value = getValueFromPayload(payload, stream, param);
            applySeverity(det, value);
        });
    }

    async function fetchAndRender(root) {
        const block = root.querySelector(".cldetector-block");
        if (!block) return;

        const endpoint = block.getAttribute("data-endpoint") || DEFAULT_ENDPOINT;

        try {
            const resp = await fetch(endpoint, {
                method: "GET",
                cache: "no-store"
            });

            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }

            const payload = await resp.json();
            renderRoot(root, payload);
        } catch (err) {
            console.error("[CLDetectorView] fetch failed:", err);
        }
    }

    function start(root) {
        stop();

        const block = root.querySelector(".cldetector-block");
        if (!block) return;

        const refreshSecAttr = block.getAttribute("data-refresh-sec");
        const refreshMs = Math.max(
            1000,
            (Number(refreshSecAttr) || (DEFAULT_REFRESH_MS / 1000)) * 1000
        );

        fetchAndRender(root);
        poller = setInterval(() => {
            fetchAndRender(root);
        }, refreshMs);
    }

    function stop() {
        if (poller) {
            clearInterval(poller);
            poller = null;
        }
    }

    function initWithin(root) {
        const scope = root || document;
        const block = scope.querySelector(".cldetector-block");
        if (!block) return;

        if (block.dataset.clInit === "1") {
            return;
        }
        block.dataset.clInit = "1";

        start(scope);
    }

    window.CLDetectorView = {
        initWithin,
        refresh: () => fetchAndRender(document),
        restart: () => start(document),
        stop
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => initWithin(document), { once: true });
    } else {
        initWithin(document);
    }
})();