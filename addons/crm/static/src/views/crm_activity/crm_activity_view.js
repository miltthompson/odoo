import { activityView } from "@mail/views/web/activity/activity_view";
import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { offlineCachedModel } from "@crm/offline/offline_cached_model";
import { registry } from "@web/core/registry";

export const crmActivityView = {
    ...activityView,
    // the activity Model disables caching; the offline mixin re-enables it
    // through the encrypted disk cache so the view works offline
    Model: class extends offlineCachedModel(activityView.Model) {
        static withCache = true;
    },
    ControlPanel: CrmControlPanel,
    SearchModel: CrmSearchModel,
};

registry.category("views").add("crm_activity", crmActivityView);
