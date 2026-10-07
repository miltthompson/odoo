import { CrmLead } from "@crm/../tests/mock_server/mock_models/crm_lead";
import { CrmLostReason } from "@crm/../tests/mock_server/mock_models/crm_lost_reason";
import { CrmStage } from "@crm/../tests/mock_server/mock_models/crm_stage";
import { CrmTeam } from "@crm/../tests/mock_server/mock_models/crm_team";
import { IrActionsActWindow } from "@crm/../tests/mock_server/mock_models/ir_actions_act_window";
import { mailModels } from "@mail/../tests/mail_test_helpers";
import { defineModels } from "@web/../tests/web_test_helpers";

export const crmModels = {
    ...mailModels,
    CrmLead,
    CrmLostReason,
    CrmStage,
    CrmTeam,
    IrActionsActWindow,
};

export function defineCrmModels() {
    defineModels(crmModels);
}
