"""Spool protocol for music-fetch (plan §3 "Spool").

    /spool/fetch/in/<uuid>.json       written by music-worker: {uuid, url, requestedBy}
    /spool/fetch/claimed/<uuid>.json  fetch-private: the request being processed
    /spool/fetch/out/<uuid>.json      written by fetch, read-only for the worker

Conventions match the portal's probe spool (music/src/server/spool/protocol.ts):
requests are claimed by rename (moves a symlink itself, never its target), read
with O_NOFOLLOW and a size cap, and results are written to an exclusive tmp
file then link()ed into place so an existing result is never overwritten.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import stat

UUID_RE = re.compile(r'\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
REQUESTED_BY_RE = re.compile(r'\A[A-Za-z0-9_.:-]{1,64}\Z')
MAX_REQUEST_BYTES = 4 * 1024
REQUEST_KEYS = frozenset({'uuid', 'url', 'requestedBy'})
OPTIONAL_REQUEST_KEYS = frozenset({'v'})


class BadRequest(Exception):
    pass


def read_small_nofollow(path: str, max_bytes: int) -> bytes:
    """Read a small regular file without following a symlink at `path`."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > max_bytes:
            raise BadRequest('not a small regular file')
        chunks = []
        remaining = max_bytes + 1
        while remaining > 0:
            b = os.read(fd, min(65536, remaining))
            if not b:
                break
            chunks.append(b)
            remaining -= len(b)
        data = b''.join(chunks)
        if len(data) > max_bytes:
            raise BadRequest('file grew past the cap')
        return data
    finally:
        os.close(fd)


def parse_request(raw: bytes, file_uuid: str) -> tuple[str, str]:
    """Validate a request document. Returns (url, requestedBy)."""
    try:
        doc = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise BadRequest('not JSON') from e
    if not isinstance(doc, dict):
        raise BadRequest('not an object')
    keys = set(doc.keys())
    if not REQUEST_KEYS <= keys or keys - REQUEST_KEYS - OPTIONAL_REQUEST_KEYS:
        raise BadRequest('wrong keys')
    if 'v' in doc and doc['v'] != 1:
        raise BadRequest('unsupported version')
    if doc['uuid'] != file_uuid:
        raise BadRequest('uuid does not match file name')
    if not isinstance(doc['url'], str):
        raise BadRequest('url not a string')
    rb = doc['requestedBy']
    if not isinstance(rb, str) or not REQUESTED_BY_RE.match(rb):
        raise BadRequest('bad requestedBy')
    return doc['url'], rb


def list_request_ids(in_dir: str) -> list[str]:
    """Pending request ids, oldest first. Anything not `<uuid>.json` is ignored."""
    found = []
    try:
        with os.scandir(in_dir) as it:
            for e in it:
                name = e.name
                if not name.endswith('.json') or not UUID_RE.match(name[:-5]):
                    continue
                try:
                    mtime = e.stat(follow_symlinks=False).st_mtime_ns
                except OSError:
                    continue
                found.append((mtime, name[:-5]))
    except FileNotFoundError:
        return []
    found.sort()
    return [u for _, u in found]


def claim(in_dir: str, claimed_dir: str, uuid: str) -> str | None:
    if not UUID_RE.match(uuid):
        return None
    dst = os.path.join(claimed_dir, f'{uuid}.json')
    try:
        os.rename(os.path.join(in_dir, f'{uuid}.json'), dst)
    except OSError:
        return None
    return dst


def write_result_noclobber(out_dir: str, uuid: str, doc: dict) -> bool:
    """Write out/<uuid>.json atomically; never replaces an existing result."""
    if not UUID_RE.match(uuid):
        raise ValueError('bad uuid')
    data = json.dumps(doc, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    tmp = os.path.join(out_dir, f'.tmp-{secrets.token_hex(12)}')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o640)
    try:
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(tmp, os.path.join(out_dir, f'{uuid}.json'))
            return True
        except FileExistsError:
            return False
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
