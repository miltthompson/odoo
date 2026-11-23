import { animationFrame, expect, mockDate, queryAllTexts, test } from "@odoo/hoot";
import { makeErrorFromResponse } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { OfflineQueueStore } from "@web/core/offline/offline_storage";
import { _OriginalIndexedDB as RealIndexedDB } from "@web/core/utils/indexed_db";
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

test("a normal save waits for pending draft replay, then writes to the server record", async () => {
    class Lead extends models.Model {
        name = fields.Char();
        _records = [{ id: 47, name: "Draft" }];
    }
    defineModels([Lead]);
    let record;
    patchWithCleanup(Record.prototype, {
        setup() {
            super.setup(...arguments);
            record = this;
        },
    });
    const writes = [];
    onRpc("web_save", ({ args: [ids, changes] }) => { writes.push([ids, changes]); });
    let reject = true;
    onRpc("/web/offline/sync", () => reject
        ? rejection(0, "odoo.exceptions.AccessError") : [{ id: 47 }]);
    await mountView({ type: "form", resModel: "lead", arch: '<form><field name="name"/></form>' });
    const offline = getService(OfflinePlugin);
    // Seed a queued draft from before the overlay added temporary record IDs.
    const changes = { name: "Draft" };
    const id = await offline.scheduleORMDurably("lead", "web_save", [[], changes], {}, { extras: { changes } });
    await record.setOfflineChanges(id);
    const [create] = offline.getPendingEntries();

    await offline._syncORM();
    await contains(".o_field_widget[name='name'] input").edit("While pending");
    await contains(".o_form_button_save").click();
    expect(writes).toEqual([]);
    const [, pendingEdit] = await offline._queue.list();
    expect(pendingEdit.args).toEqual([[`offline:${create.key}`], { name: "While pending" }]);

    reject = false;
    await offline.retryPendingChange(create.key);
    expect(await offline._queue.list()).toEqual([]);
    await contains(".o_field_widget[name='name'] input").edit("After replay");
    await contains(".o_form_button_save").click();
    expect(writes).toEqual([[[47], { name: "After replay" }]]);
    expect(await offline._queue.list()).toEqual([]);
});

test("an expired draft receipt resends the original create and uses the acknowledged ID", async () => {
    class Lead extends models.Model {
        name = fields.Char();
    }
    defineModels([Lead]);
    let record;
    patchWithCleanup(Record.prototype, {
        setup() {
            super.setup(...arguments);
            record = this;
        },
    });
    const writes = [];
    const sent = [];
    const applied = new Map();
    onRpc("web_save", ({ args }) => { writes.push(args); });
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        sent.push(params);
        if (applied.has(params.key)) {
            return { already_applied: true, created_ids: [applied.get(params.key)] };
        }
        if (!params.args[0].length) {
            applied.set(params.key, 47);
        }
        return [{ id: 47 }];
    });
    mockDate("2026-01-01T12:00:00");
    await mountView({ type: "form", resModel: "lead", arch: '<form><field name="name"/></form>' });
    const offline = getService(OfflinePlugin);
    const changes = { name: "Draft" };
    const id = await offline.scheduleORMDurably("lead", "web_save", [[], changes], {}, { extras: { changes } });
    await record.setOfflineChanges(id);
    const [create] = offline.getPendingEntries();
    await offline._syncORM();
    expect(await offline._queue.resolveRecord("lead", create.key)).toEqual({ id: 47, key: create.key });

    mockDate("2026-02-02T12:00:00");
    expect(await offline._queue.resolveRecord("lead", create.key)).toBe(undefined);
    await contains(".o_field_widget[name='name'] input").edit("After expiry");
    await contains(".o_form_button_save").click();
    expect(writes).toEqual([]);
    expect(sent).toHaveLength(3);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[2].key).not.toBe(create.key);
    expect(sent[2].args).toEqual([[`offline:${create.key}`], { name: "After expiry" }]);
    expect(applied.size).toBe(1);
    expect(record.resId).toBe(47);
    expect(await offline._queue.list()).toEqual([]);
});

test("saving an open, explicitly discarded old draft sends only the current values with a fresh key", async () => {
    class Lead extends models.Model {
        name = fields.Char();
        email = fields.Char();
        _records = [{ id: 47, name: "Latest values", email: "same@example.com" }];
    }
    defineModels([Lead]);
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
    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        sent.push((await request.json()).params);
        return [{ id: 47 }];
    });
    mockDate("2026-01-01T12:00:00");
    await mountView({ type: "form", resModel: "lead", arch: '<form><field name="name"/><field name="email"/></form>' });
    const offline = getService(OfflinePlugin);
    await setOffline(true);
    const values = { name: "Old draft", email: "same@example.com" };
    const id = await offline.scheduleORMDurably("lead", "web_save", [[], values], {}, { extras: { changes: values } });
    const [original] = await offline._queue.list();
    await record.setOfflineChanges(id);
    mockDate("2026-02-02T12:00:00");
    await offline.discardPendingChange(original.key);
    await contains("[name='name'] input").edit("Latest values");
    await contains(".o_form_button_save").click();
    const [replacement] = await offline._queue.list();
    await setOffline(false);
    await offline.syncPendingChanges();
    expect(sent.map(({ key, args }) => [key, args])).toEqual([
        [replacement.key, [[], { name: "Latest values", email: "same@example.com" }]],
    ]);
    expect(replacement.key).not.toBe(original.key);
});

test("discarding an old rejected draft does not resend its invalid payload", async () => {
    mockDate("2026-01-01T12:00:00");
    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        sent.push(params);
        return params.args[1].name === "Invalid" ? rejection(0, "odoo.exceptions.ValidationError") : [{ id: 47 }];
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const id = await offline.scheduleORMDurably("res.partner", "web_save", [[], { name: "Invalid" }], {});
    const [original] = await offline._queue.list();
    await offline.syncPendingChanges();
    expect((await offline._queue.get(original.key)).state).toBe("needs_attention");
    mockDate("2026-02-02T12:00:00");
    await offline.discardPendingChange(original.key);
    const values = [[], { name: "Corrected" }];
    await offline.scheduleORMDurably("res.partner", "web_save", values, {}, {
        id, draftCreate: original, createArgs: values,
    });
    await offline.syncPendingChanges();
    expect(sent.map(({ args }) => args[1].name)).toEqual(["Invalid", "Corrected"]);
    expect(sent[1].key).not.toBe(original.key);
    expect(await offline._queue.list()).toEqual([]);
});

test("a failed discard cannot leave a marker for a draft that can still replay", async () => {
    const setOffline = mockOffline();
    await makeTestApp();
    await setOffline(true);
    const offline = getService(OfflinePlugin);
    const db = new RealIndexedDB(`test-offline-discard-${crypto.randomUUID()}`, undefined, { durability: "strict" });
    patchWithCleanup(offline._queue, { db });
    try {
        await offline.scheduleORMDurably("res.partner", "web_save", [[], { name: "Queued" }], {});
        const [create] = await offline._queue.list();
        patchWithCleanup(IDBObjectStore.prototype, {
            delete(key) {
                if (this.name === "entries" && key === create.key) {
                    throw new Error("Could not delete the queue row");
                }
                return super.delete(key);
            },
        });
        await offline.discardPendingChange(create.key);
        expect(Boolean(offline.getQueueError())).toBe(true);
        expect(await offline._queue.wasDraftDiscarded(create.key)).toBe(undefined);
        expect((await offline._queue.get(create.key)).args).toEqual(create.args);
    } finally {
        await db.deleteDatabase();
    }
});

test("discarding an expired receipt recovery does not mark its original create unsent", async () => {
    mockDate("2026-01-01T12:00:00");
    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        sent.push((await request.json()).params);
        return sent.length === 2 ? { already_applied: true, created_ids: [47] } : [{ id: 47 }];
    });
    const setOffline = mockOffline();
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const id = await offline.scheduleORMDurably("res.partner", "web_save", [[], { name: "Original" }], {});
    const [original] = await offline._queue.list();
    await offline.syncPendingChanges();
    mockDate("2026-02-02T12:00:00");
    await setOffline(true);
    const saveEdit = (name) => offline.scheduleORMDurably("res.partner", "web_save", [[], { name }], {}, {
        id, draftCreate: original,
    });
    await saveEdit("Discard this edit");
    const [recovery, dependentEdit] = await offline._queue.list();
    expect(recovery.key).toBe(original.key);
    await offline.discardPendingChange(recovery.key);
    await offline.discardPendingChange(dependentEdit.key);
    await saveEdit("Keep this edit");
    await setOffline(false);
    await offline.syncPendingChanges();
    expect(sent).toHaveLength(3);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[2].args).toEqual([[`offline:${original.key}`], { name: "Keep this edit" }]);
    expect(await offline._queue.list()).toEqual([]);
});

test("a draft whose original key is lost is kept for manual recovery", async () => {
    class Lead extends models.Model {
        name = fields.Char();
    }
    defineModels([Lead]);
    let record;
    patchWithCleanup(Record.prototype, {
        setup() {
            super.setup(...arguments);
            record = this;
        },
    });
    onRpc("web_save", () => expect.step("unexpected create"));
    onRpc("/web/offline/sync", () => expect.step("unexpected replay"));
    await mountView({ type: "form", resModel: "lead", arch: '<form><field name="name"/></form>' });
    const offline = getService(OfflinePlugin);
    record._offlineId = "old-form-key";
    await contains(".o_field_widget[name='name'] input").edit("Keep these values");
    await contains(".o_form_button_save").click();
    await offline.syncPendingChanges();
    const [entry] = await offline._queue.list();
    expect(entry.state).toBe("needs_attention");
    expect(entry.error).toMatch(/original draft could not be found/i);
    expect(entry.args[1]).toEqual({ name: "Keep these values" });
    expect.verifySteps([]);
});

test("offline draft lines are read-only and an unmapped edit is saved for manual reapplication", async () => {
    class Draft extends models.Model {
        name = fields.Char();
        line_ids = fields.One2many({ relation: "line", relation_field: "draft_id" });
    }
    class Line extends models.Model {
        name = fields.Char();
        draft_id = fields.Many2one({ relation: "draft" });
    }
    defineModels([Draft, Line]);
    let record;
    patchWithCleanup(Record.prototype, {
        setup(config) {
            super.setup(...arguments);
            if (config.isRoot) {
                record = this;
            }
        },
    });
    const writes = [];
    const replayed = [];
    onRpc("web_save", ({ args }) => { writes.push(args); });
    onRpc("/web/offline/sync", async (request) => {
        replayed.push((await request.json()).params);
        return [{ id: 47 }];
    });
    await mountView({
        type: "form", resModel: "draft",
        arch: `<form><field name="name"/><field name="line_ids">
            <list editable="bottom"><field name="name"/></list>
        </field></form>`,
    });
    const offline = getService(OfflinePlugin);
    const changes = { name: "Draft", line_ids: [[0, 0, { name: "First line" }]] };
    const id = await offline.scheduleORMDurably("draft", "web_save", [[], changes], {}, { extras: { changes } });
    expect(".o_field_x2many_list_row_add button").toBeVisible();
    await record.setOfflineChanges(id);
    await animationFrame();
    expect(".o_field_x2many_list_row_add button").toHaveCount(0);
    await offline._syncORM();
    expect(await offline._queue.list()).toEqual([]);

    const [line] = record.data.line_ids.records;
    await line.update({ name: "Edited line" });
    expect(await record.save()).toBe(true);
    const [pending] = await offline._queue.list();
    expect(pending.state).toBe("needs_attention");
    expect(pending.error).toMatch(/Reopen .* after it has been sent to reapply this line change/);
    expect(pending.args).toEqual([[47], { line_ids: [[1, line._virtualId, { name: "Edited line" }]] }]);
    expect(record.dirty).toBe(false);
    await offline.retryPendingChange(pending.key);
    expect(writes).toEqual([]);
    expect(replayed).toHaveLength(1);
    await offline.discardPendingChange(pending.key);
    expect(await offline._queue.list()).toEqual([]);
});

test("the legacy form entry for a rejected follow-up uses the replayed record ID", async () => {
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        return params.refs.length ? rejection(0, "odoo.exceptions.AccessError") : [{ id: 47 }];
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const draft = offline.scheduleORM("res.partner", "web_save", [[], { name: "Draft" }], {});
    offline.scheduleORM("res.partner", "web_save", [[], { name: "Later" }], {}, { id: draft });
    await offline._syncORM();
    const [edit] = offline.getPendingEntries();
    expect(edit.state).toBe("needs_attention");
    expect(edit.args[0]).toEqual([`offline:${edit.refs[0]}`]);
    expect(offline._ormToSync()[draft].value.args).toEqual([[47], { name: "Later" }]);
});

test("reopening a rejected draft follow-up keeps later saves in replay order", async () => {
    class Lead extends models.Model {
        name = fields.Char();
        _records = [{ id: 47, name: "Draft" }];
    }
    defineModels([Lead]);
    let record;
    patchWithCleanup(Record.prototype, {
        setup() {
            super.setup(...arguments);
            record = this;
        },
    });
    onRpc("web_save", () => expect.step("unexpected direct write"));
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        return params.refs.length ? rejection(0, "odoo.exceptions.AccessError") : [{ id: 47 }];
    });
    await mountView({ type: "form", resModel: "lead", resId: 47, arch: '<form><field name="name"/></form>' });
    const offline = getService(OfflinePlugin);
    const id = offline.scheduleORM("lead", "web_save", [[], { name: "Draft" }], {});
    const change = { name: "Rejected edit" };
    offline.scheduleORM("lead", "web_save", [[], change], {}, { id, extras: { changes: change } });
    await offline._syncORM();
    await record.setOfflineChanges(id);
    await contains(".o_field_widget[name='name'] input").edit("Later edit");
    await contains(".o_form_button_save").click();
    await offline.syncPendingChanges();
    const [rejected, later] = await offline._queue.list();
    expect(rejected.state).toBe("needs_attention");
    expect(later.args).toEqual([[47], { name: "Later edit" }]);
    expect(later.state).toBe("held_back");
    expect.verifySteps([]);
});

test("reopening an edit queued with the server ID still keeps subsequent saves in replay order", async () => {
    class Lead extends models.Model {
        name = fields.Char();
        _records = [{ id: 47, name: "Synced draft" }];
    }
    defineModels([Lead]);
    let record;
    patchWithCleanup(Record.prototype, {
        setup(config) {
            super.setup(...arguments);
            if (config.isRoot) {
                record = this;
            }
        },
    });
    onRpc("web_save", () => expect.step("unexpected direct write"));
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        return params.refs.length ? rejection(0, "odoo.exceptions.AccessError") : [{ id: 47 }];
    });
    await mountView({ type: "form", resModel: "lead", resId: 47, arch: '<form><field name="name"/></form>' });
    const offline = getService(OfflinePlugin);
    const id = offline.scheduleORM("lead", "web_save", [[], { name: "Draft" }], {});
    const edit = { name: "Rejected edit" };
    offline.scheduleORM("lead", "web_save", [[], edit], {}, { id, extras: { changes: edit } });
    await offline._syncORM();
    const laterEdit = { name: "Later edit" };
    const laterId = await offline.scheduleORMDurably("lead", "web_save", [[47], laterEdit], {}, {
        id, extras: { changes: laterEdit },
    });
    await offline.syncPendingChanges();
    await record.setOfflineChanges(laterId);
    await contains("[name='name'] input").edit("Latest edit");
    await contains(".o_form_button_save").click();
    await offline.syncPendingChanges();
    const queued = await offline._queue.list();
    expect(queued.map(({ state }) => state)).toEqual(["needs_attention", "held_back", "held_back"]);
    expect(queued.at(-1).args).toEqual([[47], { name: "Latest edit" }]);
    expect.verifySteps([]);
});

test("an old draft label does not make a newly queued replacement eligible for recovery", async () => {
    mockDate("2026-02-02T12:00:00");
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const id = await offline.scheduleORMDurably("res.partner", "web_save", [[], { name: "Replacement" }], {}, {
        extras: { timeStamp: Date.parse("2026-01-01T12:00:00") },
    });
    const create = offline.getPendingEntry(id);
    const setOffline = mockOffline();
    await setOffline(true);
    await offline.discardPendingChange(create.key);
    expect((await offline.getDraftSaveState("res.partner", create)).recover).toBe(false);
    expect(await offline._queue.list()).toEqual([]);
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

test("a rejected stepped operation blocks edits to its resolved server record", async () => {
    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        sent.push(params);
        return params.steps ? rejection(0, "odoo.exceptions.AccessError") : true;
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const createKey = "a213a798-292f-4a42-a516-d4e76c5735ce";
    const steps = [{
        model: "res.partner", method: "write", args: [[`offline:${createKey}`], { active: false }],
        kwargs: {}, refs: [createKey],
    }];
    await offline._queue.lock(async () => {
        const id = offline.scheduleORMSteps(steps, { target: { model: "res.partner", ids: [-1] } });
        expect(offline.getPendingEntry(id).target.ids).toEqual([-1]);
        // Another tab completes replay before scheduleORM can acquire the write lock.
        await offline._queue.recordResolution("res.partner", -1, createKey, 47);
    });
    queueChange(offline, 47, "Later edit", Date.now());
    await offline._syncORM();
    const [bundle, edit] = offline.getPendingEntries();
    expect(bundle.target.ids).toEqual([47]);
    expect(bundle.state).toBe("needs_attention");
    expect(edit.state).toBe("held_back");
    expect(sent).toHaveLength(1);
    expect(sent[0].steps[0].args).toEqual(steps[0].args);
    expect(sent[0].steps[0].refs).toEqual(steps[0].refs);
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
