import { usePlugin } from "@odoo/owl";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";

// Read methods whose results can safely come from the encrypted IDB disk cache.
// Anything not listed here (writes, custom calls) goes straight to the server and
// fails normally while offline.
const READ_METHODS = new Set([
    "web_search_read",
    "web_read",
    "web_read_group",
    "web_read_grouping_sets",
    "formatted_read_group",
    "formatted_read_grouping_sets",
    "read",
    "search_read",
    "search",
    "search_count",
    "read_group",
    "get_views",
    "get_activity_data",
    "fields_get",
    "name_search",
    "web_name_search",
    "web_search_read_field",
]);

/**
 * Wraps a view Model so its read calls are served from the encrypted disk cache
 * when the user is offline, and so the view registers itself as visited/available
 * offline. Works for any Model exposing `this.orm` (RelationalModel subclasses
 * keep their own caching via `this.orm.cache(settings)`).
 */
export function offlineCachedModel(BaseModel) {
    return class OfflineCachedModel extends BaseModel {
        offlinePlugin = usePlugin(OfflinePlugin);

        setup(params, services) {
            super.setup(...arguments);
            const orm = this.orm;
            const offlinePlugin = this.offlinePlugin;
            this.orm = Object.assign(Object.create(orm), {
                call(model, method, args = [], kwargs = {}) {
                    if (!READ_METHODS.has(method)) {
                        return orm.call(model, method, args, kwargs);
                    }
                    return orm
                        .cache({
                            ...(this._cache || {}),
                            type: "disk",
                            update: "always",
                            // While online always fetch fresh data (which still
                            // updates the disk cache for offline use); read the
                            // cache only while offline.
                            noCache: !offlinePlugin.isOffline(),
                        })
                        .call(model, method, args, kwargs);
                },
            });
        }

        async load(params) {
            const res = await super.load(...arguments);
            const { actionId, viewType } = this.env.config;
            const search = this.env.searchModel?.getCurrentSearch?.();
            if (actionId && search) {
                this.offlinePlugin.setAvailableOffline(actionId, viewType, { search });
            }
            return res;
        }
    };
}
