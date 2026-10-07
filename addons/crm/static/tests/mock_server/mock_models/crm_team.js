import { fields, models } from "@web/../tests/web_test_helpers";

export class CrmTeam extends models.ServerModel {
    _name = "crm.team";

    name = fields.Char();

    _records = [{ id: 1, name: "Sales" }];
}
