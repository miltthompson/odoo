import { animationFrame, expect, queryAllTexts, test } from "@odoo/hoot";
import { makeErrorFromResponse } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { OfflineQueueStore } from "@web/core/offline/offline_storage";
import { DynamicGroupList } from "@web/model/relational_model/dynamic_group_list";
import { DynamicList } from "@web/model/relational_model/dynamic_list";
import { Record } from "@web/model/relational_model/record";
import {
    contains, defineModels, fields, getService, makeTestApp, mockOffline, models, mountView,
    onRpc, patchWithCleanup, webModels,
} from "@web/../tests/web_test_helpers";

function rejection(code, name) {
    return new Response(JSON.stringify({ error: { code, data: { name } } }), {
        headers: { "Content-Type": "application/json" },
    });
}

function queueChange(offline, recordId, name, timeStamp) {
    offline.scheduleORM("res.partner", "write", [[recordId], { name }], {}, {
        id: recordId,
        extras: { timeStamp },
    });
}

test("sync sends all changes by sequence and retries dependencies with the same UUID", async () => {
    const sent = [];
    let rejectFirst = true;
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        sent.push([params.args[1].name, params.key]);
        if (rejectFirst && params.args[1].name === "First") {
            return rejection(0, "odoo.exceptions.AccessError");
        }
        return true;
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    queueChange(offline, 1, "First", 30);
    queueChange(offline, 1, "Second", 20);
    queueChange(offline, 2, "Unrelated", 10);
    await offline._syncORM();
    expect(sent.map(([name]) => name)).toEqual(["First", "Unrelated"]);
    const [first, second] = offline.getPendingEntries();
    expect([first.state, second.state]).toEqual(["needs_attention", "held_back"]);
    expect([first.seq, second.seq]).toEqual([1, 2]);

    rejectFirst = false;
    await offline.retryPendingChange(first.key);
    expect(sent.slice(2)).toEqual([["First", first.key], ["Second", second.key]]);
    expect(offline.getPendingEntries()).toEqual([]);
});

test("editing a legacy local draft queues a write referencing its first create", async () => {
    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        sent.push(params);
        return [{ id: 47 }];
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const draft = offline.scheduleORM("res.partner", "web_save", [[], { name: "Draft" }], {});
    offline.scheduleORM("res.partner", "web_save", [[], { name: "Edited draft" }], {}, { id: draft });
    expect(offline._ormToSync()[draft].value.args[0]).toEqual([]);
    await offline._syncORM();
    expect(sent).toHaveLength(2);
    expect(sent[1].refs).toEqual([sent[0].key]);
    expect(sent[1].args).toEqual([[`offline:${sent[0].key}`], { name: "Edited draft" }]);
});

test("failed draft saves do not leave a create behind and follow-up saves only send the delta", async () => {
    class Lead extends models.Model {
        name = fields.Char();
        email = fields.Char();
    }
    defineModels([Lead]);
    const setOffline = mockOffline();
    await mountView({
        type: "form", resModel: "lead",
        arch: `<form><field name="name"/><field name="email"/></form>`,
    });
    const offline = getService(OfflinePlugin);
    let fail = true;
    patchWithCleanup(offline._queue.db, {
        async write(table, ...args) {
            if (fail && table === "entries") {
                throw new Error("Storage is full");
            }
            return super.write(table, ...args);
        },
    });
    await setOffline(true);
    await contains(".o_field_widget[name='name'] input").edit("Draft");
    await contains(".o_field_widget[name='email'] input").edit("contact@example.com");
    await contains(".o_form_button_save").click();
    expect(offline.getPendingEntries()).toEqual([]);
    expect(".o_form_button_save").toBeVisible();

    fail = false;
    await contains(".o_form_button_save").click();
    const [create] = offline.getPendingEntries();
    expect(create.args).toEqual([[], { name: "Draft", email: "contact@example.com" }]);
    await contains(".o_field_widget[name='name'] input").edit("Updated draft");
    await contains(".o_form_button_save").click();
    const [, edit] = await offline._queue.list();
    expect(edit.args).toEqual([[`offline:${create.key}`], { name: "Updated draft" }]);
});

test("an open form cannot queue a change for a discarded local record", async () => {
    class Lead extends models.Model {
        name = fields.Char();
        email = fields.Char();
    }
    defineModels([Lead]);
    const setOffline = mockOffline();
    await mountView({
        type: "form", resModel: "lead",
        arch: `<form><field name="name"/><field name="email"/></form>`,
    });
    const offline = getService(OfflinePlugin);
    await setOffline(true);
    await contains(".o_field_widget[name='name'] input").edit("Initial draft");
    await contains(".o_field_widget[name='email'] input").edit("contact@example.com");
    await contains(".o_form_button_save").click();
    const [first] = offline.getPendingEntries();
    await offline.discardPendingChange(first.key);

    await contains(".o_field_widget[name='name'] input").edit("Saved again");
    await contains(".o_form_button_save").click();
    // An assigned offline ID identifies the discarded record, not a new form.
    expect(await offline._queue.list()).toEqual([]);
    expect(".o_form_button_save").toBeVisible();
    expect(".o_field_widget[name='name'] input").toHaveValue("Saved again");
});

test("a draft discarded by another tab is recreated with its selected tags", async () => {
    class Tag extends models.Model {
        _records = [{ id: 6, display_name: "Priority" }];
    }
    class Lead extends models.Model {
        name = fields.Char();
        tag_ids = fields.Many2many({ relation: "tag", default: [6] });
    }
    defineModels([Lead, Tag]);
    let record;
    patchWithCleanup(Record.prototype, {
        setup(config) {
            super.setup(...arguments);
            if (config.isRoot) {
                record = this;
            }
        },
    });
    const setOffline = mockOffline();
    await mountView({
        type: "form", resModel: "lead",
        arch: `<form><field name="name"/><field name="tag_ids" widget="many2many_tags"/></form>`,
    });
    const offline = getService(OfflinePlugin);
    const [draftId] = await offline.scheduleORMBatch([{
        model: "lead", method: "web_save", args: [[], { name: "Initial draft" }], kwargs: {},
        options: { extras: { changes: { name: "Initial draft" } } },
    }]);
    const [draft] = offline.getPendingEntries();
    await record.setOfflineChanges(draftId);
    await setOffline(true);
    // Simulate another tab discarding it without updating this tab's snapshot.
    await offline._queue.lock(() => offline._queue.remove(draft.key));
    expect(offline.getPendingEntries().map(({ key }) => key)).toEqual([draft.key]);
    expect(".o_field_many2many_tags .badge").toHaveCount(1);

    await contains(".o_field_widget[name='name'] input").edit("Recreated draft");
    await contains(".o_form_button_save").click();
    const entries = await offline._queue.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].refs).toEqual([]);
    expect(entries[0].args).toEqual([[], { name: "Recreated draft", tag_ids: [[6, false, [6]]] }]);
});

test("an offline save uses the create receipt persisted by another tab", async () => {
    class Lead extends models.Model {
        name = fields.Char();
        email = fields.Char();
    }
    defineModels([Lead]);
    let record;
    patchWithCleanup(Record.prototype, {
        setup() {
            super.setup(...arguments);
            record = this;
        },
    });
    const setOffline = mockOffline();
    await mountView({
        type: "form", resModel: "lead", arch: `<form><field name="name"/><field name="email"/></form>`,
    });
    const offline = getService(OfflinePlugin);
    const changes = { name: "Draft", email: "initial@example.com" };
    const [draftId] = await offline.scheduleORMBatch([{
        model: "lead", method: "web_save", args: [[], changes], kwargs: {},
        options: { extras: { changes } },
    }]);
    const [draft] = offline.getPendingEntries();
    await record.setOfflineChanges(draftId);
    await setOffline(true);
    await offline._queue.lock(async () => {
        await offline._queue.recordResolution("lead", draft.key, draft.key, 47);
        await offline._queue.remove(draft.key);
    });
    expect(offline.getPendingEntries().map(({ key }) => key)).toEqual([draft.key]);

    record._applyChanges({ name: "Later edit" });
    expect(await record._offlineSave()).toBe(true);
    const [entry] = await offline._queue.list();
    expect(entry.args).toEqual([[47], { name: "Later edit" }]);
    expect(entry.refs).toEqual([]);
    expect(entry.target.ids).toEqual([47]);
});

test("a successful draft replay records the server ID before removing the create", async () => {
    onRpc("/web/offline/sync", () => ({ already_applied: true, created_ids: [47] }));
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const id = offline.scheduleORM("res.partner", "web_save", [[], { name: "Earlier draft" }], {});
    const { key } = offline.getPendingEntry(id);
    await offline._syncORM();
    expect(await offline._queue.resolveRecord("res.partner", key)).toEqual({ id: 47, key });
    expect(await offline._queue.list()).toEqual([]);
});

test("offline archive and delete keep the selection when storage fails", async () => {
    class Lead extends models.Model {
        name = fields.Char();
        active = fields.Boolean({ default: true });
        _records = [{ id: 1, name: "One" }];
    }
    defineModels([Lead, ...Object.values(webModels)]);
    let list;
    patchWithCleanup(DynamicList.prototype, {
        setup() {
            super.setup();
            list = this;
        },
    });
    const setOffline = mockOffline();
    await mountView({ type: "list", resModel: "lead", arch: `<list><field name="name"/></list>` });
    const offline = getService(OfflinePlugin);
    let fail = true;
    patchWithCleanup(offline._queue, {
        async addMany(entries) {
            if (fail) {
                throw new Error("Storage is full");
            }
            return super.addMany(entries);
        },
    });
    await setOffline(true);
    const [lead] = list.records;
    lead.toggleSelection(true);
    expect(await list.archive(true)).toBe(false);
    expect(await list._deleteRecords([lead])).toBe(false);
    expect(lead.selected).toBe(true);
    expect(await offline._queue.list()).toEqual([]);

    fail = false;
    expect(await list.archive(true)).toBe(true);
    expect(lead.selected).toBe(false);
    expect((await offline._queue.list()).map(({ method, args }) => [method, args])).toEqual([
        ["action_archive", [[1]]],
    ]);
});

test("local storage rejects chains referencing a failed queue write", async () => {
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    let fail = true;
    patchWithCleanup(offline._queue.db, {
        async write(table, ...args) {
            if (fail && table === "entries") {
                fail = false;
                throw new Error("Storage is full");
            }
            return super.write(table, ...args);
        },
    });
    const keys = Array.from({ length: 4 }, () => window.crypto.randomUUID());
    const [first, second, third, independent] = keys;
    const schedule = (key, refs) =>
        offline.scheduleORM("res.partner", "create", [{ name: key }], {}, { key, refs });
    schedule(first, []);
    schedule(second, [first]);
    schedule(third, [second]);
    schedule(independent, []);
    const saved = await Promise.all(keys.map((key) => offline.waitForPendingWrite(key)));
    expect(saved).toEqual([false, false, false, true]);
    expect((await offline._queue.list()).map(({ key }) => key)).toEqual([independent]);
    expect(offline.getPendingEntries().map(({ key }) => key)).toEqual([independent]);
});

test("ordered changes to the same draft remain blocked after its create succeeds", async () => {
    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        const { name } = params.args[1];
        sent.push(name);
        return name === "First edit" ? rejection(0, "odoo.exceptions.AccessError") : [{ id: 47 }];
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const draft = offline.scheduleORM("res.partner", "web_save", [[], { name: "Draft" }], {});
    for (const name of ["First edit", "Second edit"]) {
        offline.scheduleORM("res.partner", "web_save", [[], { name }], {}, { id: draft });
    }
    await offline._syncORM();
    expect(sent).toEqual(["Draft", "First edit"]);
    expect(offline.getPendingEntries().map(({ state }) => state)).toEqual(["needs_attention", "held_back"]);
});

test("a failed offline bulk move restores the groups and the records' field values", async () => {
    class Lead extends models.Model {
        name = fields.Char();
        stage = fields.Selection({ selection: [["new", "New"], ["won", "Won"]] });
        _records = [
            { id: 1, name: "Alpha", stage: "new" },
            { id: 2, name: "Beta", stage: "new" },
            { id: 3, name: "Gamma", stage: "won" },
        ];
    }
    defineModels([Lead, ...Object.values(webModels)]);
    let groupList;
    patchWithCleanup(DynamicGroupList.prototype, {
        setup() {
            super.setup(...arguments);
            groupList = this;
        },
    });
    const setOffline = mockOffline();
    await mountView({
        type: "kanban", resModel: "lead", groupBy: ["stage"],
        arch: `<kanban><templates><t t-name="card"><field name="name"/></t></templates></kanban>`,
    });
    const offline = getService(OfflinePlugin);
    const source = groupList.groups.find(({ value }) => value === "new");
    const target = groupList.groups.find(({ value }) => value === "won");
    const initialCards = groupList.groups.map((_, index) =>
        queryAllTexts(`.o_kanban_group:eq(${index}) .o_kanban_record`)
    );
    // The column is grouped by stage, but the card did not load that field.
    const initialStages = source.records.map(({ data }) => data.stage);
    expect(initialStages).toEqual([undefined, undefined]);
    let attempted;
    patchWithCleanup(offline._queue.db, {
        async write(table, ...args) {
            if (table === "entries") {
                attempted = args[0].length;
                expect(source.records).toHaveLength(0);
                expect(target.records.slice(0, 2).map(({ data }) => data.stage)).toEqual(["won", "won"]);
                throw new Error("Storage is full");
            }
            return super.write(table, ...args);
        },
    });
    await setOffline(true);
    await groupList.moveRecords(source.records.map(({ id }) => id), null, target.id);
    await animationFrame();
    expect(attempted).toBe(2);
    expect(source.records.map(({ data }) => data.stage)).toEqual(initialStages);
    expect(groupList.groups.map((_, index) =>
        queryAllTexts(`.o_kanban_group:eq(${index}) .o_kanban_record`)
    )).toEqual(initialCards);
    expect(await offline._queue.list()).toEqual([]);
    expect(offline.getPendingEntries()).toEqual([]);
});

test("a failed bulk offline save restores the original values in the view", async () => {
    class Lead extends models.Model {
        name = fields.Char();
        stage = fields.Char();
        _records = [
            { id: 1, name: "One", stage: "New" },
            { id: 2, name: "Two", stage: "New" },
        ];
    }
    defineModels([Lead, ...Object.values(webModels)]);
    let list;
    patchWithCleanup(DynamicList.prototype, {
        setup() {
            super.setup();
            list = this;
        },
    });
    const setOffline = mockOffline();
    await mountView({
        type: "list", resModel: "lead",
        arch: `<list><field name="name"/><field name="stage"/></list>`,
    });
    const offline = getService(OfflinePlugin);
    patchWithCleanup(offline._queue, {
        async addMany(entries) {
            expect(entries.map(({ args }) => args)).toEqual([
                [[1], { stage: "Won" }], [[2], { stage: "Won" }],
            ]);
            throw new Error("Storage is full");
        },
    });
    await setOffline(true);
    expect(await list._saveRecords(list.records, { stage: "Won" })).toBe(false);
    expect(list.records.map(({ data }) => data.stage)).toEqual(["New", "New"]);
    expect(offline.getPendingEntries()).toEqual([]);
});

test("a rejected mock dataset call stays queued through the mock replay endpoint", async () => {
    onRpc("write", () => {
        expect.step("dataset write");
        throw makeErrorFromResponse({ code: 200, data: { name: "odoo.exceptions.AccessError" } });
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    queueChange(offline, 1, "Rejected edit", 1);
    await offline._syncORM();
    expect.verifySteps(["dataset write"]);
    expect(offline.getPendingEntries().map(({ state, error }) => [state, error])).toEqual([
        ["needs_attention", "You no longer have access to this record."],
    ]);
});

test("atomic steps are persisted and sent together after their external dependency", async () => {
    const sent = [];
    let rejectCreate = true;
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        sent.push(params);
        return rejectCreate ? rejection(0, "odoo.exceptions.AccessError") : [48, true];
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const create = offline.scheduleORM("res.partner", "web_save", [[], { name: "Parent" }], {});
    const { key: createKey } = offline.getPendingEntry(create);
    const steps = [
        {
            model: "res.partner", method: "create", args: [{ parent_id: `offline:${createKey}` }],
            kwargs: { context: { active_test: false } }, refs: [createKey],
        },
        { model: "res.partner", method: "write", args: [["step:0"], { name: "Child" }], kwargs: {}, refs: [0] },
    ];
    const legacyKey = offline.scheduleORMSteps(steps, {
        target: { model: "res.partner", ids: [42] }, label: "Create a child contact",
    });
    await offline._syncORM();
    const [blocker, bundle] = offline.getPendingEntries();
    expect(sent).toHaveLength(1);
    expect(bundle.state).toBe("held_back");
    expect(bundle.steps).toEqual(steps);
    expect(bundle.refs).toEqual([createKey]);
    expect(Object.keys(offline._ormToSync()[legacyKey].value)).toEqual([
        "model", "method", "args", "kwargs", "extras",
    ]);

    rejectCreate = false;
    await offline.retryPendingChange(blocker.key);
    expect(sent.map((change) => change.key)).toEqual([createKey, createKey, bundle.key]);
    expect(Object.keys(sent[2]).sort()).toEqual(["db", "key", "steps", "uid"]);
    expect(sent[2].steps.map((step) => step.refs)).toEqual([[createKey], [0]]);
    expect(sent[2].steps[0].kwargs.context.active_test).toBe(false);
    expect(offline.getPendingEntries()).toEqual([]);
});

test("expired login pauses replay without discarding or reclassifying remaining changes", async () => {
    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        sent.push(params.key);
        return rejection(100, "odoo.http.session.SessionExpiredException");
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    queueChange(offline, 1, "First", 1);
    queueChange(offline, 2, "Second", 2);
    await offline._syncORM();
    await offline._syncORM();
    const [first, second] = offline.getPendingEntries();
    expect(sent).toEqual([first.key]);
    expect(offline.syncPaused()).toBe(true);
    expect([first.state, second.state]).toEqual(["paused", "waiting"]);
});

test("key rotation keeps the owner's waiting changes readable, not another user's", async () => {
    const owner = { db: "queue-db", uid: 7 };
    const oldKey = "11".repeat(16);
    const newKey = "22".repeat(16);
    const initial = new OfflineQueueStore(owner, oldKey);
    const old = await initial.lock(() => initial.add({ ...owner, key: "one", label: "Old change" }));
    const rotated = new OfflineQueueStore(owner, newKey);
    const current = await rotated.lock(() => rotated.add({ ...owner, key: "two", label: "New change" }));
    expect(await rotated.list()).toEqual([old, current]);
    expect((await rotated.keys.current()).id).not.toBe((await initial.keyReady).id);
    expect(await new OfflineQueueStore({ ...owner, uid: 9 }, oldKey).list()).toEqual([]);
    expect(await new OfflineQueueStore({ ...owner, db: "other-db" }, oldKey).list()).toEqual([]);
});
