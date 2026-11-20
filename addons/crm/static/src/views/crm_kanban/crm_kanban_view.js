import { onMounted, onWillUnmount } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { CrmKanbanModel } from "@crm/views/crm_kanban/crm_kanban_model";
import { CrmKanbanArchParser } from "@crm/views/crm_kanban/crm_kanban_arch_parser";
import { CrmKanbanRenderer } from "@crm/views/crm_kanban/crm_kanban_renderer";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { rottingKanbanView } from "@mail/js/rotting_mixin/rotting_kanban_view";
import { LeadGenerationDropdown } from "../../components/lead_generation_dropdown/lead_generation_dropdown";

export const crmKanbanView = {
    ...rottingKanbanView,
    ArchParser: CrmKanbanArchParser,
    // Makes it easier to patch
    Controller: class extends rottingKanbanView.Controller {
        static components = {
            ...rottingKanbanView.Controller.components,
            LeadGenerationDropdown,
        };

        setup() {
            super.setup();
            if (this.env.config.actionXmlId !== "crm.crm_lead_action_pipeline") {
                return;
            }
            const view = useService("view");
            const action = useService("action");
            let cancel;
            onMounted(() => {
                if (!view.canPrefetchViews()) {
                    return;
                }
                const prefetch = () => this.prefetchPipelineViews(view, action);
                if (window.requestIdleCallback) {
                    const id = window.requestIdleCallback(prefetch);
                    cancel = () => window.cancelIdleCallback(id);
                } else {
                    const id = window.setTimeout(prefetch, 100);
                    cancel = () => window.clearTimeout(id);
                }
            });
            onWillUnmount(() => cancel?.());
        }

        prefetchPipelineViews(view, action) {
            if (!view.canPrefetchViews()) {
                return;
            }
            const { actionId, views } = this.env.config;
            const { context, resModel } = this.props;
            const quickCreateView = this.props.archInfo.quickCreateView;
            const requests = [
                // get_views returns all layouts in the action, including Kanban, form and activity.
                view.prefetchViews({ context, resModel, views }, {
                    actionId,
                    loadActionMenus: true,
                    loadIrFilters: views.some(([, type]) => type === "search"),
                }),
                view.prefetchViews({ resModel: "mail.activity.schedule", views: [[false, "form"]] }),
                action
                    .loadAction("crm.crm_lead_lost_action", { active_ids: [] }, { silent: true })
                    .then((lost) => view.prefetchViews({
                        context: lost.context,
                        resModel: lost.res_model,
                        views: lost.views,
                    }, { actionId: lost.id })),
            ];
            if (quickCreateView) {
                requests.push(view.prefetchViews({
                    context: { ...context, form_view_ref: quickCreateView },
                    resModel,
                    views: [[false, "form"]],
                }));
            }
            // This is best-effort and deliberately does not delay or interrupt the pipeline.
            return Promise.allSettled(requests);
        }

        get progressBarAggregateFields() {
            const res = super.progressBarAggregateFields;
            const progressAttributes = this.props.archInfo.progressAttributes;
            if (progressAttributes && progressAttributes.recurring_revenue_sum_field) {
                res.push(progressAttributes.recurring_revenue_sum_field);
            }
            return res;
        }
    },
    ControlPanel: CrmControlPanel,
    Model: CrmKanbanModel,
    Renderer: CrmKanbanRenderer,
    SearchModel: CrmSearchModel,
    buttonTemplate: "crm.Kanban.Buttons",
};

registry.category("views").add("crm_kanban", crmKanbanView);
