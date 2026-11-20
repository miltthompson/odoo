import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    makeTestApp,
    mockOffline,
    models,
    mountWithCleanup,
    onRpc,
    webModels,
} from "@web/../tests/web_test_helpers";
import { isOfflineRecordId, offlineRecordId } from "@web/core/offline/offline_id";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import {
    getOfflineOverlay,
    overlayGroups,
    overlayList,
} from "@web/model/relational_model/offline_overlay";
import { RelationalModel } from "@web/model/relational_model/relational_model";
import { WebClient } from "@web/webclient/webclient";

const config = { context: {}, domain: [], fields: { active: {}, stage_id: {}, revenue: {} } };

function queued(id, values, extras = {}) {
    return {
        model: "crm.lead",
        method: "web_save",
        target: { model: "crm.lead", ids: [id] },
        extras: { overlayValues: values },
        ...extras,
    };
}

function group(stage, count, sum, records) {
    return {
        stage_id: { id: stage },
        __extra_domain: [["stage_id", "=", stage]],
        __count: count,
        __records: records,
        "revenue:sum": sum,
    };
}

test("a queued move updates the cached groups and their sums without altering the response", () => {
    const saved = { id: 2, name: "Acme", stage_id: { id: 1 }, revenue: 50 };
    const cached = { groups: [group(1, 21, 250, [saved]), group(2, 2, 20, [])] };
    const entries = [queued(2, { stage_id: { id: 2 } }), queued(2, { revenue: 80 })];
    const overlay = getOfflineOverlay(entries, "crm.lead", config.context);
    const { groups } = overlayGroups(cached, config, overlay);
    expect(groups.map((g) => [g.__count, g["revenue:sum"]])).toEqual([[20, 200], [3, 100]]);
    expect(groups[0].__records).toEqual([]);
    expect(groups[1].__records).toEqual([{ ...saved, stage_id: { id: 2 }, revenue: 80 }]);
    expect(cached.groups[0]).toEqual(group(1, 21, 250, [saved]));
    expect(cached.groups[1]).toEqual(group(2, 2, 20, []));
});

test("local creates and follow-up edits persist in the view while archived records disappear", () => {
    const archived = { id: 1, name: "Archived", active: true };
    const keep = { id: 2, name: "Keep", active: true };
    const localId = -17;
    const entries = [
        queued(localId, { name: "New lead", active: true }, { createdId: localId }),
        queued(localId, { name: "Edited offline" }),
        queued(archived.id, null, { method: "action_archive" }),
    ];
    const overlay = getOfflineOverlay(entries, "crm.lead", config.context);
    const saved = { length: 2, records: [archived, keep] };
    expect(overlayList(saved, config, overlay)).toEqual({
        length: 2,
        records: [{ id: localId, name: "Edited offline", active: true }, keep],
    });
    expect(overlay.get(localId).created).toBe(true);
    const filtered = overlayList(saved, { ...config, domain: [["company_id", "=", 2]] }, overlay);
    expect(filtered.records).toEqual([keep]);
});

test("a new offline record can be reopened and edited from a reloaded list", async () => {
    class OverlayModel extends RelationalModel {
        static offlineOverlay = true;
    }
    const views = registry.category("views");
    views.add("overlay_list", { ...views.get("list"), Model: OverlayModel });
    views.add("overlay_form", { ...views.get("form"), Model: OverlayModel });
    class Lead extends models.Model {
        name = fields.Char();
        _records = [{ id: 1, name: "Saved lead" }];
        _views = {
            "list,false": `<list js_class="overlay_list"><field name="name"/></list>`,
            "form,false": `<form js_class="overlay_form"><field name="name"/></form>`,
            "search,false": `<search/>`,
        };
    }
    defineModels([Lead, ...Object.values(webModels)]);
    defineActions([{ id: 1, res_model: "lead", views: [[false, "list"], [false, "form"]] }]);
    const setOffline = mockOffline();
    expect.errors(4);
    await mountWithCleanup(WebClient);
    const action = getService("action");
    const offline = getService(OfflinePlugin);
    await action.doAction(1);
    await contains(".o_list_button_add").click();
    await contains(".o_back_button").click();

    await setOffline(true);
    await contains(".o_list_button_add").click();
    await contains(".o_field_widget[name='name'] input").edit("Created offline");
    await contains(".o_back_button").click();
    await action.doAction(1);
    expect(".o_data_cell:first").toHaveText("Created offline");
    const [create] = offline.getPendingEntries();
    expect(isOfflineRecordId(create.createdId)).toBe(true);

    await contains(".o_data_cell:first").click();
    expect(".o_field_widget[name='name'] input").toHaveValue("Created offline");
    await contains(".o_field_widget[name='name'] input").edit("Edited offline");
    await contains(".o_back_button").click();
    expect(".o_data_cell:first").toHaveText("Edited offline");
    const [, edit] = offline.getPendingEntries();
    expect(edit.target.ids).toEqual([create.createdId]);
    expect(edit.refs).toEqual([create.key]);
    expect(edit.args).toEqual([[`offline:${create.key}`], { name: "Edited offline" }]);
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/lead/onchange" couldn't be established`,
        ...Array(3).fill(`Connection to "/web/dataset/call_kw/lead/web_search_read" couldn't be established`),
    ]);
});

test("an aged replay acknowledgement maps the local record id before removing the change", async () => {
    onRpc("/web/offline/sync", () => ({ already_applied: true, created_ids: [123] }));
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const key = window.crypto.randomUUID();
    const createdId = offlineRecordId(key);
    offline.scheduleORM("res.partner", "web_save", [[], { name: "Created earlier" }], {}, {
        key, createdId, target: { model: "res.partner", ids: [createdId] },
    });
    await offline._syncORM();
    expect((await offline.resolveOfflineRecord("res.partner", createdId)).id).toBe(123);
    expect(offline.getPendingEntries()).toEqual([]);
});
