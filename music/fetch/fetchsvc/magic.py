"""Magic-byte container check for the downloaded audio.

Allowed containers: mp3, mp4 (m4a), ogg (vorbis), opus (in ogg), wav, flac.
Anything else — HLS playlists, MPEG-TS, HTML, AIFF, WebM, images — fails.
This only identifies the container so music-probe can FORCE the demuxer
(`-f <ffmpegFormat>`); it never decodes anything.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

MAX_ID3_PADDING = 64 * 1024

# container -> ffmpeg demuxer name that music-probe must pass as `-f`
FFMPEG_FORMAT = {
    'mp3': 'mp3',
    'mp4': 'mp4',
    'ogg': 'ogg',
    'opus': 'ogg',
    'wav': 'wav',
    'flac': 'flac',
}

# yt-dlp output extension -> containers it may legitimately hold
EXT_CONTAINERS = {
    'mp3': {'mp3'},
    'm4a': {'mp4'},
    'mp4': {'mp4'},
    'opus': {'opus'},
    'ogg': {'ogg', 'opus'},
    'oga': {'ogg', 'opus'},
    'wav': {'wav'},
    'flac': {'flac'},
}


@dataclass(frozen=True)
class Detected:
    container: str
    ffmpeg_format: str


def _id3v2_size(head: bytes) -> int | None:
    """Total ID3v2 tag size, None if no tag, -1 if malformed."""
    if len(head) < 10 or head[:3] != b'ID3':
        return None
    major = head[3]
    if major < 2 or major > 4 or head[4] == 0xFF:
        return -1
    s = head[6:10]
    if any(b & 0x80 for b in s):
        return -1
    size = (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3]
    footer = 10 if (major == 4 and head[5] & 0x10) else 0
    return 10 + size + footer


_BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
_BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
_SR = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def _mp3_frame_len(b: bytes, off: int) -> int | None:
    """Length of the MPEG-1/2/2.5 Layer III frame at off, or None."""
    if off + 4 > len(b):
        return None
    b0, b1, b2 = b[off], b[off + 1], b[off + 2]
    if b0 != 0xFF or (b1 & 0xE0) != 0xE0:
        return None
    version = (b1 >> 3) & 0x03
    layer = (b1 >> 1) & 0x03
    br_idx = (b2 >> 4) & 0x0F
    sr_idx = (b2 >> 2) & 0x03
    if version == 0x01 or layer != 0x01 or br_idx in (0, 0x0F) or sr_idx == 0x03:
        return None
    bitrate = (_BR_V1 if version == 3 else _BR_V2)[br_idx] * 1000
    rate = _SR[version][sr_idx]
    padding = (b2 >> 1) & 0x01
    length = ((144 if version == 3 else 72) * bitrate) // rate + padding
    return length if length >= 24 else None


def _is_mp3(fd: int, size: int, head: bytes) -> bool:
    off = 0
    tag = _id3v2_size(head)
    if tag == -1:
        return False
    if tag is not None:
        off = tag
    if off >= size:
        return False
    window = os.pread(fd, min(MAX_ID3_PADDING + 4, size - off), off)
    i = 0
    while i < len(window) and window[i] == 0 and i < MAX_ID3_PADDING:
        i += 1
    first = _mp3_frame_len(window, i)
    if first is None:
        return False
    # The next frame header must start exactly where the first frame ends, so
    # a stray 0xFFFB pair in front of some other format is not enough.
    nxt = os.pread(fd, 4, off + i + first)
    if len(nxt) == 4:
        return _mp3_frame_len(nxt, 0) is not None
    return off + i + first >= size  # a single, complete frame is the whole file


def _ogg_kind(fd: int, head: bytes) -> str | None:
    # OggS, stream structure version 0, BOS flag on the first page.
    if len(head) < 27 or head[:4] != b'OggS' or head[4] != 0 or not (head[5] & 0x02):
        return None
    nseg = head[26]
    page = os.pread(fd, 27 + nseg + 64, 0)
    if len(page) < 27 + nseg + 8:
        return None
    body = page[27 + nseg:]
    if body[:8] == b'OpusHead':
        return 'opus'
    if body[:7] == b'\x01vorbis':
        return 'ogg'
    return None


def _is_mp4(head: bytes) -> bool:
    if len(head) < 12 or head[4:8] != b'ftyp':
        return False
    box = int.from_bytes(head[0:4], 'big')
    if box < 12 or box > 4096:
        return False
    brand = head[8:12]
    return all(0x20 <= c <= 0x7E for c in brand)


def detect_fd(fd: int) -> Detected | None:
    st = os.fstat(fd)
    size = st.st_size
    if size < 12:
        return None
    head = os.pread(fd, 64, 0)
    kind: str | None = None
    if head[:4] == b'fLaC':
        kind = 'flac'
    elif head[:4] == b'RIFF' and head[8:12] == b'WAVE':
        kind = 'wav'
    elif head[:4] == b'OggS':
        kind = _ogg_kind(fd, head)
    elif _is_mp4(head):
        kind = 'mp4'
    elif _is_mp3(fd, size, head):
        kind = 'mp3'
    if kind is None:
        return None
    return Detected(kind, FFMPEG_FORMAT[kind])
