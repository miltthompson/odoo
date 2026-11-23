import { Component, computed, usePlugin } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { useService } from "@web/core/utils/hooks";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { _t } from "../../core/l10n/translation";
import { formatDateTime } from "@web/core/l10n/dates";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

const { DateTime } = luxon;

const STATUS = {
    CREATED: { label: _t("Created"), color: 10 },
    EDITED: { label: _t("Edited"), color: 3 },
    ARCHIVED: { label: _t("Archived"), color: 2 },
    UNARCHIVED: { label: _t("Unarchived"), color: 4 },
    DELETED: { label: _t("Deleted"), color: 1 },
};

class OfflineSystray extends Component {
    static template = "web.OfflineSystray";
    static components = { Dropdown, DropdownItem };

    setup() {
        this.offlinePlugin = usePlugin(OfflinePlugin);
        this.actionService = useService("action");
        this.dialogService = useService("dialog");
        this.uiService = useService("ui");
    }

    groupEntries = computed(() => {
        const items = [];
        for (const { key, value } of Object.values(this.offlinePlugin._ormToSync())) {
            const pending = this.offlinePlugin.getPendingEntry(key);
            const extras = value.extras || {};
            const timeStamp = formatDateTime(DateTime.fromMillis(extras.timeStamp ?? pending.acted_at));
            const item = {
                id: key,
                timeStamp: extras.timeStamp ?? pending.acted_at,
                actionName: extras.actionName,
                displayName: extras.displayName || pending.label,
                clickable: this.isClickable(value),
                discardable: this.offlinePlugin.canDiscardPendingChange(pending),
                retryKey: pending.state === "needs_attention" && !pending.manualRecovery && !extras.error && pending.key,
                error: extras.error || pending.error,
                status: { label: _t("Changed"), color: 3 },
                tooltip: { timeStamp, records: extras.displayNames || [] },
            };
            if (value.method === "web_save") {
                item.status = value.args[0].length ? STATUS.EDITED : STATUS.CREATED;
                item.tooltip.changes = Object.entries(extras.changes || {}).map(([k, v]) => [
                    k,
                    v?.display_name ?? v,
                ]);
                if (value.args[0].length) {
                    item.tooltip.changes = item.tooltip.changes.map((c) => [
                        c[0],
                        extras.originalValues?.[c[0]]?.display_name ??
                            JSON.stringify(extras.originalValues?.[c[0]]),
                        c[1],
                    ]);
                }
            }
            if (value.method === "unlink" || value.method === "web_unlink") {
                item.status = STATUS.DELETED;
            }
            if (value.method === "action_archive") {
                item.status = STATUS.ARCHIVED;
            }
            if (value.method === "action_unarchive") {
                item.status = STATUS.UNARCHIVED;
            }
            item.tooltip = JSON.stringify(item.tooltip);
            items.push(item);
        }
        const sections = Object.entries(Object.groupBy(items, (item) => item.actionName || ""));
        sections.forEach(([_name, items]) => {
            items.sort((itemA, itemB) => itemA.timeStamp - itemB.timeStamp);
        });
        return sections;
    });

    isClickable(value) {
        const resId = value.args[0]?.[0] || false;
        return (
            value.method === "web_save" &&
            value.extras?.viewType === "form" &&
            (!this.offlinePlugin.isOffline() ||
                this.offlinePlugin.isAvailableOffline(value.extras.actionId, "form", resId))
        );
    }

    inError = computed(() =>
        this.offlinePlugin.getPendingEntries().find((entry) => entry.state === "needs_attention")
    );

    get labelColor() {
        if (this.inError()) {
            if (this.uiService.isSmall) {
                return "text-danger";
            }
            return "text-bg-danger";
        }
        if (this.offlinePlugin.isOffline()) {
            if (this.uiService.isSmall) {
                return "text-warning";
            }
            return "text-bg-warning";
        }
        if (this.offlinePlugin.syncingORM()) {
            if (this.uiService.isSmall) {
                return "";
            }
            return "text-bg-300";
        }
        return "text-bg-300";
    }

    get labelIcon() {
        if (this.offlinePlugin.syncingORM()) {
            return "spinner-border";
        }
        if (this.inError()) {
            return "error";
        }
        if (this.offlinePlugin.isOffline()) {
            return "link_off";
        }
        return "spinner-border";
    }

    get labelText() {
        if (this.offlinePlugin.syncPaused()) {
            return _t("Log in again to send changes");
        }
        if (this.offlinePlugin.syncingORM()) {
            return _t("Syncing");
        }
        if (this.offlinePlugin.isOffline()) {
            return _t("Working offline");
        }
        if (this.inError()) {
            return _t("Sync issues");
        }
        return _t("Syncing");
    }

    discard(id) {
        this.dialogService.add(ConfirmationDialog, {
            title: _t("Discard offline change"),
            body: _t("Are you sure that you want to discard the changes you made offline?"),
            confirmLabel: _t("Discard"),
            cancelLabel: _t("No, keep it"),
            confirm: () => this.offlinePlugin.removeScheduledORM(id),
            cancel: () => {},
        });
    }

    async openView(id) {
        const { value } = this.offlinePlugin._ormToSync()[id];
        const resId = value.args[0]?.[0];
        await this.actionService.doAction(value.extras.actionId, {
            viewType: "form",
            props: { offlineId: id, resId },
            clearBreadcrumbs: true,
        });
    }
}

const offlineSystrayItem = {
    Component: OfflineSystray,
};

registry.category("systray").add("offline", offlineSystrayItem, { sequence: 1000 });
