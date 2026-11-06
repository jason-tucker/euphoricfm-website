"""Artwork host allowlist and the capped, redirect-free download."""

import hashlib
import os
import shutil
import tempfile
import unittest

from fetchsvc.artwork import ArtworkResult, choose_artwork_url, fetch_artwork, validate_artwork_url
from fetchsvc.errors import ARTWORK_HOST, FetchError
from tests.helpers import JPEG, FakeResp


class AllowlistTests(unittest.TestCase):
    OK = [
        ('https://i1.sndcdn.com/artworks-abc-t500x500.jpg', 'i1.sndcdn.com'),
        ('https://a1.sndcdn.com/images/x.png', 'a1.sndcdn.com'),
        ('https://I1.SNDCDN.COM/x.jpg', 'i1.sndcdn.com'),
        ('https://i1.eu.sndcdn.com/x.jpg?w=500', 'i1.eu.sndcdn.com'),
    ]
    BAD = [
        'http://i1.sndcdn.com/x.jpg',
        'https://sndcdn.com/x.jpg',
        'https://evilsndcdn.com/x.jpg',
        'https://i1.sndcdn.com.evil.com/x.jpg',
        'https://evil.com/i1.sndcdn.com/x.jpg',
        'https://i1.sndcdn.com@evil.com/x.jpg',
        'https://evil.com@i1.sndcdn.com/x.jpg',
        'https://i1.sndcdn.com:443/x.jpg',
        'https://i1.sndcdn.com:8443/x.jpg',
        'https://i1.sndcdn.com',
        'https://i1.sndcdn.com/x.jpg#frag',
        'https://i1.sndcdn.com/a\\b.jpg',
        'https://i1.sndcdn.com./x.jpg',
        'https://-x.sndcdn.com/x.jpg',
        'https://i1..sndcdn.com/x.jpg',
        'https://i1.sndcdn。com/x.jpg',
        'https://i1.sńdcdn.com/x.jpg',
        'https://xn--i1-sndcdn-9za.com/x.jpg',
        'https://[::1]/x.jpg',
        'https://169.254.169.254/latest/meta-data',
        'https://i1.sndcdn%2ecom/x.jpg',
        'https://i1.sndcdn.com/x.jpg ',
        'data:image/png;base64,AAAA',
        'file:///etc/passwd',
        '', None, 42,
    ]

    def test_ok(self):
        for url, host in self.OK:
            with self.subTest(url=url):
                self.assertEqual(validate_artwork_url(url).host, host)

    def test_bad(self):
        for url in self.BAD:
            with self.subTest(url=url):
                with self.assertRaises(FetchError) as cm:
                    validate_artwork_url(url)
                self.assertEqual(cm.exception.code, ARTWORK_HOST)

    def test_choose_prefers_t500(self):
        self.assertEqual(choose_artwork_url({'thumbnails': [{'id': 'original', 'url': 'o'},
                                                            {'id': 't500x500', 'url': 't'}], 'thumbnail': 'o'}), 't')
        self.assertEqual(choose_artwork_url({'thumbnail': 'x'}), 'x')
        self.assertIsNone(choose_artwork_url({'thumbnails': 'junk', 'thumbnail': 5}))


class Opener:
    def __init__(self, resp=None, exc=None):
        self.resp, self.exc = resp, exc

    def get(self, host, target, timeout):
        if self.exc:
            raise self.exc
        return self.resp


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.dest = os.path.join(self.d, 'artwork.raw')
        self.art = validate_artwork_url('https://i1.sndcdn.com/x.jpg')

    def tearDown(self):
        shutil.rmtree(self.d)

    def fetch(self, resp=None, exc=None, **kw):
        return fetch_artwork(self.art, self.dest, Opener(resp, exc), **kw)

    def test_ok_raw_bytes_stored(self):
        r = self.fetch(FakeResp(200, {'Content-Type': 'image/jpeg'}, JPEG))
        self.assertEqual(r, ArtworkResult(hashlib.sha256(JPEG).hexdigest(), len(JPEG)))
        with open(self.dest, 'rb') as f:
            self.assertEqual(f.read(), JPEG)

    def test_skips(self):
        big = b'\x00' * (5 * 1024 * 1024 + 1)
        for resp, exc, want in [
            (FakeResp(200, {'Content-Type': 'image/jpeg', 'Content-Length': str(len(big))}, b''), None, 'artwork_too_large'),
            (FakeResp(200, {'Content-Type': 'image/jpeg'}, big), None, 'artwork_too_large'),
            (FakeResp(200, {'Content-Type': 'text/html'}, b'<html>'), None, 'artwork_not_image'),
            (FakeResp(200, {'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': 'x'}, b'<svg/>'), None, 'artwork_bad_length'),
            (FakeResp(301, {'Location': 'https://evil.example/'}, b''), None, 'artwork_http_301'),
            (FakeResp(200, {'Content-Type': 'image/png'}, b''), None, 'artwork_empty'),
            (None, TimeoutError(), 'artwork_timeout'),
            (None, ConnectionRefusedError(), 'artwork_fetch_failed'),
        ]:
            with self.subTest(want=want):
                self.assertEqual(self.fetch(resp, exc), want)
                self.assertFalse(os.path.exists(self.dest))

    def test_existing_dest_not_overwritten(self):
        decoy = os.path.join(self.d, 'decoy.txt')
        with open(decoy, 'w') as f:
            f.write('decoy')
        os.symlink(decoy, self.dest)
        with self.assertRaises(FileExistsError):
            self.fetch(FakeResp(200, {'Content-Type': 'image/jpeg'}, JPEG))
        with open(decoy) as f:
            self.assertEqual(f.read(), 'decoy')


if __name__ == '__main__':
    unittest.main()
