// bb-viewtoken.js — loaded first in <head> by _Layout on every page.
//
// The APIs behind our public pages (MHxView cards, reports, WebPM, IoT room page) need a live view token:
// the server puts one in <meta name="bb-view-token"> on every page render and keeps it alive while the page
// keeps calling /api (the 5 s alarm poll is enough). This wraps window.fetch so that every same-origin /api
// request carries it, and when the server says the token is gone (sleep, BellBeast restart, IP change) it
// renews silently with the HttpOnly refresh cookie and retries once — no page reload, because a reload would
// block alarm sound until someone taps the screen. Only when the refresh cookie itself has expired does the
// page reload (at most once per 5 minutes, so a broken server cannot cause a reload loop).
(function () {
    "use strict";

    var HEADER = "X-View-Token";
    var RENEW_URL = "/api/view/renew";
    // the server never says why (no hints for people calling the API by hand); any "unauthorized" from /api = renew once and retry
    var TOKEN_ERRORS = { unauthorized: 1 };
    var RELOAD_GUARD = "bb_view_reload_at";

    var meta = document.querySelector('meta[name="bb-view-token"]');
    var token = (meta && meta.getAttribute("content")) || "";
    var nativeFetch = window.fetch.bind(window);
    var renewing = null;

    function apiUrl(input) {
        try {
            var u = new URL(typeof input === "string" ? input : (input && input.url) || String(input), location.href);
            return u.origin === location.origin && u.pathname.indexOf("/api/") === 0 && u.pathname !== RENEW_URL;
        } catch (e) { return false; }
    }

    function reloadOnce() {
        var last = 0;
        try { last = Number(sessionStorage.getItem(RELOAD_GUARD)) || 0; } catch (e) { /* storage blocked */ }
        if (Date.now() - last < 5 * 60 * 1000) return;
        try { sessionStorage.setItem(RELOAD_GUARD, String(Date.now())); } catch (e) { /* storage blocked */ }
        location.reload();
    }

    // one renewal at a time; concurrent 401s all wait for the same one
    function renew() {
        if (renewing) return renewing;
        renewing = nativeFetch(RENEW_URL, {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ page: location.pathname }),
        }).then(function (r) {
            if (r.status === 401) { reloadOnce(); throw new Error("refresh expired"); }
            if (!r.ok) throw new Error("renew HTTP " + r.status);
            return r.json();
        }).then(function (j) {
            token = j.token || token;
            return token;
        }).finally(function () { renewing = null; });
        return renewing;
    }

    function withToken(input, init) {
        var opts = Object.assign({}, init || {});
        var headers = new Headers(opts.headers || (input instanceof Request ? input.headers : undefined));
        if (token) headers.set(HEADER, token);
        opts.headers = headers;
        return nativeFetch(input, opts);
    }

    window.fetch = function (input, init) {
        if (!apiUrl(input)) return nativeFetch(input, init);

        return withToken(input, init).then(function (r) {
            if (r.status !== 401) return r;
            return r.clone().json().catch(function () { return null; }).then(function (j) {
                if (!j || !TOKEN_ERRORS[j.error]) return r;
                return renew().then(function () { return withToken(input, init); }, function () { return r; });
            });
        });
    };

    // roll the refresh cookie forward while the page stays open (a wall can stay open for weeks)
    setInterval(function () { renew().catch(function () { /* retried next round or on the next 401 */ }); }, 4 * 60 * 60 * 1000);

    window.bbViewToken = { current: function () { return token; }, renew: renew };
})();
