// background.js — CORS-free fetch relay for the Yapper Plugins extension.
chrome.runtime.onInstalled.addListener(() => {
    console.log("Yapper Plugins extension installed.");
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchPaste") {
        // This fetch runs in the extension's background context, outside the
        // page's CORS sandbox. Because pastebin.com is in host_permissions,
        // the browser allows this cross-origin request without CORS headers.
        fetch(request.url)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.text();
            })
            .then(text => sendResponse({ ok: true, text }))
            .catch(err => sendResponse({ ok: false, error: err.message }));
        return true; // keep the message channel open for the async response
    }
});
