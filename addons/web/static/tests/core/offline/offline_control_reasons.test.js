import { animationFrame, expect, test } from "@odoo/hoot";
import { Component, xml } from "@odoo/owl";
import { getService, mountWithCleanup, patchWithCleanup } from "@web/../tests/web_test_helpers";
import { NotificationPlugin } from "@web/core/notifications/notification_plugin";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";

class OfflineControlFixture extends Component {
    static template = xml`
        <main class="o_web_client">
            <span id="o_test_original_help">Online help</span>
            <button class="o_test_generic" title="Original title" data-tooltip="Original tooltip"
                data-tooltip-template="original-template" aria-describedby="o_test_original_help">Generic</button>
            <button class="o_test_generic_other">Other</button>
            <button class="o_test_explained" data-offline-reason="Needs a connection to send">Send</button>
            <button class="o_test_available" data-available-offline="">Available</button>
        </main>
    `;
}

function tryActivating(button) {
    for (const type of ["touchstart", "touchend", "pointerup", "click"]) {
        button.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    }
    for (const key of ["Enter", " "]) {
        button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
}

function logActivations(button) {
    for (const type of ["click", "touchstart", "touchend", "pointerdown", "pointerup", "keydown"]) {
        button.addEventListener(type, () => expect.step(type));
    }
}

test("generic buttons keep native disabling, share a reason, and restore their online attributes", async () => {
    await mountWithCleanup(OfflineControlFixture);
    const offline = getService(OfflinePlugin);
    const generic = document.querySelector(".o_test_generic");
    const available = document.querySelector(".o_test_available");
    logActivations(generic);
    logActivations(available);
    offline.setOffline(true);

    expect(generic).toHaveAttribute("disabled");
    expect(generic).toHaveClass("o_disabled_offline");
    expect(generic).not.toHaveAttribute("aria-disabled");
    expect(generic).toHaveAttribute("data-tooltip", "Needs a connection");
    expect(generic).toHaveAttribute("title", "Needs a connection");
    expect(generic).not.toHaveAttribute("data-tooltip-template");
    const description = document.querySelector(".o_test_generic_other").getAttribute("aria-describedby");
    expect(generic).toHaveAttribute("aria-describedby", `o_test_original_help ${description}`);
    expect(document.getElementById(description).textContent).toBe("Needs a connection");

    generic.click();
    tryActivating(generic);
    expect.verifySteps([]);
    available.click();
    expect.verifySteps(["click"]);

    offline.setOffline(false);
    expect(generic).not.toHaveAttribute("disabled");
    expect(generic).not.toHaveClass("o_disabled_offline");
    expect(generic).toHaveAttribute("aria-describedby", "o_test_original_help");
    expect(generic).toHaveAttribute("title", "Original title");
    expect(generic).toHaveAttribute("data-tooltip", "Original tooltip");
    expect(generic).toHaveAttribute("data-tooltip-template", "original-template");
    expect(".o_test_generic_other").not.toHaveAttribute("aria-describedby");
    expect(".o_test_generic_other").not.toHaveAttribute("data-tooltip");
    expect(document.getElementById(description)).toBe(null);
    generic.click();
    expect.verifySteps(["click"]);
});

test("a retargeted tap on a native disabled button explains it once without reaching the underlying control", async () => {
    await mountWithCleanup(OfflineControlFixture);
    const offline = getService(OfflinePlugin);
    const generic = document.querySelector(".o_test_generic");
    const available = document.querySelector(".o_test_available");
    logActivations(available);
    logActivations(generic);
    patchWithCleanup(document, {
        elementsFromPoint(x, y) {
            expect([x, y]).toEqual([10, 20]);
            return [generic, available];
        },
    });
    patchWithCleanup(getService(NotificationPlugin), {
        add(message, options) {
            expect.step(message.toString());
            return super.add(message, options);
        },
    });

    offline.setOffline(true);
    available.dispatchEvent(new PointerEvent("pointerdown", {
        pointerType: "touch", clientX: 10, clientY: 20, bubbles: true, cancelable: true,
    }));
    available.dispatchEvent(new MouseEvent("click", {
        detail: 1, clientX: 10, clientY: 20, bubbles: true, cancelable: true,
    }));
    expect.verifySteps(["Needs a connection"]);
    await animationFrame();
    expect(".o_notification_content").toHaveText("Needs a connection");
    offline.setOffline(false);
    await animationFrame();
    expect(".o_notification_content").toHaveCount(0);
});

test("an explicitly explained button stays focusable but rejects pointer, touch and keyboard activation", async () => {
    await mountWithCleanup(OfflineControlFixture);
    const offline = getService(OfflinePlugin);
    const button = document.querySelector(".o_test_explained");
    logActivations(button);
    offline.setOffline(true);

    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("disabled");
    button.focus();
    expect(document.activeElement).toBe(button);
    const description = document.getElementById(button.getAttribute("aria-describedby"));
    expect(description.textContent).toBe("Needs a connection to send");
    expect(button).toHaveAttribute("data-tooltip", "Needs a connection to send");
    const { x, y, width, height } = button.getBoundingClientRect();
    button.dispatchEvent(new PointerEvent("pointerdown", {
        clientX: x + width / 2, clientY: y + height / 2, bubbles: true, cancelable: true,
    }));
    tryActivating(button);
    await animationFrame();
    expect(".o_notification_content").toHaveText("Needs a connection to send");
    expect.verifySteps([]);

    offline.setOffline(false);
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAttribute("data-tooltip");
    expect(button).not.toHaveClass("o_disabled_offline");
    button.click();
    expect.verifySteps(["click"]);
});
