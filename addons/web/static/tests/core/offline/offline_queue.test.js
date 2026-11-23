import { expect, test } from "@odoo/hoot";
import { makeErrorFromResponse } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { OfflineQueueStore } from "@web/core/offline/offline_storage";
import { DynamicList } from "@web/model/relational_model/dynamic_list";
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

test("saving an open draft after discarding its create keeps all form values", async () => {
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
    await contains(".o_field_widget[name='name'] input").edit("Draft");
    await contains(".o_field_widget[name='email'] input").edit("contact@example.com");
    await contains(".o_form_button_save").click();
    const [discarded] = offline.getPendingEntries();
    await offline.discardPendingChange(discarded.key);
    await contains(".o_field_widget[name='name'] input").edit("New draft");
    await contains(".o_form_button_save").click();
    const [create] = await offline._queue.list();
    expect(create.key).not.toBe(discarded.key);
    expect(create.args).toEqual([[], { name: "New draft", email: "contact@example.com" }]);
});

test("queue rejection propagates to callers scheduling dependent changes", async () => {
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const [first, second, third] = Array.from({ length: 3 }, () => crypto.randomUUID());
    patchWithCleanup(offline._queue, {
        async add(entry) {
            if (entry.key === first) {
                throw new Error("Storage is full");
            }
            return super.add(entry);
        },
    });
    offline.scheduleORM("res.partner", "create", [{ name: "First" }], {}, { key: first });
    offline.scheduleORM("res.partner", "create", [{ parent_id: `offline:${first}` }], {}, {
        key: second, refs: [first],
    });
    offline.scheduleORM("res.partner", "write", [[`offline:${second}`], { name: "Third" }], {}, {
        key: third, refs: [second],
    });
    expect(await offline.waitForPendingWrite(third)).toBe(false);
    expect(offline.getPendingEntries().map(({ key }) => key)).toEqual([first]);
    expect(await offline._queue.list()).toEqual([]);
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

test("a bulk edit does not publish any entries if its durable batch fails", async () => {
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    let attempted;
    let fail = true;
    patchWithCleanup(offline._queue.db, {
        async write(table, ...args) {
            if (table === "entries") {
                attempted = args[0].length;
                if (fail) {
                    throw new Error("Storage is full");
                }
            }
            return super.write(table, ...args);
        },
    });
    const calls = [1, 2].map((id) => ({
        model: "res.partner", method: "write", args: [[id], { name: "Moved" }], kwargs: {},
    }));
    expect(await offline.scheduleORMBatch(calls)).toBe(undefined);
    expect(attempted).toBe(2);
    expect(await offline._queue.list()).toEqual([]);
    expect(offline.getPendingEntries()).toEqual([]);

    fail = false;
    expect(await offline.scheduleORMBatch(calls)).toHaveLength(2);
    expect((await offline._queue.list()).map((entry) => entry.args[0])).toEqual([[1], [2]]);
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
