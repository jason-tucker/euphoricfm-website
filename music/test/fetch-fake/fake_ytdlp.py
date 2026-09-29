"""TEST HARNESS ONLY: a fake yt-dlp for the music-fetch container in the
portal's test stack. Never touches the network.

It checks that it got EXACTLY the pinned invocation (fetchsvc.runner's flags,
then -o <job>/audio.%(ext)s --write-info-json -- <canonical url>), then plays
/fixtures/<track slug>.json:

  {"info": {...yt-dlp info JSON...},   written first, atomically, like yt-dlp
   "audio": "<file in /fixtures>",     copied to <job>/audio.<ext>
   "ext": "m4a",
   "sleep": 0,                         seconds to wait after the info JSON
   "stderr": "...", "exit": 0}         what to print / exit with instead
"""

import json
import os
import shutil
import sys
import time

from fetchsvc.runner import PINNED_FLAGS

FIXTURES = '/fixtures'


def main():
    args = sys.argv[1:]
    n = len(PINNED_FLAGS)
    if tuple(args[:n]) != PINNED_FLAGS:
        print(f'ERROR: fake: pinned flags differ: {args!r}', file=sys.stderr)
        return 90
    rest = args[n:]
    if len(rest) != 5 or rest[0] != '-o' or rest[2] != '--write-info-json' or rest[3] != '--' or not rest[1].endswith('/audio.%(ext)s'):
        print(f'ERROR: fake: tail args differ: {rest!r}', file=sys.stderr)
        return 91
    job = os.path.dirname(rest[1])
    url = rest[4]
    slug = url.rsplit('/', 1)[1]
    path = os.path.join(FIXTURES, f'{slug}.json')
    if not os.path.isfile(path):
        print(f'ERROR: [soundcloud] {slug}: Unable to download JSON metadata: HTTP Error 404: Not Found', file=sys.stderr)
        return 1
    with open(path) as f:
        fx = json.load(f)
    if fx.get('stderr'):
        print(fx['stderr'], file=sys.stderr)
    if fx.get('exit'):
        return int(fx['exit'])
    info = fx.get('info')
    if info is not None:
        tmp = os.path.join(job, 'audio.info.json.fake.tmp')
        with open(tmp, 'w') as f:
            json.dump(info, f)
        os.rename(tmp, os.path.join(job, 'audio.info.json'))
    if fx.get('sleep'):
        time.sleep(float(fx['sleep']))
    if fx.get('audio'):
        shutil.copyfile(os.path.join(FIXTURES, fx['audio']), os.path.join(job, f"audio.{fx.get('ext', 'm4a')}"))
    return 0


if __name__ == '__main__':
    sys.exit(main())
