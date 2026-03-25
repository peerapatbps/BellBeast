(function () {
    "use strict";

    function safeInit(root) {
        try {
            if (window.CHEMView && typeof window.CHEMView.initWithin === "function") {
                window.CHEMView.initWithin(root || document);
            }
        } catch (e) {
            // silent
        }
    }

    // expose same shape as other blocks
    window.CHEMSummary = {
        initWithin(root) { safeInit(root); },
        destroyWithin(root) {
            try {
                if (window.CHEMView && typeof window.CHEMView.destroyWithin === "function") {
                    window.CHEMView.destroyWithin(root || document);
                }
            } catch (e) { }
        }
    };

    // auto-run once for full page load (safe if injected later: caller can call initWithin again)
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => safeInit(document), { once: true });
    } else {
        safeInit(document);
    }
})(); 
