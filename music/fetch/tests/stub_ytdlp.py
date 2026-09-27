#!/usr/bin/env python3
"""Stub yt-dlp for the spool end-to-end tests. Never touches the network.

It first asserts it was invoked with EXACTLY the pinned flags (its own
literal copy, so a drift in fetchsvc.runner fails the tests), dumps the
environment it actually received (/proc/self/environ, i.e. the execve env)
next to the staging root, then emits fixture files according to the track
slug in the URL.
"""

import json
import os
import subprocess
import sys
import time

PINNED = [
    '--ignore-config', '--no-cache-dir', '--use-extractors', 'soundcloud', '--no-playlist',
    '--max-filesize', '60M', '--restrict-filenames', '--no-exec', '--no-write-comments', '--no-mtime',
]


def mp3_bytes(frames=40):
    # MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: 417-byte frames.
    frame = b'\xff\xfb\x90\x00' + b'\x00' * 413
    return b'ID3\x04\x00\x00\x00\x00\x00\x0a' + b'\x00' * 10 + frame * frames


def m4a_bytes():
    return (b'\x00\x00\x00\x18ftypM4A \x00\x00\x02\x00isomiso2'
            + b'\x00\x00\x00\x08free' + b'\x00' * 2000)


def ogg_page(payload):
    seg = bytes([len(payload)])
    return b'OggS\x00\x02' + b'\x00' * 20 + b'\x01' + seg + payload


def opus_bytes():
    return ogg_page(b'OpusHead\x01\x02\x38\x01\x80\xbb\x00\x00\x00\x00\x00') + b'\x00' * 2000


def vorbis_bytes():
    return ogg_page(b'\x01vorbis' + b'\x00' * 22) + b'\x00' * 2000


def wav_bytes():
    return b'RIFF\x24\x08\x00\x00WAVEfmt ' + b'\x10\x00\x00\x00\x01\x00\x02\x00' + b'\x00' * 2000


def flac_bytes():
    return b'fLaC\x00\x00\x00\x22' + b'\x00' * 2000


AUDIO = {'mp3': mp3_bytes, 'm4a': m4a_bytes, 'opus': opus_bytes, 'ogg': vorbis_bytes,
         'wav': wav_bytes, 'flac': flac_bytes}


def base_info():
    return {
        'id': '123456789', 'title': 'Stub ‮Track\x07', 'uploader': 'Stub Artist',
        'duration': 200.5, 'genre': 'House', 'description': 'line one\nline two\x00',
        'license': 'cc-by', 'extractor': 'soundcloud', 'extractor_key': 'Soundcloud',
        'webpage_url': 'https://soundcloud.com/stub/x', '_type': 'video',
        'thumbnails': [{'id': 'original', 'url': 'https://i1.sndcdn.com/artworks-abc-original.png'},
                       {'id': 't500x500', 'url': 'https://i1.sndcdn.com/artworks-abc-t500x500.jpg'}],
        'thumbnail': 'https://i1.sndcdn.com/artworks-abc-original.png',
    }


def write_info(job, info):
    # yt-dlp writes the info JSON atomically (tmp file + rename) before downloading.
    tmp = os.path.join(job, 'audio.info.json.x1y2.tmp')
    with open(tmp, 'w') as f:
        if isinstance(info, str):
            f.write(info)
        else:
            json.dump(info, f)
    os.rename(tmp, os.path.join(job, 'audio.info.json'))


def write(path, data):
    with open(path, 'wb') as f:
        f.write(data)


def main():
    args = sys.argv[1:]
    if args[:len(PINNED)] != PINNED:
        print('ERROR: stub: pinned flags differ: %r' % (args,), file=sys.stderr)
        return 90
    rest = args[len(PINNED):]
    if len(rest) != 5 or rest[0] != '-o' or rest[2] != '--write-info-json' or rest[3] != '--':
        print('ERROR: stub: tail args differ: %r' % (rest,), file=sys.stderr)
        return 91
    tmpl, url = rest[1], rest[4]
    if not tmpl.endswith('/audio.%(ext)s'):
        return 92
    job = os.path.dirname(tmpl)
    uuid = os.path.basename(job)
    root = os.path.dirname(os.path.dirname(job))
    with open('/proc/self/environ', 'rb') as f:
        env = dict(kv.split(b'=', 1) for kv in f.read().split(b'\0') if b'=' in kv)
    with open(os.path.join(root, f'stub-env-{uuid}.json'), 'w') as f:
        json.dump({k.decode(): v.decode() for k, v in env.items()} | {'__cwd__': os.getcwd(), '__url__': url}, f)

    slug = url.rsplit('/', 1)[1]
    info = base_info()

    if slug.startswith('ok-'):
        ext = slug[3:]
        write_info(job, info)
        write(os.path.join(job, f'audio.{ext}'), AUDIO[ext]())
        return 0
    if slug == 'noart':
        info.pop('thumbnails')
        info.pop('thumbnail')
        write_info(job, info)
        write(os.path.join(job, 'audio.mp3'), mp3_bytes())
        return 0
    if slug == 'long':
        info['duration'] = 1500
        write_info(job, info)
        time.sleep(30)  # must be killed early, on the info JSON alone
        write(os.path.join(job, 'audio.mp3'), mp3_bytes())
        return 0
    if slug == 'exactly20':
        info['duration'] = 1200
        write_info(job, info)
        write(os.path.join(job, 'audio.mp3'), mp3_bytes())
        return 0
    if slug == 'nodur':
        info.pop('duration')
        write_info(job, info)
        write(os.path.join(job, 'audio.mp3'), mp3_bytes())
        return 0
    if slug == 'huge':
        write_info(job, info)
        with open(os.path.join(job, 'audio.mp3.part'), 'wb') as f:
            for _ in range(200):
                f.write(b'\xff' * (1024 * 1024))
                f.flush()
                time.sleep(0.002)
        os.rename(os.path.join(job, 'audio.mp3.part'), os.path.join(job, 'audio.mp3'))
        return 0
    if slug == 'maxfs':
        write_info(job, info)
        print('[download] File is larger than max-filesize (99999999 bytes > 62914560 bytes). Aborting.')
        return 0
    if slug == 'slow':
        write_info(job, info)
        time.sleep(60)
        return 0
    if slug == 'fail':
        print('ERROR: [soundcloud] 123: Unable to download JSON metadata: HTTP Error 404', file=sys.stderr)
        return 1
    if slug == 'unsupported':
        print(f'ERROR: Unsupported URL: {url}', file=sys.stderr)
        return 1
    if slug == 'playlist':
        write_info(job, {'_type': 'playlist', 'entries': [], 'extractor': 'soundcloud:set',
                         'extractor_key': 'SoundcloudSet'})
        time.sleep(30)
        return 0
    if slug == 'generic':
        info['extractor'] = 'generic'
        info['extractor_key'] = 'Generic'
        write_info(job, info)
        write(os.path.join(job, 'audio.mp3'), mp3_bytes())
        return 0
    if slug == 'badmagic':
        write_info(job, info)
        write(os.path.join(job, 'audio.mp3'), b'<!doctype html><script>alert(1)</script>' * 50)
        return 0
    if slug == 'hls':
        write_info(job, info)
        write(os.path.join(job, 'audio.mp4'), b'#EXTM3U\n#EXT-X-TARGETDURATION:10\nhttp://169.254.169.254/\n' * 20)
        return 0
    if slug == 'mpegts':
        write_info(job, info)
        write(os.path.join(job, 'audio.m4a'), (b'\x47' + b'\x00' * 187) * 50)
        return 0
    if slug == 'mismatch':
        write_info(job, info)
        write(os.path.join(job, 'audio.m4a'), mp3_bytes())
        return 0
    if slug == 'symlink':
        write_info(job, info)
        os.symlink('/etc/passwd', os.path.join(job, 'audio.mp3'))
        return 0
    if slug == 'hardlink':
        write_info(job, info)
        outside = os.path.join(root, 'outside.mp3')
        write(outside, mp3_bytes())
        os.link(outside, os.path.join(job, 'audio.mp3'))
        return 0
    if slug == 'extra':
        write_info(job, info)
        write(os.path.join(job, 'audio.mp3'), mp3_bytes())
        write(os.path.join(job, 'payload.sh'), b'#!/bin/sh\nid\n')
        return 0
    if slug == 'noaudio':
        write_info(job, info)
        return 0
    if slug.startswith('art-'):
        which = slug[4:]
        urls = {
            'evil': 'https://evil.example/a.jpg',
            'lookalike': 'https://i1.sndcdn.com.evil.example/a.jpg',
            'at': 'https://i1.sndcdn.com@evil.example/a.jpg',
            'http': 'http://i1.sndcdn.com/a.jpg',
            'port': 'https://i1.sndcdn.com:8443/a.jpg',
            'bare': 'https://sndcdn.com/a.jpg',
            'suffix': 'https://evilsndcdn.com/a.jpg',
            'meta': 'https://169.254.169.254/latest/meta-data',
            'big': 'https://i1.sndcdn.com/big-t500x500.jpg',
            'notimage': 'https://i1.sndcdn.com/html-t500x500.jpg',
            'redirect': 'https://i1.sndcdn.com/redir-t500x500.jpg',
        }
        info['thumbnails'] = [{'id': 't500x500', 'url': urls[which]}]
        info['thumbnail'] = urls[which]
        write_info(job, info)
        write(os.path.join(job, 'audio.mp3'), mp3_bytes())
        return 0
    if slug == 'infobomb':
        write_info(job, '[' * 200000 + ']' * 200000)
        time.sleep(30)
        return 0
    if slug == 'grandchild':
        # Leaves a grandchild holding stdout open; the service must kill the group.
        gc = subprocess.Popen(['/bin/sleep', '300'])
        write(os.path.join(root, f'grandchild-{uuid}.pid'), str(gc.pid).encode())
        write_info(job, info)
        write(os.path.join(job, 'audio.mp3'), mp3_bytes())
        return 0
    print(f'ERROR: stub: unknown slug {slug}', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
