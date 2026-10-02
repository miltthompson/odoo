import { fields, models } from "@web/../tests/web_test_helpers";

export class CrmLead extends models.ServerModel {
    _name = "crm.lead";
    _views = {
        form: /* xml */ `
            <form string="Lead">
                <sheet>
                    <field name="name"/>
                </sheet>
            </form>`,
    };

    name = fields.Char();
    type = fields.Selection({
        selection: [
            ["lead", "Lead"],
            ["opportunity", "Opportunity"],
        ],
    });
    stage_id = fields.Many2one({ relation: "crm.stage" });
    user_id = fields.Many2one({ relation: "res.users" });
    team_id = fields.Many2one({ relation: "crm.team" });
    active = fields.Boolean();
    won_status = fields.Selection({
        selection: [
            ["pending", "Pending"],
            ["won", "Won"],
            ["lost", "Lost"],
        ],
    });
    is_automated_probability = fields.Boolean();
    probability = fields.Float();
    automated_probability = fields.Float();
    planned_revenue = fields.Float();

    _records = [
        {
            id: 1,
            name: "Lead 1",
            type: "opportunity",
            stage_id: 1,
            active: true,
            won_status: "pending",
            planned_revenue: 5,
        },
        {
            id: 2,
            name: "Lead 2",
            type: "opportunity",
            stage_id: 2,
            active: true,
            won_status: "pending",
            planned_revenue: 3,
        },
    ];

    // no-op versions of the methods queueable while offline, so calls can be
    // asserted on the mock server
    action_set_won_rainbowman() {}
    action_set_lost() {}
    action_restore() {}
    action_convert_to_opportunity() {}
    action_set_automated_probability() {}
}
