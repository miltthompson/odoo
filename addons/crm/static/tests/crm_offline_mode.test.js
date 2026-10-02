import { afterEach, animationFrame, expect, test } from "@odoo/hoot";
import { browser } from "@web/core/browser/browser";
import { rpcBus } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import {
    contains,
    fields,
    getService,
    makeTestApp,
    mockOffline,
    models,
    mountView,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { defineCrmModels } from "@crm/../tests/crm_test_helpers";

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    is_won = fields.Boolean();

    _records = [
        { id: 1, name: "New" },
        { id: 2, name: "Qualified" },
        { id: 3, name: "Won", is_won: true },
    ];
}

class LostReason extends models.Model {
    _name = "crm.lost.reason";

    name = fields.Char();
    display_name = fields.Char();

    _records = [
        { id: 11, name: "Too expensive", display_name: "Too expensive" },
        { id: 12, name: "No answer", display_name: "No answer" },
    ];
}

class IrActionsActWindow extends models.Model {
    _name = "ir.actions.act_window";

    res_model = fields.Char();

    _records = [{ id: 99, res_model: "crm.lead.lost" }];
}

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();

    _records = [{ id: 1, name: "Sales" }];
}

defineCrmModels();

const formArch = /* xml */ `
    <form js_class="crm_form" string="Lead">
        <header>
            <button name="action_set_won_rainbowman" string="Won" type="object" data-available-offline="1"/>
            <button name="action_convert_to_opportunity" string="Convert to Opportunity" type="object" data-available-offline="1"/>
            <button name="action_restore" string="Restore" type="object" data-available-offline="1"/>
            <button name="99" string="Lost" type="action" data-available-offline="1"/>
            <button name="action_schedule_meeting" string="Meetings" type="object"/>
        </header>
        <sheet>
            <field name="name"/>
            <field name="won_status" invisible="1"/>
            <field name="type" invisible="1"/>
            <field name="active" invisible="1"/>
        </sheet>
    </form>`;

const kanbanArch = /* xml */ `
    <kanban js_class="crm_kanban" group_create="0" quick_create="0">
        <field name="stage_id"/>
        <templates>
            <t t-name="card">
                <field name="name"/>
            </t>
        </templates>
    </kanban>`;

function scheduledValues() {
    return Object.values(getService(OfflinePlugin)._ormToSync()).map((e) => e.value);
}

afterEach(async () => {
    // queued calls persist in indexeddb across tests: drop them
    const scheduled = getService(OfflinePlugin)._ormToSync();
    for (const key of Object.keys(scheduled)) {
        await getService(OfflinePlugin).removeScheduledORM(key);
    }
    browser.localStorage.removeItem("crm.offline_lost_action_id");
});

// must run first: the prefetch listener only triggers once, on the first
// crm.lead rpc
test("prefetch: lost reasons and lost action id are cached after a crm.lead rpc", async () => {
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await animationFrame();
    await animationFrame();
    expect(browser.localStorage.getItem("crm.offline_lost_action_id")).toBe("99");
    const reasons = await getService(OfflinePlugin).searchMany2XRecords("crm.lost.reason", "");
    expect(reasons.map((r) => r.id).sort()).toEqual([11, 12]);
});

test("offline: Won button on the form queues action_set_won_rainbowman", async () => {
    const setOffline = mockOffline();
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await setOffline(true);

    await contains("button[name='action_set_won_rainbowman']").click();

    const posts = scheduledValues().filter((v) => v.method === "action_set_won_rainbowman");
    expect(posts).toHaveLength(1);
    expect(posts[0].model).toBe("crm.lead");
    expect(posts[0].args).toEqual([[1]]);
});

test("offline: Convert to Opportunity queues action_convert_to_opportunity", async () => {
    const setOffline = mockOffline();
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await setOffline(true);

    await contains("button[name='action_convert_to_opportunity']").click();

    const posts = scheduledValues().filter((v) => v.method === "action_convert_to_opportunity");
    expect(posts).toHaveLength(1);
});

test("offline: Lost button opens reason dialog and queues action_set_lost", async () => {
    const setOffline = mockOffline();
    browser.localStorage.setItem("crm.offline_lost_action_id", "99");
    await makeTestApp();
    await getService(OfflinePlugin).cacheMany2XSearch("crm.lost.reason", [
        { id: 11, display_name: "Too expensive" },
        { id: 12, display_name: "No answer" },
    ]);
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await setOffline(true);

    await contains("button[name='99']").click();
    await contains(".modal select").select("Too expensive");
    await contains(".modal textarea").edit("too pricey");
    await contains(".modal .btn-primary").click();

    const values = scheduledValues();
    const lost = values.find((v) => v.method === "action_set_lost");
    expect(lost).toBeTruthy();
    expect(lost.kwargs.lost_reason_id).toBe(11);
    const note = values.find((v) => v.method === "message_post");
    expect(note).toBeTruthy();
    expect(note.kwargs.body).toBe("too pricey");
    expect(note.kwargs.subtype_xmlid).toBe("mail.mt_note");
});

test("offline: data-available-offline keeps whitelisted buttons enabled", async () => {
    const setOffline = mockOffline();
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await setOffline(true);

    expect("button[name='action_set_won_rainbowman']").not.toHaveAttribute("disabled");
    expect("button[name='action_convert_to_opportunity']").not.toHaveAttribute("disabled");
    expect("button[name='action_restore']").not.toHaveAttribute("disabled");
    expect("button[name='99']").not.toHaveAttribute("disabled");
    // non-whitelisted buttons are auto-disabled
    expect("button[name='action_schedule_meeting']").toHaveAttribute("disabled");
    expect("button[name='action_schedule_meeting']").toHaveClass("o_disabled_offline");
});

test("offline: dragging a card between stages queues the save without rainbowman", async () => {
    const setOffline = mockOffline();
    onRpc("crm.lead", "get_rainbowman_message", () => {
        expect.step("rainbowman");
    });
    await mountView({
        resModel: "crm.lead",
        type: "kanban",
        arch: kanbanArch,
        groupBy: ["stage_id"],
    });
    await setOffline(true);

    await contains(".o_kanban_group:eq(0) .o_kanban_record").dragAndDrop(".o_kanban_group:eq(1)");

    const saves = scheduledValues().filter((v) => v.method === "web_save");
    expect(saves).toHaveLength(1);
    expect(saves[0].args[0]).toEqual([1]);
    expect(saves[0].args[1].stage_id).toBe(2);
    expect.verifySteps([]);
});

test("crm_graph model reads go through the disk cache", async () => {
    const seenCaches = [];
    const listener = (ev) => {
        if (ev.detail.data?.params?.method === "formatted_read_group") {
            seenCaches.push(ev.detail.settings.cache);
        }
    };
    rpcBus.addEventListener("RPC:REQUEST", listener);
    try {
        await mountView({
            resModel: "crm.lead",
            type: "graph",
            arch: `<graph js_class="crm_graph"/>`,
        });
    } finally {
        rpcBus.removeEventListener("RPC:REQUEST", listener);
    }
    expect(seenCaches[0].type).toBe("disk");
});
