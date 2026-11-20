import { animationFrame, expect, press, queryAllTexts, queryOne, runAllTimers, test } from "@odoo/hoot";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { contains, getService, mockOffline, mountWithCleanup, onRpc } from "@web/../tests/web_test_helpers";

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
