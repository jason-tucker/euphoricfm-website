"""Shortlink resolution against a LOCAL redirect server (no SoundCloud).

The test opener sends each request the resolver makes to
http://127.0.0.1:<port>/<host><target>, so the server sees exactly which
host/path the resolver chose to request, and answers with real HTTP
redirects whose Location headers the resolver must re-validate.
"""

import http.client
import http.server
import ipaddress
import threading
import time
import unittest

from fetchsvc.errors import BAD_URL, EXTRACTOR_FAILED, NOT_A_TRACK, REDIRECT_HOST, TIMEOUT, FetchError
from fetchsvc.net import BlockedAddress, GuardedHttpsOpener, is_public_ip
from fetchsvc.urls import resolve_input, resolve_shortlink

# path on the local server -> (status, Location or None, delay seconds)
ROUTES = {
    '/on.soundcloud.com/ok': (302, 'https://soundcloud.com/artist/track?si=abc&utm_source=clipboard', 0),
    '/on.soundcloud.com/okm': (301, 'https://m.soundcloud.com/artist/track', 0),
    '/on.soundcloud.com/chain1': (302, 'https://on.soundcloud.com/chain2', 0),
    '/on.soundcloud.com/chain2': (307, '/chain3', 0),                 # relative Location
    '/on.soundcloud.com/chain3': (308, 'https://soundcloud.com/a/b', 0),
    '/on.soundcloud.com/set': (302, 'https://soundcloud.com/artist/sets/mix', 0),
    '/on.soundcloud.com/likes': (302, 'https://soundcloud.com/artist/likes', 0),
    '/on.soundcloud.com/evil': (302, 'https://evil.example/artist/track', 0),
    '/on.soundcloud.com/evilsuffix': (302, 'https://soundcloud.com.evil.example/a/b', 0),
    '/on.soundcloud.com/evilat': (302, 'https://soundcloud.com@evil.example/a/b', 0),
    '/on.soundcloud.com/evilport': (302, 'https://soundcloud.com:8443/a/b', 0),
    '/on.soundcloud.com/http': (302, 'http://soundcloud.com/a/b', 0),
    '/on.soundcloud.com/meta': (302, 'https://169.254.169.254/latest/meta-data', 0),
    '/on.soundcloud.com/idn': (302, 'https://soundcłoud.com/a/b', 0),
    '/on.soundcloud.com/noloc': (302, None, 0),
    '/on.soundcloud.com/api': (302, 'https://api-v2.soundcloud.com/tracks/1', 0),
    '/on.soundcloud.com/www': (302, 'https://www.soundcloud.com/a/b', 0),
    '/on.soundcloud.com/stay': (200, None, 0),
    '/on.soundcloud.com/gone': (404, None, 0),
    '/on.soundcloud.com/boom': (500, None, 0),
    '/on.soundcloud.com/slow': (302, 'https://soundcloud.com/a/b', 3),
}
# loopN -> loopN+1 forever (redirect cap)
for i in range(20):
    ROUTES[f'/on.soundcloud.com/loop{i}'] = (302, f'https://on.soundcloud.com/loop{i + 1}', 0)
# exactly five redirects then the track
for i in range(5):
    ROUTES[f'/on.soundcloud.com/five{i}'] = (
        302, f'https://on.soundcloud.com/five{i + 1}' if i < 4 else 'https://soundcloud.com/a/five', 0)


class _Handler(http.server.BaseHTTPRequestHandler):
    requests: list = []

    def do_GET(self):  # noqa: N802
        _Handler.requests.append(self.path)
        status, loc, delay = ROUTES.get(self.path.split('?')[0], (404, None, 0))
        if delay:
            time.sleep(delay)
        self.send_response(status)
        if loc is not None:
            # http.server encodes headers latin-1; send raw bytes for the IDN case
            self._headers_buffer.append(f'Location: {loc}\r\n'.encode('utf-8'))
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, *a):
        pass


class LocalOpener:
    def __init__(self, port):
        self.port = port

    def get(self, host, target, timeout):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        conn.request('GET', f'/{host}{target}')
        resp = conn.getresponse()

        class R:
            status = resp.status

            def getheader(self, n, d=None):
                return resp.getheader(n, d)

            def read(self, amt=None):
                return resp.read(amt)

            def close(self):
                resp.close()
                conn.close()
        return R()


class ShortlinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), _Handler)
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()
        cls.opener = LocalOpener(cls.srv.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        _Handler.requests.clear()

    def resolve(self, sid, **kw):
        return resolve_shortlink(f'https://on.soundcloud.com/{sid}', self.opener, **kw)

    def code(self, sid, **kw):
        with self.assertRaises(FetchError) as cm:
            self.resolve(sid, **kw)
        return cm.exception.code

    def test_ok_strips_query(self):
        self.assertEqual(self.resolve('ok'), 'https://soundcloud.com/artist/track')
        # soundcloud.com itself is never requested: only the shortlink hop.
        self.assertEqual(_Handler.requests, ['/on.soundcloud.com/ok'])

    def test_mobile_host_normalised(self):
        self.assertEqual(self.resolve('okm'), 'https://soundcloud.com/artist/track')

    def test_chain_with_relative_location(self):
        self.assertEqual(self.resolve('chain1'), 'https://soundcloud.com/a/b')
        self.assertEqual(_Handler.requests, ['/on.soundcloud.com/chain1', '/on.soundcloud.com/chain2',
                                             '/on.soundcloud.com/chain3'])

    def test_exactly_five_redirects_allowed(self):
        self.assertEqual(self.resolve('five0'), 'https://soundcloud.com/a/five')
        self.assertEqual(len(_Handler.requests), 5)

    def test_redirect_cap(self):
        self.assertEqual(self.code('loop0'), BAD_URL)
        self.assertEqual(len(_Handler.requests), 5)  # never a 6th request

    def test_set_and_likes_rejected(self):
        self.assertEqual(self.code('set'), NOT_A_TRACK)
        self.assertEqual(self.code('likes'), NOT_A_TRACK)

    def test_foreign_hosts_refused_before_request(self):
        for sid in ['evil', 'evilsuffix', 'evilat', 'evilport', 'http', 'meta', 'idn', 'noloc', 'api', 'www']:
            with self.subTest(sid=sid):
                _Handler.requests.clear()
                self.assertEqual(self.code(sid), REDIRECT_HOST)
                # only the shortlink itself was requested; the foreign hop never was
                self.assertEqual(_Handler.requests, [f'/on.soundcloud.com/{sid}'])

    def test_non_redirects(self):
        self.assertEqual(self.code('stay'), BAD_URL)
        self.assertEqual(self.code('gone'), BAD_URL)
        self.assertEqual(self.code('boom'), EXTRACTOR_FAILED)

    def test_timeout(self):
        self.assertEqual(self.code('slow', hop_timeout=0.5), TIMEOUT)

    def test_resolve_input_passthrough_for_track(self):
        self.assertEqual(resolve_input('https://soundcloud.com/a/b?si=1', self.opener), 'https://soundcloud.com/a/b')
        self.assertEqual(_Handler.requests, [])
        self.assertEqual(resolve_input('https://on.soundcloud.com/ok', self.opener),
                         'https://soundcloud.com/artist/track')


class ConnectGuardTests(unittest.TestCase):
    def test_is_public_ip(self):
        for bad in ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.251.1', '192.168.1.5', '100.64.0.1',
                    '100.127.255.254', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255',
                    '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '::ffff:169.254.169.254']:
            self.assertFalse(is_public_ip(ipaddress.ip_address(bad)), bad)
        for good in ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']:
            self.assertTrue(is_public_ip(ipaddress.ip_address(good)), good)

    def test_production_opener_refuses_loopback(self):
        with self.assertRaises(BlockedAddress):
            GuardedHttpsOpener().get('localhost', '/', 2)

    def test_resolver_maps_blocked_address(self):
        class Blocking:
            def get(self, host, target, timeout):
                raise BlockedAddress('x')
        with self.assertRaises(FetchError) as cm:
            resolve_shortlink('https://on.soundcloud.com/abc', Blocking())
        self.assertEqual(cm.exception.code, REDIRECT_HOST)


if __name__ == '__main__':
    unittest.main()
