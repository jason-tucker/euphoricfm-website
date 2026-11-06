"""URL validation (plan §3.6): every accept and reject case."""

import unittest

from fetchsvc.errors import BAD_URL, NOT_A_TRACK, REDIRECT_HOST, FetchError
from fetchsvc.urls import canonical_from_resolved, parse_input


class AcceptTests(unittest.TestCase):
    CASES = [
        ('https://soundcloud.com/artist/track-name', 'track', 'https://soundcloud.com/artist/track-name'),
        ('https://soundcloud.com/artist/track_name-2', 'track', 'https://soundcloud.com/artist/track_name-2'),
        ('https://soundcloud.com/artist/track/', 'track', 'https://soundcloud.com/artist/track'),
        ('HTTPS://SoundCloud.COM/Artist/Track', 'track', 'https://soundcloud.com/artist/track'),
        # SoundCloud's own share parameters are tolerated and DROPPED.
        ('https://soundcloud.com/a/b?si=0123abcd&utm_source=clipboard&utm_medium=text&utm_campaign=social_sharing',
         'track', 'https://soundcloud.com/a/b'),
        ('https://soundcloud.com/a/b?in=a/sets/mix', 'track', 'https://soundcloud.com/a/b'),
        ('https://soundcloud.com/a/b?ref=clipboard&p=i&c=1', 'track', 'https://soundcloud.com/a/b'),
        ('https://soundcloud.com/a/b?', 'track', 'https://soundcloud.com/a/b'),
        ('https://on.soundcloud.com/AbCdEf123', 'short', 'https://on.soundcloud.com/AbCdEf123'),
        ('https://on.soundcloud.com/AbC?si=x', 'short', 'https://on.soundcloud.com/AbC'),
    ]

    def test_accepts(self):
        for url, kind, canon in self.CASES:
            with self.subTest(url=url):
                p = parse_input(url)
                self.assertEqual((p.kind, p.url), (kind, canon))


class RejectTests(unittest.TestCase):
    def assertCode(self, url, code):
        with self.assertRaises(FetchError, msg=repr(url)) as cm:
            parse_input(url)
        self.assertEqual(cm.exception.code, code, repr(url))

    BAD = [
        # host confusion
        'https://soundcloud.com.evil.com/a/b',
        'https://evil.com/soundcloud.com/a/b',
        'https://evil.com/https://soundcloud.com/a/b',
        'https://evilsoundcloud.com/a/b',
        'https://soundcloud.co/a/b',
        'https://www.soundcloud.com/a/b',
        'https://api.soundcloud.com/tracks/123',
        'https://api-v2.soundcloud.com/tracks/123',
        'https://w.soundcloud.com/player/?url=https://evil.com',
        'https://soundcloud.com./a/b',
        'https://.soundcloud.com/a/b',
        'https://soundcloud..com/a/b',
        # userinfo / @ tricks
        'https://soundcloud.com@evil.com/a/b',
        'https://evil.com@soundcloud.com/a/b',
        'https://user:pass@soundcloud.com/a/b',
        'https://soundcloud.com%40evil.com/a/b',
        'https://soundcloud.com\\@evil.com/a/b',
        'https://soundcloud.com/a/b\\..\\..',
        # ports
        'https://soundcloud.com:443/a/b',
        'https://soundcloud.com:8443/a/b',
        'https://soundcloud.com:/a/b',
        'https://on.soundcloud.com:443/abc',
        # IDN / lookalikes / non-ASCII
        'https://soundcłoud.com/a/b',
        'https://soundcloud。com/a/b',          # ideographic full stop
        'https://soundcloud．com/a/b',          # fullwidth full stop
        'https://ѕoundcloud.com/a/b',               # Cyrillic dze
        'https://xn--oundcloud-7fg.com/a/b',        # punycode lookalike
        'https://soundcloud.com/a/tráck',
        'https://soundcloud.com/a/b​',         # zero-width space
        'https://ｓoundcloud.com/a/b',          # fullwidth s
        # IP literals
        'https://127.0.0.1/a/b',
        'https://[::1]/a/b',
        'https://169.254.169.254/a/b',
        # scheme
        'http://soundcloud.com/a/b',
        'ftp://soundcloud.com/a/b',
        'javascript:alert(1)//soundcloud.com/a/b',
        'https:/soundcloud.com/a/b',
        'https:soundcloud.com/a/b',
        '//soundcloud.com/a/b',
        'soundcloud.com/a/b',
        'file:///etc/passwd',
        # whitespace / control / encoding
        ' https://soundcloud.com/a/b',
        'https://soundcloud.com/a/b ',
        'https://soundcloud.com/a/b\n',
        'https://soundcloud.com/a/b\t',
        'https://sound\x00cloud.com/a/b',
        'https://soundcloud.com/a%2Fb/c',
        'https://soundcloud.com/a/%62',
        'https://soundcloud.com/a/../b',
        'https://soundcloud.com/./a/b',
        'https://soundcloud.com//a/b',
        'https://soundcloud.com/a//b',
        'https://soundcloud.com/a/b;x=1',
        # query-parameter trickery (only SoundCloud's share keys are tolerated)
        'https://soundcloud.com/a/b?url=https://evil.com/x.mp3',
        'https://soundcloud.com/a/b?secret_token=s-abc',
        'https://soundcloud.com/a/b?format=bestaudio',
        'https://soundcloud.com/a/b?si=1&si=2',
        'https://soundcloud.com/a/b?si',
        'https://soundcloud.com/a/b?si=<script>',
        'https://soundcloud.com/a/b?utm_source=x&exec=rm',
        'https://soundcloud.com/a/b?%73i=1',
        # fragments
        'https://soundcloud.com/a/b#t=1:00',
        'https://soundcloud.com/a/b#',
        # shortlink shape
        'https://on.soundcloud.com/',
        'https://on.soundcloud.com',
        'https://on.soundcloud.com/abc/def',
        'https://on.soundcloud.com/ab-cd',
        'https://on.soundcloud.com/' + 'a' * 33,
        # non-strings / sizes
        None, 123, b'https://soundcloud.com/a/b', '', 'https://soundcloud.com/a/' + 'b' * 600,
        # empty host
        'https:///a/b',
    ]

    NOT_TRACK = [
        'https://soundcloud.com/',
        'https://soundcloud.com',
        'https://soundcloud.com/artist',
        'https://soundcloud.com/artist/sets/my-mix',
        'https://soundcloud.com/artist/sets',
        'https://soundcloud.com/artist/likes',
        'https://soundcloud.com/artist/reposts',
        'https://soundcloud.com/artist/tracks',
        'https://soundcloud.com/artist/albums',
        'https://soundcloud.com/artist/popular-tracks',
        'https://soundcloud.com/artist/followers',
        'https://soundcloud.com/artist/following',
        'https://soundcloud.com/artist/comments',
        'https://soundcloud.com/artist/spotlight',
        'https://soundcloud.com/artist/track/recommended',
        'https://soundcloud.com/artist/track/s-SeCrEt',      # private share token
        'https://soundcloud.com/artist/track/albums',
        'https://soundcloud.com/you/likes',
        'https://soundcloud.com/discover/sets',
        'https://soundcloud.com/search/sounds',
        'https://soundcloud.com/charts/top',
        'https://soundcloud.com/stations/track',
        'https://soundcloud.com/stream/x',
        'https://soundcloud.com/a/b/c/d',
    ]

    def test_bad_url(self):
        for url in self.BAD:
            with self.subTest(url=url):
                self.assertCode(url, BAD_URL)

    def test_not_a_track(self):
        for url in self.NOT_TRACK:
            with self.subTest(url=url):
                self.assertCode(url, NOT_A_TRACK)


class ResolvedTests(unittest.TestCase):
    def test_final_host_normalised(self):
        self.assertEqual(canonical_from_resolved('https://m.soundcloud.com/a/b?si=x&utm_source=y#z'),
                         'https://soundcloud.com/a/b')
        self.assertEqual(canonical_from_resolved('https://soundcloud.com/a/b?in=a/sets/x'),
                         'https://soundcloud.com/a/b')

    def test_final_host_rejected(self):
        for url in ['https://soundcloud.com.evil.com/a/b', 'https://evil.com/a/b',
                    'http://soundcloud.com/a/b', 'https://www.soundcloud.com/a/b',
                    'https://soundcloud.com@evil.com/a/b', 'https://soundcloud.com:444/a/b',
                    'https://on.soundcloud.com/a/b']:
            with self.subTest(url=url):
                with self.assertRaises(FetchError) as cm:
                    canonical_from_resolved(url)
                self.assertEqual(cm.exception.code, REDIRECT_HOST)

    def test_final_path_must_be_two_segments(self):
        for url in ['https://soundcloud.com/a', 'https://soundcloud.com/a/sets/b',
                    'https://soundcloud.com/a/likes', 'https://soundcloud.com/a/b/s-token']:
            with self.subTest(url=url):
                with self.assertRaises(FetchError) as cm:
                    canonical_from_resolved(url)
                self.assertEqual(cm.exception.code, NOT_A_TRACK)


if __name__ == '__main__':
    unittest.main()
