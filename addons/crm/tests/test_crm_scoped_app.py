# Part of Odoo. See LICENSE file for full copyright and licensing details.

from lxml import html

from odoo.tests import HttpCase, tagged


@tagged('post_install', '-at_install')
class TestCrmScopedApp(HttpCase):
    def test_crm_install_manifest(self):
        self.authenticate('admin', 'admin')
        response = self.url_open('/scoped_app', params={'app_id': 'crm', 'path': 'scoped_app/crm'})
        response.raise_for_status()
        [manifest_url] = html.fromstring(response.content).xpath('//link[@rel="manifest"]/@href')
        manifest = self.url_open(manifest_url).json()
        self.assertEqual(manifest['start_url'], '/scoped_app/crm')
        self.assertEqual(manifest['scope'], '/scoped_app/crm')
        self.assertEqual(manifest['display'], 'standalone')

        response = self.url_open('/web/scoped-app-service-worker.js')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Service-Worker-Allowed'], '/scoped_app')

    def test_crm_scoped_worker_caches_pipeline_bundles(self):
        self.env.ref('base.user_admin').tour_enabled = False
        self.browser_js('/scoped_app/crm', """
            (async () => {
                const { serviceWorker } = navigator;
                if (!serviceWorker.controller) {
                    await new Promise((resolve) => {
                        serviceWorker.addEventListener('controllerchange', resolve, { once: true });
                    });
                }
                if (!serviceWorker.controller.scriptURL.endsWith('/web/scoped-app-service-worker.js')) {
                    throw new Error('The CRM pipeline is not controlled by the scoped worker');
                }
                const { loadBundle, getBundle } = odoo.loader.modules.get('@web/core/assets');
                const bundle = 'web.assets_backend_lazy';
                await loadBundle(bundle);
                const { jsLibs } = await getBundle(bundle);
                const lazyScript = jsLibs.find((url) => url.startsWith('/web/assets/'));
                const stylesheet = document.querySelector('link[rel=stylesheet][media=screen][href^="/web/assets/"]');
                const descriptor = performance.getEntriesByType('resource').find(
                    ({ name }) => new URL(name).pathname === `/web/bundle/${bundle}`
                );
                if (!lazyScript || !stylesheet || !descriptor) {
                    throw new Error('The pipeline did not load its expected JS and CSS bundles');
                }
                async function waitForCacheEntry(cache, url) {
                    const deadline = performance.now() + 5000;
                    while (performance.now() < deadline) {
                        const entry = await cache.match(url);
                        if (entry) {
                            return entry;
                        }
                        await new Promise(requestAnimationFrame);
                    }
                    throw new Error(`No cached response for ${url}`);
                }
                const cache = await caches.open('odoo-sw-bundles');
                await Promise.all([lazyScript, stylesheet.href, descriptor.name].map(
                    (url) => waitForCacheEntry(cache, url)
                ));
                const pageCache = await caches.open('odoo-sw-cache');
                const page = await waitForCacheEntry(pageCache, '/scoped_app');
                const shell = await page.text();
                if (!shell.includes('@@@session_info_secret@@@') || shell.includes('browser_cache_secret')) {
                    throw new Error('The saved shell contains session information');
                }
                console.log('test successful');
            })().catch(console.error);
        """, ready="odoo.isReady && !!document.querySelector('.o_opportunity_kanban')", login='admin')
