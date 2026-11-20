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
        self._check_pipeline_bundles('/scoped_app/crm')

    def test_crm_main_worker_primes_uncontrolled_lazy_bundles(self):
        self._check_pipeline_bundles('/odoo/crm')

    def _check_pipeline_bundles(self, path):
        self.env.ref('base.user_admin').tour_enabled = False
        scoped = 'true' if path.startswith('/scoped_app/') else 'false'
        script = """
            (async () => {
                const { serviceWorker } = navigator;
                const scoped = IS_SCOPED;
                if (scoped) {
                    if (!serviceWorker.controller) {
                        await new Promise((resolve) => {
                            serviceWorker.addEventListener('controllerchange', resolve, { once: true });
                        });
                    }
                    if (!serviceWorker.controller.scriptURL.endsWith('/web/scoped-app-service-worker.js')) {
                        throw new Error('The CRM pipeline is not controlled by the scoped worker');
                    }
                } else if (serviceWorker.controller) {
                    throw new Error('Expected the first main webclient visit to be uncontrolled');
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
                const page = await waitForCacheEntry(pageCache, scoped ? '/scoped_app' : '/odoo');
                const shell = await page.text();
                if (!shell.includes('@@@session_info_secret@@@') || shell.includes('browser_cache_secret')) {
                    throw new Error('The saved shell contains session information');
                }
                if (scoped) {
                    const response = await fetch('/scoped_app/crm?redirect=/odoo/crm', {
                        redirect: 'manual',
                        headers: { Accept: 'text/html' },
                    });
                    if (response.type !== 'opaqueredirect') {
                        throw new Error('Expected the original opaque redirect from the server');
                    }
                    const deadline = performance.now() + 5000;
                    while (await pageCache.match('/scoped_app')) {
                        if (performance.now() >= deadline) {
                            throw new Error('The scoped shell was not cleared after the redirect');
                        }
                        await new Promise(requestAnimationFrame);
                    }
                }
                console.log('test successful');
            })().catch(console.error);
        """.replace('IS_SCOPED', scoped)
        self.browser_js(path, script, ready="odoo.isReady && !!document.querySelector('.o_opportunity_kanban')", login='admin')
