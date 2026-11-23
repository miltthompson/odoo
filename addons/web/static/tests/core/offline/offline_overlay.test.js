import { animationFrame, expect, mockDate, test } from "@odoo/hoot";
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
    patchWithCleanup,
    webModels,
} from "@web/../tests/web_test_helpers";
import { isOfflineRecordId, offlineRecordId } from "@web/core/offline/offline_id";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
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

async function mountOverlayView(type, template, resId, params) {
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
        currency_id = fields.Many2one({ relation: "res.currency" });
        revenue = fields.Monetary({ aggregator: "sum", currency_field: "currency_id" });
        line_ids = fields.One2many({ relation: "lead.line", relation_field: "lead_id" });
        _records = [{ id: 1, name: "Saved lead", active: true, line_ids: [21] }];
    }
    class LeadLine extends models.Model {
        _name = "lead.line";
        lead_id = fields.Many2one({ relation: "lead" });
        description = fields.Char();
        _records = [{ id: 21, lead_id: 1, description: "Cached child description" }];
    }
    defineModels([Lead, Stage, LeadLine, ...Object.values(webModels)]);
    await mountView({
        type, resModel: "lead", resId,
        arch: `<${type} js_class="testing_overlay_${type}">${template}</${type}>`,
        ...params,
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
    await animationFrame();
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

test("bulk archive on a stale local row sends immediately and blocks later server-ID edits", async () => {
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        expect.step([params.method, params.args[0]]);
        return new Response(JSON.stringify({ error: { code: 200, data: { name: "odoo.exceptions.AccessError" } } }));
    });
    const model = await mountOverlayView("list", `<field name="name"/><field name="active"/>`);
    const offline = getService(OfflinePlugin);
    const key = window.crypto.randomUUID();
    const localId = offlineRecordId(key);
    await offline._queue.recordResolution("lead", localId, key, 47);
    model.root._setData({ records: [{ id: localId, name: "Stale row", active: true }], length: 1 });
    model.root.records[0]._toggleSelection(true);
    let sync;
    patchWithCleanup(offline, {
        syncPendingChanges() {
            sync = super.syncPendingChanges();
            return sync;
        },
    });
    expect(await model.root._toggleArchive(true, true)).toBe(true);
    await sync;
    expect.verifySteps([["action_archive", [47]]]);
    const [archive] = await offline._queue.list();
    expect(archive.target.ids).toEqual([47]);
    expect(archive.state).toBe("needs_attention");

    await offline.scheduleORMDurably("lead", "web_save", [[47], { name: "Later" }], {});
    await offline._syncORM();
    expect.verifySteps([]);
    expect((await offline._queue.list()).map(({ state }) => state)).toEqual(["needs_attention", "held_back"]);
});

test("an archive already queued when its create replays blocks a later server-ID edit", async () => {
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        expect.step([params.method, params.args[0]]);
        return params.method === "web_save" && !params.args[0].length
            ? [{ id: 47 }]
            : new Response(JSON.stringify({ error: { code: 200, data: { name: "odoo.exceptions.AccessError" } } }));
    });
    const model = await mountOverlayView("list", `<field name="name"/><field name="active"/>`);
    const offline = getService(OfflinePlugin);
    const key = window.crypto.randomUUID();
    const localId = offlineRecordId(key);
    await offline.scheduleORMBatch([{
        model: "lead", method: "web_save", args: [[], { name: "Draft" }], kwargs: {},
        options: { key, createdId: localId },
    }]);
    model.root._setData({ records: [{ id: localId, name: "Draft", active: true }], length: 1 });
    model.root.records[0]._toggleSelection(true);
    expect(await model.root._toggleArchive(true, true)).toBe(true);
    await offline._syncORM();
    expect.verifySteps([["web_save", []], ["action_archive", [`offline:${key}`]]]);
    const [archive] = await offline._queue.list();
    expect(archive.target.ids).toEqual([47]);
    expect(archive.state).toBe("needs_attention");

    await offline.scheduleORMDurably("lead", "web_save", [[47], { name: "Later" }], {});
    await offline._syncORM();
    expect.verifySteps([]);
    expect((await offline._queue.list()).map(({ state }) => state)).toEqual(["needs_attention", "held_back"]);
});

test("saving a dirty local form after its create replayed syncs the edit immediately", async () => {
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        expect.step(params.args);
        return [{ id: 47 }];
    });
    const model = await mountOverlayView("form", `<field name="name"/>`);
    const offline = getService(OfflinePlugin);
    const record = model.root;
    record._applyChanges({ name: "Draft" });
    expect(await record._offlineSave()).toBe(true);
    record._applyChanges({ name: "Later edit" });
    record.dirty = true;
    await offline._syncORM();
    expect.verifySteps([[[], { name: "Draft" }]]);
    expect(isOfflineRecordId(record.resId)).toBe(true);

    let sync;
    patchWithCleanup(offline, {
        syncPendingChanges() {
            sync = super.syncPendingChanges();
            return sync;
        },
    });
    expect(await record._save()).toBe(true);
    await sync;
    expect.verifySteps([[[47], { name: "Later edit" }]]);
    expect(offline.getPendingEntries()).toEqual([]);
});

test("saving an open local record after its receipt expires reuses the original UUID", async () => {
    mockDate("2026-01-01T12:00:00");
    const model = await mountOverlayView("form", `<field name="name"/>`);
    const offline = getService(OfflinePlugin);
    const record = model.root;
    record._applyChanges({ name: "Draft" });
    expect(await record._offlineSave()).toBe(true);
    const [create] = offline.getPendingEntries();
    const localId = record.resId;
    // Replay in another tab does not update the open form in this tab.
    await offline._queue.lock(async () => {
        await offline._queue.recordResolution(record.resModel, localId, create.key, 1);
        await offline._queue.remove(create.key);
    });
    mockDate("2026-02-02T12:00:00");
    expect(await offline.resolveOfflineRecord(record.resModel, localId)).toBe(undefined);
    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        sent.push(params);
        return params.key === create.key ? { already_applied: true, created_ids: [1] } : [{ id: 1 }];
    });
    record._applyChanges({ name: "After expiry" });
    expect(await record.save()).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0].key).toBe(create.key);
    expect(sent[0].args).toEqual(create.args);
    expect(sent[1].args).toEqual([[`offline:${create.key}`], { name: "After expiry" }]);
    expect(record.resId).toBe(1);
    expect(await offline._queue.list()).toEqual([]);
});

test("saving an aged temporary record after discard does not resurrect its create", async () => {
    mockDate("2026-01-01T12:00:00");
    const model = await mountOverlayView("form", `<field name="name"/>`);
    const record = model.root;
    const offline = getService(OfflinePlugin);
    onRpc("/web/offline/sync", () => expect.step("unexpected replay"));
    onRpc("web_save", () => expect.step("unexpected direct write"));
    await record.update({ name: "Discarded draft" });
    expect(await record._offlineSave()).toBe(true);
    expect(isOfflineRecordId(record.resId)).toBe(true);
    const [create] = offline.getPendingEntries();
    mockDate("2026-02-02T12:00:00");
    await offline.discardPendingChange(create.key);
    await record.update({ name: "Keep this edit" });
    expect(await record.save()).toBe(false);
    expect(record.data.name).toBe("Keep this edit");
    expect(await offline._queue.list()).toEqual([]);
    expect.verifySteps([]);
});

test("opening an exact rejected edit to the server ID preserves replay order", async () => {
    const model = await mountOverlayView("form", `<field name="name"/>`, 1);
    const offline = getService(OfflinePlugin);
    model.root._applyChanges({ name: "Rejected edit" });
    expect(await model.root._offlineSave()).toBe(true);
    const [entry] = offline.getPendingEntries();
    expect(entry.args[0]).toEqual([1]);
    expect(entry.resolvedResId).toBe(undefined);
    await offline._queue.lock(() => offline._storeState(entry, "needs_attention", "Not applied"));
    onRpc("web_save", () => expect.step("unexpected direct write"));
    onRpc("/web/offline/sync", () => expect.step("unexpected replay"));
    await model.root.setOfflineChanges(entry.key);
    expect(model.root.data.name).toBe("Rejected edit");
    let sync;
    patchWithCleanup(offline, {
        syncPendingChanges() {
            sync = super.syncPendingChanges();
            return sync;
        },
    });
    await model.root.update({ name: "Queued behind the rejection" });
    expect(await model.root.save()).toBe(true);
    await sync;
    const [, correction] = await offline._queue.list();
    expect(correction.state).toBe("held_back");
    expect(correction.args).toEqual([[1], { name: "Queued behind the rejection" }]);
    expect.verifySteps([]);
});

test("a temporary parent keeps line edits out of replay and preserves them for reapplication", async () => {
    const setOffline = mockOffline();
    const model = await mountOverlayView("form", `<field name="name"/>
        <field name="line_ids"><list editable="bottom"><field name="description"/></list></field>`);
    const record = model.root;
    const offline = getService(OfflinePlugin);
    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        sent.push((await request.json()).params);
        return [{ id: 1 }];
    });
    await record.update({ name: "Draft", line_ids: [[0, 0, { description: "Initial line" }]] });
    expect(await record._offlineSave()).toBe(true);
    expect(isOfflineRecordId(record.resId)).toBe(true);
    await animationFrame();
    expect(".o_field_x2many_list_row_add button").toHaveCount(0);
    const [line] = record.data.line_ids.records;
    await line.update({ description: "Retained edit" });
    await setOffline(true);
    expect(await record.save()).toBe(true);
    const [create, change] = await offline._queue.list();
    expect(change.refs).toEqual([create.key]);
    expect(change.state).toBe("needs_attention");
    expect(change.args[1].line_ids).toEqual([[1, line._virtualId, { description: "Retained edit" }]]);
    await setOffline(false);
    await offline.syncPendingChanges();
    expect(sent.map(({ key }) => key)).toEqual([create.key]);
    expect((await offline._queue.get(change.key)).target.ids).toEqual([1]);
});

test("opening an unrelated save preserves cached one2many child data", async () => {
    const setOffline = mockOffline();
    const model = await mountOverlayView("form", `<field name="name"/>
        <field name="line_ids"><list><field name="description"/></list></field>`, 1);
    const record = model.root;
    expect(record.data.line_ids.records[0].data.description).toBe("Cached child description");
    await setOffline(true);
    record._applyChanges({ name: "Edited name" });
    expect(await record._offlineSave()).toBe(true);
    const [entry] = getService(OfflinePlugin).getPendingEntries();
    await record.setOfflineChanges(entry.key);
    expect(record.data.name).toBe("Edited name");
    expect(record.data.line_ids.records[0].data.description).toBe("Cached child description");
});

test("a projected many2one group supplies data for the group header record", () => {
    const stage = { id: 7, display_name: "Qualified" };
    const localId = -17;
    const overlay = getOfflineOverlay([queued(localId, { stage_id: stage }, { createdId: localId })], "crm.lead", {});
    const { groups } = overlayGroups({ length: 0, groups: [] }, {
        ...config, groupBy: ["stage_id"], fields: { ...config.fields, stage_id: { type: "many2one" } },
    }, overlay);
    expect(groups).toHaveLength(1);
    expect(groups[0].__values).toEqual(stage);
});

test("a grouped monetary view warms offline currency rates without blocking its load", async () => {
    patchWithCleanup(user, {
        get activeCompany() {
            return { id: 1, currency_id: 1 };
        },
    });
    const readStarted = Promise.withResolvers();
    const rateResponse = Promise.withResolvers();
    onRpc("/web/dataset/call_kw/res.currency/read", () => {
        readStarted.resolve();
        return rateResponse.promise;
    });
    await mountOverlayView("list", `<field name="stage_id"/><field name="revenue" sum="Total"/>`,
        undefined, { groupBy: ["stage_id"] });
    await readStarted.promise;
    expect(".o_list_view").toBeVisible();
    rateResponse.resolve([{ id: 2, inverse_rate: 0.5, rate_date: "2025-01-01" }]);
    await animationFrame();
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
