"""The pinned yt-dlp invocation (plan §3.6) and its supervision.

    yt-dlp --ignore-config --no-plugin-dirs --no-cache-dir --use-extractors soundcloud --no-playlist
           --max-filesize 60M --restrict-filenames --no-exec --no-write-comments
           --no-mtime -o '/staging/fetch/<uuid>/audio.%(ext)s' --write-info-json -- <url>

Supervision, all enforced here and not trusted to yt-dlp:
  * 10-minute wall-clock timeout; the child runs in its own session and the
    whole process group is SIGKILLed on timeout / cap / abort.
  * Minimal constructed env {PATH, HOME=/tmp}; stdin closed; fds closed.
  * The job directory's total size is polled; over the cap -> kill (yt-dlp's
    --max-filesize is only checked against Content-Length, and not across HLS
    fragments). RLIMIT_FSIZE on the child is a kernel backstop per file.
  * The info JSON is written (atomically) before the media download starts;
    as soon as it appears, `info_check` inspects it (duration / playlist) and
    can stop the download early.
"""

from __future__ import annotations

import os
import resource
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable

PINNED_FLAGS = (
    '--ignore-config',
    '--no-plugin-dirs',       # never load yt-dlp plugins from any default plugin dir
    '--no-cache-dir',
    '--use-extractors', 'soundcloud',
    '--no-playlist',
    '--max-filesize', '60M',
    '--restrict-filenames',
    '--no-exec',
    '--no-write-comments',
    '--no-mtime',
)
MAX_AUDIO_BYTES = 60 * 1024 * 1024          # == yt-dlp's "60M" (binary)
INFO_JSON_NAME = 'audio.info.json'
TAIL_BYTES = 8 * 1024


def build_argv(prefix: list[str], job_dir: str, url: str) -> list[str]:
    if '%' in job_dir or not os.path.isabs(job_dir):
        raise ValueError('job_dir must be absolute and contain no %')
    return [*prefix, *PINNED_FLAGS, '-o', f'{job_dir}/audio.%(ext)s', '--write-info-json', '--', url]


@dataclass(frozen=True)
class Outcome:
    kind: str               # 'exited' | 'timeout' | 'too_large' | 'early' | 'aborted'
    returncode: int | None
    tail: str
    early_code: str | None = None


class _Tail(threading.Thread):
    """Drains the child's merged stdout/stderr, keeping only the last bytes."""

    def __init__(self, stream):
        super().__init__(daemon=True)
        self.stream = stream
        self.buf = bytearray()

    def run(self):
        try:
            while True:
                b = self.stream.read1(4096) if hasattr(self.stream, 'read1') else self.stream.read(4096)
                if not b:
                    break
                self.buf += b
                if len(self.buf) > TAIL_BYTES:
                    del self.buf[: len(self.buf) - TAIL_BYTES]
        except (OSError, ValueError):
            pass

    def text(self) -> str:
        return bytes(self.buf).decode('utf-8', 'replace')


def dir_bytes(path: str) -> int:
    total = 0
    try:
        with os.scandir(path) as it:
            for e in it:
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                total += max(st.st_size, st.st_blocks * 512)
    except FileNotFoundError:
        pass
    return total


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.kill()
    except ProcessLookupError:
        pass


def run_ytdlp(argv: list[str], *, env: dict[str, str], cwd: str, job_dir: str, timeout_s: float,
              max_dir_bytes: int, info_check: Callable[[], str | None],
              should_abort: Callable[[], bool], poll_s: float = 0.2) -> Outcome:
    proc = subprocess.Popen(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        env=env, cwd=cwd, close_fds=True, start_new_session=True,
    )
    try:
        # Kernel backstop: no single file the child writes may exceed the cap
        # (+1 MiB slack for the info JSON). Lowering a limit needs no privilege.
        lim = max_dir_bytes + 1024 * 1024
        resource.prlimit(proc.pid, resource.RLIMIT_FSIZE, (lim, lim))
    except (OSError, ValueError):
        pass  # the size poll below still enforces the cap
    tail = _Tail(proc.stdout)
    tail.start()
    deadline = time.monotonic() + timeout_s
    info_path = os.path.join(job_dir, INFO_JSON_NAME)
    info_checked = False
    kind = 'exited'
    early: str | None = None
    try:
        while proc.poll() is None:
            if should_abort():
                kind = 'aborted'
                break
            if time.monotonic() > deadline:
                kind = 'timeout'
                break
            if dir_bytes(job_dir) > max_dir_bytes:
                kind = 'too_large'
                break
            if not info_checked and os.path.lexists(info_path):
                info_checked = True
                early = info_check()
                if early:
                    kind = 'early'
                    break
            time.sleep(poll_s)
    finally:
        # Always: also reaps any straggler the child may have left in its group.
        _kill_group(proc)
        proc.wait()
        tail.join(timeout=5)
        if proc.stdout:
            proc.stdout.close()
    return Outcome(kind, proc.returncode, tail.text(), early)
