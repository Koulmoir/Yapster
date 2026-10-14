// bridge.js — runs in the ISOLATED world, where chrome.runtime exists.
// Relays fetch requests from the MAIN-world core.js to the background script.
(() => {
    "use strict";

    const CHANNEL = "yapster-bridge";

    window.addEventListener("message", event => {
        // Only accept messages from the same window, and only our own tagged ones.
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.channel !== CHANNEL || data.type !== "fetch") return;

        const { id, url } = data;
        if (!id || !url) return;

        try {
            chrome.runtime.sendMessage({ action: "fetchPaste", url }, res => {
                const reply = { channel: CHANNEL, type: "fetch-result", id };
                if (chrome.runtime.lastError) {
                    reply.ok = false;
                    reply.error = chrome.runtime.lastError.message;
                } else if (!res) {
                    reply.ok = false;
                    reply.error = "No response from background script";
                } else {
                    reply.ok = !!res.ok;
                    reply.text = res.text;
                    reply.error = res.error;
                }
                window.postMessage(reply, "*");
            });
        } catch (err) {
            window.postMessage(
                { channel: CHANNEL, type: "fetch-result", id, ok: false, error: String(err?.message || err) },
                "*",
            );
        }
    });
})();
