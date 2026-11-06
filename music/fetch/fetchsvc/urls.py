"""SoundCloud URL validation and shortlink resolution (plan §3.6).

Accepted input, and nothing else:
    https://soundcloud.com/<user>/<track>
    https://on.soundcloud.com/<id>

The URL handed to yt-dlp is always REBUILT from the validated parts as
`https://soundcloud.com/<user>/<track>` — never the submitted string — so no
query, fragment, userinfo, port or encoding trick can reach the extractor.

Parsing is a strict regex over a printable-ASCII string, deliberately NOT
urllib.parse: anything outside ASCII (IDN lookalikes, fullwidth dots, NFKC
tricks) is rejected before any structural parsing happens.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from urllib.parse import urljoin

from .errors import BAD_URL, EXTRACTOR_FAILED, NOT_A_TRACK, REDIRECT_HOST, TIMEOUT, FetchError
from .net import BlockedAddress, Opener

MAX_URL_LEN = 512
MAX_REDIRECTS = 5
SHORT_HOST = 'on.soundcloud.com'
TRACK_HOST = 'soundcloud.com'
RESOLVED_TRACK_HOSTS = frozenset({'soundcloud.com', 'm.soundcloud.com'})
INPUT_HOSTS = frozenset({TRACK_HOST, SHORT_HOST})

# Printable ASCII only (0x21-0x7e): no spaces, controls, DEL or non-ASCII.
_PRINTABLE_ASCII = re.compile(r'\A[\x21-\x7e]+\Z')
# scheme://authority[/path][?query][#fragment] — authority may not contain / ? #
_URL_RE = re.compile(r'\A(?P<scheme>[A-Za-z][A-Za-z0-9+.-]*)://(?P<authority>[^/?#]*)'
                     r'(?P<path>/[^?#]*)?(?:\?(?P<query>[^#]*))?(?:#(?P<fragment>.*))?\Z')
_HOST_RE = re.compile(r'\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\Z')
# SoundCloud permalinks: letters, digits, underscore, hyphen.
_SEGMENT_RE = re.compile(r'\A[A-Za-z0-9_-]{1,100}\Z')
_SHORT_ID_RE = re.compile(r'\A[A-Za-z0-9]{1,32}\Z')
_QUERY_VALUE_RE = re.compile(r'\A[A-Za-z0-9._~%:/+-]{0,200}\Z')

# Share/tracking parameters SoundCloud itself appends. They are tolerated on
# input and then DISCARDED (never forwarded). Any other key is rejected.
TOLERATED_QUERY_KEYS = frozenset({
    'si', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'ref', 'p', 'c', 'in',
})

# First path segments that are site sections, not users.
RESERVED_FIRST = frozenset({
    'discover', 'search', 'stream', 'you', 'charts', 'stations', 'upload', 'settings',
    'messages', 'notifications', 'people', 'pages', 'tags', 'terms-of-use', 'popular',
    'mobile', 'jobs', 'imprint', 'pro', 'signin', 'signup', 'logout', 'go', 'apps',
    'creators', 'artists', 'connect', 'feed', 'home', 'library', 'playlists', 'likes',
    'sets', 'tracks', 'albums', 'reposts', 'following', 'followers', 'groups', 'hc',
    'help', 'explore', 'premium', 'next', 'secret-token', 'oembed', 'player',
})
# Second segments that are user sub-pages (collections), not tracks.
RESERVED_SECOND = frozenset({
    'sets', 'likes', 'reposts', 'tracks', 'albums', 'popular-tracks', 'followers',
    'following', 'comments', 'spotlight', 'toptracks', 'playlists', 'stations',
    'recommended', 'groups',
})


@dataclass(frozen=True)
class ParsedInput:
    kind: str       # 'track' | 'short'
    url: str        # canonical rebuilt URL


@dataclass(frozen=True)
class _Split:
    scheme: str
    host: str
    path: str
    query: str | None
    fragment: str | None


def _split_strict(url: object, code: str) -> _Split:
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LEN:
        raise FetchError(code, 'not a string of acceptable length')
    if not _PRINTABLE_ASCII.match(url) or '\\' in url:
        raise FetchError(code, 'non-printable, non-ASCII or backslash')
    m = _URL_RE.match(url)
    if not m:
        raise FetchError(code, 'not an absolute URL')
    scheme = m.group('scheme').lower()
    authority = m.group('authority')
    # No userinfo (@), no port (:), no IPv6 literal ([), no percent-encoding.
    if any(ch in authority for ch in '@:[]%'):
        raise FetchError(code, 'userinfo, port or encoded host')
    host = authority.lower()
    if not _HOST_RE.match(host):
        raise FetchError(code, 'malformed host')
    return _Split(scheme, host, m.group('path') or '', m.group('query'), m.group('fragment'))


def _check_tolerated_query(query: str | None) -> None:
    if query is None or query == '':
        return
    seen: set[str] = set()
    for pair in query.split('&'):
        key, eq, value = pair.partition('=')
        if not eq or key not in TOLERATED_QUERY_KEYS or key in seen:
            raise FetchError(BAD_URL, 'query parameter not allowed')
        if not _QUERY_VALUE_RE.match(value):
            raise FetchError(BAD_URL, 'query value not allowed')
        seen.add(key)


def _segments(path: str) -> list[str]:
    if path.endswith('/') and len(path) > 1:
        path = path[:-1]  # one trailing slash is tolerated
    if path in ('', '/'):
        return []
    segs = path[1:].split('/')
    for s in segs:
        if not _SEGMENT_RE.match(s):
            raise FetchError(BAD_URL, 'bad path segment')
    return segs


def _track_from_segments(segs: list[str]) -> str:
    if len(segs) != 2:
        raise FetchError(NOT_A_TRACK, f'{len(segs)} path segments')
    user, track = segs[0].lower(), segs[1].lower()
    if user in RESERVED_FIRST or track in RESERVED_SECOND:
        raise FetchError(NOT_A_TRACK, 'collection or site page')
    return f'https://{TRACK_HOST}/{user}/{track}'


def parse_input(url: object) -> ParsedInput:
    """Validate a submitted URL. Raises FetchError(bad_url | not_a_track)."""
    sp = _split_strict(url, BAD_URL)
    if sp.scheme != 'https':
        raise FetchError(BAD_URL, 'scheme must be https')
    if sp.host not in INPUT_HOSTS:
        raise FetchError(BAD_URL, 'host not allowed')
    if sp.fragment is not None:
        raise FetchError(BAD_URL, 'fragment not allowed')
    _check_tolerated_query(sp.query)
    segs = _segments(sp.path)
    if sp.host == SHORT_HOST:
        if len(segs) != 1 or not _SHORT_ID_RE.match(segs[0]):
            raise FetchError(BAD_URL, 'bad shortlink id')
        return ParsedInput('short', f'https://{SHORT_HOST}/{segs[0]}')
    return ParsedInput('track', _track_from_segments(segs))


def canonical_from_resolved(url: str) -> str:
    """Re-validate the final URL a shortlink led to.

    The host must be exactly soundcloud.com or m.soundcloud.com (normalised to
    soundcloud.com) and the path exactly two segments. The query and fragment
    SoundCloud appends to its own redirect target are dropped.
    """
    sp = _split_strict(url, REDIRECT_HOST)
    if sp.scheme != 'https' or sp.host not in RESOLVED_TRACK_HOSTS:
        raise FetchError(REDIRECT_HOST, 'final host not allowed')
    return _track_from_segments(_segments(sp.path))


def _target(sp: _Split) -> str:
    path = sp.path or '/'
    return path if sp.query is None else f'{path}?{sp.query}'


def resolve_shortlink(short_url: str, opener: Opener, *, hop_timeout: float = 10.0,
                      total_timeout: float = 30.0) -> str:
    """Follow an on.soundcloud.com shortlink WITHOUT yt-dlp.

    GET with redirects handled here, at most MAX_REDIRECTS of them. Every hop
    must stay https on on.soundcloud.com / soundcloud.com / m.soundcloud.com;
    a hop anywhere else is refused BEFORE it is requested (redirect_host).
    Only on.soundcloud.com is ever requested: as soon as a hop lands on the
    track host it is re-validated and returned. Bodies are never read.
    """
    deadline = time.monotonic() + total_timeout
    current = short_url
    for hop in range(MAX_REDIRECTS + 1):
        sp = _split_strict(current, REDIRECT_HOST)
        if sp.scheme != 'https':
            raise FetchError(REDIRECT_HOST, 'redirect to non-https')
        if sp.host in RESOLVED_TRACK_HOSTS:
            return canonical_from_resolved(current)
        if sp.host != SHORT_HOST:
            raise FetchError(REDIRECT_HOST, 'redirect off the SoundCloud hosts')
        if hop == MAX_REDIRECTS:
            raise FetchError(BAD_URL, 'too many redirects')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FetchError(TIMEOUT, 'shortlink resolution')
        try:
            resp = opener.get(sp.host, _target(sp), min(hop_timeout, remaining))
        except TimeoutError as e:
            raise FetchError(TIMEOUT, 'shortlink resolution') from e
        except BlockedAddress as e:
            raise FetchError(REDIRECT_HOST, 'shortlink host resolved to a non-public address') from e
        except OSError as e:
            raise FetchError(EXTRACTOR_FAILED, f'shortlink request failed: {type(e).__name__}') from e
        try:
            status = resp.status
            location = resp.getheader('Location')
        finally:
            resp.close()
        if status in (301, 302, 303, 307, 308):
            if not location:
                raise FetchError(REDIRECT_HOST, 'redirect without Location')
            if not _PRINTABLE_ASCII.match(location):
                raise FetchError(REDIRECT_HOST, 'non-ASCII Location')
            current = urljoin(current, location)
            continue
        if status in (404, 410) or 200 <= status < 300:
            raise FetchError(BAD_URL, f'shortlink did not redirect (HTTP {status})')
        raise FetchError(EXTRACTOR_FAILED, f'shortlink HTTP {status}')
    raise FetchError(BAD_URL, 'too many redirects')  # unreachable


def resolve_input(url: object, opener: Opener) -> str:
    """Submitted URL -> canonical https://soundcloud.com/<user>/<track>."""
    parsed = parse_input(url)
    if parsed.kind == 'short':
        return resolve_shortlink(parsed.url, opener)
    return parsed.url
