import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { offlineCachedModel } from "@crm/offline/offline_cached_model";
import { graphView } from "@web/views/graph/graph_view";
import { registry } from "@web/core/registry";

export const crmGraphView = {
    ...graphView,
    Model: offlineCachedModel(graphView.Model),
    ControlPanel: CrmControlPanel,
    SearchModel: CrmSearchModel,
};

registry.category("views").add("crm_graph", crmGraphView);
