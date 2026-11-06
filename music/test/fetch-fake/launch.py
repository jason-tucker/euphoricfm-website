"""TEST HARNESS ONLY: runs the REAL music-fetch service (fetchsvc.Service,
from the runtime image under test) with its two network seams replaced, so
a test stack never contacts SoundCloud or anything else:

  * yt-dlp        -> fake_ytdlp.py, which plays fixture files the tests write
                     to /fixtures (<slug>.json + the media file it names);
  * shortlinks    -> /fixtures/short/<id>.txt holds the Location to answer;
  * artwork       -> /fixtures/art/<basename of the artwork URL>.

The container also runs with network_mode: none (test/compose.test.yml), so
even a bug here could not reach the internet. Everything else (spool claim,
URL validation, the pinned argv, supervision, magic checks, artwork host
allowlist, results, release markers, the env guard) is the production code.
"""

import io
import os
import signal
import sys

from fetchsvc.envguard import unexpected_env_names
from fetchsvc.service import Config, Service

FIXTURES = '/fixtures'


class Resp:
    def __init__(self, status, headers, body):
        self.status = status
        self._h = {k.lower(): v for k, v in headers.items()}
        self._b = io.BytesIO(body)

    def getheader(self, name, default=None):
        return self._h.get(name.lower(), default)

    def read(self, amt=None):
        return self._b.read(amt)

    def close(self):
        pass


def _safe(name):
    return name and all(c.isalnum() or c in '-_.' for c in name) and not name.startswith('.')


class FixtureArtOpener:
    def get(self, host, target, timeout):
        name = target.rsplit('/', 1)[-1]
        path = os.path.join(FIXTURES, 'art', name)
        if not host.endswith('.sndcdn.com') or not _safe(name) or not os.path.isfile(path):
            return Resp(404, {}, b'')
        with open(path, 'rb') as f:
            body = f.read()
        ctype = 'image/png' if name.endswith('.png') else 'image/jpeg'
        return Resp(200, {'Content-Type': ctype, 'Content-Length': str(len(body))}, body)


class FixtureUrlOpener:
    def get(self, host, target, timeout):
        sid = target.lstrip('/').split('?', 1)[0]
        path = os.path.join(FIXTURES, 'short', f'{sid}.txt')
        if host != 'on.soundcloud.com' or not _safe(sid) or not os.path.isfile(path):
            return Resp(404, {}, b'')
        with open(path) as f:
            return Resp(302, {'Location': f.read().strip()}, b'')


def main():
    bad = unexpected_env_names()
    if bad:
        print(f'[fetch] refusing to start: unexpected environment variables: {", ".join(bad)}', file=sys.stderr, flush=True)
        return 78
    timeout = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
    cfg = Config(
        ytdlp_prefix=[sys.executable, '-I', '-B', '/fake/fake_ytdlp.py'],
        timeout_s=timeout,
        url_opener=FixtureUrlOpener(),
        art_opener=FixtureArtOpener(),
        poll_idle_s=0.5,
    )
    svc = Service(cfg)
    signal.signal(signal.SIGTERM, lambda *_: svc.stop.set())
    signal.signal(signal.SIGINT, lambda *_: svc.stop.set())
    svc.prepare()
    print('[fetch] TEST MODE: fake yt-dlp, fixture artwork/shortlinks, no network', flush=True)
    svc.run_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
