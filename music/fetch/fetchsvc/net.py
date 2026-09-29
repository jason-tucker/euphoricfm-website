"""The only outbound HTTP code in fetch (besides the yt-dlp child).

Used for shortlink resolution (on.soundcloud.com) and artwork
(*.sndcdn.com). Callers validate the URL against their host allowlist first;
this layer adds a connect-time guard: every address the name resolves to must
be publicly routable, so a hostile DNS answer cannot aim fetch at the Docker
bridge, RFC1918, CGNAT, link-local/metadata or loopback. The host's
DOCKER-USER rules on fetch-egress are the primary control (README.md); this
is the in-process second layer. TLS verification is Python's default context
(system CA store, hostname checking on). No redirects are followed here —
callers see the raw 3xx and decide.
"""

from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
from typing import Protocol

USER_AGENT = 'efm-music-fetch/1 (+https://music.euphoric.fm)'

_CGNAT = ipaddress.ip_network('100.64.0.0/10')


class BlockedAddress(OSError):
    """The host resolved to a non-public address."""


def is_public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT:
        return False
    return bool(ip.is_global) and not ip.is_multicast and not ip.is_reserved


class Response(Protocol):
    status: int

    def getheader(self, name: str, default: str | None = None) -> str | None: ...
    def read(self, amt: int | None = None) -> bytes: ...
    def close(self) -> None: ...


class Opener(Protocol):
    def get(self, host: str, target: str, timeout: float) -> Response: ...


class _GuardedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPSConnection whose connect() refuses non-public resolved addresses.

    Every resolved address is checked BEFORE any connection attempt; one bad
    answer fails the whole request (no partial trust of a mixed answer set).
    SNI and certificate hostname checks use the original host name.
    """

    def __init__(self, host: str, *, timeout: float, context: ssl.SSLContext):
        super().__init__(host, 443, timeout=timeout, context=context)
        self._efm_ctx = context

    def connect(self) -> None:  # noqa: D401 - http.client hook
        infos = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
        if not infos:
            raise OSError(f'no addresses for {self.host}')
        for info in infos:
            if not is_public_ip(ipaddress.ip_address(info[4][0])):
                raise BlockedAddress(f'{self.host} resolved to a non-public address')
        last: OSError | None = None
        for family, socktype, proto, _canon, sockaddr in infos:
            sock = socket.socket(family, socktype, proto)
            try:
                sock.settimeout(self.timeout)
                sock.connect(sockaddr)
            except OSError as e:
                sock.close()
                last = e
                continue
            self.sock = self._efm_ctx.wrap_socket(sock, server_hostname=self.host)
            return
        raise last if last else OSError(f'could not connect to {self.host}')


class _ClosingResponse:
    """Wraps an HTTPResponse so close() also closes its connection."""

    def __init__(self, conn: http.client.HTTPConnection, resp: http.client.HTTPResponse):
        self._conn = conn
        self._resp = resp
        self.status = resp.status

    def getheader(self, name: str, default: str | None = None) -> str | None:
        return self._resp.getheader(name, default)

    def read(self, amt: int | None = None) -> bytes:
        return self._resp.read(amt)

    def close(self) -> None:
        try:
            self._resp.close()
        finally:
            self._conn.close()


class GuardedHttpsOpener:
    """Production opener: one GET per call, https:443 only, no redirects."""

    def __init__(self) -> None:
        self._ctx = ssl.create_default_context()

    def get(self, host: str, target: str, timeout: float) -> Response:
        if not target.startswith('/'):
            raise ValueError('target must be origin-form')
        conn = _GuardedHTTPSConnection(host, timeout=timeout, context=self._ctx)
        try:
            conn.request('GET', target, headers={
                'User-Agent': USER_AGENT,
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Connection': 'close',
            })
            resp = conn.getresponse()
        except BaseException:
            conn.close()
            raise
        return _ClosingResponse(conn, resp)
