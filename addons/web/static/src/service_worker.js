// @odoo-module ignore

/* eslint-disable no-restricted-globals */
const pageCacheName = "odoo-sw-cache";
const bundleCacheName = "odoo-sw-bundles";
const bundleDescriptorCacheName = "odoo-sw-bundle-descriptors";
const scopePath = new URL(self.registration.scope).pathname;
const offlineURL = "/odoo/offline";
const sessionPattern = /(odoo\.__session_info__\s*=\s*)({[^\r\n]*})(;)/;
const csrfPattern = /(\bcsrf_token:\s*)"([^"\r\n]*)"/;
const sessionPlaceholder = "@@@session_info_secret@@@";
const csrfPlaceholder = "@@@csrf_token_secret@@@";

// The cache contains only the shell. Bootstrap values live in this worker's RAM.
let savedPageSession;
let pageGeneration = 0;

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(pageCacheName).then((cache) => cache.add(offlineURL)));
});

self.addEventListener("activate", (event) => {
    if (scopePath === "/scoped_app") {
        // Control the install page and first app visit without waiting for a reload.
        event.waitUntil(self.clients.claim());
    }
});

const isWebclientURL = (url) =>
    url.origin === self.location.origin &&
    url.pathname !== offlineURL &&
    ((scopePath === "/odoo" && url.pathname === scopePath) ||
        url.pathname.startsWith(`${scopePath}/`));

const usesDebugAssets = (url) => url.searchParams.get("debug")?.includes("assets");

const pageResponse = (html, response) => {
    const headers = new Headers(response.headers);
    headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    return new Response(html, { headers });
};

const savePage = async (response, generation) => {
    if (!response.ok || response.redirected) {
        return;
    }
    const html = await response.text();
    const sessionInfo = html.match(sessionPattern)?.[2];
    const csrfToken = html.match(csrfPattern)?.[2];
    if (!sessionInfo || csrfToken === undefined) {
        return;
    }
    const shell = html
        .replace(sessionPattern, `$1${sessionPlaceholder}$3`)
        .replace(csrfPattern, `$1"${csrfPlaceholder}"`);
    const cache = await caches.open(pageCacheName);
    if (generation === pageGeneration) {
        await cache.put(scopePath, pageResponse(shell, response));
        if (generation === pageGeneration) {
            savedPageSession = { sessionInfo, csrfToken };
        }
    }
};

const clearSavedPage = async () => {
    pageGeneration++;
    savedPageSession = undefined;
    const cache = await caches.open(pageCacheName);
    await cache.delete(scopePath);
};

const readSavedPage = async (cache) => {
    const generation = pageGeneration;
    const response = await cache.match(scopePath);
    const html = await response?.text();
    if (!html || !savedPageSession || generation !== pageGeneration) {
        return;
    }
    const { sessionInfo, csrfToken } = savedPageSession;
    return pageResponse(
        html.replace(/@@@(?:session_info|csrf_token)_secret@@@/g, (placeholder) =>
            placeholder === sessionPlaceholder ? sessionInfo : csrfToken
        ),
        response
    );
};

const navigateOrDisplayOfflinePage = async (event, url) => {
    const { request } = event;
    const generation = pageGeneration;
    const canSave = isWebclientURL(url) && !usesDebugAssets(url);
    let response;
    try {
        response = await fetch(request);
    } catch (requestError) {
        const cache = await caches.open(pageCacheName);
        const savedPage = canSave && (await readSavedPage(cache));
        const offlinePage = savedPage || (await cache.match(offlineURL));
        if (offlinePage) {
            return offlinePage;
        }
        throw requestError;
    }
    if (isWebclientURL(url) && generation === pageGeneration) {
        if (invalidatesSavedPage(response)) {
            event.waitUntil(clearSavedPage().catch(() => {}));
        } else if (canSave && response.ok && !response.redirected) {
            event.waitUntil(savePage(response.clone(), generation).catch(() => {}));
        }
    }
    return response;
};

const invalidatesSavedPage = (response) =>
    // The browser follows a manual navigation redirect itself. Its target is
    // hidden from the worker, so we cannot rule out a redirect to login.
    response.type === "opaqueredirect" ||
    (response.redirected && new URL(response.url).pathname === "/web/login");

const isBundleFile = (url) =>
    url.origin === self.location.origin &&
    /^\/web\/assets\/(?:[^/]+\/)*[a-f0-9]{7}\/[^/]+\.min\.(?:js|css)$/.test(url.pathname);

const isBundleDescriptor = (url) =>
    url.origin === self.location.origin &&
    /^\/web\/bundle\/[^/]+$/.test(url.pathname) &&
    url.searchParams.has("registry_hash") &&
    !usesDebugAssets(url);

const hasBundleFiles = async (cache, descriptor) => {
    const files = descriptor
        .filter(({ src }) => src)
        .map(({ src }) => new URL(src, self.location.origin))
        .filter(isBundleFile);
    return (await Promise.all(files.map((file) => cache.match(file.href)))).every(Boolean);
};

const saveBundleDescriptor = async (cache, request, response) => {
    const descriptor = await response.json();
    if (!Array.isArray(descriptor)) {
        return;
    }
    const latestCache = await caches.open(bundleDescriptorCacheName);
    const previous = await latestCache.match(request);
    if (previous) {
        const previousDescriptor = await previous.json();
        if (JSON.stringify(previousDescriptor) === JSON.stringify(descriptor)) {
            return;
        }
        // Keep the last complete bundle before recording a replacement. Check at
        // descriptor reads/writes, not at every asset load or in worker memory.
        if (await hasBundleFiles(cache, previousDescriptor)) {
            await cache.put(request, Response.json(previousDescriptor));
        }
    }
    await latestCache.put(request, Response.json(descriptor));
};

const saveBundle = async (request, response, descriptor) => {
    const contentType = response.headers.get("Content-Type") || "";
    const expectedType = descriptor ? /application\/json/ : /javascript|text\/css/;
    if (response.status !== 200 || response.redirected || !expectedType.test(contentType)) {
        return;
    }
    const cache = await caches.open(bundleCacheName);
    if (descriptor) {
        await saveBundleDescriptor(cache, request, response);
    } else if (!(await cache.match(request))) {
        await cache.put(request, response);
    } else {
        await response.body?.cancel();
    }
};

const readCachedBundle = async (request, descriptor) => {
    const cache = await caches.open(bundleCacheName);
    const cached = await cache.match(request);
    if (!descriptor) {
        return cached;
    }
    const latestCache = await caches.open(bundleDescriptorCacheName);
    const latest = await latestCache.match(request);
    // With no complete version, a partial descriptor can still serve a caller
    // that needs only CSS (or only JS). Never mix assets from different versions.
    if (latest && (!cached || (await hasBundleFiles(cache, await latest.clone().json())))) {
        return latest;
    }
    return cached;
};

const fetchBundle = async (event, descriptor) => {
    let response;
    try {
        // Preserve the regular HTTP cache policy before trying Cache Storage.
        response = await fetch(event.request);
    } catch (error) {
        const cached = await readCachedBundle(event.request, descriptor);
        if (cached) {
            return cached;
        }
        throw error;
    }
    event.waitUntil(saveBundle(event.request, response.clone(), descriptor).catch(() => {}));
    return response;
};

const primeBundleFiles = async (bundles) => {
    if (!Array.isArray(bundles)) {
        return;
    }
    async function copyBundle(bundle) {
        if (typeof bundle !== "string") {
            return;
        }
        const bundleURL = new URL(bundle, self.location.origin);
        if (isBundleFile(bundleURL)) {
            // The first document has loaded these files outside the worker. Copy them
            // from the HTTP cache rather than downloading them again.
            const response = await fetch(bundleURL, { cache: "only-if-cached", mode: "same-origin" });
            await saveBundle(bundleURL.href, response, false);
        }
    }
    await Promise.allSettled(Array.from(new Set(bundles), copyBundle));
};

const primeWebclient = async ({ url, bundles }) => {
    const pageURL = new URL(url, self.location.origin);
    if (!isWebclientURL(pageURL) || usesDebugAssets(pageURL)) {
        return;
    }
    const generation = pageGeneration;
    await Promise.all([
        fetch(pageURL).then((response) => {
            if (generation === pageGeneration && invalidatesSavedPage(response)) {
                return clearSavedPage();
            }
            return savePage(response, generation);
        }),
        primeBundleFiles(bundles),
    ]);
};

const primeBundle = async ({ source, data: { url, descriptor, bundles } }) => {
    if (source?.type !== "window" || !isWebclientURL(new URL(source.url))) {
        return;
    }
    if (Array.isArray(descriptor) && typeof url === "string") {
        const descriptorURL = new URL(url, self.location.origin);
        if (isBundleDescriptor(descriptorURL)) {
            await saveBundle(descriptorURL.href, Response.json(descriptor), true);
        }
    }
    await primeBundleFiles(bundles);
};

const serveShareTarget = (event) => {
    // Redirect so the user can refresh the page without resending data.
    event.respondWith(Response.redirect("/odoo?share_target=trigger"));
    event.waitUntil(
        (async () => {
            // The page sends this message to tell the service worker it's ready to receive the file.
            await waitingMessage("odoo_share_target");
            const client = await self.clients.get(event.resultingClientId || event.clientId);
            const data = await event.request.formData();
            client.postMessage({
                shared_files: data.getAll("externalMedia") || [],
                action: "odoo_share_target_ack",
            });
        })()
    );
};

self.addEventListener("fetch", (event) => {
    const { request } = event;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        return;
    }
    if (request.method === "POST" && url.searchParams.has("share_target")) {
        return serveShareTarget(event);
    }
    if (request.method !== "GET") {
        return;
    }
    const descriptor = isBundleDescriptor(url);
    if (descriptor || isBundleFile(url)) {
        event.respondWith(fetchBundle(event, descriptor));
    } else if (
        (request.mode === "navigate" && request.destination === "document") ||
        // Some browsers do not set mode to navigate.
        request.headers.get("accept")?.includes("text/html")
    ) {
        if (isWebclientURL(url) || url.pathname === scopePath || url.pathname === offlineURL) {
            event.respondWith(navigateOrDisplayOfflinePage(event, url));
        }
    }
});

/**
 * Resolvers of the pending `waitingMessage` calls, keyed by the id of the
 * client the message is expected from (`false` for any client), then by
 * awaited message.
 *
 * @type {Map<string|false, Map<string, Function[]>>}
 */
const nextMessageMap = new Map();

/**
 * Drop the resolvers waiting for `message` from `clientId`, and the client
 * entry itself once it has no awaited message left.
 *
 * @param {string|false} clientId
 * @param {string} message
 * @param {Function} [resolver] if given, only that resolver is dropped
 */
const forgetMessage = (clientId, message, resolver) => {
    const messageMap = nextMessageMap.get(clientId);
    if (!messageMap) {
        return;
    }
    const resolvers = resolver ? (messageMap.get(message) || []).filter((r) => r !== resolver) : [];
    if (resolvers.length) {
        messageMap.set(message, resolvers);
    } else {
        messageMap.delete(message);
    }
    if (!messageMap.size) {
        nextMessageMap.delete(clientId);
    }
};

/**
 * Wait for a client to post `message` to this service worker.
 *
 * @param {string} message
 * @param {string|false} [clientId] id of the client the message is expected
 *  from, `false` to resolve on the message from any client.
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] stop waiting when aborted: the
 *  returned promise rejects with the abort reason and the resolver is dropped.
 *  Pass one whenever the message may never come (e.g. the client is closed
 *  before answering), otherwise its resolver is kept for the whole lifetime of
 *  the service worker.
 * @return {Promise<void>}
 */
const waitingMessage = async (message, clientId = false, { signal } = {}) => {
    if (typeof message !== "string") {
        throw new Error("message must be a string");
    }
    if (signal?.aborted) {
        throw signal.reason;
    }
    return new Promise((resolve, reject) => {
        function settle() {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }
        function onAbort() {
            forgetMessage(clientId, message, settle);
            reject(signal.reason);
        }
        if (!nextMessageMap.has(clientId)) {
            nextMessageMap.set(clientId, new Map());
        }
        if (!nextMessageMap.get(clientId).has(message)) {
            nextMessageMap.get(clientId).set(message, []);
        }
        nextMessageMap.get(clientId).get(message).push(settle);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
};

self.addEventListener("message", (event) => {
    if (event.data?.type === "cache_webclient") {
        event.waitUntil(primeWebclient(event.data).catch(() => {}));
        return;
    }
    if (event.data?.type === "cache_bundle") {
        event.waitUntil(primeBundle(event).catch(() => {}));
        return;
    }
    if (typeof event.data !== "string") {
        return;
    }
    // `source` is null for a message that does not come from a client.
    const clientId = event.source?.id;
    const messageNotifiers = [
        ...(nextMessageMap.get(false)?.get(event.data) || []),
        ...(nextMessageMap.get(clientId)?.get(event.data) || []),
    ];
    if (messageNotifiers.length) {
        for (const messageNotified of messageNotifiers) {
            messageNotified();
        }
        forgetMessage(false, event.data);
        forgetMessage(clientId, event.data);
    }
    if (event.data === "user_logout") {
        event.waitUntil(clearSavedPage().catch(() => {}));
    }
});
