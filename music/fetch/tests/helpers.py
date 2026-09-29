import io
import json
import os
import shutil
import sys
import tempfile
import uuid as uuidlib

from fetchsvc.service import Config, Service

HERE = os.path.dirname(os.path.abspath(__file__))
STUB = os.path.join(HERE, 'stub_ytdlp.py')
JPEG = b'\xff\xd8\xff\xe0\x00\x10JFIF\x00' + b'\x00' * 900 + b'\xff\xd9'


class FakeResp:
    def __init__(self, status, headers, body):
        self.status = status
        self._h = {k.lower(): v for k, v in headers.items()}
        self._b = io.BytesIO(body)
        self.closed = False

    def getheader(self, name, default=None):
        return self._h.get(name.lower(), default)

    def read(self, amt=None):
        return self._b.read(amt)

    def close(self):
        self.closed = True


class FakeArtOpener:
    """Stands in for *.sndcdn.com. Records every request it is asked to make."""

    def __init__(self):
        self.calls = []

    def get(self, host, target, timeout):
        self.calls.append((host, target))
        if 'big' in target:  # no Content-Length: the streaming cap must catch it
            return FakeResp(200, {'Content-Type': 'image/jpeg'}, b'\xff' * (5 * 1024 * 1024 + 10))
        if 'html' in target:
            return FakeResp(200, {'Content-Type': 'text/html'}, b'<html></html>')
        if 'redir' in target:
            return FakeResp(302, {'Location': 'https://evil.example/x.jpg'}, b'')
        return FakeResp(200, {'Content-Type': 'image/jpeg', 'Content-Length': str(len(JPEG))}, JPEG)


class FakeUrlOpener:
    """Stands in for on.soundcloud.com: {shortid: Location}."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def get(self, host, target, timeout):
        self.calls.append((host, target))
        loc = self.routes.get(target.lstrip('/'))
        if loc is None:
            return FakeResp(404, {}, b'')
        return FakeResp(302, {'Location': loc}, b'')


class Env:
    """A temp spool/staging tree plus a Service wired to the stub yt-dlp."""

    def __init__(self, **cfg_overrides):
        self.root = tempfile.mkdtemp(prefix='fetchtest-')
        self.spool = os.path.join(self.root, 'spool')
        self.staging = os.path.join(self.root, 'staging')
        self.home = os.path.join(self.root, 'home')
        for d in ('in', 'out'):
            os.makedirs(os.path.join(self.spool, d))
        os.makedirs(self.staging)
        os.makedirs(self.home)
        # Symlink tests point at this decoy, never at a real system file.
        self.decoy = os.path.join(self.root, 'decoy.txt')
        with open(self.decoy, 'w') as f:
            f.write('decoy')
        os.chmod(self.decoy, 0o644)
        self.art = FakeArtOpener()
        self.urls = FakeUrlOpener({})
        cfg = Config(spool_dir=self.spool, staging_dir=self.staging, home_dir=self.home,
                     ytdlp_prefix=[sys.executable, STUB], timeout_s=20.0,
                     url_opener=self.urls, art_opener=self.art)
        for k, v in cfg_overrides.items():
            setattr(cfg, k, v)
        self.svc = Service(cfg)
        self.svc.prepare()

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def submit(self, url, uid=None, doc=None, requested_by='117501528641634310'):
        uid = uid or str(uuidlib.uuid4())
        if doc is None:
            doc = {'uuid': uid, 'url': url, 'requestedBy': requested_by}
        raw = doc if isinstance(doc, (bytes, str)) else json.dumps(doc)
        mode = 'wb' if isinstance(raw, bytes) else 'w'
        with open(os.path.join(self.spool, 'in', f'{uid}.json'), mode) as f:
            f.write(raw)
        return uid

    def run(self, url, **kw):
        uid = self.submit(url, **kw)
        assert self.svc.process_one(uid)
        return uid, self.result(uid)

    def result(self, uid):
        with open(os.path.join(self.spool, 'out', f'{uid}.json')) as f:
            return json.load(f)

    def job_dir(self, uid):
        return os.path.join(self.staging, uid)

    def stub_env(self, uid):
        p = os.path.join(self.root, f'stub-env-{uid}.json')
        if not os.path.exists(p):
            return None
        with open(p) as f:
            return json.load(f)
