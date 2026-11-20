import {
    computed,
    markRaw,
    onWillDestroy,
    Plugin,
    signal,
    useListener,
    usePlugin,
} from "@odoo/owl";
import { browser } from "@web/core/browser/browser";
import { Crypto, CRYPTO_ALGO } from "@web/core/crypto";
import { DebugModePlugin } from "@web/core/debug_mode_plugin";
import { NonSecureContextError } from "@web/core/errors/non_secure_context_error";
import { _t } from "@web/core/l10n/translation";
import { normalize } from "@web/core/l10n/utils";
import { ConnectionLostError, rpc, rpcBus } from "@web/core/network/rpc";
import { OfflineQueueStore, offlineDatabaseName, withLegacyQueue } from "./offline_storage";
import { user } from "@web/core/user";
import { registry } from "@web/core/registry";
import { services } from "@web/core/services";
import { IndexedDB } from "@web/core/utils/indexed_db";
import { hashCode } from "@web/core/utils/strings";
import { session } from "@web/session";

const IS_READY = Symbol("ready");

class FakeIndexedDB {
    // used in non secure context to disable the offline features as data can't be encrypted
    invalidate() {}
    read() {
        return Promise.resolve({});
    }
    write() {}
    delete() {}
    getAllKeys() {
        return Promise.resolve([]);
    }
    getAllEntries() {
        return Promise.resolve([]);
    }
}

export class OfflinePlugin extends Plugin {
    static VISITED_UI_TABLE_NAME = "visited-ui-items";
    static VISITED_UI_TABLE_NAME_DEBUG = "visited-ui-items-debug";
    static MANY2X_TABLE_PREFIX = "many2x_";

    static SELECTORS_TO_DISABLE = ["button:not([data-available-offline]):not([disabled])"];

    debugMode = usePlugin(DebugModePlugin);
    _owner = { db: session.db, uid: user.userId };
    _idb = window.isSecureContext && this._owner.uid && this._owner.db
        ? markRaw(new IndexedDB(offlineDatabaseName("offline", this._owner), session.registry_hash + CRYPTO_ALGO))
        : new FakeIndexedDB();
    _crypto =
        window.isSecureContext &&
        this._owner.uid && this._owner.db && session.browser_cache_secret &&
        new Crypto(session.browser_cache_secret);
    _queue = null;
    _pending = signal([]);
    _legacyCount = signal(0);
    syncPaused = signal(false);
    _queueFailure = signal(null);
    _writes = Promise.resolve();
    _visitedUITable = computed(() =>
        this.debugMode.isActive()
            ? OfflinePlugin.VISITED_UI_TABLE_NAME_DEBUG
            : OfflinePlugin.VISITED_UI_TABLE_NAME
    );
    _timeout = null; // used to repeatedly ping the server when offline
    _observer = null; // used to detect DOM mutations and disable the UI when offline

    /** whether the connection to the server is currently lost */
    isOffline = signal(false);

    /** whether scheduled ORM calls are currently being synced */
    syncingORM = signal(false);

    /** orm calls that need to be synced once we go back online */
    _ormToSync = signal.Object({});

    /** items available offline (only populated when offline) */
    _visited = signal.Object({ [IS_READY]: null });

    setup() {
        // Use "offline" and "online" events for instant detection of connection lost/restored.
        useListener(browser, "offline", () => {
            if (!this.isOffline()) {
                this.checkConnection();
            }
        });
        useListener(browser, "online", () => {
            if (this.isOffline()) {
                this.checkConnection();
            }
        });

        // Use RPC:RESPONSE to validate the current offline status, which is more accurate than
        // the "offline"/"online" events (e.g. server is down).
        useListener(rpcBus, "RPC:RESPONSE", (ev) => {
            this.setOffline(ev.detail.error instanceof ConnectionLostError);
        });

        // When the "CLEAR-CACHES" event is triggered, the rpc cache is wiped out, so we must also
        // clear the information about elements that are available offline, as they aren't anymore.
        useListener(rpcBus, "CLEAR-CACHES", () => {
            this._idb.invalidate([
                OfflinePlugin.VISITED_UI_TABLE_NAME,
                OfflinePlugin.VISITED_UI_TABLE_NAME_DEBUG,
                new RegExp(`^${OfflinePlugin.MANY2X_TABLE_PREFIX}`),
            ]);
            this._visited.set({});
        });

        if (this._crypto) {
            this._queue = markRaw(new OfflineQueueStore(this._owner, session.browser_cache_secret));
            this._queueReady = Promise.all([
                this._queue.keyReady,
                this._queue.lock(() => this._refreshQueue()),
            ]).catch(() => this._reportStorageError());
            this._readLegacyCount().catch(() => this._reportStorageError());
            this._syncTimeout = browser.setTimeout(() => this._syncORM(), 3000);
        }

        onWillDestroy(() => {
            browser.clearTimeout(this._syncTimeout);
            this._cleanup();
        });
    }

    /**
     * Sets the offline status.
     *
     * If we're going offline, we must get the information about actions, views, records that
     * are available offline before toggling the status, such that the rest of the UI can
     * synchronously access the information when rendering offline. As reading from indexeddb
     * is async, we read everything once, and store it in an plain object. We also ensure that
     * buttons and inputs in the UI that haven't been tagged as "available-offline" are
     * disabled while being offline. Finally, we repeatedly try to ping the server to detect if
     * connection is back.
     *
     * If we're going online, we re-enable the UI and update the offline status.
     *
     * @param {boolean} offline
     */
    setOffline(offline) {
        if (offline === this.isOffline()) {
            return;
        }
        this.isOffline.set(offline);
        this._visited.set({});
        if (offline) {
            // Disable everything in the UI that isn't marked as available offline.
            this._offlineUI();
            // Create an observer instance linked to the callback function to keep disabling
            // elements that would appear in the DOM while being offline.
            this._observer = new MutationObserver(() => {
                if (this.isOffline()) {
                    this._offlineUI();
                }
            });
            this._observer.observe(document.body, {
                childList: true, // listen for direct children being added/removed
                subtree: true, // also observe descendants (not just direct children)
                attributeFilter: ["data-available-offline"], // listen for specific attribute change
            });

            // Repeatedly check if connection is back.
            let delay = 2000;
            const _checkConnection = async () => {
                if (this.isOffline()) {
                    await this.checkConnection();
                    // exponential backoff, with some jitter
                    delay = delay * 1.5 + 500 * Math.random();
                    this._timeout = browser.setTimeout(_checkConnection, delay);
                }
            };
            this._timeout = browser.setTimeout(_checkConnection, delay);

            // Retrieve the information about visited items from indexeddb.
            this._visited()[IS_READY] = this._populateVisited();
        } else {
            this._syncORM();
            this._cleanup();
        }
    }

    /**
     * Pings the server to check if it is reachable.
     */
    async checkConnection() {
        try {
            await rpc("/web/webclient/version_info", {});
        } catch {
            // just catch the error, the offline status will be updated with RPC:RESPONSE
        }
    }

    // Expose the promise to allow tests to wait for it
    getVisitedStatus() {
        return this._visited()[IS_READY];
    }
    /**
     * Returns search queries that are available offline, their facets and the number of times they
     * have been accessed, given an action id and a view type.
     *
     * @param {number} actionId
     * @param {"kanban"|"list"}
     * @returns Promise<Object[]>
     */
    async getAvailableSearches(actionId, viewType) {
        await this._visited()[IS_READY];
        if (!this._visited()[actionId]?.views[viewType]) {
            return [];
        } else if (this._visited()[actionId]?.views[viewType] === true) {
            // Searches for that action/view type haven't been retrieve from idb yet
            this._visited()[actionId].views[viewType] = this._idb
                .read(this._visitedUITable(), this._generateKey(actionId, viewType))
                .then((value) => this._decryptSearch(value))
                .then((r) =>
                    Object.values(r || {})
                        .reverse() // last visited first
                        .sort(({ count: c1 }, { count: c2 }) => c2 - c1)
                        .map(({ search }) => search)
                );
        }
        const searches = await this._visited()[actionId]?.views[viewType];
        return [...searches];
    }

    /**
     * Returns a boolean indicating whether the requested element is available offline, i.e.
     * if it has been visited online and stored in cache.
     *
     * @param {number} actionId
     * @param {"kanban"|"list"|"form"} [viewType]
     * @param {number} [resId]
     * @returns boolean
     */
    isAvailableOffline(actionId, viewType, resId) {
        const action = this._visited()[actionId];
        if (!viewType) {
            return !!action;
        }
        const view = action?.views[viewType];
        if (viewType !== "form") {
            return !!view;
        }
        return view?.includes(resId);
    }

    /**
     * Mark an action, view type and optionally record as available offline.
     *
     * @param {number} actionId
     * @param {"kanban"|"list"|"form"|"kanban_quick_create"|"list_quick_create"} viewType
     * @param {Object} params
     * @param {number} [params.resId] the record id, when viewType is "form"
     * @param {Object} [params.search] the current search view state
     */
    async setAvailableOffline(actionId, viewType, { resId, search }) {
        if (!this.isOffline()) {
            const key = this._generateKey(actionId, viewType, resId);
            let value;
            if (["form", "kanban_quick_create", "list_quick_create"].includes(viewType)) {
                value = true;
            } else {
                const saved = await this._idb.read(this._visitedUITable(), key);
                value = (saved && await this._decryptSearch(saved)) || {};
                let count = value[search.key]?.count || 0;
                search = value[search.key]?.search || search; // keep original search (no "Custom Filter")
                delete value[search.key]; // delete and re-add to mark it as "last visited"
                value[search.key] = { count: ++count, search };
            }
            if (this._crypto && !this._clearing) {
                const encrypted = await this._crypto.encrypt(value);
                if (!this._clearing) {
                    return this._idb.write(this._visitedUITable(), key, encrypted);
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // ORM Offline
    // -------------------------------------------------------------------------

    scheduleORM(model, method, args, kwargs, options = {}) {
        if (!this._queue) {
            throw new NonSecureContextError(_t("Offline changes are not available in this session."));
        }
        const value = { model, method, args, kwargs, extras: options.extras };
        const legacyKey = options.id ?? hashCode(JSON.stringify(value));
        const entry = this._makeEntry(legacyKey, value, options);
        this._pending.set([...this._pending(), entry]);
        this._ormToSync()[legacyKey] = { key: legacyKey, value };
        this._enqueueWrite(async () => {
            const saved = await this._queue.add(entry);
            this._replaceEntry(saved);
        });
        return legacyKey;
    }

    removeScheduledORM(legacyKey) {
        const entry = this.getPendingEntry(legacyKey);
        if (entry) {
            delete this._ormToSync()[legacyKey];
            return this.discardPendingChange(entry.key);
        }
    }

    get hasScheduledCalls() {
        return !!Object.keys(this._ormToSync()).length || !!this._legacyCount() || !!this.getQueueError();
    }

    /** The durable queue in send order. `key` is the sync UUID, not the compatibility key. */
    getPendingEntries() {
        return this._pending();
    }

    getPendingEntry(legacyKey) {
        return this._pending().findLast((entry) => String(entry.legacyKey) === String(legacyKey));
    }

    getQueueReady() {
        return this._queueReady;
    }

    getLegacyPendingCount() {
        return this._legacyCount();
    }

    getQueueError() {
        return this._queueFailure();
    }

    async clearReadStores() {
        this._clearing = true;
        this._visited.set({});
        await this._idb.invalidate();
    }

    async retryPendingChange(key) {
        await this._enqueueWrite(async () => {
            const entry = await this._queue.get(key);
            const unwritten = this._pending().find((item) => item.key === key && item.seq === null);
            if (!entry && unwritten) {
                this._replaceEntry(await this._queue.add(unwritten));
            } else if (entry?.state === "needs_attention") {
                await this._storeState(entry, "waiting");
            }
        });
        return this._syncORM();
    }

    async discardPendingChange(key) {
        await this._enqueueWrite(async () => {
            const entry = await this._queue.get(key);
            if (entry?.state !== "sending") {
                await this._queue.remove(key);
                this._removeEntry(key);
            }
        });
        return this._syncORM();
    }

    /** Only call after the user has explicitly confirmed ownership (or confirmed discard). */
    async resolveLegacyChanges(send) {
        await this._enqueueWrite(() => withLegacyQueue(async (rows, legacy, table) => {
            const mine = rows.filter(({ claim }) => !claim || claim.owner === this._queue.name);
            const entries = send ? await Promise.all(mine.map(async (row) => ({
                ...row,
                value: await row.crypto.decrypt(row.payload),
            }))) : mine;
            const existing = new Set((await this._queue.list()).map((entry) => entry.key));
            entries.sort((a, b) => (a.value?.extras?.timeStamp || 0) - (b.value?.extras?.timeStamp || 0));
            for (const { key, value, payload, claim } of entries) {
                if (send) {
                    const entry = this._makeEntry(key, value, { key: claim?.key });
                    if (!claim) {
                        await legacy.write(table, key, { payload, claim: { owner: this._queue.name, key: entry.key } });
                    }
                    if (!existing.has(entry.key)) {
                        await this._queue.add(entry);
                    }
                }
                await legacy.delete(table, key);
            }
            await this._refreshQueue();
            this._legacyCount.set(0);
        }));
        return this._syncORM();
    }

    // -------------------------------------------------------------------------
    // Many2X Offline
    // -------------------------------------------------------------------------

    async cacheMany2XSearch(resModel, result) {
        if (!this._crypto) {
            return;
        }
        const tableName = OfflinePlugin.MANY2X_TABLE_PREFIX + resModel;
        const values = await this._encryptAndFormat(result);
        if (!this._clearing) {
            this._idb.write(tableName, values);
        }
    }

    async searchMany2XRecords(resModel, name) {
        if (!this._crypto) {
            return;
        }

        const normalizeSearch = normalize(name);
        const _searchFn = !normalizeSearch
            ? () => true
            : async (value) => {
                  const decryptedValue = normalize(await this._crypto.decrypt(value));
                  return decryptedValue.includes(normalizeSearch);
              };
        const tableName = OfflinePlugin.MANY2X_TABLE_PREFIX + resModel;
        const res = await this._idb.search(tableName, _searchFn);
        return this._decryptAndFormat(res);
    }

    async readMany2XRecords(resModel, resIds) {
        if (!this._crypto) {
            return;
        }
        const tableName = OfflinePlugin.MANY2X_TABLE_PREFIX + resModel;
        const res = await this._idb.read(tableName, resIds);
        return this._decryptAndFormat(res);
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    /**
     * @private
     */
    _cleanup() {
        this._onlineUI();
        this._observer?.disconnect();
        browser.clearTimeout(this._timeout);
    }

    async _decryptSearch(value) {
        if (value && this._crypto) {
            try {
                return await this._crypto.decrypt(value);
            } catch {
                // A previous key cannot decrypt this cache, so ignore the saved copy.
            }
        }
    }

    async _decryptAndFormat(offlineRes) {
        const decrytedRes = [];
        for (const r of offlineRes) {
            const value = r.value ? await this._crypto.decrypt(r.value) : undefined;
            decrytedRes.push({ id: Number(r.key), display_name: value });
        }
        return decrytedRes;
    }

    async _encryptAndFormat(ormResult) {
        const encryptedRes = [];
        for (const r of ormResult) {
            const value = await this._crypto.encrypt(
                typeof r.display_name === "string" ? r.display_name.split("\n")[0] : r.display_name
            );

            encryptedRes.push({ key: r.id, value });
        }
        return encryptedRes;
    }

    /**
     * Generates the key to identify an action, a viewType and optionally a record
     * id, to use as key in the indexeddb table.
     *
     * @private
     * @param {number} actionId
     * @param {"kanban"|"list"|"form"} viewType
     * @param {number} [params.resId] the record id, when viewType is "form"
     * @returns string
     */
    _generateKey(actionId, viewType, resId) {
        return JSON.stringify({ action: actionId, viewType, resId });
    }

    /**
     * Populates the `_visited` structure with the information read from indexeddb.
     *
     * @private
     */
    async _populateVisited() {
        return this._idb.getAllKeys(this._visitedUITable()).then((keys) => {
            if (!this.isOffline()) {
                return; // status changed again meanwhile
            }
            for (const key of keys || []) {
                const { action, viewType, resId } = JSON.parse(key);
                this._visited()[action] = this._visited()[action] || { views: {} };
                if (viewType === "form") {
                    this._visited()[action].views.form = this._visited()[action].views.form || [];
                    this._visited()[action].views.form.push(resId);
                } else {
                    this._visited()[action].views[viewType] = true;
                }
            }
        });
    }

    /**
     * Disables interactive elements (e.g. buttons) that haven't been tagged as "available-offline".
     *
     * @private
     */
    _offlineUI() {
        // Re-enable elements that have been marked as available offline
        document.querySelectorAll(".o_disabled_offline[data-available-offline]").forEach((el) => {
            el.removeAttribute("disabled");
            el.classList.remove("o_disabled_offline");
        });
        document.querySelectorAll(OfflinePlugin.SELECTORS_TO_DISABLE.join(", ")).forEach((el) => {
            el.setAttribute("disabled", "");
            el.classList.add("o_disabled_offline");
        });
    }

    /**
     * Re-enables elements that have previously been disabled by @_offlineUI.
     *
     * @private
     */
    _onlineUI() {
        document.querySelectorAll(".o_disabled_offline").forEach((el) => {
            el.removeAttribute("disabled");
            el.classList.remove("o_disabled_offline");
        });
    }

    // -------------------------------------------------------------------------
    // ORM Offline
    // -------------------------------------------------------------------------

    _makeEntry(legacyKey, value, options) {
        const { model, method, args, kwargs, extras } = value;
        const targetIds = (method !== "create" && Array.isArray(args[0]) &&
            args[0].filter((id) => typeof id === "number" || typeof id === "string")) || [];
        return {
            ...this._owner,
            key: options.key || window.crypto.randomUUID(),
            legacyKey,
            seq: null,
            model, method, args, kwargs, extras,
            refs: options.refs || [],
            target: options.target || { model, ids: targetIds },
            label: options.label || extras?.displayName || "",
            acted_at: extras?.timeStamp ?? Date.now(),
            server_version: session.registry_hash,
            state: extras?.error ? "needs_attention" : "waiting",
            error: extras?.error || null,
        };
    }

    _replaceEntry(entry) {
        this._pending.set(this._pending().map((item) => item.key === entry.key ? entry : item));
    }

    _removeEntry(key) {
        const entry = this._pending().find((item) => item.key === key);
        if (entry) {
            this._pending.set(this._pending().filter((item) => item.key !== key));
            const replacement = this.getPendingEntry(entry.legacyKey);
            if (replacement) {
                this._ormToSync()[entry.legacyKey] = this._compatEntry(replacement);
            } else {
                delete this._ormToSync()[entry.legacyKey];
            }
        }
    }

    _compatEntry(entry) {
        const { model, method, args, kwargs, extras } = entry;
        return { key: entry.legacyKey, value: { model, method, args, kwargs, extras } };
    }

    async _refreshQueue() {
        const stored = (await this._queue.list()).map((entry) => ({ ...entry, legacyKey: String(entry.legacyKey) }));
        const knownKeys = new Set(stored.map((entry) => entry.key));
        const pending = [...stored, ...this._pending().filter((entry) => entry.seq === null && !knownKeys.has(entry.key))];
        this._pending.set(pending);
        this._ormToSync.set(Object.fromEntries(pending.map((entry) => [entry.legacyKey, this._compatEntry(entry)])));
        return stored;
    }

    _reportStorageError() {
        this._queueFailure.set(_t("Pending changes could not be read or saved on this device."));
    }

    _enqueueWrite(callback) {
        const next = this._writes.then(() => this._queue.lock(callback));
        this._writes = next.catch(() => this._reportStorageError());
        return this._writes;
    }

    _readLegacyCount() {
        return withLegacyQueue((rows) => {
            this._legacyCount.set(rows.filter(({ claim }) => !claim || claim.owner === this._queue.name).length);
        });
    }

    async _storeState(entry, state, error = null) {
        const updated = { ...entry, state, error };
        await this._queue.write(updated);
        this._replaceEntry(updated);
    }

    _reason(error) {
        switch (error.exceptionName) {
            case "odoo.exceptions.MissingError":
                return _t("The record or an earlier change is missing.");
            case "odoo.exceptions.AccessError":
                return _t("You no longer have access to this record.");
            case "odoo.exceptions.ValidationError":
            case "odoo.exceptions.UserError":
                return _t("Not applied: %s", error.data.message);
            default:
                return _t("Something went wrong on the server. Try again later.");
        }
    }

    _isBlocked(entry, blockers) {
        return blockers.some((previous) => entry.refs.includes(previous.key) || (
            previous.target.model === entry.target.model &&
            previous.target.ids.some((id) => entry.target.ids.includes(id))
        ));
    }

    async _syncORM() {
        if (!this._queue || this.isOffline() || this.syncPaused() || this.syncingORM()) {
            return;
        }
        this.syncingORM.set(true);
        try {
            await navigator.locks.request(`${this._queue.name}:send`, async () => {
                await this._writes;
                const entries = await this._queue.lock(() => this._refreshQueue());
                const blockers = [];
                for (const snapshot of entries) {
                    if (this.isOffline()) {
                        break;
                    }
                    const entry = await this._queue.lock(async () => {
                        // Another tab may have discarded the item while we were sending an earlier one.
                        const current = await this._queue.get(snapshot.key);
                        if (!current) {
                            this._removeEntry(snapshot.key);
                            return;
                        }
                        if (current.state === "needs_attention") {
                            blockers.push(current);
                            return;
                        }
                        if (this._isBlocked(current, blockers)) {
                            blockers.push(current);
                            await this._storeState(current, "held_back", _t("Waiting for an earlier change on this record."));
                            return;
                        }
                        await this._storeState(current, "sending");
                        return current;
                    });
                    if (!entry) {
                        continue;
                    }
                    const { db, uid, key, model, method, args, kwargs, refs } = entry;
                    let result;
                    try {
                        const xhr = new browser.XMLHttpRequest();
                        xhr.timeout = 30000;
                        result = await rpc("/web/offline/sync", {
                            db, uid, key, model, method, args, refs,
                            kwargs: { ...kwargs, context: { ...user.context, ...kwargs.context } },
                        }, { silent: true, xhr });
                    } catch (error) {
                        if (error instanceof ConnectionLostError) {
                            // A lost response is not a rejection. Reuse this UUID on the next send.
                            await this._queue.lock(() => this._storeState(entry, "waiting"));
                            break;
                        }
                        if (error.code === 100) {
                            this.syncPaused.set(true);
                            await this._queue.lock(() => this._storeState(entry, "paused", _t("Log in again to send your changes.")));
                            break;
                        }
                        blockers.push(entry);
                        await this._queue.lock(() => this._storeState(entry, "needs_attention", this._reason(error)));
                        continue;
                    }
                    await this._queue.lock(async () => {
                        await this._queue.remove(key);
                        this._removeEntry(key);
                    });
                    rpcBus.trigger("OFFLINE:SYNCED", { entry, result });
                }
            });
        } catch {
            this._reportStorageError();
        } finally {
            this.syncingORM.set(false);
        }
    }
}

services.add(OfflinePlugin);

/**
 * -----------------------------------------------------------------------------
 * @todo owl3 migration
 * temporary - to remove when all use of the offline service are removed
 * -----------------------------------------------------------------------------
 *
 * Bridges the legacy `useService("offline")` API to the OfflinePlugin. New code
 * should use `usePlugin(OfflinePlugin)` directly and read the `isOffline()` signal.
 */
export const offlineService = {
    start() {
        const offlinePlugin = usePlugin(OfflinePlugin);
        const offlineService = Object.create(offlinePlugin);
        Object.defineProperty(offlineService, "offline", {
            get() {
                return offlinePlugin.isOffline();
            },
            set(offline) {
                offlinePlugin.setOffline(offline);
            },
        });
        Object.defineProperty(offlineService, "syncingORM", {
            get() {
                return offlinePlugin.syncingORM();
            },
        });
        Object.defineProperty(offlineService, "scheduledORM", {
            get() {
                return offlinePlugin._ormToSync();
            },
        });
        return offlineService;
    },
};

registry.category("services").add("offline", offlineService);
