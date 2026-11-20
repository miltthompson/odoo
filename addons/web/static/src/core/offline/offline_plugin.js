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
import { NotificationPlugin } from "@web/core/notifications/notification_plugin";
import { ORM } from "@web/core/orm_plugin";
import { registry } from "@web/core/registry";
import { services } from "@web/core/services";
import { uniqueId } from "@web/core/utils/functions";
import { IndexedDB } from "@web/core/utils/indexed_db";
import { hashCode } from "@web/core/utils/strings";
import { session } from "@web/session";

const IS_READY = Symbol("ready");
const MANY2X_SCAN_LIMIT = 1000;
const GUARDED_EVENTS = [
    "click", "auxclick", "dblclick", "keydown", "keyup", "keypress",
    "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "submit",
];

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
    static ORM_SYNC_TABLE_NAME = "orm-to-sync";
    static MANY2X_TABLE_PREFIX = "many2x_";

    static SELECTORS_TO_DISABLE = [
        "button:not([data-available-offline]):not([disabled])",
        "[data-offline-reason]:not([data-available-offline]):not([disabled])",
    ];

    debugMode = usePlugin(DebugModePlugin);
    notification = usePlugin(NotificationPlugin);
    _gatedControls = new Map();
    _offlineDescriptions = new Map();
    orm = usePlugin(ORM);

    _idb = window.isSecureContext
        ? markRaw(new IndexedDB("offline", session.registry_hash + CRYPTO_ALGO))
        : new FakeIndexedDB();
    _crypto =
        window.isSecureContext &&
        session.browser_cache_secret &&
        new Crypto(session.browser_cache_secret);
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

    _onOfflineActivation = (ev) => this._guardOfflineActivation(ev);

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

        this._updateScheduledORMList().then(async () => {
            if (!this.isOffline()) {
                // wait a bit for the webclient to be started before synchronizing
                await new Promise((r) => browser.setTimeout(r, 3000));
                this._syncORM();
            }
        });

        onWillDestroy(() => this._cleanup());
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
            // Guard newly rendered controls too, before the observer has added their attributes.
            for (const type of GUARDED_EVENTS) {
                window.addEventListener(type, this._onOfflineActivation, true);
            }
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
                attributeFilter: ["data-available-offline", "data-offline-reason", "disabled"],
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
                value = (await this._idb.read(this._visitedUITable(), key)) || {};
                let count = value[search.key]?.count || 0;
                search = value[search.key]?.search || search; // keep original search (no "Custom Filter")
                delete value[search.key]; // delete and re-add to mark it as "last visited"
                value[search.key] = { count: ++count, search };
            }
            return this._idb.write(this._visitedUITable(), key, value);
        }
    }

    // -------------------------------------------------------------------------
    // ORM Offline
    // -------------------------------------------------------------------------

    scheduleORM(model, method, args, kwargs, options) {
        if (!window.isSecureContext) {
            throw new NonSecureContextError(
                _t("Offline features not available in a non-secure context")
            );
        }
        const value = { model, method, args, kwargs, extras: options.extras };
        const key = options.id ?? hashCode(JSON.stringify(value));
        this._ormToSync()[key] = { key, value };
        this._idb.write(OfflinePlugin.ORM_SYNC_TABLE_NAME, key, JSON.stringify(value));
        return key;
    }

    removeScheduledORM(key) {
        delete this._ormToSync()[key];
        this._idb.delete(OfflinePlugin.ORM_SYNC_TABLE_NAME, key);
    }

    get hasScheduledCalls() {
        return !!Object.keys(this._ormToSync()).length;
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
        this._idb.write(tableName, values);
    }

    async searchMany2XRecords(resModel, name) {
        if (!this._crypto) {
            return [];
        }

        const query = normalize(name);
        const labels = new Map();
        const tableName = OfflinePlugin.MANY2X_TABLE_PREFIX + resModel;
        const results = await this._idb.search(tableName, async (value) => {
            try {
                const label = await this._crypto.decrypt(value);
                if (typeof label === "string" && normalize(label).includes(query)) {
                    labels.set(value, label);
                    return true;
                }
            } catch {
                // A saved entry encrypted with a previous key is not available.
            }
            return false;
        }, 8, MANY2X_SCAN_LIMIT);
        return (results || []).map(({ key, value }) => ({
            id: Number(key),
            display_name: labels.get(value),
        }));
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
        this._observer?.disconnect();
        for (const type of GUARDED_EVENTS) {
            window.removeEventListener(type, this._onOfflineActivation, true);
        }
        this._onlineUI();
        browser.clearTimeout(this._timeout);
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
            for (const key of keys) {
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
        const selector = OfflinePlugin.SELECTORS_TO_DISABLE.join(", ");
        for (const [el, state] of this._gatedControls) {
            if (
                !el.isConnected ||
                el.hasAttribute("data-available-offline") ||
                (state.native && el.hasAttribute("data-offline-reason")) ||
                (!state.native && (!el.matches(selector) || state.reason !== this._offlineReason(el)))
            ) {
                this._restoreOfflineControl(el, state);
            }
        }
        for (const el of document.querySelectorAll(selector)) {
            if (this._gatedControls.has(el)) {
                continue;
            }
            const reason = this._offlineReason(el);
            // Legacy standalone clients keep native disabling unless they supply a reason.
            const native = !el.closest(".o_web_client, .o_action_manager, .o_dialog") &&
                !el.hasAttribute("data-offline-reason");
            const ariaDisabled = el.getAttribute("aria-disabled");
            const describedBy = el.getAttribute("aria-describedby");
            const hadClass = el.classList.contains("o_disabled_offline");
            const description = this._getOfflineDescription(reason);
            this._gatedControls.set(el, { native, reason, ariaDisabled, description, hadClass });
            el.setAttribute("aria-disabled", "true");
            el.setAttribute("aria-describedby", [describedBy, description].filter(Boolean).join(" "));
            el.classList.add("o_disabled_offline");
            if (native) {
                el.setAttribute("disabled", "");
            }
        }
    }

    _offlineReason(el) {
        return el.dataset.offlineReason || String(_t("This action needs a connection."));
    }

    _getOfflineDescription(reason) {
        if (!this._offlineDescriptions.has(reason)) {
            const description = document.createElement("span");
            description.id = uniqueId("o_offline_reason_");
            description.hidden = true;
            description.textContent = reason;
            document.body.append(description);
            this._offlineDescriptions.set(reason, description);
        }
        return this._offlineDescriptions.get(reason).id;
    }

    _guardOfflineActivation(ev) {
        if (!this.isOffline()) {
            return;
        }
        const keyboard = ev.type.startsWith("key");
        if (keyboard && !["Enter", " "].includes(ev.key)) {
            return;
        }
        const target = ev.submitter || ev.target;
        const control = target.closest?.("button, [data-offline-reason]") ||
            (ev.type === "submit" ? target.querySelector('button[type="submit"], button:not([type])') : null);
        if (!control || control.hasAttribute("data-available-offline")) {
            return;
        }
        if (!this._gatedControls.has(control) && !control.matches(OfflinePlugin.SELECTORS_TO_DISABLE.join(", "))) {
            return;
        }
        ev.stopImmediatePropagation();
        if (keyboard || ["click", "auxclick", "dblclick", "submit"].includes(ev.type)) {
            ev.preventDefault();
        }
        if (["click", "auxclick", "submit"].includes(ev.type) || (ev.type === "keydown" && !ev.repeat)) {
            this.explainUnavailable(this._offlineReason(control));
        }
    }

    explainUnavailable(reason = _t("This action needs a connection.")) {
        this.notification.add(reason, { type: "info" });
    }

    _restoreOfflineControl(el, state) {
        this._gatedControls.delete(el);
        if (state.native) {
            el.removeAttribute("disabled");
        }
        if (state.ariaDisabled === null) {
            el.removeAttribute("aria-disabled");
        } else {
            el.setAttribute("aria-disabled", state.ariaDisabled);
        }
        const ids = el.getAttribute("aria-describedby")?.split(/\s+/).filter((id) => id !== state.description);
        if (ids?.length) {
            el.setAttribute("aria-describedby", ids.join(" "));
        } else {
            el.removeAttribute("aria-describedby");
        }
        if (!state.hadClass) {
            el.classList.remove("o_disabled_offline");
        }
    }

    _onlineUI() {
        for (const [el, state] of this._gatedControls) {
            this._restoreOfflineControl(el, state);
        }
        for (const description of this._offlineDescriptions.values()) {
            description.remove();
        }
        this._offlineDescriptions.clear();
    }

    // -------------------------------------------------------------------------
    // ORM Offline
    // -------------------------------------------------------------------------

    async _syncORM() {
        if (!window.isSecureContext) {
            return;
        }

        // Only one tab can execute this block at a time
        // This can only be done in a secure context
        await navigator.locks.request("db-sync", async () => {
            this.syncingORM.set(true);
            await this._updateScheduledORMList();

            for (const [index, { key, value }] of Object.values(this._ormToSync())
                .filter(({ value }) => !value.extras.error)
                .sort((s1, s2) => s1.value.extras.timeStamp - s2.value.extras.timeStamp)
                .entries()) {
                if (index !== 0) {
                    await new Promise((r) => browser.setTimeout(r, 1000)); // Waits 1 second
                }
                try {
                    await this.orm.silent.call(value.model, value.method, value.args, value.kwargs);
                    this.removeScheduledORM(key);
                } catch (e) {
                    if (e instanceof ConnectionLostError) {
                        break;
                    }
                    let error = e.message || _t("Error");
                    if (e.data) {
                        error = e.data.name + " - " + e.data.message;
                    }
                    this.scheduleORM(value.model, value.method, value.args, value.kwargs, {
                        id: key,
                        extras: { ...value.extras, error },
                    });
                }
            }
            this.syncingORM.set(false);
        });
    }

    async _updateScheduledORMList() {
        const table = await this._idb.getAllEntries(OfflinePlugin.ORM_SYNC_TABLE_NAME);
        this._ormToSync.set(
            Object.fromEntries(
                table.map((v) => [v.key, { key: v.key, value: JSON.parse(v.value) }])
            )
        );
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
