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
                const { loadBundle, getBundle, loadCSS } = odoo.loader.modules.get('@web/core/assets');
                const bundle = 'web.assets_backend_lazy';
                const { bundle_params, registry_hash } = odoo.loader.modules.get('@web/session').session;
                const descriptorURL = new URL(`/web/bundle/${bundle}`, location.origin);
                descriptorURL.search = new URLSearchParams({ ...bundle_params, registry_hash });
                const cache = await caches.open('odoo-sw-bundles');
                const latestDescriptors = await caches.open('odoo-sw-bundle-descriptors');
                const oldScript = '/web/assets/abcdef0/web.assets_backend_lazy.min.js';
                if (!scoped) {
                    // An asset edit can leave a working older bundle at the same descriptor URL.
                    await cache.put(oldScript, new Response('// old bundle', {
                        headers: { 'Content-Type': 'text/javascript' },
                    }));
                    await latestDescriptors.put(descriptorURL, Response.json([{ type: 'script', src: oldScript }]));
                }
                const { jsLibs, cssLibs } = await getBundle(bundle);
                const lazyScript = jsLibs.find((url) => url.startsWith('/web/assets/'));
                const lazyStylesheet = cssLibs.find((url) => url.startsWith('/web/assets/'));
                if (!lazyScript || !lazyStylesheet) {
                    throw new Error('The pipeline did not load its expected lazy JS and CSS bundles');
                }
                async function waitForCacheEntry(cache, url, matches) {
                    const deadline = performance.now() + 5000;
                    while (performance.now() < deadline) {
                        const entry = await cache.match(url);
                        if (entry && (!matches || await matches(entry))) {
                            return entry;
                        }
                        await new Promise(requestAnimationFrame);
                    }
                    throw new Error(`No matching cached response for ${url}`);
                }
                await waitForCacheEntry(latestDescriptors, descriptorURL, async (entry) => {
                    const files = (await entry.json()).map(({ src }) => src);
                    return files.includes(lazyScript) && files.includes(lazyStylesheet);
                });
                if (!scoped) {
                    // The new descriptor survives on disk even if only its CSS has arrived.
                    await loadCSS(lazyStylesheet);
                    const { active } = await serviceWorker.ready;
                    active.postMessage({ type: 'cache_bundle', bundles: [lazyStylesheet] });
                    await waitForCacheEntry(cache, lazyStylesheet);
                    if (await cache.match(lazyScript)) {
                        throw new Error('The test must leave the replacement JS unloaded');
                    }
                    const [entry] = await (await cache.match(descriptorURL)).json();
                    if (entry.src !== oldScript) {
                        throw new Error('An incomplete bundle replaced the usable cached descriptor');
                    }
                }
                await loadBundle(bundle);
                await Promise.all([
                    waitForCacheEntry(cache, lazyScript),
                    waitForCacheEntry(cache, lazyStylesheet),
                ]);
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
