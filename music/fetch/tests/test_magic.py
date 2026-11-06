"""Magic-byte allowlist."""

import os
import tempfile
import unittest

from fetchsvc.magic import detect_fd
from tests import stub_ytdlp as S


def detect(data):
    with tempfile.TemporaryFile() as f:
        f.write(data)
        f.flush()
        r = detect_fd(f.fileno())
    return (r.container, r.ffmpeg_format) if r else None


class MagicTests(unittest.TestCase):
    def test_allowed(self):
        self.assertEqual(detect(S.mp3_bytes()), ('mp3', 'mp3'))
        self.assertEqual(detect(S.mp3_bytes()[20:]), ('mp3', 'mp3'))  # no ID3
        self.assertEqual(detect(S.m4a_bytes()), ('mp4', 'mp4'))
        self.assertEqual(detect(S.opus_bytes()), ('opus', 'ogg'))
        self.assertEqual(detect(S.vorbis_bytes()), ('ogg', 'ogg'))
        self.assertEqual(detect(S.wav_bytes()), ('wav', 'wav'))
        self.assertEqual(detect(S.flac_bytes()), ('flac', 'flac'))

    def test_rejected(self):
        for name, data in [
            ('html', b'<!doctype html>' * 10),
            ('hls', b'#EXTM3U\n#EXT-X-VERSION:3\n' * 5),
            ('mpegts', (b'\x47' + b'\x00' * 187) * 5),
            ('aiff', b'FORM\x00\x00\x10\x00AIFFCOMM' + b'\x00' * 100),
            ('webm', b'\x1a\x45\xdf\xa3' + b'\x00' * 100),
            ('jpeg', b'\xff\xd8\xff\xe0\x00\x10JFIF' + b'\x00' * 100),
            ('png', b'\x89PNG\r\n\x1a\n' + b'\x00' * 100),
            ('lone sync', b'\xff\xfb\x90\x00' + b'\x01' * 500),
            ('bad id3', b'ID3\x09\x00\x00\x00\x00\x00\x0a' + b'\x00' * 100),
            ('id3 only', b'ID3\x04\x00\x00\x00\x00\x00\x0a' + b'\x00' * 10),
            ('ogg flac', S.ogg_page(b'\x7fFLAC' + b'\x00' * 20)),
            ('ogg no bos', b'OggS\x00\x00' + b'\x00' * 20 + b'\x01\x13OpusHead' + b'\x00' * 20),
            ('ftyp huge box', b'\xff\xff\xff\xffftypM4A ' + b'\x00' * 100),
            ('tiny', b'ID3'),
            ('empty', b''),
            ('riff avi', b'RIFF\x00\x00\x00\x00AVI LIST' + b'\x00' * 100),
        ]:
            with self.subTest(name=name):
                self.assertIsNone(detect(data))


if __name__ == '__main__':
    unittest.main()
