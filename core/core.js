(() => {
    "use strict";

    /* ================= storage (localStorage for Main World) ================= */
    const loadPlugins = () => {
        try {
            return JSON.parse(localStorage.getItem("yapster_plugins")) || [];
        } catch {
            return [];
        }
    };
    const savePlugins = p => localStorage.setItem("yapster_plugins", JSON.stringify(p));

    /* ==== official channel ==== */
    const OFFICIAL_CHANNEL_KEY = "yapster_official_channel";
    const DEFAULT_OFFICIAL_CHANNEL = "official-plugins";
    const getOfficialChannel = () => {
        const v = localStorage.getItem(OFFICIAL_CHANNEL_KEY);
        return String(v || DEFAULT_OFFICIAL_CHANNEL);
    };
    const setOfficialChannel = name => localStorage.setItem(OFFICIAL_CHANNEL_KEY, String(name || "").trim());
    /* ==== /official channel ==== */

    /* ================= Supabase/profile cache ================= */
    const sb = { origin: null, apikey: null, auth: null };
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const profileCache = {
        byId: new Map(),
        byUsername: new Map(),
        byAlias: new Map(),
        aliasesById: new Map(),
    };

    /* ================= early WebSocket observer ================= */
    const webSocketMessageListeners = new Set();
    let originalWebSocketCtor = null;
    let wrappedWebSocketCtor = null;

    (function installEarlyWebSocketObserver() {
        try {
            originalWebSocketCtor = window.WebSocket;
            if (typeof originalWebSocketCtor !== "function" || originalWebSocketCtor.__ypEarlyObserver) return;

            const Original = originalWebSocketCtor;
            function WrappedWebSocket(...args) {
                const socket = Reflect.construct(
                    Original,
                    args,
                    new.target === WrappedWebSocket ? Original : new.target,
                );
                const socketUrl = (() => {
                    try {
                        return String(args[0] || "");
                    } catch {
                        return "";
                    }
                })();
                socket.addEventListener("message", event => {
                    for (const callback of [...webSocketMessageListeners]) {
                        try {
                            callback({ event, socket, url: socketUrl });
                        } catch (error) {
                            console.error("[yapster-plugins] WebSocket observer failed", error);
                        }
                    }
                });
                return socket;
            }
            WrappedWebSocket.prototype = Original.prototype;
            Object.setPrototypeOf(WrappedWebSocket, Original);
            Object.defineProperty(WrappedWebSocket, "__ypEarlyObserver", { value: true });
            window.WebSocket = WrappedWebSocket;
            wrappedWebSocketCtor = WrappedWebSocket;
        } catch (error) {
            console.error("[yapster-plugins] could not install early WebSocket observer", error);
        }
    })();
    let scheduleUserModalCheck = () => {};

    const normaliseUserName = value =>
        String(value ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .toLocaleLowerCase();
    const normaliseChannelName = value =>
        String(value ?? "")
            .replace(/^#/, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLocaleLowerCase();

    function cacheProfiles(rows) {
        if (!Array.isArray(rows)) return;
        let changed = false;
        for (const profile of rows) {
            if (!profile || !UUID_RE.test(String(profile.id || "")) || !profile.username) continue;
            const id = String(profile.id);
            const previous = profileCache.byId.get(id);
            if (previous) {
                for (const alias of profileCache.aliasesById.get(id) || []) {
                    const bucket = profileCache.byAlias.get(alias);
                    bucket?.delete(id);
                    if (bucket && !bucket.size) profileCache.byAlias.delete(alias);
                }
            }
            profileCache.byId.set(id, profile);
            profileCache.byUsername.set(String(profile.username), profile);

            const aliases = new Set(
                [profile.username, profile.display_name]
                    .filter(value => typeof value === "string" && value.trim())
                    .map(normaliseUserName),
            );
            profileCache.aliasesById.set(id, aliases);
            for (const alias of aliases) {
                if (!profileCache.byAlias.has(alias)) profileCache.byAlias.set(alias, new Map());
                profileCache.byAlias.get(alias).set(id, profile);
            }
            changed = true;
        }
        if (changed) scheduleUserModalCheck();
    }

    function findProfileByName(name) {
        const raw = String(name ?? "")
            .replace(/\s+/g, " ")
            .trim();
        if (!raw) return null;
        const exact = profileCache.byUsername.get(raw);
        if (exact) return exact;
        const matches = profileCache.byAlias.get(normaliseUserName(raw));
        return matches?.size === 1 ? matches.values().next().value : null;
    }

    const localToken = () => {
        try {
            for (const k of Object.keys(localStorage)) {
                if (/^sb-.*-auth-token$/.test(k)) {
                    const v = JSON.parse(localStorage.getItem(k));
                    return v?.access_token ?? v?.currentSession?.access_token ?? null;
                }
            }
        } catch {}
        return null;
    };
    (function hookFetch() {
        const orig = window.fetch;
        window.fetch = function (input, init) {
            let url = null;
            try {
                url = new URL(typeof input === "string" ? input : (input.url ?? String(input)), location.href);
                if (url.hostname.endsWith(".supabase.co") && url.pathname.startsWith("/rest/v1/")) {
                    const h = new Headers(
                        (init && init.headers) || (typeof input !== "string" && input.headers) || undefined,
                    );
                    if (h.get("apikey")) {
                        sb.origin = url.origin;
                        sb.apikey = h.get("apikey");
                        sb.auth = h.get("authorization") || sb.auth;
                    }
                }
            } catch {}

            const result = orig.apply(this, arguments);
            if (url && url.hostname.endsWith(".supabase.co") && url.pathname === "/rest/v1/profiles") {
                return Promise.resolve(result).then(response => {
                    try {
                        response
                            .clone()
                            .json()
                            .then(cacheProfiles)
                            .catch(() => {});
                    } catch {}
                    return response;
                });
            }
            return result;
        };
    })();
    const sbApi = {
        async get(path) {
            const t0 = Date.now();
            while (!sb.apikey && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 250));
            if (!sb.apikey) throw new Error("No Supabase credentials captured yet. Switch server or refresh once.");
            const tok = localToken();
            const r = await window.fetch(`${sb.origin}/rest/v1/${path}`, {
                headers: {
                    apikey: sb.apikey,
                    authorization: sb.auth || (tok ? "Bearer " + tok : "Bearer " + sb.apikey),
                    accept: "application/json",
                },
            });
            if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
            return r.json();
        },
    };

    /* ================= view-change detection (DOM only) ================= */
    const getContext = () => ({
        server: document.querySelector(".rail-item.active")?.title ?? null,
        channel:
            document.querySelector(".channel-row.active .name")?.textContent ??
            document.querySelector(".main-head .title-btn")?.textContent ??
            null,
        view: document.querySelector(".app")?.classList.contains("chat-open") ? "chat" : "other",
    });
    let lastKey = "";
    const navListeners = new Set();
    function checkNav() {
        const ctx = getContext();
        const key = JSON.stringify(ctx);
        if (key === lastKey) return;
        lastKey = key;
        navListeners.forEach(fn => {
            try {
                fn(ctx);
            } catch (e) {
                console.error(e);
            }
        });
    }

    /* ==== plugin repository (install from pastebin links) ==== */
    function isInOfficialChannel() {
        const target = normaliseChannelName(getOfficialChannel());
        if (!target) return false;
        const current = normaliseChannelName(getContext().channel);
        return !!current && current === target;
    }

    const PASTEBIN_RE = /https?:\/\/(?:www\.)?pastebin\.com\/(?!api\/)(?:raw\/)?([A-Za-z0-9_-]{4,32})/gi;
    const PASTEBIN_RESERVED = new Set(["raw", "api", "login", "signup", "tools", "faq", "pro"]);

    function extractPastebinLinks(text) {
        if (typeof text !== "string" || !text) return [];
        const out = [];
        const seen = new Set();
        PASTEBIN_RE.lastIndex = 0;
        let m;
        while ((m = PASTEBIN_RE.exec(text)) !== null) {
            const id = m[1];
            if (PASTEBIN_RESERVED.has(id.toLowerCase())) continue;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id, raw: `https://pastebin.com/raw/${id}` });
        }
        return out;
    }

    function extractPastebinLinksFromDom(msg) {
        const out = [];
        const seen = new Set();
        msg.querySelectorAll("a[href]").forEach(a => {
            const href = a.getAttribute("href") || "";
            const found = extractPastebinLinks(href);
            for (const f of found) {
                if (!seen.has(f.id)) {
                    seen.add(f.id);
                    out.push(f);
                }
            }
        });
        return out;
    }

    async function findPastebinLinks(msgId, msgEl) {
        const dom = extractPastebinLinksFromDom(msgEl);
        if (dom.length) return dom;
        try {
            const rows = await sbApi.get(`messages?select=content&id=eq.${encodeURIComponent(msgId)}`);
            const row = Array.isArray(rows) ? rows[0] : null;
            if (!row?.content) return [];
            return extractPastebinLinks(row.content);
        } catch (e) {
            console.warn("[yapster-plugins] message lookup failed", e);
            return [];
        }
    }

    // Ask the isolated-world bridge to fetch the raw paste. The bridge has access
    // to chrome.runtime, which the MAIN world does not. This bypasses CORS without
    // any third-party proxy.
    const BRIDGE_CHANNEL = "yapster-bridge";
    let bridgeRequestSeq = 0;

    function bridgeFetchPaste(url) {
        return new Promise((resolve, reject) => {
            const id = `pf-${Date.now()}-${++bridgeRequestSeq}`;

            const onMessage = event => {
                if (event.source !== window) return;
                const data = event.data;
                if (!data || data.channel !== BRIDGE_CHANNEL) return;
                if (data.type !== "fetch-result" || data.id !== id) return;
                window.removeEventListener("message", onMessage);
                if (!data.ok) return reject(new Error(data.error || "Fetch failed"));
                resolve(data.text);
            };

            window.addEventListener("message", onMessage);

            window.postMessage({ channel: BRIDGE_CHANNEL, type: "fetch", id, url }, "*");

            setTimeout(() => {
                window.removeEventListener("message", onMessage);
                reject(new Error("Bridge fetch timed out"));
            }, 15000);
        });
    }

    async function fetchPaste(pastebin) {
        const text = await bridgeFetchPaste(pastebin.raw);
        if (!text || !text.trim()) throw new Error(`Paste ${pastebin.id} is empty`);
        if (/^(?:error|too many|rate limit)/i.test(text.trim().slice(0, 40))) {
            throw new Error(`Pastebin returned: ${text.trim().slice(0, 120)}`);
        }
        return text;
    }

    // Shared confirm dialog. Resolves only after the user clicks the enabled
    // confirm button; rejects on Cancel, Escape, or click-outside. The confirm
    // button stays disabled until the countdown finishes.
    function showConfirmDialog({ title, subtitle, bodyHtml, okText, waitSeconds = 3 }) {
        return new Promise((resolve, reject) => {
            const overlay = document.createElement("div");
            overlay.className = "yp-confirm-ov";
            overlay.innerHTML = `
        <div class="yp-confirm" role="alertdialog" aria-modal="true">
          <div class="yp-confirm-head">
            <span class="yp-confirm-warn">⚠️</span>
            <h3>${esc(title)}</h3>
          </div>
          <p class="yp-confirm-sub">${esc(subtitle)}</p>
          <div class="yp-confirm-body">${bodyHtml}</div>
          <div class="yp-confirm-actions">
            <button type="button" class="yp-confirm-cancel">Cancel</button>
            <button type="button" class="yp-confirm-ok" disabled>Wait <span class="yp-confirm-count">${waitSeconds}</span>s</button>
          </div>
        </div>`;
            document.body.append(overlay);

            const okBtn = overlay.querySelector(".yp-confirm-ok");
            const cancelBtn = overlay.querySelector(".yp-confirm-cancel");
            const countEl = overlay.querySelector(".yp-confirm-count");

            let remaining = waitSeconds;
            let interval = null;
            let done = false;

            function cleanup() {
                if (interval) {
                    clearInterval(interval);
                    interval = null;
                }
                document.removeEventListener("keydown", onKey, true);
                overlay.remove();
            }
            function finish(fn, arg) {
                if (done) return;
                done = true;
                cleanup();
                fn(arg);
            }
            function cancel() {
                finish(reject, new Error("Cancelled by user"));
            }

            cancelBtn.onclick = cancel;
            okBtn.onclick = () => {
                if (!okBtn.disabled) finish(resolve);
            };
            overlay.addEventListener("mousedown", e => {
                if (e.target === overlay) cancel();
            });

            function onKey(e) {
                if (e.key === "Escape") cancel();
                if (e.key === "Enter") e.preventDefault();
            }
            document.addEventListener("keydown", onKey, true);

            interval = setInterval(() => {
                remaining -= 1;
                if (remaining <= 0) {
                    clearInterval(interval);
                    interval = null;
                    okBtn.disabled = false;
                    okBtn.textContent = okText;
                } else {
                    countEl.textContent = String(remaining);
                }
            }, 1000);
        });
    }

    // Shows a blocking safety warning before any plugin is installed.
    function confirmInstall(pluginName, source) {
        const sourceLine = source
            ? `You are about to install a plugin from an untrusted source (<strong>${esc(source)}</strong>):`
            : "You are about to install a plugin:";
        return showConfirmDialog({
            title: "Security warning",
            subtitle: "Read this before installing.",
            okText: "I understand — install anyway",
            bodyHtml: `
        <p>${sourceLine}</p>
        <div class="yp-confirm-name">${esc(pluginName)}</div>
        <div class="yp-confirm-warning">
          <strong>Plugins run with full access to your account.</strong>
          A malicious plugin can do anything you can do on this site, including:
          <ul>
            <li>Read every message in every server you're in</li>
            <li>Send messages as you, to anyone</li>
            <li>Delete your messages, channels, or servers</li>
            <li>Steal your Supabase session token</li>
            <li>Silently install other plugins</li>
          </ul>
          Only continue if you wrote this code yourself, or have read
          every line of it and trust the author completely.
        </div>
        <p class="yp-confirm-hint">If someone sent you this, ask them for the source code first. Never install a plugin you haven't read.</p>`,
        });
    }

    // Shows a blocking warning before the official channel is changed, since
    // plugins installed from that channel skip the install-time safety dialog.
    function confirmOfficialChannelChange(newName, reason) {
        return showConfirmDialog({
            title: "Change official plugin channel?",
            subtitle: "Read this before continuing.",
            okText: "I understand — change it",
            bodyHtml: `
        <p>${esc(reason)}</p>
        <div class="yp-confirm-name">#${esc(newName)}</div>
        <div class="yp-confirm-warning">
          <strong>Plugins from this channel install with no warning.</strong>
          Anything anyone posts in <em>#${esc(newName)}</em> with a pastebin link will be
          installed the moment you click "+ Plugin" — no safety prompt, no delay.
          <ul>
            <li>Only set this to a channel you control or fully trust.</li>
            <li>If a stranger can post there, they can run code in your session.</li>
            <li>You can change it back at any time, but anything already installed stays.</li>
          </ul>
        </div>
        <p class="yp-confirm-hint">If you're not sure, click Cancel.</p>`,
        });
    }

    async function installPluginFromCode(code, label) {
        let def;
        try {
            def = parse(code);
        } catch (e) {
            throw new Error(`Not valid plugin code${label ? ` in ${label}` : ""}: ${e.message}`);
        }

        // Skip the safety warning only when installing from the user's designated
        // official channel. Everywhere else, block until the user acknowledges.
        if (!isInOfficialChannel()) {
            await confirmInstall(def.name, label);
        }

        const all = loadPlugins();
        const existing = all.find(p => {
            try {
                return parse(p.code).name === def.name;
            } catch {
                return false;
            }
        });
        let plugin;
        if (existing) {
            stopPlugin(existing.id);
            existing.code = code;
            existing.enabled = true;
            plugin = existing;
        } else {
            plugin = { id: "p" + Date.now().toString(36), code, enabled: true };
            all.push(plugin);
        }
        savePlugins(all);
        startPlugin(plugin);
        if (errors.has(plugin.id)) throw new Error(`Installed but start() failed: ${errors.get(plugin.id)}`);
        return def.name;
    }

    function installPluginMessageButtons() {
        let wasActive = false;

        function cleanupButtons() {
            document.querySelectorAll("[data-yp-addplugin]").forEach(b => b.remove());
        }

        function addButtonToMessage(msg) {
            if (msg.querySelector("[data-yp-addplugin]")) return;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.dataset.ypAddplugin = "1";
            btn.className = "yp-addplugin";
            btn.textContent = "+ Plugin";
            btn.title = "Install plugins from pastebin links in this message";
            btn.onclick = async e => {
                e.preventDefault();
                e.stopPropagation();
                const original = "+ Plugin";
                btn.disabled = true;
                btn.textContent = "Checking…";
                const msgId = msg.getAttribute("data-message-id");
                try {
                    const pastes = await findPastebinLinks(msgId, msg);
                    if (!pastes.length) {
                        btn.textContent = "No pastebin link";
                        setTimeout(() => {
                            btn.textContent = original;
                            btn.disabled = false;
                        }, 2200);
                        return;
                    }
                    const installed = [];
                    for (let i = 0; i < pastes.length; i++) {
                        const p = pastes[i];
                        const label = `pastebin.com/${p.id}`;
                        btn.textContent = `Fetching ${p.id}…`;
                        try {
                            const code = await fetchPaste(p);
                            const name = await installPluginFromCode(code, label);
                            installed.push(name);
                        } catch (err) {
                            console.error("[yapster-plugins] install failed", p, err);
                        }
                    }
                    if (installed.length) {
                        btn.textContent = `✓ ${installed.join(", ")}`;
                        setTimeout(() => {
                            btn.textContent = original;
                            btn.disabled = false;
                        }, 3000);
                    } else {
                        btn.textContent = "Install failed";
                        setTimeout(() => {
                            btn.textContent = original;
                            btn.disabled = false;
                        }, 2500);
                    }
                } catch (err) {
                    console.error("[yapster-plugins] add-plugin click failed", err);
                    btn.textContent = "Failed";
                    setTimeout(() => {
                        btn.textContent = original;
                        btn.disabled = false;
                    }, 2200);
                }
            };
            const anchor =
                msg.querySelector(".msg-header") || msg.querySelector(".msg-author") || msg.querySelector(".msg-meta");
            if (anchor) anchor.insertAdjacentElement("afterend", btn);
            else msg.append(btn);
        }

        function scan() {
            const inOfficial = isInOfficialChannel();
            if (!inOfficial) {
                if (wasActive) cleanupButtons();
                wasActive = false;
                return;
            }
            wasActive = true;
            document.querySelectorAll(".msg[data-message-id]").forEach(msg => {
                if (msg.querySelector("[data-yp-addplugin]")) return;
                addButtonToMessage(msg);
            });
        }

        const mo = new MutationObserver(scan);
        mo.observe(document.body, { childList: true, subtree: true });
        scan();
        navListeners.add(scan);
        return () => {
            mo.disconnect();
            navListeners.delete(scan);
        };
    }
    /* ==== /plugin repository ==== */

    /* ================= shared user-modal event ================= */
    const userModalListeners = new Set();
    let pendingUserClick = null;
    let lastEmittedProfileCard = null;
    let lastEmittedProfileKey = "";
    let lastUserModalDetail = null;
    let userModalObserver = null;
    let userModalClickListenerInstalled = false;
    let userModalCheckQueued = false;

    function userIdFromAvatarUrl(value) {
        const src = String(value || "");
        const match = src.match(/\/avatars\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i);
        return match ? match[1] : null;
    }

    function extractAvatarUserId(element) {
        if (!(element instanceof Element)) return null;
        for (let node = element, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
            for (const attr of ["data-user-id", "data-userid", "data-profile-id"]) {
                const value = node.getAttribute?.(attr);
                if (value && UUID_RE.test(value)) return value;
            }
        }
        const avatar = element.closest(".avatar");
        const avatarId = userIdFromAvatarUrl(avatar?.querySelector("img[src]")?.getAttribute("src"));
        if (avatarId) return avatarId;
        const message = element.closest(".msg");
        const messageId = userIdFromAvatarUrl(
            message?.querySelector(".msg-gutter .avatar img[src]")?.getAttribute("src"),
        );
        if (messageId) return messageId;
        const pickRow = element.closest(".pick-row");
        const rowId = userIdFromAvatarUrl(pickRow?.querySelector(":scope > .avatar img[src]")?.getAttribute("src"));
        if (rowId) return rowId;
        const profileCard = element.closest(".profile-card") || (element.matches(".profile-card") ? element : null);
        const cardId = userIdFromAvatarUrl(
            profileCard?.querySelector(".profile-card-avatar .avatar img[src]")?.getAttribute("src"),
        );
        return cardId || null;
    }

    function extractClickedUserName(element) {
        if (!(element instanceof Element)) return "";
        const pickRow = element.closest(".pick-row");
        if (pickRow) {
            const spans = [...pickRow.querySelectorAll(":scope > span")];
            if (spans.length) return spans[spans.length - 1].textContent.trim();
        }
        const author = element.closest(".msg-author");
        if (author?.textContent.trim()) return author.textContent.trim();
        const labelledAvatar = element.closest(`[aria-label$="'s profile"], [aria-label$="’s profile"]`);
        const aria = labelledAvatar?.getAttribute("aria-label") || "";
        const match = aria.match(/^(.+?)['’]s profile$/i);
        if (match) return match[1].trim();
        const replyAuthor = element.closest(".reply-author");
        if (replyAuthor?.textContent.trim()) return replyAuthor.textContent.trim();
        const named = element.closest("[data-username], .member-name, .user-name, .uname");
        return named?.getAttribute("data-username") || named?.textContent?.trim() || "";
    }

    function onUserTriggerClick(event) {
        const target = event.target instanceof Element ? event.target : event.target?.parentElement;
        if (!target || target.closest(".profile-card")) return;
        const trigger = target.closest(
            ".pick-row, .msg-author, .msg-gutter .avatar[aria-label], .members-panel .avatar[aria-label], [data-user-id], [data-profile-id]",
        );
        if (!trigger) return;
        const name = extractClickedUserName(trigger) || extractClickedUserName(target);
        const id = extractAvatarUserId(trigger) || extractAvatarUserId(target);
        const profile = (id && profileCache.byId.get(id)) || findProfileByName(name);
        pendingUserClick = { id: id || profile?.id || null, name, profile, at: Date.now() };
    }

    function checkUserModal() {
        const card = document.querySelector(".overlay .modal[role='dialog'] .profile-card");
        if (!card) {
            lastEmittedProfileCard = null;
            lastEmittedProfileKey = "";
            lastUserModalDetail = null;
            return;
        }
        const name = card.querySelector(".profile-card-name")?.textContent?.replace(/\s+/g, " ").trim() || "";
        if (!name) return;

        const cardId = extractAvatarUserId(card);
        const namedProfile = findProfileByName(name);
        const pending = pendingUserClick && Date.now() - pendingUserClick.at < 7000 ? pendingUserClick : null;
        const pendingMatches =
            pending &&
            (normaliseUserName(pending.name) === normaliseUserName(name) ||
                normaliseUserName(pending.profile?.username) === normaliseUserName(name) ||
                normaliseUserName(pending.profile?.display_name) === normaliseUserName(name));
        const id = cardId || namedProfile?.id || (pendingMatches ? pending.id : null);
        if (!id || !UUID_RE.test(String(id))) return;
        const profile =
            profileCache.byId.get(String(id)) || namedProfile || (pendingMatches ? pending.profile : null) || null;
        const username = profile?.username || (pendingMatches ? pending.name : name);
        const key = `${id}:${normaliseUserName(name)}`;
        if (card === lastEmittedProfileCard && key === lastEmittedProfileKey) return;
        lastEmittedProfileCard = card;
        lastEmittedProfileKey = key;

        const modal = card.closest(".modal[role='dialog']") || card;
        const detail = { userId: String(id), name, username, profile, modal, card };
        lastUserModalDetail = detail;
        for (const listener of [...userModalListeners]) {
            try {
                listener(detail);
            } catch (error) {
                console.error("[yapster-plugins] onUserModalOpen listener failed", error);
            }
        }
        try {
            window.dispatchEvent(new CustomEvent("yapster:user-modal-open", { detail }));
            window.dispatchEvent(new CustomEvent("yapper:user-modal-open", { detail }));
        } catch {}
    }

    scheduleUserModalCheck = () => {
        if (userModalCheckQueued) return;
        userModalCheckQueued = true;
        requestAnimationFrame(() => {
            userModalCheckQueued = false;
            checkUserModal();
        });
    };

    function installUserModalTracking() {
        if (!userModalClickListenerInstalled) {
            document.addEventListener("click", onUserTriggerClick, true);
            userModalClickListenerInstalled = true;
        }
        if (!userModalObserver && document.body) {
            userModalObserver = new MutationObserver(scheduleUserModalCheck);
            userModalObserver.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ["class", "src", "aria-label", "data-user-id", "data-profile-id"],
            });
        }
        scheduleUserModalCheck();
    }

    /* ================= plugin API ================= */
    function makeApi(id, settings) {
        const cleanups = [];
        const api = {
            page: window,
            context: getContext,
            settings,
            getSettings: () => ({ ...settings }),
            onCleanup: fn => cleanups.push(fn),
            log: (...a) => console.log(`[yapster-plugin:${id}]`, ...a),
            supabase: sbApi,
            onWebSocketMessage(callback) {
                if (typeof callback !== "function") throw new TypeError("onWebSocketMessage expects a function");
                webSocketMessageListeners.add(callback);
                const off = () => webSocketMessageListeners.delete(callback);
                cleanups.push(off);
                return off;
            },
            onUserModalOpen(callback) {
                if (typeof callback !== "function") throw new TypeError("onUserModalOpen expects a function");
                userModalListeners.add(callback);
                const off = () => userModalListeners.delete(callback);
                cleanups.push(off);
                if (lastUserModalDetail?.card?.isConnected) {
                    try {
                        callback(lastUserModalDetail);
                    } catch (error) {
                        console.error("[yapster-plugins] onUserModalOpen listener failed", error);
                    }
                }
                scheduleUserModalCheck();
                return off;
            },
            addStyle(css) {
                const s = document.createElement("style");
                s.textContent = css;
                (document.head || document.documentElement).append(s);
                cleanups.push(() => s.remove());
                return s;
            },
            observe(selector, cb) {
                const seen = new WeakSet();
                const scan = () =>
                    document.querySelectorAll(selector).forEach(el => {
                        if (!seen.has(el)) {
                            seen.add(el);
                            cb(el);
                        }
                    });
                const mo = new MutationObserver(scan);
                mo.observe(document.body, { childList: true, subtree: true });
                scan();
                cleanups.push(() => mo.disconnect());
            },
            listen(target, type, fn, opts) {
                target.addEventListener(type, fn, opts);
                cleanups.push(() => target.removeEventListener(type, fn, opts));
            },
            storage: {
                get: (k, d) => {
                    try {
                        const v = localStorage.getItem(`yapster_pdata_${id}_${k}`);
                        return v ? JSON.parse(v) : d;
                    } catch {
                        return d;
                    }
                },
                set: (k, v) => {
                    try {
                        localStorage.setItem(`yapster_pdata_${id}_${k}`, JSON.stringify(v));
                    } catch {}
                },
            },
        };
        return { api, cleanups };
    }

    /* ================= plugin runtime ================= */
    const running = new Map();
    const errors = new Map();

    const definePlugin = d => d;
    function parse(code) {
        const expr = code.trim().replace(/;+\s*$/, "");
        const def = new Function("definePlugin", `"use strict"; return (${expr}\n);`)(definePlugin);
        if (!def || typeof def !== "object") throw new Error("Plugin must be an object");
        if (!def.name) throw new Error('Plugin needs a "name"');
        return def;
    }

    function settingsEntries(def) {
        const schema = def?.settings;
        if (Array.isArray(schema)) {
            return schema
                .map((entry, index) => ({
                    ...entry,
                    key: entry?.key ?? entry?.id ?? `setting${index + 1}`,
                }))
                .filter(entry => entry && typeof entry === "object");
        }
        if (schema && typeof schema === "object") {
            return Object.entries(schema).map(([key, entry]) => ({
                ...(entry && typeof entry === "object" ? entry : { type: "string", default: entry }),
                key,
            }));
        }
        return [];
    }

    function defaultForSetting(entry) {
        if (Object.prototype.hasOwnProperty.call(entry, "default")) return entry.default;
        if (Object.prototype.hasOwnProperty.call(entry, "defaultValue")) return entry.defaultValue;
        switch (String(entry.type || "string").toLowerCase()) {
            case "toggle":
            case "boolean":
                return false;
            case "number":
                return 0;
            case "custom":
                return undefined;
            default:
                return "";
        }
    }

    function readPluginSettings(pluginId, def) {
        const defaults = {};
        for (const entry of settingsEntries(def)) {
            if (String(entry.type || "string").toLowerCase() === "custom") continue;
            defaults[entry.key] = defaultForSetting(entry);
        }
        let saved = {};
        try {
            saved = JSON.parse(localStorage.getItem(`yapster_psettings_${pluginId}`)) || {};
        } catch {}
        return { ...defaults, ...(saved && typeof saved === "object" ? saved : {}) };
    }

    function writePluginSettings(pluginId, values) {
        try {
            localStorage.setItem(`yapster_psettings_${pluginId}`, JSON.stringify({ ...values }));
        } catch {}
    }

    function startPlugin(p) {
        if (running.has(p.id)) return;
        let def, api, cleanups, settings;
        try {
            def = parse(p.code);
            settings = readPluginSettings(p.id, def);
            ({ api, cleanups } = makeApi(p.id, settings));
            const nav = ctx => def.onNavigate?.(ctx, api);
            def.start?.(api, settings);
            navListeners.add(nav);
            running.set(p.id, { def, api, cleanups, nav, settings });
            errors.delete(p.id);
        } catch (e) {
            if (cleanups)
                cleanups.forEach(fn => {
                    try {
                        fn();
                    } catch {}
                });
            errors.set(p.id, e.message);
            console.error("[yapster-plugins] failed to start", p?.id, e);
        }
    }

    function stopPlugin(id) {
        const r = running.get(id);
        if (!r) return;
        navListeners.delete(r.nav);
        try {
            r.def.stop?.(r.api, { ...r.settings });
        } catch (e) {
            console.error("[yapster-plugins] plugin stop failed", id, e);
        }
        r.cleanups.forEach(fn => {
            try {
                fn();
            } catch {}
        });
        running.delete(id);
    }

    /* ================= settings-menu integration ================= */
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

    const style = document.createElement("style");
    style.textContent = `
    .settings-main[data-yp-active] > :not(.yp-panel):not(.settings-close) { display: none !important; }
    .yp-panel { padding: 4px 0; }
    .yp-row { display: flex; align-items: center; gap: 12px; padding: 12px 0;
              border-top: 1px solid rgba(128,128,128,.25); }
    .yp-info { flex: 1; min-width: 0; }
    .yp-name { font-weight: 600; }
    .yp-desc { opacity: .7; font-size: 12px; margin-top: 2px; }
    .yp-err  { color: #ff6b6b; font-size: 12px; margin-top: 2px; }
    .yp-ok   { color: #57d28f; }
    .yp-empty { opacity: .6; padding: 12px 0; }
    .yp-msg { margin-top: 10px; font-size: 13px; min-height: 18px; }
    .yp-code { width: 100%; min-height: 240px; resize: vertical; font-family: monospace; font-size: 12px; }
    .yp-settings-top { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .yp-settings-top h2 { margin: 0; }
    .yp-settings-intro { opacity: .7; font-size: 12px; line-height: 1.5; margin: 6px 0 14px; }
    .yp-setting { border-top: 1px solid rgba(128,128,128,.25); padding: 14px 0; }
    .yp-setting:first-child { border-top: 0; }
    .yp-setting-head { display: flex; gap: 16px; align-items: center; justify-content: space-between; }
    .yp-setting-info { flex: 1; min-width: 0; }
    .yp-setting-label { font-weight: 600; }
    .yp-setting-desc { opacity: .7; font-size: 12px; line-height: 1.45; margin-top: 3px; }
    .yp-setting-input { width: min(280px, 48%); max-width: 100%; box-sizing: border-box; }
    .yp-setting-input.yp-setting-multiline { width: 100%; min-height: 76px; resize: vertical; margin-top: 10px; }
    .yp-setting-custom { width: 100%; margin-top: 8px; }
    .yp-settings-footer { position: sticky; bottom: 0; z-index: 2; display: flex; justify-content: flex-end; align-items: center;
      gap: 12px; padding: 12px 0 4px; margin-top: 16px; border-top: 1px solid rgba(128,128,128,.25);
      background: var(--bg-elev, var(--background, #232428)); }
    .yp-settings-footer .yp-msg { flex: 1; margin: 0; }
    .yp-sw { position: relative; width: 38px; height: 22px; flex: none; }
    .yp-sw input { opacity: 0; position: absolute; inset: 0; margin: 0; cursor: pointer; z-index: 1; }
    .yp-sw span { position: absolute; inset: 0; background: rgba(128,128,128,.5); border-radius: 11px; transition: .15s; }
    .yp-sw span::after { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px;
                         background: #fff; border-radius: 50%; transition: .15s; }
    .yp-sw input:checked + span { background: #5865f2; }
    .yp-sw input:checked + span::after { transform: translateX(16px); }

    .yp-official-section { display: flex; align-items: center; gap: 12px; padding: 12px 0;
      border-bottom: 1px solid rgba(128,128,128,.25); margin-bottom: 8px; }
    .yp-official-info { flex: 1; min-width: 0; }
    .yp-official-label { font-weight: 600; font-size: 13px; }
    .yp-official-value { font-family: monospace; font-size: 12px; opacity: .85; margin-top: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .yp-official-value.yp-unset { opacity: .5; font-style: italic; font-family: inherit; }
    .yp-official-desc { opacity: .6; font-size: 11px; margin-top: 4px; line-height: 1.4; }
    .yp-official-btns { display: flex; flex-direction: column; gap: 6px; flex: none; }

    .yp-addplugin {
      display: inline-flex; align-items: center;
      padding: 2px 8px; margin-left: 8px;
      font-size: 11px; font-weight: 600; line-height: 1.4;
      background: rgba(88,101,242,.15);
      color: #7b86ff;
      border: 1px solid rgba(88,101,242,.4);
      border-radius: 4px;
      cursor: pointer; vertical-align: middle;
      opacity: 0; transition: opacity .12s, background .12s;
    }
    .msg:hover .yp-addplugin,
    .yp-addplugin:focus-visible { opacity: 1; }
    .yp-addplugin:hover { background: rgba(88,101,242,.3); }
    .yp-addplugin:disabled { opacity: .7; cursor: progress; }

    /* ==== safety dialogs ==== */
    .yp-confirm-ov { position: fixed; inset: 0; z-index: 2147483010; background: rgba(0,0,0,.72);
                     display: flex; align-items: center; justify-content: center; padding: 20px;
                     animation: yp-fadein .15s ease-out; }
    @keyframes yp-fadein { from { opacity: 0; } to { opacity: 1; } }
    .yp-confirm { width: min(560px, 100%); max-height: 90vh; overflow: auto;
                  background: #2b1a1c; border: 2px solid #b8353f; border-radius: 12px;
                  padding: 24px 26px; color: #fff;
                  box-shadow: 0 12px 60px rgba(0,0,0,.65), 0 0 40px rgba(184,53,63,.25);
                  font: 14px/1.5 system-ui, sans-serif; }
    .yp-confirm-head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
    .yp-confirm-warn { font-size: 34px; line-height: 1; flex: none; }
    .yp-confirm-head h3 { margin: 0; font-size: 19px; color: #ff7a86; letter-spacing: .01em; }
    .yp-confirm-sub { font-size: 12px; color: #ff7a86; opacity: .8; margin: 0 0 16px 46px; }
    .yp-confirm-body p { margin: 0 0 12px; color: #eee; }
    .yp-confirm-name { background: rgba(0,0,0,.35); padding: 8px 12px; border-radius: 6px;
                       font-family: ui-monospace, monospace; font-size: 13px;
                       margin-bottom: 16px; word-break: break-word; color: #ffdfe2; }
    .yp-confirm-warning { background: rgba(184,53,63,.15); border-left: 4px solid #b8353f;
                          padding: 14px 16px; border-radius: 6px; margin-bottom: 14px;
                          font-size: 13.5px; line-height: 1.6; }
    .yp-confirm-warning strong { color: #ff7a86; display: block; margin-bottom: 6px; }
    .yp-confirm-warning ul { margin: 8px 0 0; padding-left: 20px; }
    .yp-confirm-warning li { margin-bottom: 3px; }
    .yp-confirm-hint { font-size: 12px; opacity: .65; font-style: italic; margin: 0; }
    .yp-confirm-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
    .yp-confirm-actions button { padding: 10px 20px; border-radius: 6px;
                                 font-size: 13px; font-weight: 600; cursor: pointer;
                                 border: 1px solid transparent; font-family: inherit; }
    .yp-confirm-cancel { background: transparent; color: #ccc;
                         border-color: rgba(255,255,255,.22); }
    .yp-confirm-cancel:hover { background: rgba(255,255,255,.08); color: #fff; }
    .yp-confirm-ok { background: #b8353f; color: white; border-color: #b8353f;
                     transition: background .12s, opacity .12s; }
    .yp-confirm-ok:hover:not(:disabled) { background: #d44550; }
    .yp-confirm-ok:disabled { background: rgba(184,53,63,.35); color: rgba(255,255,255,.5);
                              cursor: not-allowed; }
  `;
    (document.head || document.documentElement).append(style);

    let current = null;
    let prevActive = null;
    const tabBtns = {};

    function renderManage(panel) {
        const configured = getOfficialChannel();
        const detected = getContext().channel || "";
        const isDefault = normaliseChannelName(configured) === normaliseChannelName(DEFAULT_OFFICIAL_CHANNEL);
        panel.innerHTML = `
      <h2>Yapster Plugins</h2>
      <div class="yp-official-section">
        <div class="yp-official-info">
          <div class="yp-official-label">Official plugin channel</div>
          <div class="yp-official-value ${configured ? "" : "yp-unset"}">#${esc(configured || "not set")}</div>
          <div class="yp-official-desc">In this channel, any message containing a pastebin link gets a "+ Plugin" button that installs the paste as a plugin. Installs from this channel skip the safety warning.</div>
        </div>
        <div class="yp-official-btns">
          ${
              detected && normaliseChannelName(detected) !== normaliseChannelName(configured)
                  ? `<button class="btn small yp-use-current">Use "${esc(detected)}"</button>`
                  : ""
          }
          <button class="btn small yp-set-official">Set manually…</button>
          ${!isDefault ? `<button class="btn small yp-clear-official">Reset to default</button>` : ""}
        </div>
      </div>
      <div class="yp-list"></div>`;

        panel.querySelector(".yp-use-current")?.addEventListener("click", async () => {
            try {
                await confirmOfficialChannelChange(
                    detected,
                    `You're about to trust the channel you're currently viewing.`,
                );
            } catch {
                return;
            }
            setOfficialChannel(detected);
            renderManage(panel);
        });

        panel.querySelector(".yp-set-official").addEventListener("click", async () => {
            const value = window.prompt(
                "Exact name of the official plugin channel (without #):",
                configured || detected || DEFAULT_OFFICIAL_CHANNEL,
            );
            if (value === null) return;
            const trimmed = String(value).trim();
            if (!trimmed) return;
            try {
                await confirmOfficialChannelChange(trimmed, "You're about to trust a channel by name.");
            } catch {
                return;
            }
            setOfficialChannel(trimmed);
            renderManage(panel);
        });

        panel.querySelector(".yp-clear-official")?.addEventListener("click", async () => {
            try {
                await confirmOfficialChannelChange(DEFAULT_OFFICIAL_CHANNEL, `Resetting to the built-in default.`);
            } catch {
                return;
            }
            setOfficialChannel(DEFAULT_OFFICIAL_CHANNEL);
            renderManage(panel);
        });

        const list = panel.querySelector(".yp-list");
        const plugins = loadPlugins();
        if (!plugins.length) {
            list.innerHTML = `<div class="yp-empty">No plugins installed yet. Install from a message in #${esc(configured)} or use "Install plugin" in the sidebar.</div>`;
            return;
        }
        for (const p of plugins) {
            let def = {};
            try {
                def = parse(p.code);
            } catch {}
            const row = document.createElement("div");
            row.className = "yp-row";
            const hasSettings = settingsEntries(def).length > 0;
            row.innerHTML = `
        <label class="yp-sw"><input type="checkbox" ${p.enabled ? "checked" : ""}><span></span></label>
        <div class="yp-info">
          <div class="yp-name">${esc(def.name || p.id)}</div>
          ${def.description ? `<div class="yp-desc">${esc(def.description)}</div>` : ""}
          ${errors.has(p.id) ? `<div class="yp-err">Error: ${esc(errors.get(p.id))}</div>` : ""}
        </div>
        ${hasSettings ? `<button class="btn small yp-configure">Settings</button>` : ""}
        <button class="btn small yp-uninstall">Uninstall</button>`;
            row.querySelector("input").onchange = e => {
                const all = loadPlugins();
                const t = all.find(x => x.id === p.id);
                if (!t) return;
                t.enabled = e.target.checked;
                savePlugins(all);
                e.target.checked ? startPlugin(t) : stopPlugin(p.id);
                renderManage(panel);
            };
            row.querySelector(".yp-configure")?.addEventListener("click", () => renderPluginSettings(panel, p, def));
            row.querySelector(".yp-uninstall").onclick = () => {
                stopPlugin(p.id);
                savePlugins(loadPlugins().filter(x => x.id !== p.id));
                renderManage(panel);
            };
            list.append(row);
        }
    }

    function renderPluginSettings(panel, plugin, def, feedback = "") {
        const entries = settingsEntries(def);
        const draft = readPluginSettings(plugin.id, def);
        panel.innerHTML = `
      <div class="yp-settings-top"><button class="btn small yp-back">← Back</button><h2>${esc(def.name || plugin.id)} settings</h2></div>
      <div class="yp-settings-intro">Changes are staged until you click Save settings. Saving restarts an enabled plugin with the new values.</div>
      <div class="yp-setting-list"></div>
      <div class="yp-settings-footer"><div class="yp-msg ${feedback ? "yp-ok" : ""}">${esc(feedback)}</div><button class="btn yp-save-settings">Save settings</button></div>`;
        panel.querySelector(".yp-back").onclick = () => renderManage(panel);
        const list = panel.querySelector(".yp-setting-list");
        const updateFeedback = (message = "Unsaved changes") => {
            const node = panel.querySelector(".yp-settings-footer .yp-msg");
            if (node) {
                node.textContent = message;
                node.className = "yp-msg";
            }
        };

        for (const entry of entries) {
            const type = String(entry.type || "string").toLowerCase();
            const row = document.createElement("div");
            row.className = "yp-setting";
            const label = entry.label ?? entry.name ?? entry.key;
            if (type === "custom") {
                if (label || entry.description) {
                    const head = document.createElement("div");
                    head.className = "yp-setting-info";
                    if (label) {
                        const title = document.createElement("div");
                        title.className = "yp-setting-label";
                        title.textContent = label;
                        head.append(title);
                    }
                    if (entry.description) {
                        const desc = document.createElement("div");
                        desc.className = "yp-setting-desc";
                        desc.textContent = entry.description;
                        head.append(desc);
                    }
                    row.append(head);
                }
                const custom = document.createElement("div");
                custom.className = "yp-setting-custom";
                row.append(custom);
                list.append(row);
                const customContext = {
                    settings: draft,
                    values: draft,
                    api: {
                        page: window,
                        context: getContext,
                        supabase: sbApi,
                        log: (...args) => console.log("[yapster-plugin-settings]", ...args),
                    },
                    getValue: (key, fallback) =>
                        Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : fallback,
                    setValue: (key, value) => {
                        draft[key] = value;
                        updateFeedback();
                    },
                    onChange: updateFeedback,
                };
                try {
                    const customRenderer = entry.render || entry.component;
                    const rendered = customRenderer?.(custom, customContext);
                    if (rendered instanceof Node) {
                        if (rendered !== custom && rendered.parentNode !== custom) custom.append(rendered);
                    } else if (typeof rendered === "string") custom.innerHTML = rendered;
                    if (!customRenderer && typeof entry.html === "string") custom.innerHTML = entry.html;
                } catch (error) {
                    const err = document.createElement("div");
                    err.className = "yp-err";
                    err.textContent = `Custom setting failed: ${error?.message || String(error)}`;
                    custom.append(err);
                }
                continue;
            }

            const head = document.createElement("div");
            head.className = "yp-setting-head";
            const info = document.createElement("div");
            info.className = "yp-setting-info";
            const title = document.createElement("div");
            title.className = "yp-setting-label";
            title.textContent = label;
            info.append(title);
            if (entry.description) {
                const desc = document.createElement("div");
                desc.className = "yp-setting-desc";
                desc.textContent = entry.description;
                info.append(desc);
            }
            head.append(info);

            let input;
            if (type === "toggle" || type === "boolean") {
                const wrap = document.createElement("label");
                wrap.className = "yp-sw";
                input = document.createElement("input");
                input.type = "checkbox";
                input.checked = !!draft[entry.key];
                const track = document.createElement("span");
                wrap.append(input, track);
                head.append(wrap);
                input.addEventListener("change", () => {
                    draft[entry.key] = input.checked;
                    updateFeedback();
                });
            } else {
                input = document.createElement(entry.multiline ? "textarea" : "input");
                input.className = `input yp-setting-input${entry.multiline ? " yp-setting-multiline" : ""}`;
                if (type === "number") {
                    input.type = "number";
                    if (entry.min != null) input.min = String(entry.min);
                    if (entry.max != null) input.max = String(entry.max);
                    if (entry.step != null) input.step = String(entry.step);
                    else input.step = "any";
                    input.value = Number.isFinite(Number(draft[entry.key])) ? String(draft[entry.key]) : "0";
                } else {
                    if (!entry.multiline) input.type = "text";
                    input.value = draft[entry.key] == null ? "" : String(draft[entry.key]);
                    if (entry.placeholder) input.placeholder = entry.placeholder;
                    if (entry.maxLength != null) input.maxLength = Number(entry.maxLength);
                }
                if (!entry.multiline) head.append(input);
                else row.append(head, input);
                input.addEventListener("input", () => {
                    draft[entry.key] =
                        type === "number" ? (input.value === "" ? null : Number(input.value)) : input.value;
                    updateFeedback();
                });
            }
            if (!(type === "string" && entry.multiline)) row.append(head);
            list.append(row);
        }

        panel.querySelector(".yp-save-settings").onclick = () => {
            try {
                const invalidNumber = panel.querySelector('input[type="number"]:invalid');
                if (invalidNumber) {
                    invalidNumber.reportValidity();
                    return;
                }
                writePluginSettings(plugin.id, draft);
                if (plugin.enabled) {
                    stopPlugin(plugin.id);
                    startPlugin(plugin);
                }
                const message = errors.has(plugin.id)
                    ? `Settings saved, but plugin start failed: ${errors.get(plugin.id)}`
                    : plugin.enabled
                      ? "Settings saved and plugin restarted."
                      : "Settings saved. Plugin is disabled.";
                renderPluginSettings(panel, plugin, parse(plugin.code), message);
            } catch (error) {
                updateFeedback(`Could not save settings: ${error?.message || String(error)}`);
            }
        };
    }

    function renderInstall(panel) {
        panel.innerHTML = `
      <h2>Install Yapster plugin</h2>
      <div class="field">
        <label>Plugin code</label>
        <textarea class="input yp-code" spellcheck="false"
          placeholder="definePlugin({ name: 'My Plugin', start(api) {} })"></textarea>
        <span class="hint">Plugins run with full access to the page, including your session. Only install code you have read.</span>
      </div>
      <button class="btn small yp-install">Install</button>
      <div class="yp-msg"></div>`;
        const ta = panel.querySelector("textarea");
        const msg = panel.querySelector(".yp-msg");
        const setMsg = (t, ok) => {
            msg.textContent = t;
            msg.className = "yp-msg " + (ok ? "yp-ok" : "yp-err");
        };

        panel.querySelector(".yp-install").onclick = async () => {
            const code = ta.value;
            if (!code.trim()) return setMsg("Paste some code first.", false);
            let def;
            try {
                def = parse(code);
            } catch (e) {
                return setMsg("Parse error: " + e.message, false);
            }

            // Manual installs always warn, regardless of current channel — the user
            // is pasting arbitrary code, not clicking a trusted channel's button.
            try {
                await confirmInstall(def.name, "manual paste");
            } catch {
                return;
            }

            const all = loadPlugins();
            const existing = all.find(p => {
                try {
                    return parse(p.code).name === def.name;
                } catch {
                    return false;
                }
            });
            let plugin;
            if (existing) {
                stopPlugin(existing.id);
                existing.code = code;
                existing.enabled = true;
                plugin = existing;
            } else {
                plugin = { id: "p" + Date.now().toString(36), code, enabled: true };
                all.push(plugin);
            }
            savePlugins(all);
            startPlugin(plugin);
            if (errors.has(plugin.id)) return setMsg(`Installed, but start() failed: ${errors.get(plugin.id)}`, false);
            ta.value = "";
            setMsg(`${existing ? "Updated" : "Installed"} "${def.name}".`, true);
        };
    }

    function openPanel(kind) {
        const nav = document.querySelector(".settings-nav");
        const main = document.querySelector(".settings-main");
        if (!nav || !main) return;

        if (!current) {
            prevActive = nav.querySelector("button.active:not([data-yp])");
            prevActive?.classList.remove("active");
        }
        current = kind;
        Object.entries(tabBtns).forEach(([k, b]) => b.classList.toggle("active", k === kind));

        main.querySelector(".yp-panel")?.remove();
        const panel = document.createElement("div");
        panel.className = "yp-panel profile-editor";
        main.dataset.ypActive = "1";
        main.append(panel);
        (kind === "manage" ? renderManage : renderInstall)(panel);
    }

    function closePanel() {
        if (!current) return;
        const main = document.querySelector(".settings-main");
        main?.querySelector(".yp-panel")?.remove();
        if (main) delete main.dataset.ypActive;
        Object.values(tabBtns).forEach(b => b.classList.remove("active"));
        prevActive?.classList.add("active");
        prevActive = null;
        current = null;
    }

    function injectTabs() {
        const nav = document.querySelector(".settings-nav");
        if (!nav) {
            current = null;
            prevActive = null;
            return;
        }
        if (nav.querySelector("[data-yp]")) return;

        const label = document.createElement("div");
        label.className = "settings-nav-label";
        label.style.marginTop = "14px";
        label.textContent = "Yapster";
        label.dataset.yp = "label";

        const mk = (kind, text) => {
            const b = document.createElement("button");
            b.textContent = text;
            b.dataset.yp = kind;
            b.onclick = () => openPanel(kind);
            tabBtns[kind] = b;
            return b;
        };
        nav.append(label, mk("manage", "Manage plugins"), mk("install", "Install plugin"));

        nav.addEventListener(
            "click",
            e => {
                const b = e.target.closest("button");
                if (b && !b.dataset.yp) closePanel();
            },
            true,
        );
    }

    /* ================= boot ================= */
    let queued = false;
    const onMutation = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            injectTabs();
            checkNav();
        });
    };

    function boot() {
        installUserModalTracking();
        installPluginMessageButtons();
        loadPlugins()
            .filter(p => p.enabled)
            .forEach(startPlugin);
        injectTabs();
        checkNav();
        new MutationObserver(onMutation).observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class"],
        });
    }

    if (document.querySelector(".app")) boot();
    else {
        const mo = new MutationObserver(() => {
            if (document.querySelector(".app")) {
                mo.disconnect();
                boot();
            }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }
})();
