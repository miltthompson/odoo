import {
    contains,
    defineMailModels,
    openFormView,
    start,
    startServer,
} from "@mail/../tests/mail_test_helpers";
import { getChatterReadCache } from "@mail/chatter/web/chatter_read_cache";

import { beforeEach, expect, test } from "@odoo/hoot";
import { mockDate } from "@odoo/hoot-mock";

import { getService, mockOffline, serverState } from "@web/../tests/web_test_helpers";
import { user } from "@web/core/user";
import { Mutex } from "@web/core/utils/concurrency";
import { patch } from "@web/core/utils/patch";
import { session } from "@web/session";

const MODEL = "res.partner";
const threadParams = (id) => ({ thread_model: MODEL, thread_id: id });
const historyRequest = (id, fetchParams) => [
    "/mail/thread/messages",
    { ...threadParams(id), fetch_params: { limit: 2, ...fetchParams } },
    1,
];
const detailsRequest = (id) => ["mail.thread", { ...threadParams(id), request_list: ["activities"] }];

function historyResponse(id, ids) {
    return {
        DataResponse: [{ id: 1, messages: ids }],
        "mail.message": ids.map((messageId) => ({
            id: messageId,
            thread: { model: MODEL, id },
            body: ["markup", `<p>Note ${messageId}</p>`],
            author_id: 1,
            attachment_ids: [12],
        })),
        "res.partner": [{ id: 1, name: "Author" }, { id: 2, name: "Unrelated partner" }],
        "ir.attachment": [{ id: 12, name: "private-file.txt" }],
    };
}

defineMailModels();
let cacheVersion = 0;
beforeEach(() => {
    mockDate("2026-11-20 12:00:00");
    // HOOT resets the contents of its IndexedDB mock after each test.
    patch(session, { registry_hash: `chatter-test-${++cacheVersion}` });
    // HOOT's default Web Locks mock does not serialize requests or return their results.
    const locks = new Map();
    patch(navigator.locks, {
        request(name, callback) {
            if (!locks.has(name)) {
                locks.set(name, new Mutex());
            }
            return locks.get(name).exec(callback);
        },
    });
    patch(window.crypto.subtle, {
        // HOOT already mocks encryption; preserve distinct inputs for cache-key assertions.
        async digest(_algorithm, input) {
            return input.buffer;
        },
    });
});

test("offline chatter retains contiguous history and isolates users and companies", async () => {
    const cache = getChatterReadCache();
    await cache.capture([historyRequest(42)], historyResponse(42, [9, 8]), user.context);
    await cache.capture([historyRequest(42, { before: 8 })], historyResponse(42, [7, 6]), user.context);
    await cache.capture([historyRequest(42, { before: 2 })], historyResponse(42, [1]), user.context);
    await cache.capture([historyRequest(42)], historyResponse(42, [10, 9]), user.context);
    let snapshot = await cache.read(MODEL, 42);
    expect(snapshot.messages.ids).toEqual([6, 7, 8, 9, 10]);
    expect(snapshot.messages.hasOlder).toBe(true);
    expect(snapshot.messages.data["res.partner"]).toEqual([{ id: 1, name: "Author" }]);
    expect(snapshot.messages.data["ir.attachment"]).toBe(undefined);
    expect(snapshot.messages.data["mail.message"][0].attachment_ids).toBe(undefined);
    expect(await cache.read(MODEL, 43)).toBe(undefined);

    const originalContext = user.context;
    let context = { ...originalContext, allowed_company_ids: [999] };
    let userId = serverState.userId;
    patch(user, {
        get context() {
            return context;
        },
        get userId() {
            return userId;
        },
    });
    expect(await cache.read(MODEL, 42)).toBe(undefined);
    context = originalContext;
    userId += 100;
    expect(await getChatterReadCache().read(MODEL, 42)).toBe(undefined);
    userId = serverState.userId;

    // Two instances share the same database and must not overwrite each other's updates.
    const secondCache = getChatterReadCache();
    expect(secondCache === cache).toBe(false);
    await Promise.all([
        cache.capture(
            [historyRequest(42, { before: 6 })], historyResponse(42, [5, 4]), user.context
        ),
        secondCache.capture(
            [detailsRequest(42)],
            { "mail.thread": [{ model: MODEL, id: 42, hasReadAccess: true, activities: [] }] },
            user.context
        ),
    ]);
    snapshot = await cache.read(MODEL, 42);
    expect(snapshot.messages.ids).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(snapshot.activities.data["mail.thread"][0].activities).toEqual([]);

    await secondCache.capture(
        [detailsRequest(42)],
        { "mail.thread": [{ model: MODEL, id: 42, hasReadAccess: false }] },
        user.context
    );
    snapshot = await cache.read(MODEL, 42);
    expect(snapshot).toBe(undefined);
});

test("loading an older page again refreshes saved notes without losing surrounding history", async () => {
    const cache = getChatterReadCache();
    await cache.capture([historyRequest(42)], historyResponse(42, [10, 9]), user.context);
    await cache.capture([historyRequest(42, { before: 9 })], historyResponse(42, [8, 7]), user.context);
    await cache.capture([historyRequest(42, { before: 7 })], historyResponse(42, [6, 5]), user.context);

    const refreshed = historyResponse(42, [7, 6]);
    refreshed["mail.message"][0].body = ["markup", "<p>Edited note</p>"];
    await cache.capture([historyRequest(42, { before: 9 })], refreshed, user.context);

    const { messages } = await cache.read(MODEL, 42);
    expect(messages.ids).toEqual([5, 6, 7, 9, 10]);
    const rows = messages.data["mail.message"];
    expect(rows.find(({ id }) => id === 7).body).toEqual(["markup", "<p>Edited note</p>"]);
    expect(rows.some(({ id }) => id === 8)).toBe(false);
    expect(messages.hasOlder).toBe(true);
});

test("initial and paginated search results cannot overwrite saved history", async () => {
    const cache = getChatterReadCache();
    await cache.capture([historyRequest(42)], historyResponse(42, [10, 9]), user.context);
    await cache.capture([historyRequest(42, { before: 9 })], historyResponse(42, [8, 7]), user.context);
    const expected = (await cache.read(MODEL, 42)).messages;

    // A filtered initial result and a subsequent search page sharing a saved history cursor.
    await cache.capture(
        [historyRequest(42, { search_filter: "notes", limit: undefined })],
        historyResponse(42, [10, 9]),
        user.context
    );
    await cache.capture(
        [historyRequest(42, { before: 9, search_term: "Note 7", limit: undefined })],
        historyResponse(42, [7]),
        user.context
    );
    // A limit alone cannot establish continuity when results are filtered.
    await cache.capture(
        [historyRequest(42, { before: 9, search_filter: "notes" })],
        historyResponse(42, [7]),
        user.context
    );
    expect((await cache.read(MODEL, 42)).messages).toEqual(expected);
});

test("an older page can extend the saved history using a deleted message as its cursor", async () => {
    const cache = getChatterReadCache();
    await cache.capture([historyRequest(42)], historyResponse(42, [10, 9]), user.context);
    await cache.updateMessage(MODEL, 42, 9);
    await cache.capture([historyRequest(42, { before: 9 })], historyResponse(42, [8]), user.context);

    const { messages } = await cache.read(MODEL, 42);
    expect(messages.ids).toEqual([8, 10]);
    expect(messages.data["mail.message"].some(({ id }) => id === 9)).toBe(false);
    expect(messages.hasOlder).toBe(false);
});

test("offline chatter restores notes and activities with explained unavailable controls", async () => {
    const pyEnv = await startServer();
    const id = pyEnv[MODEL].create({ name: "Saved contact" });
    const [removedId, editedId, noteId] = pyEnv["mail.message"].create([
        { body: "Draft quote", model: MODEL, res_id: id },
        { body: "Quote sent", model: MODEL, res_id: id },
        { body: "Internal note about the quote", model: MODEL, res_id: id },
    ]);
    pyEnv["mail.activity"].create({
        summary: "Call about the quote",
        date_deadline: "2026-11-20",
        res_model: MODEL,
        res_id: id,
        state: "planned",
    });
    const setOffline = mockOffline();
    await start();
    const cache = getChatterReadCache();
    const captured = Promise.withResolvers();
    patch(cache, {
        async capture() {
            try {
                await super.capture(...arguments);
                captured.resolve(await this.read(MODEL, id));
            } catch (error) {
                captured.reject(error);
            }
        },
    });
    const openedAt = Date.now();
    await openFormView(MODEL, id);
    await contains(".o-mail-Message", { text: "Internal note about the quote" });
    await contains(".o-mail-Activity", { text: "Call about the quote" });
    const saved = await captured.promise;
    expect(saved?.activities?.savedAt).toBeGreaterThan(openedAt);
    expect(saved?.messages?.savedAt).toBeGreaterThan(openedAt);
    const store = getService("mail.store");
    const thread = store["mail.thread"].get({ model: MODEL, id });
    const updateRecorded = Promise.withResolvers();
    patch(cache, {
        async updateMessage(_model, _id, messageId) {
            await super.updateMessage(...arguments);
            if (messageId === removedId) {
                updateRecorded.resolve();
            }
        },
    });
    await store["mail.message"].get(editedId).edit("Quote accepted");
    await store["mail.message"].get(removedId).remove({ removeFromThread: true });
    await updateRecorded.promise;
    const updated = await cache.read(MODEL, id);
    expect(updated.messages.ids).toEqual([editedId, noteId]);
    expect(updated.messages.data["mail.message"].find(({ id }) => id === editedId).body[1]).toInclude(
        "Quote accepted"
    );
    // Evict the records too: a cache containing only IDs must not be able to restore the UI.
    for (const record of [...thread.messages, ...thread.activities]) {
        record.delete();
    }
    expect(store["mail.message"].get(noteId)).toBe(undefined);
    thread.hasLoadedChatterActivities = false;
    thread.isLoaded = false;

    await setOffline(true);
    await contains(".o-mail-Message-content:text('Quote accepted (edited)')");
    await contains(".o-mail-Message", { text: "Draft quote", count: 0 });
    await contains(".o-mail-Message", { text: "Internal note about the quote" });
    await contains(".o-mail-Activity", { text: "Call about the quote" });
    await contains(".o-mail-Chatter-savedAt", { text: "Saved on this device · updated now" });
    await contains(".o-mail-Chatter-sendMessage:disabled");
    await contains(".o-mail-Followers-button:disabled");
    await contains(".o-mail-Chatter-attachFiles:disabled");

    pyEnv["mail.message"].create(Array.from({ length: store.FETCH_LIMIT + 2 }, (_, index) => ({
        body: `New message ${index}`,
        model: MODEL,
        res_id: id,
    })));
    await setOffline(false);
    await contains(".o-mail-Message", { text: `New message ${store.FETCH_LIMIT + 1}` });
});
