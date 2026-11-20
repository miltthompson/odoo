"""Opt-in loopback TCP relay for browser tests; no HTTP or browser interception."""

import selectors
import socket
import socketserver
import threading
from contextlib import ExitStack, suppress


class _RelayHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.server.relay._forward(self.request)


class BrowserNetworkRelay:
    """Relay a browser origin to the local Odoo HTTP server (including websockets)."""

    def __init__(self, host, port, *, slow_delay=0.5):
        self._upstream = (host, port)
        self._slow_delay = slow_delay
        self._mode = 'online'
        self._condition = threading.Condition()
        self._sockets = set()
        self._cleanup = ExitStack()

    def __enter__(self):
        with ExitStack() as cleanup:
            server = cleanup.enter_context(socketserver.ThreadingTCPServer((self._upstream[0], 0), _RelayHandler))
            server.relay = self
            self.url = f'http://{server.server_address[0]}:{server.server_address[1]}'
            thread = threading.Thread(target=server.serve_forever, args=(0.05,), name='Browser network relay')
            thread.start()
            cleanup.callback(thread.join)
            cleanup.callback(server.shutdown)
            cleanup.callback(self.set_mode, 'offline')
            self._cleanup = cleanup.pop_all()
        return self

    def __exit__(self, *exc_details):
        return self._cleanup.__exit__(*exc_details)

    def set_mode(self, mode):
        """Apply to open and new connections until changed again.

        ``slow`` delays forwarded chunks by ``slow_delay`` seconds.
        ``drop_response`` closes each connection on its first upstream response
        bytes, without forwarding them. Arm it before the request under test.
        """
        if mode not in ('online', 'offline', 'slow', 'drop_response'):
            raise ValueError(f'Unknown browser network mode: {mode!r}')
        with self._condition:
            self._mode = mode
            if mode == 'offline':
                for sock in self._sockets:
                    with suppress(OSError):
                        sock.shutdown(socket.SHUT_RDWR)
            self._condition.notify_all()

    def _forward(self, client):
        with self._condition:
            if self._mode == 'offline':
                return
            self._sockets.add(client)
        try:
            with socket.create_connection(self._upstream, timeout=5) as upstream:
                upstream.settimeout(None)
                with self._condition:
                    if self._mode == 'offline':
                        return
                    self._sockets.add(upstream)
                try:
                    self._relay(client, upstream)
                finally:
                    with self._condition:
                        self._sockets.discard(upstream)
        except OSError:
            # Normal on connection shutdown/reset and when the upstream is down.
            pass
        finally:
            with self._condition:
                self._sockets.discard(client)

    def _relay(self, client, upstream):
        with selectors.DefaultSelector() as selector:
            selector.register(client, selectors.EVENT_READ, upstream)
            selector.register(upstream, selectors.EVENT_READ, client)
            while selector.get_map():
                for key, _ in selector.select():
                    chunk = key.fileobj.recv(65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.data.shutdown(socket.SHUT_WR)
                        continue
                    with self._condition:
                        if self._mode == 'slow':
                            self._condition.wait_for(lambda: self._mode != 'slow', timeout=self._slow_delay)
                        if self._mode == 'offline' or (
                            self._mode == 'drop_response' and key.fileobj is upstream
                        ):
                            return
                    key.data.sendall(chunk)
