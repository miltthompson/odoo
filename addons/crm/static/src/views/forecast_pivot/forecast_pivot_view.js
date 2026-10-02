import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { offlineCachedModel } from "@crm/offline/offline_cached_model";
import { registry } from "@web/core/registry";
import { pivotView } from "@web/views/pivot/pivot_view";
import { ForecastSearchModel } from "@crm/views/forecast_search_model";

export const forecastPivotView = {
    ...pivotView,
    Model: offlineCachedModel(pivotView.Model),
    ControlPanel: CrmControlPanel,
    SearchModel: ForecastSearchModel,
};

registry.category("views").add("forecast_pivot", forecastPivotView);
