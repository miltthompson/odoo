import { calendarView } from "@web/views/calendar/calendar_view";
import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { offlineCachedModel } from "@crm/offline/offline_cached_model";
import { registry } from "@web/core/registry";

export const crmCalendarView = {
    ...calendarView,
    Model: offlineCachedModel(calendarView.Model),
    ControlPanel: CrmControlPanel,
    SearchModel: CrmSearchModel,
};
registry.category("views").add("crm_calendar", crmCalendarView);
