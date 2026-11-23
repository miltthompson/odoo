import { computed, signal, t, usePlugin } from "@odoo/owl";
import { DebugModePlugin } from "@web/core/debug_mode_plugin";
import { Crypto } from "@web/core/crypto";
import { offlineDatabaseName } from "@web/core/offline/offline_storage";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { IndexedDB } from "@web/core/utils/indexed_db";
import { session } from "@web/session";

export const menuService = {
    dependencies: ["action"],
    async start(env, { action }) {
        /**
         * @param {boolean} [reload=false]
         */
        async function fetchMenus(reload) {
            if (!reload && odoo.loadMenusPromise) {
                return odoo.loadMenusPromise;
            }
            const res = await fetch(loadMenusUrl, { cache: "no-store" });
            if (!res.ok) {
                throw new Error("Error while fetching menus");
            }
            return res.json();
        }

        /**
         * @param {string | number} menuId
         */
        function getMenu(menuId) {
            return menusData()[menuId];
        }

        /**
         * @param {string | number | Record<string, any>} menu
         */
        function setCurrentMenu(menu) {
            menu = typeof menu === "number" ? getMenu(menu) : menu;
            if (menu && menu.appID !== currentAppId()) {
                currentAppId.set(menu.appID ?? null);
                sessionStorage.setItem("menu_id", menu.appID);
                env.bus.trigger("MENUS:APP-CHANGED");
            }
        }

        const currentAppId = signal(null, {
            type: t.or([t.string(), t.number(), t.literal(null)]),
        });
        const menusData = signal(null, { type: t.record(t.string()) });

        const owner = { db: session.db, uid: user.userId };
        const crypto = window.isSecureContext && owner.db && owner.uid && session.browser_cache_secret &&
            new Crypto(session.browser_cache_secret);
        const menuDB = crypto && new IndexedDB(offlineDatabaseName("webclient_menu", owner), session.registry_hash);
        let clearing = false;
        async function storeMenus(menus) {
            if (menuDB && !clearing) {
                const data = await crypto.encrypt(menus);
                if (!clearing) {
                    await menuDB.write(table, key, data);
                }
            }
        }
        const table = "menu";
        const debugMode = usePlugin(DebugModePlugin);
        const key = JSON.stringify({ debug: debugMode.isActive() });
        const loadMenusUrl = `/web/webclient/load_menus`;

        let storedMenus;
        if (menuDB) {
            const stored = await menuDB.read(table, key);
            if (stored) {
                storedMenus = await crypto.decrypt(stored).catch(() => undefined);
            }
        }
        if (storedMenus) {
            fetchMenus().then((res) => {
                if (res) {
                    const fetchedMenus = JSON.stringify(res);
                    if (fetchedMenus !== storedMenus) {
                        storeMenus(fetchedMenus);
                        menusData.set(res);
                        env.bus.trigger("MENUS:APP-CHANGED");
                    }
                }
            });
            menusData.set(JSON.parse(storedMenus));
        } else {
            const fetchedMenus = await fetchMenus();
            menusData.set(fetchedMenus);
            if (fetchedMenus) {
                storeMenus(JSON.stringify(fetchedMenus));
            }
        }

        return {
            getAll: computed(() => Object.values(menusData())),
            getApps: computed(() => getMenu("root").children.map(getMenu)),
            getCurrentApp: computed(() => currentAppId() && getMenu(currentAppId())),
            getMenu,
            clearCache() {
                clearing = true;
                sessionStorage.removeItem("menu_id");
                return menuDB?.invalidate();
            },
            getMenuAsTree(menuID) {
                const menu = getMenu(menuID);
                if (!menu.childrenTree) {
                    menu.childrenTree = menu.children.map((mid) => this.getMenuAsTree(mid));
                }
                return menu;
            },
            async reload() {
                menusData.set(await fetchMenus(true));
                env.bus.trigger("MENUS:APP-CHANGED");
            },
            async selectMenu(menu) {
                menu = typeof menu === "number" ? getMenu(menu) : menu;
                if (!menu.actionID) {
                    return;
                }
                await action.doAction(menu.actionID, {
                    clearBreadcrumbs: true,
                    onActionReady: () => {
                        setCurrentMenu(menu);
                    },
                });
            },
            setCurrentMenu,
        };
    },
};

registry.category("services").add("menu", menuService);
