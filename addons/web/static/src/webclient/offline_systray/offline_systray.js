import { Component, computed, signal, useEffect, usePlugin } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { useBus, useService } from "@web/core/utils/hooks";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { useDropdownState } from "@web/core/dropdown/dropdown_hooks";
import { _t } from "../../core/l10n/translation";
import { formatDateTime } from "@web/core/l10n/dates";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { rpcBus } from "@web/core/network/rpc";

const { DateTime } = luxon;

const STATUS = {
    CREATED: { label: _t("Created"), color: 10 },
    EDITED: { label: _t("Edited"), color: 3 },
    ARCHIVED: { label: _t("Archived"), color: 2 },
    UNARCHIVED: { label: _t("Unarchived"), color: 4 },
    DELETED: { label: _t("Deleted"), color: 1 },
};

const CHANGE_STATES = {
    waiting: _t("Waiting to be sent"),
    sending: _t("Sending"),
    paused: _t("Log in again to send"),
    needs_attention: _t("Needs attention"),
    held_back: _t("Held back"),
};

function describeChange(entry, recordName) {
    if (entry.label && entry.label !== entry.extras?.displayName) {
        return entry.label;
    }
    switch (entry.method) {
        case "web_save": {
            if (!entry.args[0]?.length) {
                return _t("Created %s", recordName);
            }
            const stageName = entry.extras?.changes?.stage_id?.display_name;
            if (stageName) {
                return _t("Moved %(record)s to %(stage)s", { record: recordName, stage: stageName });
            }
            return _t("Edited %s", recordName);
        }
        case "action_archive":
            return _t("Archived %s", recordName);
        case "action_unarchive":
            return _t("Unarchived %s", recordName);
        case "unlink":
        case "web_unlink":
            return _t("Deleted %s", recordName);
        default:
            return _t("Changed %s", recordName);
    }
}

class OfflineSystray extends Component {
    static template = "web.OfflineSystray";
    static components = { Dropdown, DropdownItem };

    setup() {
        this.offlinePlugin = usePlugin(OfflinePlugin);
        this.actionService = useService("action");
        this.dialogService = useService("dialog");
        this.uiService = useService("ui");
        this.dropdown = useDropdownState();
        let previous;
        let sent = false;
        let alternate = false;
        useBus(rpcBus, "OFFLINE:SYNCED", () => (sent = true));
        useEffect(() => {
            const offline = this.offlinePlugin.isOffline();
            const issues = this.offlinePlugin.getPendingEntries().filter((entry) => entry.state === "needs_attention").length;
            const paused = this.offlinePlugin.syncPaused();
            const syncing = this.offlinePlugin.syncingORM();
            const count = this.pendingCount;
            const announcement = [];
            if (previous) {
                if (offline !== previous.offline) {
                    announcement.push(offline ? _t("Working offline") : _t("Back online"));
                }
                if (paused && !previous.paused) {
                    announcement.push(_t("Log in again to send changes. Pending changes: %s", count));
                }
                if (!syncing && issues && (previous.syncing || issues !== previous.issues)) {
                    announcement.push(_t("Changes need your attention: %s", issues));
                } else if (!count && !syncing && sent && !this.offlinePlugin.getQueueError()) {
                    announcement.push(_t("All changes sent"));
                }
            }
            if (!syncing) {
                sent = false;
            }
            if (announcement.length) {
                alternate = !alternate;
                this.announcement.set({ text: announcement.join(". "), alternate });
            }
            previous = { offline, issues, paused, syncing };
        });
    }

    announcement = signal({ text: "", alternate: false });

    navigationOptions = {
        shouldFocusChildInput: false,
        hotkeys: {
            enter: {
                isAvailable: ({ navigator, target }) =>
                    Boolean(navigator.activeItem) && !target?.closest?.(".o_offline_pending_item button"),
            },
        },
    };

    get pendingCount() {
        return this.offlinePlugin.getPendingEntries().length + this.offlinePlugin.getLegacyPendingCount();
    }

    get counterLabel() {
        return _t("Pending changes: %s", this.pendingCount);
    }

    groupEntries = computed(() => {
        const sections = [];
        let section, previousTarget;
        const paused = this.offlinePlugin.syncPaused();
        for (const entry of this.offlinePlugin.getPendingEntries()) {
            const extras = entry.extras || {};
            const actionName = extras.actionName || "";
            if (!section || section.name !== actionName) {
                section = { id: entry.key, name: actionName, items: [] };
                sections.push(section);
                previousTarget = null;
            }
            const ids = entry.target?.ids || [];
            const target = ids.length ? JSON.stringify([entry.target.model, ids]) : entry.key;
            const recordName = entry.target?.displayName || extras.displayName || _t("this record");
            const state = paused && entry.state === "waiting" ? "paused" : entry.state;
            const timeStamp = formatDateTime(DateTime.fromMillis(entry.acted_at));
            const item = {
                id: entry.key,
                entry,
                timeStamp,
                recordName,
                sameRecord: target === previousTarget,
                displayName: extras.displayName || entry.label || recordName,
                description: describeChange(entry, recordName),
                clickable: this.isClickable(entry),
                retryKey: entry.state === "needs_attention" && entry.key,
                error: entry.error,
                reason: typeof entry.error === "string" ? entry.error : "",
                stateLabel: CHANGE_STATES[state],
                status: { label: _t("Changed"), color: 3 },
                tooltip: { timeStamp, records: extras.displayNames || [] },
            };
            const value = entry;
            previousTarget = target;
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
            section.items.push(item);
        }
        return sections;
    });

    isClickable(value) {
        const resId = (value.legacyArgs || value.args)[0]?.[0] || false;
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

    get legacyNotice() {
        const count = this.offlinePlugin.getLegacyPendingCount();
        return count === 1
            ? _t("One change saved on this device before the update can't be sent from this account.")
            : _t("%s changes saved on this device before the update can't be sent from this account.", count);
    }

    get labelIcon() {
        if (this.offlinePlugin.syncingORM()) {
            return "spinner-border";
        }
        if (this.inError() || this.offlinePlugin.getLegacyPendingCount()) {
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
        if (this.inError() || this.offlinePlugin.getLegacyPendingCount()) {
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
            confirm: () => this.offlinePlugin.discardPendingChange(id),
            cancel: () => {},
        });
    }

    async openView(entry, exact = false) {
        this.dropdown.close();
        const resId = (entry.legacyArgs || entry.args)[0]?.[0];
        const siblings = this.offlinePlugin.getPendingEntries().filter((item) => item.legacyKey === entry.legacyKey);
        await this.actionService.doAction(entry.extras.actionId, {
            viewType: "form",
            props: { offlineId: exact || siblings.length > 1 ? entry.key : entry.legacyKey, resId },
            clearBreadcrumbs: true,
        });
    }
}

const offlineSystrayItem = {
    Component: OfflineSystray,
};

registry.category("systray").add("offline", offlineSystrayItem, { sequence: 1000 });
