import { expect, test } from "@odoo/hoot";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { OfflineQueueStore } from "@web/core/offline/offline_storage";
import { user } from "@web/core/user";
import { IndexedDB, VERSION_KEY, VERSION_TABLE } from "@web/core/utils/indexed_db";
import { getService, makeTestApp, onRpc } from "@web/../tests/web_test_helpers";

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

test("an update quarantines legacy changes even when their UID matches", async () => {
    const previousTab = new IndexedDB("offline", "another-database-version");
    await previousTab.read(VERSION_TABLE, VERSION_KEY);
    const currentTab = new IndexedDB("offline", "current-database-version");
    const saveLegacy = (db, key, kwargs) => db.write("orm-to-sync", key, JSON.stringify({
        model: "res.partner", method: "write", args: [[1], { name: key }], kwargs,
    }));
    await saveLegacy(currentTab, "No owner recorded", {});
    // A tab that initialized before the database switch writes under the new marker.
    await saveLegacy(previousTab, "Another database", { context: { uid: user.userId } });
    expect(await currentTab.read(VERSION_TABLE, VERSION_KEY)).toBe("current-database-version");

    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        sent.push(params.args[1].name);
        return true;
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    await offline.getQueueReady();
    expect(offline.getPendingEntries()).toEqual([]);
    expect(offline.getLegacyPendingCount()).toBe(2);

    queueChange(offline, 1, "New edit", 30);
    await offline._syncORM();
    expect(sent).toEqual(["New edit"]);
    const rows = await currentTab.getAllEntries("orm-to-sync");
    expect(rows.map(({ key }) => key).sort()).toEqual(["Another database", "No owner recorded"]);
    expect(rows.every(({ value }) => !!value.payload)).toBe(true);
});
