import { fields, models } from "@web/../tests/web_test_helpers";

export class CrmStage extends models.ServerModel {
    _name = "crm.stage";

    name = fields.Char();
    is_won = fields.Boolean();
    fold = fields.Boolean();
    sequence = fields.Integer();

    _records = [
        { id: 1, name: "New", sequence: 1 },
        { id: 2, name: "Qualified", sequence: 2 },
        { id: 3, name: "Won", is_won: true, sequence: 3 },
    ];
}
