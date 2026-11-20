import { ConnectionLostError } from "@web/core/network/rpc";

export async function checkRainbowmanMessage({ orm, effect, offlinePlugin }, recordId) {
    if (offlinePlugin.isOffline()) {
        return;
    }
    let message;
    try {
        message = await orm.call("crm.lead", "get_rainbowman_message", [[recordId]]);
    } catch (error) {
        if (error instanceof ConnectionLostError) {
            return; // The write succeeded; the effect is only decorative.
        }
        throw error;
    }
    if (message && !offlinePlugin.isOffline()) {
        effect.add({
            message,
            type: "rainbow_man",
        });
    }
}
