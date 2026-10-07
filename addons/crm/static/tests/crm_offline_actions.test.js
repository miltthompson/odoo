import { afterEach, expect, test } from "@odoo/hoot";
import { markup } from "@odoo/owl";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import {
    getService,
    getTestApp,
    makeTestApp,
    mockOffline,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { Store as StoreService } from "@mail/core/common/store_service";
import { patch } from "@web/core/utils/patch";
import { defineCrmModels } from "@crm/../tests/crm_test_helpers";

defineCrmModels();

function stubStoreFetch() {
    // the debounced store fetch must never hit the wire in offline tests: a
    // 502 becomes an unverified error, a success flips isOffline back to false
    patch(StoreService.prototype, {
        fetchStoreData: () => Promise.resolve({ data: {} }),
    });
}

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
});

test("offline: allowlisted object button is queued on crm.lead", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await makeTestApp();
    await setOffline(true);

    await getService("action").doActionButton({
        resModel: "crm.lead",
        resId: 1,
        name: "action_set_won_rainbowman",
        type: "object",
        context: {},
    });

    const values = scheduledValues();
    expect(values).toHaveLength(1);
    expect(values[0].model).toBe("crm.lead");
    expect(values[0].method).toBe("action_set_won_rainbowman");
    expect(values[0].args).toEqual([[1]]);
});

test("offline: extras carry timestamp and display name", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await makeTestApp();
    await setOffline(true);

    await getService("action").doActionButton({
        resModel: "crm.lead",
        resIds: [1, 2],
        name: "action_restore",
        type: "object",
        context: {},
    });

    const values = scheduledValues();
    expect(values).toHaveLength(1);
    expect(values[0].args).toEqual([[1, 2]]);
    expect(typeof values[0].extras.timeStamp).toBe("number");
    expect(values[0].extras.displayName).toBe("2 Records");
});

test("offline: non-allowlisted object button is refused", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await makeTestApp();
    await setOffline(true);

    await getService("action").doActionButton({
        resModel: "crm.lead",
        resId: 1,
        name: "action_schedule_meeting",
        type: "object",
        context: {},
    });

    expect(scheduledValues()).toHaveLength(0);
});

test("offline: non-allowlisted action button is refused", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await makeTestApp();
    await setOffline(true);

    await getService("action").doActionButton({
        resModel: "crm.lead",
        resId: 1,
        name: 12345, // not the cached lost-wizard action id
        type: "action",
        context: {},
    });

    expect(scheduledValues()).toHaveLength(0);
});

test("offline: object button on another model is not intercepted", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    // route-level listener registered after mockOffline so it runs before the
    // /* short-circuit: object buttons go through /web/dataset/call_button
    onRpc("/web/dataset/call_button/res.partner/some_method", () => {
        expect.step("partner call");
    });
    await makeTestApp();
    await setOffline(true);

    await getService("action")
        .doActionButton({
            resModel: "res.partner",
            resId: 1,
            name: "some_method",
            type: "object",
            context: {},
        })
        .catch(() => {}); // rpc fails offline: what matters is the original path ran

    await expect.waitForSteps(["partner call"]);
    expect(scheduledValues()).toHaveLength(0);
});

test("online: allowlisted button calls through to the server", async () => {
    onRpc("crm.lead", "action_set_won_rainbowman", () => {
        expect.step("won call");
    });
    await makeTestApp();

    await getService("action").doActionButton({
        resModel: "crm.lead",
        resId: 1,
        name: "action_set_won_rainbowman",
        type: "object",
        context: {},
    });

    await expect.waitForSteps(["won call"]);
    expect(scheduledValues()).toHaveLength(0);
});

test("offline: actions are refused on records without a real id", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await makeTestApp();
    await setOffline(true);

    await getService("action").doActionButton({
        resModel: "crm.lead",
        resId: "crm.lead_1", // virtual id of a record created offline
        name: "action_set_lost",
        type: "object",
        context: {},
    });

    expect(scheduledValues()).toHaveLength(0);
});

test("offline: log note on a crm.lead thread is queued as message_post", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await makeTestApp();
    const thread = getService("mail.store")["mail.thread"].insert({
        model: "crm.lead",
        id: 1,
    });
    await setOffline(true);

    await thread.post(markup("<p>my note</p>"), { isNote: true });

    const posts = scheduledValues().filter((v) => v.method === "message_post");
    expect(posts).toHaveLength(1);
    expect(posts[0].model).toBe("crm.lead");
    expect(posts[0].args).toEqual([[1]]);
    expect(posts[0].kwargs.subtype_xmlid).toBe("mail.mt_note");
    expect(posts[0].kwargs.message_type).toBe("comment");
    expect(String(posts[0].kwargs.body)).toBe("<p>my note</p>");
    expect(typeof posts[0].extras.timeStamp).toBe("number");
    expect(posts[0].extras.displayName).toBe("Lead 1");
});

test("offline: message_post merges recipients and honors isCcEnabled", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await makeTestApp();
    const thread = getService("mail.store")["mail.thread"].insert({
        model: "crm.lead",
        id: 1,
    });
    thread.suggestedRecipients = [
        { persona: { id: 41 }, recipient_type: "to" },
        { persona: { id: 42 }, recipient_type: "cc" },
    ];
    await setOffline(true);

    await thread.post(markup("<p>hi</p>"), { isNote: false, isCcEnabled: false });

    const posts = scheduledValues().filter((v) => v.method === "message_post");
    expect(posts).toHaveLength(1);
    expect(posts[0].kwargs.partner_ids).toEqual([41]);
    // Cc recipient dropped: the composer Cc field was not enabled
    expect(posts[0].kwargs.partner_cc_ids).toBe(undefined);

    await thread.post(markup("<p>hi</p>"), { isNote: false, isCcEnabled: true });
    const posts2 = scheduledValues().filter((v) => v.method === "message_post");
    expect(posts2).toHaveLength(2);
    expect(posts2[1].kwargs.partner_cc_ids).toEqual([42]);
});

test("offline: message_post skips recipients without a partner", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await makeTestApp();
    const thread = getService("mail.store")["mail.thread"].insert({
        model: "crm.lead",
        id: 1,
    });
    thread.suggestedRecipients = [{ email: "someone@example.com", recipient_type: "to" }];
    await setOffline(true);

    await thread.post(markup("<p>hi</p>"), { isNote: false });

    const posts = scheduledValues().filter((v) => v.method === "message_post");
    expect(posts).toHaveLength(1);
    // email-only suggestions resolve server-side: not queueable, dropped
    expect(posts[0].kwargs.partner_ids).toBe(undefined);
});

test("offline: message_post with attachments is refused", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await makeTestApp();
    const thread = getService("mail.store")["mail.thread"].insert({
        model: "crm.lead",
        id: 1,
    });
    await setOffline(true);

    await thread.post(markup("<p>hi</p>"), {
        isNote: true,
        attachments: [{ id: 1, name: "file.txt" }],
    });

    expect(scheduledValues()).toHaveLength(0);
});

test("offline: message_post on an offline-created record is refused", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    await makeTestApp();
    const thread = getService("mail.store")["mail.thread"].insert({
        model: "crm.lead",
        id: "crm.lead_1",
    });
    await setOffline(true);

    await thread.post(markup("<p>hi</p>"), { isNote: true });

    expect(scheduledValues()).toHaveLength(0);
});

test("offline: message_post on another model is not intercepted", async () => {
    const setOffline = mockOffline();
    stubStoreFetch();
    // Reaching the real store params builder proves the patch let this model
    // through; the minimal return keeps the post off heavy store internals.
    patch(StoreService.prototype, {
        async getMessagePostParams() {
            expect.step("real post");
            return {};
        },
    });
    await makeTestApp();
    const thread = getService("mail.store")["mail.thread"].insert({
        model: "res.partner",
        id: 1,
    });
    await setOffline(true);

    await thread.post(markup("<p>hi</p>"), { isNote: true }).catch(() => {});

    await expect.waitForSteps(["real post"]);
    expect(scheduledValues()).toHaveLength(0);
});
