import { afterEach, expect, test } from "@odoo/hoot";
import { markup } from "@odoo/owl";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { getService, makeTestApp, mockOffline, onRpc } from "@web/../tests/web_test_helpers";
import { defineCrmModels } from "@crm/../tests/crm_test_helpers";

defineCrmModels();

function scheduledValues() {
    return Object.values(getService(OfflinePlugin)._ormToSync()).map((e) => e.value);
}

afterEach(async () => {
    // queued calls persist in indexeddb across tests: drop them
    const scheduled = getService(OfflinePlugin)._ormToSync();
    for (const key of Object.keys(scheduled)) {
        await getService(OfflinePlugin).removeScheduledORM(key);
    }
});

test("offline: whitelisted object button is queued on crm.lead", async () => {
    const setOffline = mockOffline();
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

test("offline: non-whitelisted object button is not queued", async () => {
    const setOffline = mockOffline();
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

test("offline: object button on another model is not intercepted", async () => {
    // onRpc must be registered before mockOffline's /* listener, which
    // short-circuits every route while offline
    onRpc("res.partner", "some_method", () => {
        expect.step("partner call");
    });
    const setOffline = mockOffline();
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

test("online: whitelisted button calls through to the server", async () => {
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

test("offline: message_post on crm.lead thread is queued as note", async () => {
    const setOffline = mockOffline();
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
    expect(posts[0].kwargs.body).toBe("<p>my note</p>");
});

test("offline: message_post with attachments is refused", async () => {
    const setOffline = mockOffline();
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

test("offline: message_post on another model is not intercepted", async () => {
    onRpc("/mail/message/post", () => {
        expect.step("real post");
        return {};
    });
    const setOffline = mockOffline();
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
