import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { offlineCachedModel } from "@crm/offline/offline_cached_model";
import { registry } from "@web/core/registry";
import { graphView } from "@web/views/graph/graph_view";
import { ForecastSearchModel } from "@crm/views/forecast_search_model";

export const forecastGraphView = {
    ...graphView,
    Model: offlineCachedModel(graphView.Model),
    ControlPanel: CrmControlPanel,
    SearchModel: ForecastSearchModel,
};

registry.category("views").add("forecast_graph", forecastGraphView);
