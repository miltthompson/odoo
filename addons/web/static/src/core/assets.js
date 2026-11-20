import { whenReady } from "@odoo/owl";
import { session } from "@web/session";

/**
 * @typedef {{ targetDoc?: Document }} LoadAssetOptions
 *
 * @typedef {HTMLLinkElement | HTMLScriptElement} LoadTarget
 *
 * @typedef {{
 *  cssLibs: string[];
 *  jsLibs: string[];
 * }} BundleFileNames
 */

function computeAssetCaches() {
    const cacheMap = getDocumentAssetCache(document);
    for (const script of document.head.querySelectorAll("script[src]")) {
        cacheMap.set(script.getAttribute("src"), Promise.resolve(script));
    }
    for (const link of document.head.querySelectorAll("link[rel=stylesheet][href]")) {
        cacheMap.set(link.getAttribute("href"), Promise.resolve(link));
    }
}

/**
 * @param {Document} targetDoc
 */
function getDocumentAssetCache(targetDoc) {
    if (!assets.documentCaches.has(targetDoc)) {
        assets.documentCaches.set(targetDoc, new Map());
    }
    return assets.documentCaches.get(targetDoc);
}

/**
 * @param {LoadTarget} el
 * @param {(target: LoadTarget) => void} onLoad
 * @param {(error: Error) => any} onError
 */
function onLoadAndError(el, onLoad, onError) {
    function onLoadListener() {
        removeListeners();
        onLoad(el);
    }

    /**
     * @param {Error} error
     */
    function onErrorListener(error) {
        removeListeners();
        onError(error);
    }

    function removeListeners() {
        el.removeEventListener("load", onLoadListener);
        el.removeEventListener("error", onErrorListener);
    }

    el.addEventListener("load", onLoadListener);
    el.addEventListener("error", onErrorListener);

    const view = el.ownerDocument.defaultView || window;
    view.addEventListener("pagehide", removeListeners);
}

whenReady(computeAssetCaches);

function canCacheBundlesOffline() {
    return (
        session.db &&
        window.navigator.serviceWorker &&
        /^(?:\/odoo(?:\/|$)|\/scoped_app\/)/.test(location.pathname)
    );
}

function getOfflineBundleCache() {
    const { serviceWorker } = window.navigator;
    if (canCacheBundlesOffline() && !serviceWorker.controller) {
        // Fetches that started before registration were not seen by the worker.
        return (data) => {
            serviceWorker.ready
                .then(({ active }) => active?.postMessage({ type: "cache_bundle", ...data }))
                .catch(() => {});
        };
    }
}

/** @type {typeof assets["getBundle"]} */
export function getBundle() {
    return assets.getBundle(...arguments);
}

/** @type {typeof assets["loadBundle"]} */
export function loadBundle() {
    return assets.loadBundle(...arguments);
}

/** @type {typeof assets["loadJS"]} */
export function loadJS() {
    return assets.loadJS(...arguments);
}

/** @type {typeof assets["loadCSS"]} */
export function loadCSS() {
    return assets.loadCSS(...arguments);
}

export class AssetsLoadingError extends Error {}

/**
 * This export is done only in order to modify the behavior of the exported
 * functions. This is done in order to be able to make a test environment.
 * Modules should only use the methods exported below.
 */
export const assets = {
    /** @type {WeakMap<Document, Map<string, Promise<LoadTarget>>>} */
    documentCaches: new WeakMap(),
    /** @type {Map<string, Promise<LoadTarget>>} */
    globalCache: new Map(),

    retries: {
        count: 3,
        delay: 5000,
        extraDelay: 2500,
    },

    /**
     * Get the files information as descriptor object from a public asset template.
     *
     * @param {string} bundleName Name of the bundle containing the list of files
     * @param {{ css?: boolean; js?: boolean }} [options]
     * @returns {Promise<BundleFileNames>}
     */
    getBundle(bundleName, { css = true, js = true } = {}) {
        if (!css && !js) {
            return Promise.resolve({ cssLibs: [], jsLibs: [] });
        }
        const assetType = css === js ? "" : css ? "css" : "js";
        const cacheKey = assetType ? `${bundleName}:${assetType}` : bundleName;
        if (assets.globalCache.has(cacheKey)) {
            return assets.globalCache.get(cacheKey);
        }
        const url = new URL(`/web/bundle/${bundleName}`, location.origin);
        for (const [key, value] of Object.entries(session.bundle_params || {})) {
            url.searchParams.set(key, value);
        }
        if (session.db && session.registry_hash) {
            // Keep offline bundle descriptors tied to the database and registry that loaded them.
            url.searchParams.set("registry_hash", session.registry_hash);
            if (assetType && canCacheBundlesOffline()) {
                url.searchParams.set("offline_asset_type", assetType);
            }
        }
        const cacheOfflineBundle = getOfflineBundleCache();
        const promise = fetch(url)
            .then(async (response) => {
                const cssLibs = [];
                const jsLibs = [];
                if (!response.bodyUsed) {
                    const result = await response.json();
                    if (response.ok && !response.redirected) {
                        cacheOfflineBundle?.({ url: url.href, descriptor: result });
                    }
                    for (const { src, type } of Object.values(result)) {
                        if (css && type === "link" && src) {
                            cssLibs.push(src);
                        } else if (js && type === "script" && src) {
                            jsLibs.push(src);
                        }
                    }
                }
                return { cssLibs, jsLibs };
            })
            .catch((reason) => {
                assets.globalCache.delete(cacheKey);
                throw new AssetsLoadingError(`The loading of ${url} failed`, { cause: reason });
            });
        assets.globalCache.set(cacheKey, promise);
        return promise;
    },

    /**
     * Loads the given js/css libraries and asset bundles. Note that no library or
     * asset will be loaded if it was already done before.
     *
     * @param {string} bundleName
     * @param {LoadAssetOptions & {
     *  css?: boolean;
     *  js?: boolean;
     * }} [options]
     * @returns {Promise<LoadTarget>}
     */
    loadBundle(bundleName, options) {
        if (typeof bundleName !== "string") {
            throw new Error(
                `loadBundle(bundleName:string) accepts only bundleName argument as a string ! Not ${JSON.stringify(
                    bundleName
                )} as ${typeof bundleName}`
            );
        }
        const cacheOfflineBundle = getOfflineBundleCache();
        return getBundle(bundleName, options).then(({ cssLibs, jsLibs }) => {
            const promises = [];
            if (options?.css ?? true) {
                for (const url of cssLibs) {
                    promises.push(assets.loadCSS(url, options));
                }
            }
            if (options?.js ?? true) {
                for (const url of jsLibs) {
                    promises.push(assets.loadJS(url, options));
                }
            }
            return Promise.all(promises).then((elements) => {
                cacheOfflineBundle?.({
                    bundles: elements.map((element) => element?.src || element?.href),
                });
                return elements;
            });
        });
    },

    /**
     * Loads the given url as a stylesheet.
     *
     * @param {string} url the url of the stylesheet
     * @param {LoadAssetOptions & {
     *  retryCount?: number;
     *  type?: string;
     * }} [options]
     * @returns {Promise<LoadTarget>} resolved when the stylesheet has been loaded
     */
    loadCSS(url, options) {
        const targetDoc = options?.targetDoc || document;
        const cacheMap = getDocumentAssetCache(targetDoc);
        if (cacheMap.has(url)) {
            return cacheMap.get(url);
        }
        const retryCount = options?.retryCount || 0;
        const linkEl = targetDoc.createElement("link");
        linkEl.setAttribute("href", url);
        linkEl.type = options?.type || "text/css";
        linkEl.rel = "stylesheet";
        const promise = new Promise((resolve, reject) =>
            onLoadAndError(linkEl, resolve, async (error) => {
                cacheMap.delete(url);
                if (retryCount < assets.retries.count) {
                    const delay = assets.retries.delay + assets.retries.extraDelay * retryCount;
                    await new Promise((res) => setTimeout(res, delay));
                    linkEl.remove();
                    assets
                        .loadCSS(url, { ...options, retryCount: retryCount + 1 })
                        .then(resolve)
                        .catch((reason) => {
                            cacheMap.delete(url);
                            reject(reason);
                        });
                } else {
                    reject(
                        new AssetsLoadingError(`The loading of ${url} failed`, { cause: error })
                    );
                }
            })
        );
        cacheMap.set(url, promise);
        targetDoc.head.appendChild(linkEl);
        return promise;
    },

    /**
     * Loads the given url inside a script tag.
     *
     * @param {string} url the url of the script
     * @param {LoadAssetOptions & {
     *  type?: string;
     * }} [options]
     * @returns {Promise<LoadTarget>} resolved when the script has been loaded
     */
    loadJS(url, options) {
        const targetDoc = options?.targetDoc || document;
        const cacheMap = getDocumentAssetCache(targetDoc);
        if (cacheMap.has(url)) {
            return cacheMap.get(url);
        }
        const scriptEl = targetDoc.createElement("script");
        scriptEl.setAttribute("src", url);
        scriptEl.type = options?.type || "text/javascript";
        const promise = new Promise((resolve, reject) =>
            onLoadAndError(scriptEl, resolve, (error) => {
                cacheMap.delete(url);
                reject(new AssetsLoadingError(`The loading of ${url} failed`, { cause: error }));
            })
        );
        cacheMap.set(url, promise);
        targetDoc.head.appendChild(scriptEl);
        return promise;
    },
};
