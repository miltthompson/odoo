import { onMounted, onPatched, onWillUnmount } from "@odoo/owl";
import { patch } from "@web/core/utils/patch";
import { StatusBarField } from "@web/views/fields/statusbar/statusbar_field";

// The form statusbar (stage_id) is the other way to move a lead through the
// pipeline, next to kanban drag-and-drop which the offline framework already
// queues. The framework auto-disables every <button> without this attribute,
// so stage buttons — including folded-stage dropdown items rendered on open —
// are tagged here, and selectItem below queues the stage change as a web_save
// like a kanban drag. Covers the
// rotting_statusbar_duration widget too: it subclasses StatusBarField.
const OFFLINE_STATUSBAR_SELECTOR = ".o_arrow_button, .o-dropdown-item";

patch(StatusBarField.prototype, {
    setup() {
        super.setup(...arguments);
        const tagOfflineButtons = (root) => {
            if (this.props.record?.resModel !== "crm.lead") {
                return;
            }
            root?.querySelectorAll(OFFLINE_STATUSBAR_SELECTOR).forEach((el) => {
                el.setAttribute("data-available-offline", "");
                // Elements mounted while already offline got disabled before
                // this tag lands; undo it like the plugin's re-enable pass.
                if (el.classList.contains("o_disabled_offline")) {
                    el.removeAttribute("disabled");
                    el.classList.remove("o_disabled_offline");
                }
            });
        };
        // Folded-stage dropdown items are rendered lazily when the dropdown
        // opens, after mount/patch: watch for added buttons too.
        let observer;
        onMounted(() => {
            tagOfflineButtons(this.rootRef());
            if (this.props.record?.resModel === "crm.lead") {
                observer = new MutationObserver(() => tagOfflineButtons(this.rootRef()));
                observer.observe(this.rootRef(), { childList: true, subtree: true });
            }
        });
        onPatched(() => tagOfflineButtons(this.rootRef()));
        onWillUnmount(() => observer?.disconnect());
    },
    async selectItem(item) {
        await super.selectItem(...arguments);
        // Online, a statusbar click only marks the record dirty and the form's
        // save button commits it — but that button is disabled offline. Save
        // right away so the stage change queues as web_save like a kanban drag.
        if (this.props.record?.resModel === "crm.lead" && this.env.services.offline?.offline) {
            await this.props.record.save();
        }
    },
});
