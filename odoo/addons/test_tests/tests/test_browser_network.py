import json
import socket
import threading
from contextlib import closing
from http.client import HTTPConnection, RemoteDisconnected
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from time import monotonic
from urllib.parse import urlsplit

from odoo.tests import HttpCase
from odoo.tests.browser_network import BrowserNetworkRelay
from odoo.tests.case import TestCase
from odoo.tests.common import ChromeBrowser, HOST


class _EchoHandler(BaseHTTPRequestHandler):
    def handle(self):
        self.server.accepted.set()
        super().handle()

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.server.received.append(body)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class TestBrowserNetworkRelay(TestCase):
    def test_relay_modes(self):
        with ThreadingHTTPServer((HOST, 0), _EchoHandler) as upstream:
            upstream.received = []
            upstream.accepted = threading.Event()
            server = threading.Thread(target=upstream.serve_forever, args=(0.05,))
            server.start()
            try:
                with BrowserNetworkRelay(*upstream.server_address, slow_delay=0.1) as relay:
                    port = urlsplit(relay.url).port

                    def post(body):
                        with closing(HTTPConnection(HOST, port, timeout=3)) as connection:
                            connection.request('POST', '/', body=body)
                            return connection.getresponse().read()

                    with closing(socket.create_connection((HOST, port), timeout=3)) as client:
                        # Keep an established connection idle during the cut.
                        self.assertTrue(upstream.accepted.wait(3))
                        self.assertEqual(post(b'first'), b'first')
                        relay.set_mode('offline')
                        try:
                            self.assertEqual(client.recv(1), b'')
                        except ConnectionResetError:
                            pass
                        with self.assertRaises((ConnectionResetError, BrokenPipeError, RemoteDisconnected)):
                            post(b'unplugged')
                    relay.set_mode('online')
                    self.assertEqual(post(b'reconnected'), b'reconnected')
                    relay.set_mode('slow')
                    started = monotonic()
                    self.assertEqual(post(b'slow'), b'slow')
                    self.assertGreaterEqual(monotonic() - started, 0.1)
                    relay.set_mode('drop_response')
                    with self.assertRaises((ConnectionResetError, RemoteDisconnected)):
                        post(b'dropped')
                    self.assertEqual(upstream.received, [b'first', b'reconnected', b'slow', b'dropped'])
            finally:
                upstream.shutdown()
                server.join()


class TestBrowserNetwork(HttpCase):
    PAGE = '/test_tests/static/tests/browser_network.html'

    def test_tour_origin(self):
        relay = self.start_network_relay()
        self.browser_js(self.PAGE, f"""
            if (location.origin !== {json.dumps(relay.url)}) {{
                throw new Error("Browser did not use the relay origin");
            }}
            console.log('test successful');
        """)

    def test_page_and_service_worker_fetch_fail_without_network(self):
        relay = self.start_network_relay()
        browser = ChromeBrowser(self)
        with self.allow_requests(browser=browser), browser.cleanup:
            browser.navigate_to(relay.url + self.PAGE, wait_stop=True)

            def evaluate(expression):
                result = browser._websocket_request('Runtime.evaluate', params={
                    'expression': expression, 'awaitPromise': True, 'returnByValue': True,
                })
                self.assertNotIn('exceptionDetails', result, result)
                return result['result'].get('value')

            evaluate("""(async () => {
                await navigator.serviceWorker.register('./browser_network_worker.js');
                const { active } = await navigator.serviceWorker.ready;
                window.checkWorkerFetch = () => new Promise(resolve => {
                    const { port1, port2 } = new MessageChannel();
                    port1.onmessage = event => {
                        port1.close();
                        resolve(event.data);
                    };
                    active.postMessage(location.pathname, [port2]);
                });
                window.checkPageFetch = () => fetch(location.pathname, { cache: 'no-store' }).then(
                    response => response.ok ? 'online' : 'http error', error => error.name
                );
            })()""")
            self.assertEqual(evaluate('checkPageFetch()'), 'online')
            self.assertEqual(evaluate('checkWorkerFetch()'), 'online')
            relay.set_mode('offline')
            self.assertEqual(evaluate('checkPageFetch()'), 'TypeError')
            self.assertEqual(evaluate('checkWorkerFetch()'), 'TypeError')
            browser.stop_service_workers()
            relay.set_mode('online')
            self.assertEqual(evaluate('checkPageFetch()'), 'online')
            self.assertEqual(evaluate('checkWorkerFetch()'), 'online')
