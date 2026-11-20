# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

import json

from odoo.addons.base.tests.common import HttpCaseWithUserDemo
from odoo.tests.common import tagged


@tagged("-at_install", "post_install")
class WebManifestRoutesTest(HttpCaseWithUserDemo):
    """
    This test suite is used to request the routes used by the PWA backend implementation
    """

    def test_webmanifest(self):
        """
        This route returns a well formed backend's WebManifest
        """
        self.authenticate("admin", "admin")
        response = self.url_open("/web/manifest.webmanifest")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Content-Type"], "application/manifest+json")
        data = response.json()
        self.assertEqual(data["name"], "Odoo")
        self.assertEqual(data["scope"], "/odoo")
        self.assertEqual(data["start_url"], "/odoo")
        self.assertEqual(data["display"], "standalone")
        self.assertEqual(data["background_color"], "#714B67")
        self.assertEqual(data["theme_color"], "#714B67")
        self.assertEqual(data["prefer_related_applications"], False)
        self.assertCountEqual(data["icons"], [
            {'src': '/web/static/img/odoo-icon-192x192.png', 'sizes': '192x192', 'type': 'image/png'},
            {'src': '/web/static/img/odoo-icon-512x512.png', 'sizes': '512x512', 'type': 'image/png'}
        ])
        self.assertGreaterEqual(len(data["shortcuts"]), 0)
        for shortcut in data["shortcuts"]:
            self.assertGreater(len(shortcut["name"]), 0)
            self.assertGreater(len(shortcut["description"]), 0)
            self.assertGreater(len(shortcut["icons"]), 0)
            self.assertTrue(shortcut["url"].startswith("/odoo?menu_id="))

    def test_webmanifest_unauthenticated(self):
        """
        This route returns a well formed backend's WebManifest
        """
        response = self.url_open("/web/manifest.webmanifest")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Content-Type"], "application/manifest+json")
        data = response.json()
        self.assertEqual(data["name"], "Odoo")
        self.assertEqual(data["scope"], "/odoo")
        self.assertEqual(data["start_url"], "/odoo")
        self.assertEqual(data["display"], "standalone")
        self.assertEqual(data["background_color"], "#714B67")
        self.assertEqual(data["theme_color"], "#714B67")
        self.assertEqual(data["prefer_related_applications"], False)
        self.assertCountEqual(data["icons"], [
            {'src': '/web/static/img/odoo-icon-192x192.png', 'sizes': '192x192', 'type': 'image/png'},
            {'src': '/web/static/img/odoo-icon-512x512.png', 'sizes': '512x512', 'type': 'image/png'}
        ])
        self.assertEqual(len(data["shortcuts"]), 0)

    def test_webmanifest_scoped(self):
        response = self.url_open("/web/manifest.scoped_app_manifest?app_id=test&path=/test&app_name=Test")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Content-Type"], "application/manifest+json")
        data = response.json()
        self.assertEqual(data["name"], "Test")
        self.assertEqual(data["scope"], "/test")
        self.assertEqual(data["start_url"], "/test")
        self.assertEqual(data["display"], "standalone")
        self.assertEqual(data["background_color"], "#714B67")
        self.assertEqual(data["theme_color"], "#714B67")
        self.assertEqual(data["prefer_related_applications"], False)
        self.assertCountEqual(data["icons"], [
            {'src': "/web/static/img/odoo-icon-192x192.png", 'sizes': 'any', 'type': 'image/png'}
        ])
        self.assertEqual(len(data["shortcuts"]), 0)

    def test_serviceworker(self):
        """
        This route returns a JavaScript's ServiceWorker
        """
        response = self.url_open("/web/service-worker.js")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Content-Type"], "text/javascript")
        self.assertEqual(response.headers["Service-Worker-Allowed"], "/odoo")

    def _test_worker_cache(self, code):
        self.browser_js("/odoo/offline", """
            const workerURL = URL.createObjectURL(new Blob([`
                self.registration = { scope: self.location.origin + '/odoo' };
                importScripts(self.location.origin + '/web/service-worker.js');
                (async () => {
            `, CODE, `
                    self.postMessage('test successful');
                })().catch((error) => self.postMessage(error.message));
            `], { type: 'text/javascript' }));
            const worker = new Worker(workerURL);
            worker.onmessage = ({ data }) => {
                worker.terminate();
                URL.revokeObjectURL(workerURL);
                if (data === 'test successful') {
                    console.log(data);
                } else {
                    console.error(data);
                }
            };
            worker.onerror = (event) => console.error(event.message);
        """.replace("CODE", json.dumps(code)))

    def test_offline_descriptor_lookup_during_refresh(self):
        self._test_worker_cache("""
            const request = new Request(self.location.origin + '/web/bundle/test?registry_hash=test');
            const oldScript = self.location.origin + '/web/assets/abcdef0/test.min.js';
            const newScript = self.location.origin + '/web/assets/abcdef1/test.min.js';
            const bundle = (src) => Response.json([{ type: 'script', src }]);
            const cache = await caches.open(bundleCacheName);
            await cache.put(oldScript, new Response('// cached script'));
            await saveBundleDescriptor(cache, request, bundle(oldScript));

            // Use real Cache Storage and control only the order of the reads.
            const match = Cache.prototype.match;
            let refreshed = false;
            Cache.prototype.match = async function (key) {
                const response = await match.call(this, key);
                if (!refreshed && key === request) {
                    refreshed = true;
                    await saveBundleDescriptor(cache, request, bundle(newScript));
                }
                return response;
            };
            const [entry] = await (await readCachedBundle(request, true)).json();
            if (!refreshed || entry.src !== oldScript) {
                throw new Error('Overlapping descriptor refresh hid the usable cached bundle');
            }
        """)

    def test_offline_css_lookup_requires_cached_stylesheet(self):
        self._test_worker_cache("""
            const full = new Request(self.location.origin + '/web/bundle/test?registry_hash=test');
            const cssOnly = new Request(full.url + '&offline_asset_type=css');
            const src = '/web/assets/abcdef0/test.min.css';
            const cache = await caches.open(bundleCacheName);
            await saveBundleDescriptor(cache, full, Response.json([
                { type: 'link', src },
                { type: 'script', src: '/web/assets/abcdef0/test.min.js' },
            ]));
            if (await readCachedBundle(cssOnly, true)) {
                throw new Error('Offline lookup returned an uncached stylesheet');
            }
            await cache.put(new URL(src, self.location.origin), new Response('/* cached CSS */'));
            const [entry] = await (await readCachedBundle(cssOnly, true)).json();
            if (entry.src !== src || await readCachedBundle(full, true)) {
                throw new Error('Only the CSS subset of this bundle is usable offline');
            }
        """)

    def test_offline_descriptor_reuses_files_in_http_cache(self):
        self._test_worker_cache("""
            const full = new URL('/web/bundle/web.assets_backend_lazy?registry_hash=test', self.location.origin);
            const files = await (await fetch(full)).json();
            const { src } = files.find(({ type, src }) =>
                type === 'link' && src && isBundleFile(new URL(src, self.location.origin))
            );
            const stylesheet = new URL(src, self.location.origin);
            const cssOnly = new Request(full.href + '&offline_asset_type=css');
            const cache = await caches.open(bundleCacheName);
            await saveBundleDescriptor(cache, full.href, Response.json(files));
            // The stylesheet exists on the server but is not cached yet.
            if (await readCachedBundle(cssOnly, true) || await cache.match(stylesheet.href)) {
                throw new Error('A cache miss downloaded the stylesheet from the server');
            }

            // An uncontrolled page can load a stylesheet without notifying the worker.
            const response = await fetch(stylesheet);
            if (!response.ok) {
                throw new Error('Failed to warm the stylesheet in the HTTP cache');
            }
            await response.arrayBuffer();
            if (!(await readCachedBundle(cssOnly, true)) || !(await cache.match(stylesheet.href))) {
                throw new Error('Offline descriptor lookup did not recover the HTTP-cached stylesheet');
            }

            // Model another uncontrolled load where the old stylesheet is only in HTTP cache.
            await cache.delete(stylesheet.href);
            await saveBundleDescriptor(cache, cssOnly, Response.json([{ type: 'link', src }]));
            await saveBundleDescriptor(cache, cssOnly, Response.json([
                { type: 'link', src: '/web/assets/abcdef1/unloaded.min.css' },
            ]));
            const previous = await cache.match(cssOnly);
            if (!previous || (await previous.json())[0].src !== src) {
                throw new Error('Descriptor refresh discarded the stylesheet still in HTTP cache');
            }
            const [entry] = await (await readCachedBundle(cssOnly, true)).json();
            if (entry.src !== src) {
                throw new Error('Offline lookup did not return the preserved descriptor');
            }
        """)

    def test_offline_url(self):
        """
        This route returns the offline page
        """
        response = self.url_open("/odoo/offline")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Content-Type"], "text/html; charset=utf-8")

    def test_apple_touch_icon(self):
        """
        This request tests the presence of an apple-touch-icon image route for the PWA icon and
        its presence from the head of the document.
        """
        self.authenticate("demo", "demo")
        response = self.url_open("/web/static/img/odoo-icon-ios.png")
        self.assertEqual(response.status_code, 200)

        document = self.url_open("/odoo")
        self.assertIn(
            '<link rel="apple-touch-icon" href="/web/static/img/odoo-icon-ios.png"/>', document.text,
            "Icon for iOS is present in the head of the document.",
        )
