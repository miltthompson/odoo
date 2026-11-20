import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    mockOffline,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    switchView,
} from "@web/../tests/web_test_helpers";
import { animationFrame } from "@odoo/hoot-mock";
import { expect, test } from "@odoo/hoot";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { rpcBus } from "@web/core/network/rpc";
import { user } from "@web/core/user";
import { session } from "@web/session";
import { WebClient } from "@web/webclient/webclient";

class Users extends models.Model {
    name = fields.Char();

    _records = [
        { id: 1, name: "Mario" },
        { id: 2, name: "Luigi" },
        { id: 3, name: "Link" },
        { id: 4, name: "Zelda" },
    ];
}

class Team extends models.Model {
    _name = "crm.team";

    sequence = fields.Integer({ string: "Sequence", default: 10 });
    name = fields.Char();
    member_ids = fields.Many2many({ string: "Members", relation: "users" });
    use_opportunities = fields.Boolean({ default: true });

    _records = [
        { id: 1, name: "Mushroom Kingdom", member_ids: [1, 2] },
        { id: 2, name: "Hyrule", member_ids: [3, 4] },
    ];

    get_team_switcher_data() {
        const teams = this._filter([["use_opportunities", "=", true]]);
        const stages = this.env["crm.stage"];
        const sharedStageIds = stages
            .filter((stage) => !stage.team_ids.length)
            .map((stage) => stage.id);
        return {
            available: teams.length > 1,
            teams: teams.map((team) => {
                const teamStageIds = stages
                    .filter((stage) => stage.team_ids.includes(team.id))
                    .map((stage) => stage.id);
                return {
                    id: team.id,
                    name: team.name,
                    switcher_domain: [
                        "|",
                            ["team_id", "=", team.id],
                            "&",
                                ["team_id", "=", false],
                                ["stage_id", "in", [...teamStageIds, ...sharedStageIds]],
                    ],
                };
            }),
        };
    }
}

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    is_won = fields.Boolean({ string: "Is won" });
    team_ids = fields.Many2many({ relation: "crm.team" });

    _records = [
        { id: 1, name: "Start" },
        { id: 2, name: "Middle" },
        { id: 3, name: "Middle Hyrule", team_ids: [2] },
        { id: 4, name: "Won", is_won: true },
    ];
}

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });
    user_id = fields.Many2one({ string: "Salesperson", relation: "users" });

    _records = [
        { // Start - Unassigned
            id: 1,
            name: "Lead 1",
            stage_id: 1,
        },
        { // Start - Mushroom Kingdom
            id: 2,
            name: "Lead 2",
            stage_id: 1,
            team_id: 1,
        },
        { // Start - Hyrule
            id: 3,
            name: "Lead 3",
            stage_id: 1,
            team_id: 2,
        },
        { // Middle - Mushroom Kingdom
            id: 4,
            name: "Lead 4",
            stage_id: 2,
            team_id: 1,
        },
        { // Middle - Hyrule
            id: 5,
            name: "Lead 5",
            stage_id: 2,
            team_id: 2,
        },
        { // Middle Hyrule - Hyrule
            id: 6,
            name: "Lead 6",
            stage_id: 3,
            team_id: 2,
        },
        { // Won - Mushroom Kingdom
            id: 7,
            name: "Lead 7",
            stage_id: 4,
            team_id: 1,
        },
        { // Won - Hyrule
            id: 8,
            name: "Lead 8",
            stage_id: 4,
            team_id: 2,
        },
    ];

    _views = {
        form: `
            <form>
                <group>
                    <field name="name"/>
                    <field name="team_id"/>
                </group>
            </form>
        `,
        kanban: `
            <kanban js_class="crm_kanban" default_group_by="stage_id" on_create="quick_create" quick_create_view="form">
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>
        `,
        list: `
            <list js_class="crm_list">
                <field name="id"/>
                <field name="name"/>
            </list>
        `,
        search: `
            <search>
                <field name="team_id"/>
            </search>
        `,
    };
}

class LostReasonWizard extends models.Model {
    _name = "crm.lead.lost";
    _views = { form: `<form/>` };
}

defineModels([Users, Team, Stage, Lead, LostReasonWizard]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        context: {
            show_team_switcher: true,
        },
        views: [
            [false, "kanban"],
            [false, "list"],
            [false, "form"],
        ],
    },
    {
        id: 2,
        xml_id: "crm.crm_lead_action_pipeline",
        res_model: "crm.lead",
        context: { show_lead_gen_button: true },
        views: [[false, "kanban"], [false, "form"]],
    },
    {
        id: 3,
        xml_id: "crm.crm_lead_lost_action",
        res_model: "crm.lead.lost",
        target: "new",
        views: [[false, "form"]],
    },
]);

test.tags("desktop");
test("crm team switcher rendering", async () => {
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Team switcher should default on "All Teams", all records and stages should be visible
    expect(".o_cp_team_switcher:contains('All Teams')").toHaveCount(1);
    expect(".o_kanban_record").toHaveCount(8);
    expect(".o_kanban_group").toHaveCount(4);
    // Changing the selected team should update the displayed stages and records
    // Mushroom Kingdom: 4 records (1 unassigned + 3 assigned), 3 stages (Start, Middle, Won)
    await contains(".o_cp_team_switcher").click();
    await contains(".o_popover .dropdown-item:text('Mushroom Kingdom')").click();
    expect(".o_cp_team_switcher:contains('Mushroom Kingdom')").toHaveCount(1);
    expect(".o_kanban_record").toHaveCount(4);
    expect(".o_kanban_group").toHaveCount(3);
    // Hyrule: 4 records (1 unassigned + 4 assigned), 4 stages (Start, Middle, Won, Hyrule Stage)
    await contains(".o_cp_team_switcher").click();
    await contains(".o_popover .dropdown-item:text('Hyrule')").click();
    expect(".o_kanban_record").toHaveCount(5);
    expect(".o_kanban_group").toHaveCount(4);
    // Selected team should be the default one on quick create (using search context)
    await contains(".o-kanban-button-new").click();
    await animationFrame();
    expect(".o_kanban_quick_create .o_field_many2one[name='team_id'] input").toHaveValue("Hyrule");
    await contains(".o_kanban_cancel").click();
    // Switching view should keep the current team selection
    await switchView("list");
    expect(".o_cp_team_switcher:contains('Hyrule')").toHaveCount(1);
    expect("tr.o_data_row").toHaveCount(5);
    // Selected team should be the default one on record creation via form view (using action context)
    await contains(".o_list_button_add").click();
    expect(".o_field_many2one[name='team_id'] input").toHaveValue("Hyrule");
    await contains(".o_form_button_cancel").click();
});

test.tags("desktop");
test("offline team switcher restores the last saved team and does not offer unsaved teams", async () => {
    expect.errors(3); // Refresh attempts for the cached team list and the two saved pipelines.
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    const action = getService("action");
    await action.doAction(1);
    await contains(".o_cp_team_switcher").click();
    await contains(".o_popover .dropdown-item:text('Mushroom Kingdom')").click();
    expect(".o_kanban_record").toHaveCount(4);
    await animationFrame();

    await setOffline(true);
    await getService(OfflinePlugin).getVisitedStatus();
    await action.doAction(1, { clearBreadcrumbs: true });
    expect(".o_cp_team_switcher").toHaveText("Mushroom Kingdom");
    expect(".o_kanban_record").toHaveCount(4);
    await contains(".o_cp_team_switcher").click();
    expect(".o_popover .dropdown-item:text('Hyrule')").toHaveAttribute("aria-disabled", "true");
    await contains(".o_popover .dropdown-item:text('All Teams')").click();
    expect(".o_kanban_record").toHaveCount(8);
    expect(".o_cp_team_switcher").toHaveText("All Teams");
    expect.verifyErrors([/get_team_switcher_data/, /web_read_group/, /web_read_group/]);
});

test.tags("desktop");
test("the CRM team preference is user-scoped and cleared on logout", async () => {
    const currentKey = `crm.switcher_team_id:${JSON.stringify([session.db, user.userId])}`;
    const anotherKey = `crm.switcher_team_id:${JSON.stringify([session.db, 9999])}`;
    localStorage.setItem(anotherKey, "2");
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect(".o_cp_team_switcher").toHaveText("All Teams");
    await contains(".o_cp_team_switcher").click();
    await contains(".o_popover .dropdown-item:text('Mushroom Kingdom')").click();
    expect(localStorage.getItem(currentKey)).toBe("1");
    rpcBus.trigger("WEBCLIENT:LOGOUT");
    expect(localStorage.getItem(currentKey)).toBe(null);
    expect(localStorage.getItem(anotherKey)).toBe("2");
});

test.tags("desktop");
test("the pipeline warms dialog layouts only after it renders and does not generate leads offline", async () => {
    const setOffline = mockOffline();
    let prefetch;
    patchWithCleanup(window, {
        requestIdleCallback(callback) {
            prefetch = callback;
            return 1;
        },
        cancelIdleCallback() {},
    });
    const layouts = new Set();
    onRpc("get_views", ({ model, kwargs }) => {
        layouts.add(kwargs.context.form_view_ref || model);
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(2);
    expect(".o_kanban_record").toHaveCount(8);
    expect([...layouts]).toEqual(["crm.lead"]);
    await prefetch();
    expect([...layouts].sort()).toEqual(["crm.lead", "crm.lead.lost", "form", "mail.activity.schedule"]);
    await setOffline(true);
    expect("button:text('Generate')").toHaveAttribute("aria-disabled", "true");
    await contains("button:text('Generate')").click();
    expect(".o_lead_mining_menu_choices").toHaveCount(0);
});

test("prefetched view layouts are served from the normal cache while offline", async () => {
    const setOffline = mockOffline();
    onRpc("crm.lead", "get_views", ({ kwargs }) => {
        expect.step(kwargs.views);
    });
    await mountWithCleanup(WebClient);
    const view = getService("view");
    const params = { resModel: "crm.lead", views: [[false, "form"]], context: {} };
    await view.prefetchViews(params);
    await expect.waitForSteps([[[false, "form"]]]);
    await setOffline(true);
    const { views } = await view.loadViews(params);
    expect(views.form.arch).toInclude("<form");
    await expect.waitForSteps([]);
});

test("CRM dependent-app action and object buttons are unavailable offline", async () => {
    const setOffline = mockOffline();
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: `<form><header>
            <button name="action_sale_quotations_new" string="New Quotation" type="object"/>
            <button name="2" string="SMS" type="action"/>
        </header><field name="name"/></form>`,
    });
    expect("button[name='action_sale_quotations_new']").not.toHaveAttribute("aria-disabled");
    expect("button[name='2']").not.toHaveAttribute("aria-disabled");
    await setOffline(true);
    expect("button[name='action_sale_quotations_new']").toHaveAttribute("aria-disabled", "true");
    expect("button[name='2']").toHaveAttribute("aria-disabled", "true");
});
