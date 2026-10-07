import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { offlineCachedModel } from "@crm/offline/offline_cached_model";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { pivotView } from "@web/views/pivot/pivot_view";
import { registry } from "@web/core/registry";

export const crmPivotView = {
    ...pivotView,
    Model: offlineCachedModel(pivotView.Model),
    ControlPanel: CrmControlPanel,
    SearchModel: CrmSearchModel,
};

registry.category("views").add("crm_pivot", crmPivotView);
