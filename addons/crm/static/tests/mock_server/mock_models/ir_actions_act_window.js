import { fields, models } from "@web/../tests/web_test_helpers";

export class IrActionsActWindow extends models.ServerModel {
    _name = "ir.actions.act_window";

    name = fields.Char();
    res_model = fields.Char();
    type = fields.Char({ default: "ir.actions.act_window" });

    _records = [{ id: 99, name: "Mark as Lost", res_model: "crm.lead.lost" }];
}
