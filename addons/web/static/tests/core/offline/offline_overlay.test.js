import { expect, test } from "@odoo/hoot";
import { mockSendBeacon } from "@odoo/hoot-mock";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    makeTestApp,
    mockOffline,
    models,
    mountView,
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

test("a cached card can move through an unread filter to a new group", () => {
    const saved = { id: 2, name: "Acme", stage_id: { id: 1 }, revenue: 50 };
    const cached = { length: 1, groups: [group(1, 1, 50, [saved])] };
    const stage = { id: 2, display_name: "Won" };
    const overlay = getOfflineOverlay([queued(2, { stage_id: stage })], "crm.lead", config.context);
    const result = overlayGroups(cached, {
        ...config,
        groupBy: ["stage_id"],
        domain: [["unread_field", "=", 7]],
        fields: {
            ...config.fields,
            stage_id: { name: "stage_id", type: "many2one" },
            revenue: { name: "revenue", type: "float", aggregator: "sum" },
        },
    }, overlay);
    expect(result.length).toBe(2);
    expect(result.groups.map((g) => [g.__count, g["revenue:sum"]])).toEqual([[0, 0], [1, 50]]);
    expect(result.groups[1].stage_id).toEqual([2, "Won"]);
    expect(result.groups[1].__records).toEqual([{ ...saved, stage_id: stage }]);
    expect(cached.groups[0].__records).toEqual([saved]);
});

test("monetary overlay updates converted totals and currencies when a card moves", () => {
    const saved = { id: 2, stage_id: { id: 1 }, revenue: 50, currency_id: { id: 2 } };
    const other = { id: 3, stage_id: { id: 1 }, revenue: 20, currency_id: { id: 1 } };
    const cached = {
        groups: [
            { ...group(1, 2, 70, [saved, other]), "currency_id:array_agg_distinct": [1, 2], "revenue:sum_currency": 120 },
            { ...group(2, 0, 0, []), "currency_id:array_agg_distinct": [], "revenue:sum_currency": 0 },
        ],
    };
    const overlay = getOfflineOverlay([queued(2, { stage_id: { id: 2 }, revenue: 80 })], "crm.lead", config.context);
    const { groups } = overlayGroups(cached, {
        ...config,
        fields: { ...config.fields, revenue: { currency_field: "currency_id" } },
    }, overlay, { 2: { rate: 2 } }, 1);
    expect(groups.map((g) => [g["revenue:sum"], g["revenue:sum_currency"], g["currency_id:array_agg_distinct"]]))
        .toEqual([[20, 20, [1]], [80, 160, [2]]]);
});

async function mountOverlayView(type, template, resId) {
    let model;
    class OverlayModel extends RelationalModel {
        static offlineOverlay = true;
        setup(...args) {
            super.setup(...args);
            model = this;
        }
    }
    const views = registry.category("views");
    views.add(`testing_overlay_${type}`, { ...views.get(type), Model: OverlayModel });
    class Stage extends models.Model {
        _records = [{ id: 7, display_name: "Qualified" }];
    }
    class Lead extends models.Model {
        name = fields.Char();
        stage_id = fields.Many2one({ relation: "stage" });
        active = fields.Boolean({ default: true });
        _records = [{ id: 1, name: "Saved lead", active: true }];
    }
    defineModels([Lead, Stage, ...Object.values(webModels)]);
    await mountView({
        type, resModel: "lead", resId,
        arch: `<${type} js_class="testing_overlay_${type}">${template}</${type}>`,
    });
    await getService(OfflinePlugin).getQueueReady();
    return model;
}

test("an offline relation keeps its label and ID when a queued form is reopened", async () => {
    const setOffline = mockOffline();
    const model = await mountOverlayView("form", `<field name="name"/><field name="stage_id"/>`);
    await setOffline(true);
    const record = model.root;
    record._applyChanges({ name: "New lead", stage_id: { id: 7, display_name: "Qualified" } });
    expect(await record._offlineSave()).toBe(true);
    const id = record.resId;
    await model.load({ resId: id });
    expect(model.root.data.stage_id).toEqual({ id: 7, display_name: "Qualified" });
    expect(".o_field_widget[name='stage_id'] input").toHaveValue("Qualified");
});

test("an urgent save on a local ID after reconnect does not send a beacon or clear the edit", async () => {
    const setOffline = mockOffline();
    const model = await mountOverlayView("form", `<field name="name"/>`);
    const offline = getService(OfflinePlugin);
    const record = model.root;
    await setOffline(true);
    record._applyChanges({ name: "Draft" });
    expect(await record._offlineSave()).toBe(true);
    record._applyChanges({ name: "Unsaved edit" });
    record.dirty = true;
    model.useSendBeaconToSaveUrgently = true;
    mockSendBeacon(() => expect.step("sent a beacon"));
    // Exercise the interval after the connection is reported up but before the draft is synced.
    offline.isOffline.set(false);
    expect(await record.urgentSave()).toBe(false);
    expect.verifySteps([]);
    expect(record.dirty).toBe(true);
    expect(record.data.name).toBe("Unsaved edit");
});

test("bulk archive and unlink target the create reference, not the local ID", async () => {
    const model = await mountOverlayView("list", `<field name="name"/><field name="active"/>`);
    const offline = getService(OfflinePlugin);
    const key = window.crypto.randomUUID();
    const createdId = offlineRecordId(key);
    const context = model.root.context;
    await offline.scheduleORMBatch([{
        model: "lead", method: "web_save", args: [[], { name: "New lead" }], kwargs: { context },
        options: {
            key, createdId, target: { model: "lead", ids: [createdId] },
            extras: { overlayValues: { name: "New lead", active: true } },
        },
    }]);
    model.root._setData({
        records: [{ id: createdId, name: "New lead", active: true }, { id: 1, name: "Saved lead", active: true }],
        length: 2,
    });
    const records = model.root.records;
    for (const record of records) {
        record._toggleSelection(true);
    }
    expect(await model.root._toggleArchive(true, true)).toBe(true);
    expect(await model.root._deleteRecords(records)).toBe(true);
    const [, archive, unlink] = await offline._queue.list();
    for (const [entry, method] of [[archive, "action_archive"], [unlink, "web_unlink"]]) {
        expect(entry.method).toBe(method);
        expect(entry.args).toEqual([[`offline:${key}`, 1]]);
        expect(entry.target.ids).toEqual([createdId, 1]);
        expect(entry.refs).toEqual([key]);
    }
});

test("follow-up saves of an older durable draft keep referencing its original create", async () => {
    const model = await mountOverlayView("form", `<field name="name"/>`);
    const offline = getService(OfflinePlugin);
    const legacyKey = offline.scheduleORM("lead", "web_save", [[], { name: "Draft" }], {}, {
        extras: { changes: { name: "Draft" } },
    });
    const { key } = offline.getPendingEntry(legacyKey);
    await offline.waitForPendingWrite(key);
    const record = model.root;
    await record.setOfflineChanges(legacyKey);
    for (const name of ["First edit", "Second edit"]) {
        record._applyChanges({ name });
        expect(await record._offlineSave()).toBe(true);
        expect(record.isNew).toBe(true);
    }
    const [, ...edits] = await offline._queue.list();
    expect(edits.map(({ args, refs, createdId }) => [args, refs, createdId])).toEqual([
        [[[`offline:${key}`], { name: "First edit" }], [key], undefined],
        [[[`offline:${key}`], { name: "Second edit" }], [key], undefined],
    ]);
});

test("opening the exact queued save overrides the latest form overlay", async () => {
    const setOffline = mockOffline();
    const model = await mountOverlayView("form", `<field name="name"/>`, 1);
    await setOffline(true);
    for (const name of ["First edit", "Latest edit"]) {
        model.root._applyChanges({ name });
        expect(await model.root._offlineSave()).toBe(true);
    }
    expect(model.root.data.name).toBe("Latest edit");
    const [first] = getService(OfflinePlugin).getPendingEntries();
    await model.root.setOfflineChanges(first.key);
    expect(model.root.data.name).toBe("First edit");
});
