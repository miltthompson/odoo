import { animationFrame, expect, press, queryAllTexts, queryOne, runAllTimers, test, waitFor } from "@odoo/hoot";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import {
    contains, defineActions, defineModels, fields, getService, mockOffline, models,
    mountWithCleanup, onRpc, patchWithCleanup, webModels,
} from "@web/../tests/web_test_helpers";

function schedule(offline, id, label, timeStamp) {
    offline.scheduleORM("res.partner", "write", [[id], { name: label }], {}, {
        label,
        extras: { actionName: "Contacts", displayName: `Contact ${id}`, timeStamp },
    });
}

test("pending changes keep send order and discard only after confirmation", async () => {
    const setOffline = mockOffline();
    onRpc("/web/webclient/version_info", () => new Response("", { status: 502 }), { pure: true });
    await mountWithCleanup(WebClient);
    const offline = getService(OfflinePlugin);
    await runAllTimers();
    await setOffline(true);
    expect("[aria-live='polite'].visually-hidden").toHaveText("Working offline");
    schedule(offline, 1, "First edit", 55);
    schedule(offline, 1, "Second edit", 42);
    schedule(offline, 2, "Third edit", 30);
    await animationFrame();
    expect(".o_offline_pending_count").toHaveText("3");
    await contains(".o_offline_systray").click();
    expect(queryAllTexts(".o_offline_pending_details > span")).toEqual([
        "First edit", "Second edit", "Third edit",
    ]);
    expect(queryAllTexts(".o_offline_pending_details strong")).toEqual(["Contact 1", "Contact 2"]);
    expect(queryAllTexts(".o_offline_pending_details small")).toEqual([
        "Waiting to be sent", "Waiting to be sent", "Waiting to be sent",
    ]);
    await contains(".o_offline_pending_item button[aria-label='Discard offline changes']:first").click();
    expect(offline.getPendingEntries()).toHaveLength(3);
    await contains(".modal-footer button.btn-primary").click();
    expect(offline.getPendingEntries()).toHaveLength(2);
});

test("a rejected change shows its reason and can be retried", async () => {
    let blocked = true;
    onRpc("/web/offline/sync", () => blocked
        ? new Response(JSON.stringify({ error: { code: 0, data: { name: "odoo.exceptions.AccessError" } } }))
        : true);
    await mountWithCleanup(WebClient);
    const offline = getService(OfflinePlugin);
    await runAllTimers();
    schedule(offline, 1, "Edited the phone number", 10);
    await offline._syncORM();
    await animationFrame();
    await contains(".o_offline_systray").click();
    expect(queryAllTexts(".o_offline_pending_details small")).toEqual([
        "Needs attention", "You no longer have access to this record.",
    ]);
    blocked = false;
    queryOne(".o_offline_pending_item").focus();
    queryOne(".o_offline_pending_details button:contains(Retry)").focus();
    await press("Enter");
    await runAllTimers();
    await animationFrame();
    const liveRegion = "[aria-live='polite'].visually-hidden";
    expect(liveRegion).toHaveText("All changes sent");
    const firstAnnouncement = queryOne(`${liveRegion} span`);
    schedule(offline, 2, "Second successful edit", 20);
    await offline._syncORM();
    await animationFrame();
    expect(queryOne(`${liveRegion} span`)).not.toBe(firstAnnouncement);
    expect(liveRegion).toHaveText("All changes sent");
});

test("Open shows the values of the selected save when two saves share a legacy key", async () => {
    class PendingContact extends models.Model {
        _name = "pending.contact";
        name = fields.Char();
        _records = [{ id: 1, name: "Server value" }];
        _views = { "form,false": '<form><field name="name" readonly="1"/></form>' };
    }
    defineModels([PendingContact, ...Object.values(webModels)]);
    defineActions([{ id: 5, res_model: "pending.contact", views: [[false, "form"]] }]);
    await mountWithCleanup(WebClient);
    await runAllTimers();
    const offline = getService(OfflinePlugin);
    const legacyKey = "same-form-save";
    await offline.scheduleORMBatch(["First queued name", "Second queued name"].map((name) => ({
        model: "pending.contact",
        method: "web_save",
        args: [[1], { name }],
        kwargs: {},
        options: {
            id: legacyKey,
            extras: { actionId: 5, viewType: "form", changes: { name } },
        },
    })));

    await contains(".o_offline_systray").click();
    await contains(".o_offline_pending_item button:contains(Open):first").click();
    await waitFor(".o_form_view .o_field_widget[name='name']:contains(First queued name)");
    await contains(".o_offline_systray").click();
    await contains(".o_offline_pending_item button:contains(Open):last").click();
    await waitFor(".o_form_view .o_field_widget[name='name']:contains(Second queued name)");
});

test("Open targets the saved record when a follow-up draft edit is rejected", async () => {
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        if (!params.refs.length) {
            return [{ id: 47 }];
        }
        return new Response(JSON.stringify({ error: {
            code: 200, data: { name: "odoo.exceptions.ValidationError", message: "Check the name." },
        } }));
    });
    await mountWithCleanup(WebClient);
    await runAllTimers();
    const offline = getService(OfflinePlugin);
    const extras = { actionId: 5, viewType: "form", timeStamp: Date.now() };
    const draft = offline.scheduleORM("res.partner", "web_save", [[], { name: "Draft" }], {}, { extras });
    offline.scheduleORM("res.partner", "web_save", [[], { name: "Follow-up edit" }], {}, { id: draft, extras });
    await offline._syncORM();
    const [edit] = await offline._queue.list();
    expect(edit.state).toBe("needs_attention");
    expect(edit.resolvedResId).toBe(47);

    patchWithCleanup(getService("action"), {
        async doAction(action, options) {
            expect.step([action, options.viewType, options.props.resId, options.props.offlineId]);
        },
    });
    await contains(".o_offline_systray").click();
    await contains(".o_offline_pending_item button:contains(Open)").click();
    expect.verifySteps([[5, "form", 47, edit.key]]);
});

test("a new edit to a synced draft waits behind a rejected edit to the same record", async () => {
    const sent = [];
    onRpc("/web/offline/sync", async (request) => {
        const { params } = await request.json();
        const { name } = params.args[1];
        sent.push(name);
        return name === "Rejected edit"
            ? new Response(JSON.stringify({ error: { code: 0, data: { name: "odoo.exceptions.AccessError" } } }))
            : [{ id: 47 }];
    });
    await mountWithCleanup(WebClient);
    await runAllTimers();
    const offline = getService(OfflinePlugin);
    const draft = offline.scheduleORM("res.partner", "web_save", [[], { name: "Draft" }], {});
    offline.scheduleORM("res.partner", "web_save", [[], { name: "Rejected edit" }], {}, { id: draft });
    await offline._syncORM();
    offline.scheduleORM("res.partner", "web_save", [[47], { name: "Later edit" }], {});
    await offline._syncORM();
    expect(sent).toEqual(["Draft", "Rejected edit"]);
    expect((await offline._queue.list()).map(({ state }) => state)).toEqual(["needs_attention", "held_back"]);
});

test("Open shows a follow-up save for an unsent draft while offline", async () => {
    class PendingContact extends models.Model {
        _name = "pending.contact";
        name = fields.Char();
        _views = { "form,false": '<form><field name="name" readonly="1"/></form>' };
    }
    defineModels([PendingContact, ...Object.values(webModels)]);
    defineActions([{ id: 5, res_model: "pending.contact", views: [[false, "form"]] }]);
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(5);
    await waitFor(".o_form_view");
    await setOffline(true);
    const offline = getService(OfflinePlugin);
    const base = { actionId: 5, viewType: "form" };
    const draft = offline.scheduleORM("pending.contact", "web_save", [[], { name: "Draft" }], {}, {
        extras: { ...base, changes: { name: "Draft" } },
    });
    offline.scheduleORM("pending.contact", "web_save", [[], { name: "Updated draft" }], {}, {
        id: draft, extras: { ...base, changes: { name: "Updated draft" } },
    });
    await offline.waitForPendingWrite(offline.getPendingEntry(draft).key);
    await contains(".o_offline_systray").click();
    expect(".o_offline_pending_item button:contains(Open)").toHaveCount(2);
    // The cached form opens even if its background revalidation can't reach the server.
    expect.errors(1);
    await contains(".o_offline_pending_item button:contains(Open):last").click();
    await waitFor(".o_form_view .o_field_widget[name='name']:contains(Updated draft)");
    expect.verifyErrors([
        'Connection to "/web/dataset/call_kw/pending.contact/onchange" couldn\'t be established',
    ]);
});

test("session expiry is announced without opening the pending-changes panel", async () => {
    onRpc("/web/offline/sync", () => new Response(JSON.stringify({ error: {
        code: 100,
        data: { name: "odoo.http.session.SessionExpiredException" },
    } })));
    await mountWithCleanup(WebClient);
    await runAllTimers();
    const offline = getService(OfflinePlugin);
    schedule(offline, 1, "My edit", 1);
    await offline._syncORM();
    await animationFrame();
    expect("[aria-live='polite'].visually-hidden").toHaveText("Log in again to send changes. Pending changes: 1");
});
