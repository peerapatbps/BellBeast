(function () {
    "use strict";

    function safeInit(root) {
        try {
            if (window.CHEMView && typeof window.CHEMView.initWithin === "function") {
                window.CHEMView.initWithin(root || document);
            }

            if (window.CHEMSettings && typeof window.CHEMSettings.initWithin === "function") {
                window.CHEMSettings.initWithin(root || document);
            }
        } catch (e) {
            // silent
        }
    }

    window.CHEMSummary = {
        initWithin(root) { safeInit(root); },

        restartWithin(root) {
            try {
                if (window.CHEMView && typeof window.CHEMView.restartWithin === "function") {
                    window.CHEMView.restartWithin(root || document);
                } else {
                    safeInit(root || document);
                }

                if (window.CHEMSettings && typeof window.CHEMSettings.initWithin === "function") {
                    window.CHEMSettings.initWithin(root || document);
                }
            } catch (e) { }
        },

        destroyWithin(root) {
            try {
                if (window.CHEMView && typeof window.CHEMView.destroyWithin === "function") {
                    window.CHEMView.destroyWithin(root || document);
                }
            } catch (e) { }
        }
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => safeInit(document), { once: true });
    } else {
        safeInit(document);
    }
})();
