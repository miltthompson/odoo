import { Component, proxy, t, usePlugin, useProps } from "@odoo/owl";

import { browser } from "@web/core/browser/browser";
import { makeContext } from "@web/core/context";
import { Dialog } from "@web/core/dialog/dialog";
import { DialogPlugin } from "@web/core/dialog/dialog_plugin";
import { _t } from "@web/core/l10n/translation";
import { rpcBus } from "@web/core/network/rpc";
import { NotificationPlugin } from "@web/core/notifications/notification_plugin";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { ORM } from "@web/core/orm_plugin";
import { patch } from "@web/core/utils/patch";
import { ActionPlugin } from "@web/webclient/actions/action_plugin";

// localStorage key holding the db id of the crm.lead.lost wizard action
const LOST_ACTION_ID_KEY = "crm.offline_lost_action_id";

// crm.lead object methods that can be replayed as-is once back online
const OFFLINE_METHODS = new Set([
    "action_set_won_rainbowman",
    "action_set_lost",
    "action_convert_to_opportunity",
    "action_restore",
    "action_set_automated_probability",
]);

class OfflineLostReasonDialog extends Component {
    static template = "crm.OfflineLostReasonDialog";
    static components = { Dialog };
    props = useProps({
        close: t.function(),
        reasons: t.array(t.object()),
        onConfirm: t.function(),
    });
    setup() {
        this.state = proxy({ reasonId: "", feedback: "" });
    }
    confirm() {
        this.props.onConfirm({
            lostReasonId: this.state.reasonId ? Number(this.state.reasonId) : false,
            feedback: this.state.feedback.trim(),
        });
        this.props.close();
    }
}

function queueExtras(actionPlugin, ids) {
    const action = actionPlugin.currentAction;
    return {
        actionId: action?.id,
        actionName: action?.name,
        viewType: actionPlugin.currentController?.view?.type,
        timeStamp: Date.now(),
        displayName:
            ids.length > 1 ? _t("%s Records", ids.length) : _t("Lead %(id)s", { id: ids[0] }),
    };
}

function scheduleOnLeads(offlinePlugin, actionPlugin, params, method, kwargs = {}) {
    const ids = params.resId ? [params.resId] : params.resIds;
    return offlinePlugin.scheduleORM(
        "crm.lead",
        method,
        [ids],
        { context: makeContext([params.context, params.buttonContext]), ...kwargs },
        { extras: queueExtras(actionPlugin, ids) }
    );
}

// While online, cache the lost reasons and the id of the crm.lead.lost wizard
// action so both stay usable offline. Triggered once, on the first successful
// crm.lead RPC.
let prefetchStarted = false;
let prefetchFn = null;
rpcBus.addEventListener("RPC:RESPONSE", (ev) => {
    const { data, error } = ev.detail;
    if (prefetchStarted || error || data?.params?.model !== "crm.lead") {
        return;
    }
    prefetchStarted = true;
    prefetchFn?.();
});

async function prefetchOfflineData(orm, offlinePlugin) {
    try {
        const reasons = await orm.silent.searchRead("crm.lost.reason", [], ["display_name"]);
        if (reasons.length) {
            await offlinePlugin.cacheMany2XSearch("crm.lost.reason", reasons);
        }
        const lostAction = await orm.silent.searchRead(
            "ir.actions.act_window",
            [["res_model", "=", "crm.lead.lost"]],
            ["id"],
            { limit: 1 }
        );
        if (lostAction.length) {
            browser.localStorage.setItem(LOST_ACTION_ID_KEY, String(lostAction[0].id));
        }
    } catch {
        // best effort: the offline lost flow just stays unavailable
    }
}

patch(ActionPlugin.prototype, {
    setup() {
        super.setup(...arguments);
        const offlinePlugin = usePlugin(OfflinePlugin);
        const notification = usePlugin(NotificationPlugin);
        const dialog = usePlugin(DialogPlugin);
        const orm = usePlugin(ORM);

        prefetchFn = () => prefetchOfflineData(orm, offlinePlugin);

        const doActionButton = this.doActionButton;
        this.doActionButton = async (params, options = {}) => {
            if (!offlinePlugin.isOffline() || params.resModel !== "crm.lead") {
                return doActionButton(params, options);
            }
            const ids = params.resId ? [params.resId] : params.resIds;
            if (!ids?.length || !ids.every((id) => Number.isInteger(id) && id > 0)) {
                // records created offline have no real id: server methods would
                // not know what to replay on
                notification.add(
                    _t("This action is only available once the record is saved online."),
                    { type: "warning" }
                );
                return;
            }
            if (params.type === "object" && OFFLINE_METHODS.has(params.name)) {
                await scheduleOnLeads(offlinePlugin, this, params, params.name);
                notification.add(_t("Saved: will be applied once back online."), {
                    type: "info",
                });
                return;
            }
            if (
                params.type === "action" &&
                Number(params.name) === Number(browser.localStorage.getItem(LOST_ACTION_ID_KEY))
            ) {
                const reasons =
                    (await offlinePlugin.searchMany2XRecords("crm.lost.reason", "")) || [];
                dialog.add(OfflineLostReasonDialog, {
                    reasons,
                    onConfirm: async ({ lostReasonId, feedback }) => {
                        const lostKwargs = {};
                        if (lostReasonId) {
                            lostKwargs.lost_reason_id = lostReasonId;
                        }
                        await scheduleOnLeads(
                            offlinePlugin,
                            this,
                            params,
                            "action_set_lost",
                            lostKwargs
                        );
                        if (feedback) {
                            await scheduleOnLeads(offlinePlugin, this, params, "message_post", {
                                body: feedback,
                                message_type: "comment",
                                subtype_xmlid: "mail.mt_note",
                            });
                        }
                        notification.add(_t("Saved: will be applied once back online."), {
                            type: "info",
                        });
                    },
                });
                return;
            }
            notification.add(_t("This action is not available while offline."), {
                type: "warning",
            });
        };
    },
});
