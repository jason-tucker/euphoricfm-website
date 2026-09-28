"""Spool protocol end to end, with the stub yt-dlp emitting fixture files."""

import hashlib
import json
import os
import stat
import threading
import time
import unittest

from fetchsvc.envguard import CHILD_PATH
from fetchsvc.errors import (ARTWORK_HOST, BAD_MEDIA, BAD_REQUEST, BAD_URL, EXTRACTOR_FAILED, INTERRUPTED,
                             NOT_A_TRACK, REDIRECT_HOST, TIMEOUT, TOO_LARGE, TOO_LONG)
from tests.helpers import JPEG, Env

SC = 'https://soundcloud.com/stub/'


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


class E2EBase(unittest.TestCase):
    cfg = {}

    def setUp(self):
        self.env = Env(**self.cfg)

    def tearDown(self):
        self.env.cleanup()

    def assertError(self, url, code, stub_invoked=True):
        uid, res = self.env.run(url)
        self.assertEqual(res['status'], 'error', res)
        self.assertEqual(res['errorCode'], code, res)
        self.assertIsNone(res['files'])
        self.assertIsNone(res['rawSha256'])
        self.assertFalse(os.path.lexists(self.env.job_dir(uid)), 'job dir must be removed on error')
        self.assertEqual(self.env.stub_env(uid) is not None, stub_invoked)
        self.assertEqual(os.listdir(os.path.join(self.env.spool, 'claimed')), [])
        return uid, res


class HappyPathTests(E2EBase):
    def test_ok_mp3_full_result(self):
        uid, res = self.env.run(SC + 'ok-mp3')
        self.assertEqual(res['status'], 'ok')
        self.assertIsNone(res['errorCode'])
        self.assertEqual(res['uuid'], uid)
        job = self.env.job_dir(uid)
        self.assertEqual(res['files'], {'audio': f'{job}/audio.mp3', 'artwork': f'{job}/artwork.raw'})
        self.assertEqual(res['rawSha256'], sha(f'{job}/audio.mp3'))
        self.assertEqual(res['artworkSha256'], hashlib.sha256(JPEG).hexdigest())
        self.assertEqual((res['container'], res['ffmpegFormat']), ('mp3', 'mp3'))
        self.assertEqual(res['canonicalUrl'], SC + 'ok-mp3')
        self.assertEqual(res['meta'], {
            'title': 'Stub Track',                      # RLO + BEL stripped
            'uploader': 'Stub Artist',
            'duration': 200.5,
            'genre': 'House',
            'description': 'line one\nline two',        # NUL stripped, newline kept
            'artworkSourceHost': 'i1.sndcdn.com',
            'license': 'cc-by',
            'trackId': '123456789',
        })
        # t500x500 preferred; only the allowlisted CDN was contacted
        self.assertEqual(self.env.art.calls, [('i1.sndcdn.com', '/artworks-abc-t500x500.jpg')])
        # only media left in staging, read-only
        self.assertEqual(sorted(os.listdir(job)), ['artwork.raw', 'audio.mp3'])
        for n in os.listdir(job):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(job, n)).st_mode), 0o440)
        # spool housekeeping
        self.assertEqual(os.listdir(os.path.join(self.env.spool, 'in')), [])
        self.assertEqual(os.listdir(os.path.join(self.env.spool, 'claimed')), [])
        self.assertEqual(os.listdir(os.path.join(self.env.spool, 'out')), [f'{uid}.json'])

    def test_all_allowed_containers(self):
        for ext, container, fmt in [('mp3', 'mp3', 'mp3'), ('m4a', 'mp4', 'mp4'), ('opus', 'opus', 'ogg'),
                                    ('ogg', 'ogg', 'ogg'), ('wav', 'wav', 'wav'), ('flac', 'flac', 'flac')]:
            with self.subTest(ext=ext):
                uid, res = self.env.run(SC + f'ok-{ext}')
                self.assertEqual(res['status'], 'ok', res)
                self.assertEqual((res['container'], res['ffmpegFormat']), (container, fmt))
                self.assertTrue(res['files']['audio'].endswith(f'/audio.{ext}'))

    def test_no_artwork(self):
        uid, res = self.env.run(SC + 'noart')
        self.assertEqual(res['status'], 'ok')
        self.assertNotIn('artwork', res['files'])
        self.assertIsNone(res['meta']['artworkSourceHost'])
        self.assertEqual(self.env.art.calls, [])

    def test_exactly_24_minutes_is_allowed(self):
        _, res = self.env.run(SC + 'exactly24')
        self.assertEqual(res['status'], 'ok')

    def test_shortlink_resolved_before_ytdlp(self):
        self.env.urls.routes['AbC123'] = 'https://soundcloud.com/stub/ok-mp3?si=zzz&utm_source=clipboard'
        uid, res = self.env.run('https://on.soundcloud.com/AbC123')
        self.assertEqual(res['status'], 'ok', res)
        self.assertEqual(res['canonicalUrl'], SC + 'ok-mp3')
        self.assertEqual(self.env.stub_env(uid)['__url__'], SC + 'ok-mp3')  # query never reaches yt-dlp

    def test_share_params_never_reach_ytdlp(self):
        uid, res = self.env.run(SC + 'ok-mp3?si=abc&utm_source=clipboard&in=stub/sets/x')
        self.assertEqual(res['status'], 'ok')
        self.assertEqual(self.env.stub_env(uid)['__url__'], SC + 'ok-mp3')

    def test_fifo_one_at_a_time(self):
        a = self.env.submit(SC + 'noart')
        time.sleep(0.02)
        b = self.env.submit(SC + 'noart')
        os.utime(os.path.join(self.env.spool, 'in', f'{a}.json'), ns=(1, 1))
        self.env.svc.run_until_empty()
        self.assertEqual(self.env.result(a)['status'], 'ok')
        self.assertEqual(self.env.result(b)['status'], 'ok')


class ChildEnvTests(E2EBase):
    def test_child_gets_only_path_and_home(self):
        os.environ['EFM_FAKE_SECRET_FOR_TEST'] = 'hunter2'   # present in the PARENT only
        try:
            uid, res = self.env.run(SC + 'noart')
        finally:
            del os.environ['EFM_FAKE_SECRET_FOR_TEST']
        self.assertEqual(res['status'], 'ok')
        seen = self.env.stub_env(uid)
        cwd = seen.pop('__cwd__')
        seen.pop('__url__')
        self.assertEqual(seen, {'PATH': CHILD_PATH, 'HOME': self.env.home})
        self.assertEqual(cwd, self.env.home)


class ErrorPathTests(E2EBase):
    cfg = {'timeout_s': 1.5}

    def test_timeout(self):
        t = time.monotonic()
        self.assertError(SC + 'slow', TIMEOUT)
        self.assertLess(time.monotonic() - t, 10)

    def test_too_large_by_directory_cap(self):
        t = time.monotonic()
        self.env.svc.cfg.timeout_s = 60
        self.assertError(SC + 'huge', TOO_LARGE)
        self.assertLess(time.monotonic() - t, 30)

    def test_too_large_reported_by_ytdlp(self):
        self.assertError(SC + 'maxfs', TOO_LARGE)

    def test_too_long_stops_download_early(self):
        self.env.svc.cfg.timeout_s = 60
        t = time.monotonic()
        self.assertError(SC + 'long', TOO_LONG)
        self.assertLess(time.monotonic() - t, 10)  # stub would sleep 30 s before writing audio

    def test_playlist_info_stops_early(self):
        self.env.svc.cfg.timeout_s = 60
        t = time.monotonic()
        self.assertError(SC + 'playlist', NOT_A_TRACK)
        self.assertLess(time.monotonic() - t, 10)

    def test_extractor_errors(self):
        self.assertError(SC + 'fail', EXTRACTOR_FAILED)
        self.assertError(SC + 'unsupported', NOT_A_TRACK)
        self.assertError(SC + 'nosuitable', NOT_A_TRACK)
        self.assertError(SC + 'generic', NOT_A_TRACK)
        self.assertError(SC + 'nodur', EXTRACTOR_FAILED)
        self.assertError(SC + 'noaudio', EXTRACTOR_FAILED)
        self.assertError(SC + 'extra', EXTRACTOR_FAILED)
        self.env.svc.cfg.timeout_s = 60
        self.assertError(SC + 'infobomb', EXTRACTOR_FAILED)

    def test_magic_bytes(self):
        for slug in ['badmagic', 'hls', 'mpegts', 'mismatch', 'symlink', 'hardlink']:
            with self.subTest(slug=slug):
                self.assertError(SC + slug, BAD_MEDIA)

    def test_symlink_target_untouched(self):
        self.assertError(SC + 'symlink', BAD_MEDIA)
        self.assertEqual(stat.S_IMODE(os.stat(self.env.decoy).st_mode), 0o644)
        with open(self.env.decoy) as f:
            self.assertEqual(f.read(), 'decoy')

    def test_url_rejected_before_ytdlp(self):
        for url, code in [
            ('https://soundcloud.com.evil.com/a/b', BAD_URL),
            ('https://evil.com/soundcloud.com/a/b', BAD_URL),
            ('https://soundcloud.com/stub/sets/x', NOT_A_TRACK),
            ('https://soundcloud.com/stub/likes', NOT_A_TRACK),
            ('https://soundcloud.com/stub/ok-mp3?url=https://evil.com', BAD_URL),
        ]:
            with self.subTest(url=url):
                self.assertError(url, code, stub_invoked=False)

    def test_shortlink_foreign_redirect(self):
        self.env.urls.routes['Evil1'] = 'https://evil.example/stub/ok-mp3'
        self.env.urls.routes['Set1'] = 'https://soundcloud.com/stub/sets/mix'
        self.assertError('https://on.soundcloud.com/Evil1', REDIRECT_HOST, stub_invoked=False)
        self.assertError('https://on.soundcloud.com/Set1', NOT_A_TRACK, stub_invoked=False)
        self.assertError('https://on.soundcloud.com/Missing', BAD_URL, stub_invoked=False)

    def test_grandchild_is_killed(self):
        uid, res = self.env.run(SC + 'grandchild')
        self.assertEqual(res['status'], 'ok')
        with open(os.path.join(self.env.root, f'grandchild-{uid}.pid')) as f:
            pid = int(f.read())
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                with open(f'/proc/{pid}/stat') as f:
                    state = f.read().rsplit(')', 1)[1].split()[0]
            except FileNotFoundError:
                state = 'gone'
            if state in ('gone', 'Z'):
                break
            time.sleep(0.05)
        self.assertIn(state, ('gone', 'Z'))

    def test_sigterm_aborts_running_job(self):
        self.env.svc.cfg.timeout_s = 60
        uid = self.env.submit(SC + 'slow')
        th = threading.Thread(target=self.env.svc.process_one, args=(uid,))
        th.start()
        time.sleep(0.8)
        self.env.svc.stop.set()
        th.join(10)
        self.assertFalse(th.is_alive())
        res = self.env.result(uid)
        self.assertEqual(res['errorCode'], INTERRUPTED)
        self.assertFalse(os.path.lexists(self.env.job_dir(uid)))


class ArtworkE2ETests(E2EBase):
    def test_artwork_host_allowlist(self):
        for slug in ['evil', 'lookalike', 'at', 'http', 'port', 'bare', 'suffix', 'meta']:
            with self.subTest(slug=slug):
                self.assertError(SC + f'art-{slug}', ARTWORK_HOST)
        self.assertEqual(self.env.art.calls, [], 'no request may be made to a non-allowlisted host')

    def test_artwork_transfer_problems_only_drop_artwork(self):
        for slug, warning in [('big', 'artwork_too_large'), ('notimage', 'artwork_not_image'),
                              ('redirect', 'artwork_http_302')]:
            with self.subTest(slug=slug):
                uid, res = self.env.run(SC + f'art-{slug}')
                self.assertEqual(res['status'], 'ok')
                self.assertNotIn('artwork', res['files'])
                self.assertEqual(res['warnings'], [warning])
                self.assertEqual(os.listdir(self.env.job_dir(uid)), ['audio.mp3'])
        # the 302 was not followed to evil.example
        self.assertNotIn('evil.example', json.dumps(self.env.art.calls))


class RequestDocTests(E2EBase):
    def test_bad_request_documents(self):
        import uuid as u
        for doc in [
            b'not json',
            b'[1,2]',
            json.dumps({'uuid': 'X', 'url': SC + 'noart'}),                                    # missing key
            json.dumps({'uuid': 'X', 'url': SC + 'noart', 'requestedBy': '1', 'cmd': 'id'}),   # extra key
            json.dumps({'uuid': str(u.uuid4()), 'url': SC + 'noart', 'requestedBy': '1'}),     # uuid mismatch
            json.dumps({'uuid': 'X', 'url': ['x'], 'requestedBy': '1'}),
            json.dumps({'uuid': 'X', 'url': SC + 'noart', 'requestedBy': 'a b'}),
            json.dumps({'uuid': 'X', 'url': SC + 'noart', 'requestedBy': '1', 'v': 2}),
            json.dumps({'uuid': 'X', 'url': SC + 'noart', 'requestedBy': '1' * 5000}),        # > 4 KiB
        ]:
            with self.subTest(doc=doc[:60]):
                uid = str(u.uuid4())
                if isinstance(doc, str):
                    doc = doc.replace('"X"', f'"{uid}"')
                self.env.submit(None, uid=uid, doc=doc)
                self.assertTrue(self.env.svc.process_one(uid))
                res = self.env.result(uid)
                self.assertEqual(res['errorCode'], BAD_REQUEST)
                self.assertIsNone(self.env.stub_env(uid))

    def test_symlinked_request_is_not_followed(self):
        import uuid as u
        uid = str(u.uuid4())
        os.symlink(self.env.decoy, os.path.join(self.env.spool, 'in', f'{uid}.json'))
        self.assertTrue(self.env.svc.process_one(uid))
        self.assertEqual(self.env.result(uid)['errorCode'], BAD_REQUEST)

    def test_non_uuid_names_ignored(self):
        for name in ['../../x.json', 'abc.json', '.tmp-123', 'README']:
            p = os.path.join(self.env.spool, 'in', os.path.basename(name))
            with open(p, 'w') as f:
                f.write('{}')
        self.env.svc.run_until_empty()
        self.assertEqual(os.listdir(os.path.join(self.env.spool, 'out')), [])

    def test_existing_job_dir_is_not_reused(self):
        import uuid as u
        uid = str(u.uuid4())
        os.mkdir(self.env.job_dir(uid))
        with open(os.path.join(self.env.job_dir(uid), 'keep'), 'w') as f:
            f.write('x')
        _, res = self.env.run(SC + 'noart', uid=uid)
        self.assertEqual(res['errorCode'], BAD_REQUEST)
        self.assertEqual(os.listdir(self.env.job_dir(uid)), ['keep'])  # not ours: untouched

    def test_existing_result_never_overwritten(self):
        import uuid as u
        uid = str(u.uuid4())
        with open(os.path.join(self.env.spool, 'out', f'{uid}.json'), 'w') as f:
            f.write('{"original":true}')
        self.env.run(SC + 'noart', uid=uid)
        self.assertEqual(self.env.result(uid), {'original': True})

    def test_recovery_of_interrupted_claim(self):
        import uuid as u
        from fetchsvc.service import Service
        uid = str(u.uuid4())
        with open(os.path.join(self.env.spool, 'claimed', f'{uid}.json'), 'w') as f:
            f.write('{}')
        os.mkdir(self.env.job_dir(uid))
        with open(os.path.join(self.env.job_dir(uid), 'audio.mp3.part'), 'w') as f:
            f.write('partial')
        Service(self.env.svc.cfg).prepare()
        self.assertEqual(self.env.result(uid)['errorCode'], INTERRUPTED)
        self.assertFalse(os.path.exists(self.env.job_dir(uid)))
        self.assertEqual(os.listdir(os.path.join(self.env.spool, 'claimed')), [])


class SweepTests(E2EBase):
    def test_stale_job_dirs_swept(self):
        import uuid as u
        old, fresh = str(u.uuid4()), str(u.uuid4())
        for d in (old, fresh, 'not-a-uuid'):
            os.mkdir(os.path.join(self.env.staging, d))
        decoy_dir = os.path.join(self.env.root, 'decoy-dir')
        os.mkdir(decoy_dir)
        past0 = time.time() - 3 * 86400
        os.utime(decoy_dir, (past0, past0))
        os.symlink(decoy_dir, os.path.join(self.env.staging, str(u.uuid4())))
        past = time.time() - 3 * 86400
        os.utime(os.path.join(self.env.staging, old), (past, past))
        os.utime(os.path.join(self.env.staging, 'not-a-uuid'), (past, past))
        self.env.svc.maybe_sweep()
        left = os.listdir(self.env.staging)
        self.assertNotIn(old, left)
        self.assertIn(fresh, left)
        self.assertIn('not-a-uuid', left)
        self.assertEqual(len(left), 3)  # the symlink is left alone (and its target untouched)
        self.assertTrue(os.path.isdir(decoy_dir))


class ReleaseTests(E2EBase):
    """Portal v0.4.0: `in/<uuid>.release` deletes a finished job's staging dir."""

    def marker(self, uid):
        path = os.path.join(self.env.spool, 'in', f'{uid}.release')
        with open(path, 'w') as f:
            f.write('')
        return path

    def test_release_removes_finished_job_dir_and_marker(self):
        uid, res = self.env.run(SC + 'ok-m4a')
        self.assertEqual(res['status'], 'ok')
        self.assertTrue(os.path.isdir(self.env.job_dir(uid)))
        m = self.marker(uid)
        self.assertEqual(self.env.svc.process_releases(), 1)
        self.assertFalse(os.path.lexists(self.env.job_dir(uid)))
        self.assertFalse(os.path.lexists(m))
        self.assertEqual(self.env.result(uid)['status'], 'ok')  # the result stays
        # a repeated release is a no-op
        self.marker(uid)
        self.assertEqual(self.env.svc.process_releases(), 0)

    def test_release_without_result_leaves_dir(self):
        import uuid as u
        uid = str(u.uuid4())
        os.mkdir(self.env.job_dir(uid))
        m = self.marker(uid)
        self.assertEqual(self.env.svc.process_releases(), 0)
        self.assertTrue(os.path.isdir(self.env.job_dir(uid)))
        self.assertFalse(os.path.lexists(m))

    def test_release_of_claimed_job_waits(self):
        uid, _ = self.env.run(SC + 'ok-mp3')
        claimed = os.path.join(self.env.spool, 'claimed', f'{uid}.json')
        with open(claimed, 'w') as f:
            f.write('{}')
        m = self.marker(uid)
        self.assertEqual(self.env.svc.process_releases(), 0)
        self.assertTrue(os.path.isdir(self.env.job_dir(uid)))
        self.assertTrue(os.path.lexists(m), 'the marker of a job in progress is kept')
        # once the job is no longer claimed, a later pass releases it
        os.unlink(claimed)
        self.assertEqual(self.env.svc.process_releases(), 1)
        self.assertFalse(os.path.lexists(self.env.job_dir(uid)))
        self.assertFalse(os.path.lexists(m))

    def test_release_before_fetch_cancels_the_job(self):
        # SC-SEC-3: the worker gave up (sc_fetch_unanswered) while the request
        # was still queued; it must never be downloaded afterwards.
        uid = self.env.submit(SC + 'ok-m4a')
        m = self.marker(uid)
        self.assertEqual(self.env.svc.process_releases(), 1)
        self.assertFalse(os.path.lexists(m))
        self.assertFalse(os.path.lexists(os.path.join(self.env.spool, 'in', f'{uid}.json')))
        self.env.svc.run_until_empty()
        self.assertIsNone(self.env.stub_env(uid), 'yt-dlp must not run for a released job')
        self.assertFalse(os.path.lexists(self.env.job_dir(uid)))
        self.assertEqual(os.listdir(os.path.join(self.env.spool, 'out')), [])
        self.assertEqual(os.listdir(os.path.join(self.env.spool, 'in')), [])

    def test_release_before_fetch_cancels_it_in_the_service_loop(self):
        # the same through run_until_empty: releases are processed before the
        # next request is claimed
        a = self.env.submit(SC + 'ok-mp3')
        self.marker(a)
        b = self.env.submit(SC + 'ok-m4a')
        self.env.svc.run_until_empty()
        self.assertIsNone(self.env.stub_env(a))
        self.assertFalse(os.path.lexists(self.env.job_dir(a)))
        self.assertEqual(self.env.result(b)['status'], 'ok')
        self.assertEqual(os.listdir(os.path.join(self.env.spool, 'out')), [f'{b}.json'])

    def test_symlinked_request_is_cancelled_by_unlinking_the_link_only(self):
        import uuid as u
        uid = str(u.uuid4())
        os.symlink(self.env.decoy, os.path.join(self.env.spool, 'in', f'{uid}.json'))
        self.marker(uid)
        self.env.svc.process_releases()
        self.assertFalse(os.path.lexists(os.path.join(self.env.spool, 'in', f'{uid}.json')))
        self.assertTrue(os.path.isfile(self.env.decoy))

    def test_symlinked_marker_and_job_dir_never_followed(self):
        uid, _ = self.env.run(SC + 'ok-mp3')
        # the marker is a symlink to the decoy: only the link goes
        os.symlink(self.env.decoy, os.path.join(self.env.spool, 'in', f'{uid}.release'))
        # the job dir is replaced by a symlink to a decoy dir: only the link goes
        import shutil
        shutil.rmtree(self.env.job_dir(uid))
        decoy_dir = os.path.join(self.env.root, 'decoy-dir')
        os.mkdir(decoy_dir)
        with open(os.path.join(decoy_dir, 'keep'), 'w') as f:
            f.write('keep')
        os.symlink(decoy_dir, self.env.job_dir(uid))
        self.env.svc.process_releases()
        self.assertFalse(os.path.lexists(self.env.job_dir(uid)))
        self.assertTrue(os.path.isfile(os.path.join(decoy_dir, 'keep')))
        self.assertTrue(os.path.isfile(self.env.decoy))

    def test_bad_marker_names_ignored_and_not_requests(self):
        for name in ('not-a-uuid.release', 'ABCDEF00-0000-4000-8000-000000000000.release'):
            with open(os.path.join(self.env.spool, 'in', name), 'w') as f:
                f.write('')
        self.assertEqual(self.env.svc.process_releases(), 0)
        self.env.svc.run_until_empty()  # markers are never taken for requests
        self.assertEqual(os.listdir(os.path.join(self.env.spool, 'out')), [])


if __name__ == '__main__':
    unittest.main()
