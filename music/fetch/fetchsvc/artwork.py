"""Artwork: chosen from the info JSON, fetched server-side ONLY from
https://*.sndcdn.com, size-capped (5 MiB) and time-capped, stored RAW.

fetch never decodes the image; music-probe re-encodes it (plan §3.6). A URL
outside the allowlist is never requested; since 0.2.1 it only drops the
artwork (warning `artwork_host`; it used to fail the whole job). A transfer
problem (non-200, redirect, non-image type, too big, slow) also only drops
the artwork and adds a warning: artwork is optional.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from dataclasses import dataclass

from .errors import ARTWORK_HOST, FetchError
from .net import BlockedAddress, Opener

MAX_ARTWORK_BYTES = 5 * 1024 * 1024
ARTWORK_TIMEOUT_S = 20.0
ARTWORK_TOTAL_S = 30.0
ARTWORK_SUFFIX = '.sndcdn.com'

_PRINTABLE_ASCII = re.compile(r'\A[\x21-\x7e]+\Z')
_URL_RE = re.compile(r'\Ahttps://(?P<host>[^/?#@:\\\[\]%]+)(?P<target>/[^#\\]*)\Z')
_LABEL_RE = re.compile(r'\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z')
# Preference order for SoundCloud thumbnail ids (probe caps at 1000 px).
_PREFERRED_IDS = ('t500x500', 'crop', 't300x300', 'original')


@dataclass(frozen=True)
class ArtworkUrl:
    host: str
    target: str


def validate_artwork_url(url: object) -> ArtworkUrl:
    """https only, host exactly `<label>(.<label>)*.sndcdn.com`, no userinfo,
    no port, no fragment, printable ASCII. Raises FetchError(artwork_host)."""
    if not isinstance(url, str) or len(url) > 1024 or not _PRINTABLE_ASCII.match(url):
        raise FetchError(ARTWORK_HOST, 'artwork URL not printable ASCII')
    m = _URL_RE.match(url)
    if not m:
        raise FetchError(ARTWORK_HOST, 'artwork URL not https/plain host')
    host = m.group('host').lower()
    if not host.endswith(ARTWORK_SUFFIX):
        raise FetchError(ARTWORK_HOST, 'artwork host not *.sndcdn.com')
    labels = host[: -len(ARTWORK_SUFFIX)].split('.')
    if not labels or not all(_LABEL_RE.match(lb) for lb in labels):
        raise FetchError(ARTWORK_HOST, 'artwork host malformed')
    return ArtworkUrl(host, m.group('target'))


def choose_artwork_url(info: dict) -> str | None:
    """Pick one thumbnail URL from the info JSON (data only, never executed)."""
    thumbs = info.get('thumbnails')
    if isinstance(thumbs, list):
        by_id = {t.get('id'): t.get('url') for t in thumbs if isinstance(t, dict)}
        for tid in _PREFERRED_IDS:
            if isinstance(by_id.get(tid), str):
                return by_id[tid]
    thumb = info.get('thumbnail')
    if isinstance(thumb, str) and thumb:
        return thumb
    return None


@dataclass(frozen=True)
class ArtworkResult:
    sha256: str
    size: int


def fetch_artwork(art: ArtworkUrl, dest: str, opener: Opener, *, max_bytes: int = MAX_ARTWORK_BYTES,
                  timeout: float = ARTWORK_TIMEOUT_S, total: float = ARTWORK_TOTAL_S) -> ArtworkResult | str:
    """Download to `dest` (created exclusively). Returns ArtworkResult, or a
    warning string when the artwork is skipped (dest is then removed)."""
    deadline = time.monotonic() + total
    try:
        resp = opener.get(art.host, art.target, timeout)
    except BlockedAddress:
        return 'artwork_blocked_address'
    except TimeoutError:
        return 'artwork_timeout'
    except OSError:
        return 'artwork_fetch_failed'
    try:
        if resp.status != 200:  # redirects are NOT followed
            return f'artwork_http_{resp.status}'
        ctype = (resp.getheader('Content-Type') or '').split(';')[0].strip().lower()
        if not ctype.startswith('image/'):
            return 'artwork_not_image'
        clen = resp.getheader('Content-Length')
        if clen is not None:
            try:
                if int(clen) > max_bytes:
                    return 'artwork_too_large'
            except ValueError:
                return 'artwork_bad_length'
        fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o640)
        h = hashlib.sha256()
        n = 0
        ok = False
        try:
            while True:
                if time.monotonic() > deadline:
                    return 'artwork_timeout'
                try:
                    chunk = resp.read(64 * 1024)
                except TimeoutError:
                    return 'artwork_timeout'
                except OSError:
                    return 'artwork_fetch_failed'
                if not chunk:
                    break
                n += len(chunk)
                if n > max_bytes:
                    return 'artwork_too_large'
                h.update(chunk)
                view = memoryview(chunk)
                while view:
                    view = view[os.write(fd, view):]
            if n == 0:
                return 'artwork_empty'
            os.fchmod(fd, 0o440)
            ok = True
        finally:
            os.close(fd)
            if not ok:
                try:
                    os.unlink(dest)
                except OSError:
                    pass
        return ArtworkResult(h.hexdigest(), n)
    finally:
        resp.close()
