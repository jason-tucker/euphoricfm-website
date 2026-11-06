"""Supervision of the yt-dlp child, independent of the stub."""

import os
import shutil
import sys
import tempfile
import time
import unittest

from fetchsvc.runner import PINNED_FLAGS, build_argv, run_ytdlp

SLOW_WRITER = ('import time,sys\n'
               'with open(sys.argv[1] + "/audio.mp3.part", "wb") as f:\n'
               '    for _ in range(400):\n'
               '        f.write(b"x" * 65536); f.flush(); time.sleep(0.05)\n')


class RunnerTests(unittest.TestCase):
    def run_child(self, code, *args, **kw):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        params = dict(env={'PATH': '/usr/bin:/bin', 'HOME': '/tmp'}, cwd='/tmp', job_dir=d, timeout_s=10,
                      max_dir_bytes=1024 * 1024, info_check=lambda: None, should_abort=lambda: False)
        params.update(kw)
        t = time.monotonic()
        out = run_ytdlp([sys.executable, '-c', code, d, *args], **params)
        return out, time.monotonic() - t, d

    def test_argv_is_exactly_the_pinned_invocation(self):
        self.assertEqual(
            build_argv(['yt-dlp'], '/staging/fetch/0f03984e-f585-4993-82b7-b29c24ddc907', 'https://soundcloud.com/a/b'),
            ['yt-dlp', '--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--use-extractors', 'soundcloud', '--no-playlist',
             '--max-filesize', '60M', '--restrict-filenames', '--no-exec', '--no-write-comments', '--no-mtime',
             '-o', '/staging/fetch/0f03984e-f585-4993-82b7-b29c24ddc907/audio.%(ext)s', '--write-info-json',
             '--', 'https://soundcloud.com/a/b'])
        self.assertEqual(len(PINNED_FLAGS), 12)
        with self.assertRaises(ValueError):
            build_argv(['yt-dlp'], '/staging/%(title)s', 'https://soundcloud.com/a/b')
        with self.assertRaises(ValueError):
            build_argv(['yt-dlp'], 'relative', 'https://soundcloud.com/a/b')

    def test_directory_cap_kills_slow_writer(self):
        out, took, d = self.run_child(SLOW_WRITER)
        self.assertEqual(out.kind, 'too_large')
        self.assertLess(took, 5)

    def test_timeout_kills(self):
        out, took, _ = self.run_child('import time; time.sleep(60)', timeout_s=1)
        self.assertEqual(out.kind, 'timeout')
        self.assertLess(took, 5)

    def test_rlimit_fsize_backstop(self):
        # No polling help: a burst write past the cap fails in the kernel (EFBIG).
        code = ('import sys\n'
                'open(sys.argv[1] + "/audio.mp3", "wb").write(b"x" * (8 * 1024 * 1024))\n')
        out, _, d = self.run_child(code, max_dir_bytes=512 * 1024)
        self.assertIn('[Errno 27]', out.tail)
        self.assertLessEqual(os.path.getsize(os.path.join(d, 'audio.mp3')), 512 * 1024 + 1024 * 1024)

    def test_output_tail_is_bounded(self):
        out, _, _ = self.run_child('import sys; sys.stdout.write("A" * 500000 + "END")')
        self.assertEqual(out.kind, 'exited')
        self.assertLessEqual(len(out.tail), 8192)
        self.assertTrue(out.tail.endswith('END'))

    def test_stdin_closed(self):
        out, _, _ = self.run_child('import sys; print(repr(sys.stdin.read()))')
        self.assertIn("''", out.tail)


if __name__ == '__main__':
    unittest.main()
