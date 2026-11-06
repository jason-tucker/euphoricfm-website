"""music-fetch: one job at a time, spool in -> yt-dlp -> checks -> spool out.

For each /spool/fetch/in/<uuid>.json {uuid, url, requestedBy}:
  1. claim it (rename into claimed/), validate the document;
  2. validate the URL (and resolve a shortlink WITHOUT yt-dlp) -> canonical URL;
  3. create /staging/fetch/<uuid>/ (must be new) and run the pinned yt-dlp;
  4. parse the info JSON as DATA only (never executed): extractor, type,
     a preview-only format (0.2.1), duration;
  5. magic-byte check of the audio, size cap, rawSha256;
  6. artwork: only https://*.sndcdn.com, 5 MiB cap, stored raw (never decoded);
  7. write /spool/fetch/out/<uuid>.json (never overwriting an existing result).
On any failure the job directory fetch created is removed and an error
result is written. Transcoding/probing is music-probe's job, not fetch's.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import stat
import sys
import threading
import time
import traceback
import unicodedata
from dataclasses import dataclass, field

from . import errors as E
from .artwork import choose_artwork_url, fetch_artwork, validate_artwork_url
from .envguard import child_env
from .errors import FetchError
from .magic import EXT_CONTAINERS, detect_fd
from .net import GuardedHttpsOpener, Opener
from .runner import INFO_JSON_NAME, MAX_AUDIO_BYTES, build_argv, run_ytdlp
from .spool import (MAX_REQUEST_BYTES, UUID_RE, BadRequest, cancel_request, claim, list_release_ids, list_request_ids,
                    parse_request, read_small_nofollow, remove_release_marker, write_result_noclobber)
from .urls import resolve_input

MAX_INFO_BYTES = 8 * 1024 * 1024
# The portal's duration cap (music/src/lib/fit.ts MAX_DURATION_S: the longest
# song whose 192 kbps MP3 still fits the 35 MiB final file). The probe
# re-checks the decoded stream against the same cap.
MAX_DURATION_S = 24 * 60
AUDIO_RE = re.compile(r'\Aaudio\.(mp3|m4a|mp4|opus|ogg|oga|wav|flac)\Z')
ARTWORK_NAME = 'artwork.raw'
SWEEP_EVERY_S = 600
# Portal v0.4.1: the liveness file the worker checks before it writes a
# request (out/ is read-only for the worker; both id listers ignore the name).
HEARTBEAT_NAME = '.alive'
HEARTBEAT_EVERY_S = 30.0
TMP_PREFIX = '.tmp-'


def _default_ytdlp() -> list[str]:
    # Same program as the `yt-dlp` console script, run isolated (-I: no
    # PYTHON* env, no cwd/script dir on sys.path; -B: no .pyc writes).
    return [sys.executable, '-I', '-B', '-m', 'yt_dlp']


@dataclass
class Config:
    spool_dir: str = '/spool/fetch'
    staging_dir: str = '/staging/fetch'
    home_dir: str = '/tmp'
    ytdlp_prefix: list[str] = field(default_factory=_default_ytdlp)
    timeout_s: float = 600.0
    max_audio_bytes: int = MAX_AUDIO_BYTES
    max_duration_s: float = MAX_DURATION_S
    poll_idle_s: float = 2.0
    staging_ttl_s: float = 24 * 3600.0     # 0 disables the sweep
    url_opener: Opener = field(default_factory=GuardedHttpsOpener)
    art_opener: Opener = field(default_factory=GuardedHttpsOpener)


def _log(msg: str) -> None:
    safe = ''.join(ch if ch.isprintable() else '?' for ch in msg)
    print(f'[fetch] {safe}', flush=True)


def _largest_file(path: str) -> int:
    biggest = 0
    with os.scandir(path) as it:
        for e in it:
            try:
                biggest = max(biggest, e.stat(follow_symlinks=False).st_size)
            except OSError:
                pass
    return biggest


# ------------------------------------------------------------ info JSON ----

def load_info(job_dir: str) -> dict:
    try:
        raw = read_small_nofollow(os.path.join(job_dir, INFO_JSON_NAME), MAX_INFO_BYTES)
    except (OSError, BadRequest) as e:
        raise FetchError(E.EXTRACTOR_FAILED, 'info JSON missing or unreadable') from e
    try:
        info = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise FetchError(E.EXTRACTOR_FAILED, 'info JSON not parseable') from e
    if not isinstance(info, dict):
        raise FetchError(E.EXTRACTOR_FAILED, 'info JSON not an object')
    return info


def _duration(info: dict) -> float | None:
    d = info.get('duration')
    if isinstance(d, bool) or not isinstance(d, (int, float)):
        return None
    d = float(d)
    if not math.isfinite(d) or d <= 0:
        return None
    return d


def check_info(info: dict, max_duration_s: float) -> None:
    """Data-only checks on the info JSON. Raises FetchError."""
    if info.get('_type', 'video') != 'video' or 'entries' in info:
        raise FetchError(E.NOT_A_TRACK, 'info JSON is a playlist')
    if info.get('extractor') != 'soundcloud' or info.get('extractor_key') != 'Soundcloud':
        raise FetchError(E.NOT_A_TRACK, 'not the soundcloud track extractor')
    # 0.2.1: a Go+ (premium) track offers an anonymous client only 30 s
    # preview transcodings. yt-dlp ranks them last (preference -10) but still
    # picks one when nothing else exists, while `duration` stays the full
    # length. The info JSON carries the SELECTED format's fields and is
    # written before the download, so this stops the job before any media.
    fid = info.get('format_id')
    if (isinstance(fid, str) and 'preview' in fid.lower()) or info.get('snipped') is True:
        raise FetchError(E.PREVIEW_ONLY, f'selected format {fid!r} is a preview')
    d = _duration(info)
    if d is None:
        raise FetchError(E.EXTRACTOR_FAILED, 'no usable duration in info JSON')
    if d > max_duration_s:
        raise FetchError(E.TOO_LONG, f'duration {d:.0f}s')


_DROP_CATS = frozenset({'Cc', 'Cf', 'Cs', 'Co', 'Cn', 'Zl', 'Zp'})


def clean_text(v: object, limit: int, multiline: bool = False) -> str | None:
    if not isinstance(v, str):
        return None
    out = []
    for ch in unicodedata.normalize('NFC', v):
        if ch == '\n' and multiline:
            out.append('\n')
        elif ch == '\t':
            out.append(' ')
        elif unicodedata.category(ch) not in _DROP_CATS:
            out.append(ch)
    s = ''.join(out).strip()[:limit].strip()
    return s or None


def build_meta(info: dict, artwork_host: str | None) -> dict:
    genre = info.get('genre')
    if not isinstance(genre, str):
        genres = info.get('genres')
        genre = genres[0] if isinstance(genres, list) and genres else None
    lic = info.get('license')
    track_id = info.get('id')
    meta: dict = {
        'title': clean_text(info.get('title'), 200),
        'uploader': clean_text(info.get('uploader'), 200),
        'duration': round(_duration(info) or 0.0, 3),
        'artworkSourceHost': artwork_host,
    }
    g = clean_text(genre, 100)
    if g:
        meta['genre'] = g
    desc = clean_text(info.get('description'), 4000, multiline=True)
    if desc:
        meta['description'] = desc
    if isinstance(lic, str) and re.fullmatch(r'[a-z0-9-]{1,40}', lic):
        meta['license'] = lic
    if isinstance(track_id, (str, int)) and not isinstance(track_id, bool) and re.fullmatch(r'\d{1,20}', str(track_id)):
        meta['trackId'] = str(track_id)
    return meta


# ------------------------------------------------------------- service ----

class Service:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.in_dir = os.path.join(cfg.spool_dir, 'in')
        self.out_dir = os.path.join(cfg.spool_dir, 'out')
        self.claimed_dir = os.path.join(cfg.spool_dir, 'claimed')
        self.stop = threading.Event()
        self._last_sweep = float('-inf')

    # -- lifecycle --
    def prepare(self) -> None:
        for d in (self.in_dir, self.out_dir, self.claimed_dir):
            os.makedirs(d, mode=0o750, exist_ok=True)
        for d in (self.in_dir, self.out_dir, self.claimed_dir, self.cfg.staging_dir):
            st = os.lstat(d)
            if not stat.S_ISDIR(st.st_mode):
                raise RuntimeError(f'{d} is not a real directory')
        if not shutil.rmtree.avoids_symlink_attacks:
            raise RuntimeError('shutil.rmtree is not symlink-attack safe on this platform')
        self.recover_interrupted()

    def recover_interrupted(self) -> None:
        for name in os.listdir(self.claimed_dir):
            path = os.path.join(self.claimed_dir, name)
            uuid = name[:-5] if name.endswith('.json') else ''
            # A crash between writing the result and unlinking the claim: the
            # job finished, so its result stands and its media stays until the
            # worker's release marker (or the 24 h sweep). Only the claim goes.
            if UUID_RE.match(uuid) and os.path.lexists(os.path.join(self.out_dir, f'{uuid}.json')):
                _log(f'{uuid} already answered; claim dropped at startup')
            elif UUID_RE.match(uuid):
                self._remove_job_dir(uuid)
                write_result_noclobber(self.out_dir, uuid, self._error_doc(uuid, E.INTERRUPTED))
                _log(f'{uuid} error {E.INTERRUPTED} (recovered at startup)')
            try:
                os.unlink(path)
            except OSError:
                pass

    def touch_heartbeat(self) -> None:
        """Create or refresh out/.alive (never through a symlink)."""
        path = os.path.join(self.out_dir, HEARTBEAT_NAME)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o640)
        except OSError:
            return
        try:
            os.utime(fd)
        except OSError:
            pass
        finally:
            os.close(fd)

    def _heartbeat_loop(self) -> None:
        # A thread, so the beat continues while a job runs (up to 10 min).
        while not self.stop.is_set():
            self.touch_heartbeat()
            self.stop.wait(HEARTBEAT_EVERY_S)

    def run_forever(self) -> None:
        _log('ready')
        threading.Thread(target=self._heartbeat_loop, name='heartbeat', daemon=True).start()
        while not self.stop.is_set():
            self.process_releases()
            ids = list_request_ids(self.in_dir)
            if ids:
                self.process_one(ids[0])
                continue
            self.maybe_sweep()
            self.stop.wait(self.cfg.poll_idle_s)
        _log('stopped')

    def run_until_empty(self) -> None:
        while not self.stop.is_set():
            self.process_releases()
            ids = list_request_ids(self.in_dir)
            if not ids:
                return
            self.process_one(ids[0])

    # -- one job --
    def process_one(self, uuid: str) -> bool:
        claimed = claim(self.in_dir, self.claimed_dir, uuid)
        if claimed is None:
            return False
        started = time.monotonic()
        doc = self.handle(uuid, claimed)
        if not write_result_noclobber(self.out_dir, uuid, doc):
            _log(f'{uuid} result already exists; not overwritten')
        try:
            os.unlink(claimed)
        except OSError:
            pass
        took = time.monotonic() - started
        if doc['status'] == 'ok':
            _log(f'{uuid} ok {doc["container"]} {doc["audioBytes"]}B {took:.1f}s')
        else:
            _log(f'{uuid} error {doc["errorCode"]} {took:.1f}s')
        return True

    def _job_dir(self, uuid: str) -> str:
        return os.path.join(self.cfg.staging_dir, uuid)

    def _remove_job_dir(self, uuid: str) -> None:
        path = self._job_dir(uuid)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return
        if stat.S_ISDIR(st.st_mode):
            shutil.rmtree(path, ignore_errors=True)
        else:
            os.unlink(path)  # a symlink/file squatting on the name: remove the link only

    @staticmethod
    def _error_doc(uuid: str, code: str) -> dict:
        return {'v': 1, 'uuid': uuid, 'status': 'error', 'errorCode': code,
                'files': None, 'meta': None, 'rawSha256': None}

    def handle(self, uuid: str, claimed: str) -> dict:
        created = False
        try:
            try:
                url, _requested_by = parse_request(read_small_nofollow(claimed, MAX_REQUEST_BYTES), uuid)
            except (BadRequest, OSError) as e:
                raise FetchError(E.BAD_REQUEST, str(e)) from e
            canonical = resolve_input(url, self.cfg.url_opener)
            job_dir = self._job_dir(uuid)
            try:
                os.mkdir(job_dir, 0o750)
            except FileExistsError as e:
                raise FetchError(E.BAD_REQUEST, 'job directory already exists') from e
            created = True
            doc = self._download(uuid, job_dir, canonical)
            return doc
        except FetchError as e:
            if e.code == E.EXTRACTOR_FAILED and e.detail:
                _log(f'{uuid} detail: {e.detail[-600:]}')
            if created:
                self._remove_job_dir(uuid)
            return self._error_doc(uuid, e.code)
        except Exception:  # noqa: BLE001 - one bad job must not kill the service
            _log(f'{uuid} internal error: {traceback.format_exc(limit=5)[-1500:]}')
            if created:
                self._remove_job_dir(uuid)
            return self._error_doc(uuid, E.INTERNAL)

    def _early_info_check(self, job_dir: str):
        def check() -> str | None:
            try:
                check_info(load_info(job_dir), self.cfg.max_duration_s)
            except FetchError as e:
                return e.code
            return None
        return check

    def _download(self, uuid: str, job_dir: str, canonical: str) -> dict:
        cfg = self.cfg
        outcome = run_ytdlp(
            build_argv(cfg.ytdlp_prefix, job_dir, canonical),
            env=child_env(cfg.home_dir), cwd=cfg.home_dir, job_dir=job_dir,
            timeout_s=cfg.timeout_s, max_dir_bytes=cfg.max_audio_bytes + MAX_INFO_BYTES,
            info_check=self._early_info_check(job_dir), should_abort=self.stop.is_set,
        )
        tail = outcome.tail
        if outcome.kind == 'aborted':
            raise FetchError(E.INTERRUPTED)
        if outcome.kind == 'timeout':
            raise FetchError(E.TIMEOUT, 'yt-dlp')
        if outcome.kind == 'too_large':
            raise FetchError(E.TOO_LARGE, 'job directory over cap')
        if outcome.kind == 'early':
            raise FetchError(outcome.early_code or E.EXTRACTOR_FAILED, 'stopped after info JSON')
        # RLIMIT_FSIZE backstop: SIGXFSZ, or EFBIG (errno 27) where the child
        # ignores SIGXFSZ, as CPython (and so yt-dlp) does.
        if outcome.returncode == -25 or '[Errno 27]' in tail or _largest_file(job_dir) > cfg.max_audio_bytes:
            raise FetchError(E.TOO_LARGE, 'file size limit')
        if 'larger than max-filesize' in tail:
            raise FetchError(E.TOO_LARGE, 'yt-dlp max-filesize')
        if outcome.returncode != 0:
            if 'Unsupported URL' in tail or 'No suitable extractor' in tail:
                raise FetchError(E.NOT_A_TRACK, 'extractor refused URL')
            raise FetchError(E.EXTRACTOR_FAILED, f'yt-dlp exit {outcome.returncode}: {tail[-600:]}')

        info = load_info(job_dir)
        check_info(info, cfg.max_duration_s)

        # Exactly the info JSON plus one audio.<ext>, all regular files.
        audio_name = None
        with os.scandir(job_dir) as it:
            for e in it:
                if e.name == INFO_JSON_NAME:
                    continue
                if AUDIO_RE.match(e.name) and audio_name is None and e.is_file(follow_symlinks=False):
                    audio_name = e.name
                    continue
                if AUDIO_RE.match(e.name) and e.is_symlink():
                    raise FetchError(E.BAD_MEDIA, 'audio is a symlink')
                raise FetchError(E.EXTRACTOR_FAILED, 'unexpected file in job directory')
        if audio_name is None:
            raise FetchError(E.EXTRACTOR_FAILED, 'no audio file produced')
        audio_path = os.path.join(job_dir, audio_name)
        ext = audio_name.split('.', 1)[1]

        try:
            fd = os.open(audio_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError as e:
            raise FetchError(E.BAD_MEDIA, 'audio not openable') from e
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                raise FetchError(E.BAD_MEDIA, 'audio not a plain regular file')
            if st.st_size > cfg.max_audio_bytes:
                raise FetchError(E.TOO_LARGE, 'audio over cap')
            det = detect_fd(fd)
            if det is None:
                raise FetchError(E.BAD_MEDIA, 'magic bytes not in allowlist')
            if det.container not in EXT_CONTAINERS[ext]:
                raise FetchError(E.BAD_MEDIA, f'.{ext} holds {det.container}')
            h = hashlib.sha256()
            size = 0
            os.lseek(fd, 0, os.SEEK_SET)
            while True:
                b = os.read(fd, 1024 * 1024)
                if not b:
                    break
                size += len(b)
                if size > cfg.max_audio_bytes:
                    raise FetchError(E.TOO_LARGE, 'audio grew over cap')
                h.update(b)
            raw_sha = h.hexdigest()
            os.fchmod(fd, 0o440)  # on the verified fd, never by path
        finally:
            os.close(fd)

        warnings: list[str] = []
        files: dict = {'audio': audio_path}
        artwork_sha = None
        artwork_host = None
        art_url = choose_artwork_url(info)
        art = None
        if art_url is not None:
            # 0.2.1: a URL outside the allowlist drops the artwork (warning
            # `artwork_host`) instead of failing the job. Nothing is requested
            # from it either way, and artwork is optional.
            try:
                art = validate_artwork_url(art_url)
            except FetchError as e:
                if e.code != E.ARTWORK_HOST:
                    raise
                warnings.append(E.ARTWORK_HOST)
        if art is not None:
            res = fetch_artwork(art, os.path.join(job_dir, ARTWORK_NAME), cfg.art_opener)
            if isinstance(res, str):
                warnings.append(res)
            else:
                files['artwork'] = os.path.join(job_dir, ARTWORK_NAME)
                artwork_sha = res.sha256
                artwork_host = art.host

        meta = build_meta(info, artwork_host)
        # The info JSON is not media: drop it so only media stays in staging.
        os.unlink(os.path.join(job_dir, INFO_JSON_NAME))

        doc = {
            'v': 1, 'uuid': uuid, 'status': 'ok', 'errorCode': None,
            'files': files,
            'meta': meta,
            'rawSha256': raw_sha,
            'audioBytes': size,
            'container': det.container,
            'ffmpegFormat': det.ffmpeg_format,
            'canonicalUrl': canonical,
            'warnings': warnings,
        }
        if artwork_sha:
            doc['artworkSha256'] = artwork_sha
        return doc

    # -- housekeeping --
    def process_releases(self) -> int:
        """Portal v0.4.0: the worker writes `in/<uuid>.release` once the probe has
        converted (or refused) a job's audio, or once it has given up on the job
        (rejected, or no answer in time). The marker only NAMES the job (its
        content is never read), and the name is a v4 UUID, so the path cannot
        leave the staging directory; `_remove_job_dir` never follows a link.

        Per job:
          * finished (a result in out/, not claimed): its staging directory is
            deleted right away instead of at the 24 h sweep; the marker goes;
          * still queued (its request is in in/): the worker no longer wants
            it, so it is CANCELLED (the request is removed, nothing is fetched,
            no result is written); the marker goes;
          * claimed (being fetched now): the marker is KEPT, and the job is
            released by a later pass once its result is written, so a late
            download never stays behind until the sweep;
          * unknown (no request, not claimed, no result): the marker goes.
        The worst a forged marker can do is delete a finished job's raw media
        early or cancel a queued one: the worker would see its job fail."""
        n = 0
        for uuid in list_release_ids(self.in_dir):
            if os.path.lexists(os.path.join(self.claimed_dir, f'{uuid}.json')):
                continue  # in progress: released once it has a result
            if not remove_release_marker(self.in_dir, uuid):
                continue
            if os.path.lexists(os.path.join(self.out_dir, f'{uuid}.json')):
                if os.path.lexists(self._job_dir(uuid)):
                    self._remove_job_dir(uuid)
                    _log(f'{uuid} released')
                    n += 1
                continue
            if cancel_request(self.in_dir, uuid):
                _log(f'{uuid} cancelled (released before it was fetched)')
                n += 1
        return n

    def maybe_sweep(self) -> None:
        ttl = self.cfg.staging_ttl_s
        now = time.time()
        if ttl <= 0 or time.monotonic() - self._last_sweep < SWEEP_EVERY_S:
            return
        self._last_sweep = time.monotonic()
        try:
            with os.scandir(self.cfg.staging_dir) as it:
                entries = list(it)
        except OSError:
            return
        for e in entries:
            if not UUID_RE.match(e.name):
                continue
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISDIR(st.st_mode) and now - st.st_mtime > ttl:
                shutil.rmtree(e.path, ignore_errors=True)
                _log(f'swept stale staging dir {e.name}')
        n = self.sweep_spool(now, ttl)
        if n:
            _log(f'swept {n} old spool file(s)')

    def sweep_spool(self, now: float, ttl: float) -> int:
        """Portal v0.4.1: results in out/ older than the TTL (the worker reads a
        result within 15 min of its request) and `.tmp-*` files a crash left
        between create and rename in in/, claimed/ and out/. Regular files
        only, by name; unlink never follows a link."""
        n = 0
        for d, results in ((self.out_dir, True), (self.in_dir, False), (self.claimed_dir, False)):
            try:
                with os.scandir(d) as it:
                    entries = list(it)
            except OSError:
                continue
            for e in entries:
                name = e.name
                is_result = results and name.endswith('.json') and UUID_RE.match(name[:-5]) is not None
                if not (is_result or name.startswith(TMP_PREFIX)):
                    continue
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                if not (stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode)) or now - st.st_mtime <= ttl:
                    continue
                try:
                    os.unlink(e.path)
                    n += 1
                except OSError:
                    pass
        return n
