import { fields, models } from "@web/../tests/web_test_helpers";

export class CrmLostReason extends models.ServerModel {
    _name = "crm.lost.reason";

    name = fields.Char();
    display_name = fields.Char();

    _records = [
        { id: 11, name: "Too expensive", display_name: "Too expensive" },
        { id: 12, name: "No answer", display_name: "No answer" },
    ];
}
