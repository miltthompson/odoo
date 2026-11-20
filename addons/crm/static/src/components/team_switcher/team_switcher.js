import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { _t } from "@web/core/l10n/translation";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";

import { Component, onWillStart, signal, useEffect, usePlugin } from "@odoo/owl";
import { ConnectionLostError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";

export class TeamSwitcher extends Component {
    static template = "crm.team_switcher";
    static components = { Dropdown, DropdownItem };

    savedSearches = signal(new Map());
    offlinePlugin = usePlugin(OfflinePlugin);

    /**
     * @override
     */
    setup() {
        super.setup();
        this.actionService = useService("action");

        onWillStart(async () => {
            try {
                this.isSaleManager = await user.hasGroup("sales_team.group_sale_manager");
            } catch (error) {
                if (!(error instanceof ConnectionLostError)) {
                    throw error;
                }
            }
        });
        useEffect(() => {
            if (!this.offlinePlugin.isOffline()) {
                this.savedSearches.set(new Map());
                return;
            }
            let active = true;
            this.env.searchModel.getSavedTeamSearches().then((searches) => {
                if (active) {
                    this.savedSearches.set(searches);
                }
            });
            return () => { active = false; };
        });
    }

    get allTeamsLabel() {
        return _t("All Teams");
    }

    get currentLabel() {
        return this.teams.find((t) => t.id === this.selectedTeamId)?.name || this.allTeamsLabel;
    }

    get hasDropdown() {
        return this.teams.length > 0;
    }

    get selectedTeamId() {
        return this.env.searchModel.state.switcherTeamId;
    }

    get teams() {
        return this.env.searchModel.state.switcherTeams;
    }

    teamOfflineReason(teamId) {
        return this.offlinePlugin.isOffline() &&
            this.selectedTeamId !== teamId &&
            !this.savedSearches().has(teamId) &&
            _t("This team's pipeline isn't saved on this device.");
    }

    manageTeamsOfflineReason() {
        return this.offlinePlugin.isOffline() && _t("Managing teams needs a connection.");
    }

    onClickManageTeams() {
        const reason = this.manageTeamsOfflineReason();
        if (reason) {
            this.offlinePlugin.explainUnavailable(reason);
            return;
        }
        this.actionService.doAction("sales_team.crm_team_action_config");
    }

    /**
     * Change the currently selected team:
     * - crm.lead records are filtered to that team + team-less records
     * - only that team's stages are shown + the stages of team-less records
     * - the team becomes the default when creating a new crm.lead or crm.stage
     * @param {Number} teamId Id of the new selected team, "undefined" fallbacks on "All Sales Team".
     */
    onSelect(teamId) {
        if (this.selectedTeamId === teamId) {
            return;
        }
        if (this.offlinePlugin.isOffline()) {
            const search = this.savedSearches().get(teamId);
            if (search) {
                this.env.searchModel.applySearch(search);
            } else {
                this.offlinePlugin.explainUnavailable(this.teamOfflineReason(teamId));
            }
            return;
        }
        this.env.searchModel._updateSwitcherSelection(teamId);
    }
};
