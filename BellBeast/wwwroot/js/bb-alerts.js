(function () {
    "use strict";

    const sectionState = new WeakMap();
    let audioCtx = null;
    let activeAlarmTimer = null;
    let activeAlarmCount = 0;

    function getSectionState(section) {
        let state = sectionState.get(section);
        if (!state) {
            state = {
                rules: Object.create(null)
            };
            sectionState.set(section, state);
        }
        return state;
    }

    function toNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function clamp(value, min, max, fallback) {
        const n = toNumber(value);
        if (n === null) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function loadSettings(key, defaults) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return { ...defaults };
            return { ...defaults, ...JSON.parse(raw) };
        } catch {
            return { ...defaults };
        }
    }

    function saveSettings(key, settings) {
        localStorage.setItem(key, JSON.stringify(settings));
    }

    function ensureAudio() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!audioCtx) audioCtx = new Ctx();
        return audioCtx;
    }

    async function armAudio() {
        const ctx = ensureAudio();
        if (!ctx) return false;
        if (ctx.state === "suspended") {
            try {
                await ctx.resume();
            } catch {
                return false;
            }
        }
        return ctx.state === "running";
    }

    function playAlert() {
        const ctx = ensureAudio();
        if (!ctx || ctx.state !== "running") return false;

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(660, now + 0.12);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.3);
        return true;
    }

    function startContinuousAlarm() {
        if (activeAlarmTimer || activeAlarmCount <= 0) return;

        playAlert();
        activeAlarmTimer = window.setInterval(() => {
            if (activeAlarmCount <= 0) {
                stopContinuousAlarm();
                return;
            }
            playAlert();
        }, 700);
    }

    function stopContinuousAlarm() {
        if (activeAlarmTimer) {
            window.clearInterval(activeAlarmTimer);
            activeAlarmTimer = null;
        }
    }

    function syncContinuousAlarm() {
        if (activeAlarmCount > 0) {
            startContinuousAlarm();
            return;
        }
        stopContinuousAlarm();
    }

    function isExceeded(value, limit, direction) {
        const current = toNumber(value);
        const target = toNumber(limit);
        if (current === null || target === null) return false;
        return direction === "lt" ? current < target : current > target;
    }

    function evaluate(section, rule) {
        if (!section || !rule || !rule.ruleKey) return false;

        const state = getSectionState(section);
        const prev = !!state.rules[rule.ruleKey];
        const active = !!rule.enabled && isExceeded(rule.value, rule.limit, rule.direction);
        const canSound = active && !rule.muted;

        if (prev !== canSound) {
            activeAlarmCount += canSound ? 1 : -1;
            if (activeAlarmCount < 0) activeAlarmCount = 0;
            syncContinuousAlarm();
        }

        state.rules[rule.ruleKey] = canSound;
        return active;
    }

    function resetRule(section, ruleKey) {
        if (!section || !ruleKey) return;
        const state = getSectionState(section);
        if (state.rules[ruleKey]) {
            activeAlarmCount = Math.max(0, activeAlarmCount - 1);
            syncContinuousAlarm();
        }
        delete state.rules[ruleKey];
    }

    function setBellState(button, state) {
        if (!button) return;

        button.classList.remove("is-muted", "is-armed", "is-alerting");

        if (state === "alerting") {
            button.classList.add("is-alerting");
            button.title = "Bell: alert active";
            button.setAttribute("aria-label", "Bell alert active");
            return;
        }

        if (state === "muted") {
            button.classList.add("is-muted");
            button.title = "Bell: muted";
            button.setAttribute("aria-label", "Bell muted");
            return;
        }

        button.classList.add("is-armed");
        button.title = "Bell: armed";
        button.setAttribute("aria-label", "Bell armed");
    }

    window.BBAlerts = {
        armAudio,
        clamp,
        evaluate,
        loadSettings,
        resetRule,
        saveSettings,
        setBellState
    };
})();
