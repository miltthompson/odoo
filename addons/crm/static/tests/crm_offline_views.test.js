import { afterEach, animationFrame, expect, test } from "@odoo/hoot";
import { browser } from "@web/core/browser/browser";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { offlineCachedModel } from "@crm/offline/offline_cached_model";
import { session } from "@web/session";
import {
    contains,
    getService,
    getTestApp,
    makeTestApp,
    mockOffline,
    mountView,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { Store as StoreService } from "@mail/core/common/store_service";
import { patch } from "@web/core/utils/patch";
import { defineCrmModels } from "@crm/../tests/crm_test_helpers";

const LOST_KEY = `crm.offline_lost_action_id.${session.db}`;

defineCrmModels();

function stubStoreFetch() {
    // the debounced store fetch must never hit the wire in offline tests: a
    // 502 becomes an unverified error, a success flips isOffline back to false
    patch(StoreService.prototype, {
        fetchStoreData: () => Promise.resolve({ data: {} }),
    });
}

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
            <field name="stage_id" widget="statusbar" options="{'clickable': '1'}"/>
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
    if (!getTestApp()) {
        return;
    }
    // queued calls persist in indexeddb across tests: drop them
    const scheduled = getService(OfflinePlugin)._ormToSync();
    for (const key of Object.keys(scheduled)) {
        await getService(OfflinePlugin).removeScheduledORM(key);
    }
    browser.localStorage.removeItem(LOST_KEY);
});

// must run first: the prefetch listener triggers on the first crm.lead rpc and
// its module-level flags are shared across the whole run
test("prefetch: lost reasons and lost action id are cached after a crm.lead rpc", async () => {
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await animationFrame();
    await animationFrame();
    expect(browser.localStorage.getItem(LOST_KEY)).toBe("99");
    const reasons = await getService(OfflinePlugin).searchMany2XRecords("crm.lost.reason", "");
    expect(reasons.map((r) => r.id).sort()).toEqual([11, 12]);
});

test("offline: whitelisted header buttons stay enabled, others get disabled", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
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

test("offline: Won button on the form queues action_set_won_rainbowman", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await setOffline(true);

    await contains("button[name='action_set_won_rainbowman']").click();

    const posts = scheduledValues().filter((v) => v.method === "action_set_won_rainbowman");
    expect(posts).toHaveLength(1);
    expect(posts[0].model).toBe("crm.lead");
    expect(posts[0].args).toEqual([[1]]);
    // mountView runs outside the action stack so the controller-derived extras
    // (viewType, actionId) are legitimately absent here; the queue payload must
    // still carry a timestamp and a display name
    expect(typeof posts[0].extras.timeStamp).toBe("number");
    expect(posts[0].extras.displayName).toBe("Lead 1");
});

test("offline: Lost button opens reason dialog and queues action_set_lost + note", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    browser.localStorage.setItem(LOST_KEY, "99");
    await makeTestApp();
    await getService(OfflinePlugin).cacheMany2XSearch("crm.lost.reason", [
        { id: 11, display_name: "Too expensive" },
        { id: 12, display_name: "No answer" },
    ]);
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await setOffline(true);

    await contains("button[name='99']").click();
    await contains(".modal select").select("11");
    await contains(".modal textarea").edit("too pricey");
    await contains(".modal .btn-primary").click();

    const values = scheduledValues();
    const lost = values.find((v) => v.method === "action_set_lost");
    expect(lost).not.toBe(undefined);
    expect(lost.kwargs.lost_reason_id).toBe(11);
    const note = values.find((v) => v.method === "message_post");
    expect(note).not.toBe(undefined);
    expect(note.kwargs.body).toBe("too pricey");
    expect(note.kwargs.subtype_xmlid).toBe("mail.mt_note");
});

test("offline: Lost dialog with no reason queues action_set_lost without kwargs", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    browser.localStorage.setItem(LOST_KEY, "99");
    await makeTestApp();
    await getService(OfflinePlugin).cacheMany2XSearch("crm.lost.reason", [
        { id: 11, display_name: "Too expensive" },
    ]);
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await setOffline(true);

    await contains("button[name='99']").click();
    await contains(".modal .btn-primary").click();

    const values = scheduledValues();
    const lost = values.find((v) => v.method === "action_set_lost");
    expect(lost).not.toBe(undefined);
    expect(lost.kwargs.lost_reason_id).toBe(undefined);
    expect(values.find((v) => v.method === "message_post")).toBe(undefined);
});

test("offline: Lost dialog cancel queues nothing", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    browser.localStorage.setItem(LOST_KEY, "99");
    await makeTestApp();
    await getService(OfflinePlugin).cacheMany2XSearch("crm.lost.reason", [
        { id: 11, display_name: "Too expensive" },
    ]);
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await setOffline(true);

    await contains("button[name='99']").click();
    await contains(".modal .btn-secondary").click();

    expect(scheduledValues()).toHaveLength(0);
});

test("offline: statusbar stage buttons are tagged available on crm.lead", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await setOffline(true);

    expect(".o_statusbar_status .o_arrow_button_wrap .o_arrow_button").toHaveCount(3, {
        message: "the three stages render as arrow buttons",
    });
    expect(
        ".o_statusbar_status .o_arrow_button_wrap .o_arrow_button[data-available-offline]"
    ).toHaveCount(3);
});

test("offline: kanban stage drag queues the save without rainbowman", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
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

test("offline: form stage change does not fetch the rainbowman message", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    onRpc("crm.lead", "get_rainbowman_message", () => {
        expect.step("rainbowman");
    });
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: formArch });
    await setOffline(true);

    // stage buttons render right-to-left: Won is first, current stage (New) is
    // disabled. Clicking Won changes stage without fetching the rainbowman.
    await contains(".o_statusbar_status .o_arrow_button_wrap .o_arrow_button:eq(0)").click();
    await animationFrame();
    await animationFrame();
    await animationFrame();

    const saves = scheduledValues().filter((v) => v.method === "web_save");
    expect(saves).toHaveLength(1);
    expect.verifySteps([]);
});

test("offlineCachedModel wraps model reads with the disk cache", async () => {
    class FakeModel {
        constructor(env, params, services) {
            this.env = env;
            this.orm = services.orm;
            this.setup(params, services);
        }
        setup() {}
        async load() {}
    }
    const env = {
        config: { actionId: 1, viewType: "graph" },
        services: {
            offline: {
                offline: false,
                setAvailableOffline: () => expect.step("available"),
            },
        },
        searchModel: { getCurrentSearch: () => ({ domain: [] }) },
    };
    const spyOrm = {
        _cache: false,
        call(model, method) {
            expect.step(`orm.call ${method}`);
            return Promise.resolve();
        },
        cache(options) {
            expect.step(`orm.cache ${options.type} noCache=${options.noCache}`);
            return Object.assign(Object.create(this), { _cache: options });
        },
    };
    const Model = offlineCachedModel(FakeModel);
    const model = new Model(env, {}, { orm: spyOrm });

    // read method: wrapped through orm.cache (online => noCache, fresh fetch)
    await model.orm.call("crm.lead", "web_read", [[1]], {});
    expect.verifySteps(["orm.cache disk noCache=true", "orm.call web_read"]);

    // write method: goes straight through
    await model.orm.call("crm.lead", "create", [[{}]], {});
    expect.verifySteps(["orm.call create"]);

    await model.load();
    expect.verifySteps(["available"]);
});
