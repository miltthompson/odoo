// Read methods whose results may be served from the offline disk cache while
// offline. Anything not listed goes straight to the server and fails normally.
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
    "get_unusual_days",
    "fields_get",
    "name_search",
    "web_name_search",
    "web_search_read_field",
]);

/**
 * Wraps a view Model so its read calls are served from the encrypted disk cache
 * when the user is offline, and so the view registers itself as available
 * offline. For Models that call `this.orm` directly (RelationalModel subclasses
 * get the same behaviour from the framework's own `orm.cache` wrapper).
 */
export function offlineCachedModel(BaseModel) {
    return class OfflineCachedModel extends BaseModel {
        setup(params, services) {
            super.setup(...arguments);
            const orm = this.orm;
            const offlineService = this.env.services.offline;
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
                            // Online: always fetch fresh data (which still
                            // refreshes the disk cache). Offline: read cache.
                            noCache: !offlineService?.offline,
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
                this.env.services.offline?.setAvailableOffline(actionId, viewType, { search });
            }
            return res;
        }
    };
}
