import { browser } from "@web/core/browser/browser";

export const SCOPED_APP_SCOPE = "/scoped_app";
export const WEBCLIENT_SCOPE = "/odoo";

export function registerServiceWorker(scope) {
    const script =
        scope === SCOPED_APP_SCOPE ? "/web/scoped-app-service-worker.js" : "/web/service-worker.js";
    return browser.navigator.serviceWorker.register(script, { scope });
}
