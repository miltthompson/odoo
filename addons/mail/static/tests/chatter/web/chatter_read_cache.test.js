import {
    contains,
    defineMailModels,
    openFormView,
    start,
    startServer,
} from "@mail/../tests/mail_test_helpers";
import { getChatterReadCache } from "@mail/chatter/web/chatter_read_cache";

import { expect, test } from "@odoo/hoot";

import { getService, mockOffline, serverState } from "@web/../tests/web_test_helpers";
import { user } from "@web/core/user";
import { patch } from "@web/core/utils/patch";

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

test("offline chatter retains contiguous history and isolates users and companies", async () => {
    const cache = getChatterReadCache();
    await cache.capture([historyRequest(42)], historyResponse(42, [9, 8]), user.context);
    await cache.capture([historyRequest(42, { before: 8 })], historyResponse(42, [7, 6]), user.context);
    await cache.capture([historyRequest(42, { before: 2 })], historyResponse(42, [1]), user.context);
    let snapshot = await cache.read(MODEL, 42);
    expect(snapshot.messages.ids).toEqual([6, 7, 8, 9]);
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

    await getChatterReadCache().capture(
        [detailsRequest(42)],
        { "mail.thread": [{ model: MODEL, id: 42, hasReadAccess: false }] },
        user.context
    );
    snapshot = await getChatterReadCache().read(MODEL, 42);
    expect(snapshot).toBe(undefined);
});

test("offline chatter restores notes and activities with explained unavailable controls", async () => {
    const pyEnv = await startServer();
    const id = pyEnv[MODEL].create({ name: "Saved contact" });
    pyEnv["mail.message"].create({ body: "Quote sent", model: MODEL, res_id: id });
    pyEnv["mail.message"].create({ body: "Internal note about the quote", model: MODEL, res_id: id });
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
            await super.capture(...arguments);
            const snapshot = await this.read(MODEL, id);
            if (snapshot?.activities && snapshot?.messages) {
                captured.resolve();
            }
        },
    });
    await openFormView(MODEL, id);
    await contains(".o-mail-Message", { text: "Internal note about the quote" });
    await contains(".o-mail-Activity", { text: "Call about the quote" });
    await captured.promise;
    const thread = getService("mail.store")["mail.thread"].get({ model: MODEL, id });
    // Simulate re-opening in a fresh mail store without relying on the warm in-memory thread.
    thread.hasLoadedChatterActivities = false;
    thread.messages = [];
    thread.activities = [];
    thread.isLoaded = false;

    await setOffline(true);
    await contains(".o-mail-Message", { text: "Quote sent" });
    await contains(".o-mail-Message", { text: "Internal note about the quote" });
    await contains(".o-mail-Activity", { text: "Call about the quote" });
    await contains(".o-mail-Chatter-savedAt", { text: "Saved on this device" });
    await contains(".o-mail-Chatter-sendMessage:disabled");
    await contains(".o-mail-Followers-button:disabled");
    await contains(".o-mail-Chatter-attachFiles:disabled");
});
