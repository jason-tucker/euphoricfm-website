"""Entry point: `python -I -B -m fetchsvc [options]`.

Configuration is by command-line flags only — never by environment variables
(the environment is checked, by name only, and must hold nothing unexpected).
"""

from __future__ import annotations

import argparse
import signal
import sys

from .envguard import unexpected_env_names
from .service import Config, Service


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog='music-fetch')
    p.add_argument('--spool-dir', default='/spool/fetch')
    p.add_argument('--staging-dir', default='/staging/fetch')
    p.add_argument('--home-dir', default='/tmp')
    p.add_argument('--ytdlp', default=None, help='path to a yt-dlp executable (default: python -I -m yt_dlp)')
    p.add_argument('--timeout', type=float, default=600.0)
    p.add_argument('--staging-ttl-hours', type=float, default=24.0)
    p.add_argument('--once', action='store_true', help='process the inbox until empty, then exit')
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    bad = unexpected_env_names()
    if bad:
        # Names only — values are never read or printed.
        print(f'[fetch] refusing to start: unexpected environment variables: {", ".join(bad)}',
              file=sys.stderr, flush=True)
        return 78  # EX_CONFIG
    args = parse_args(sys.argv[1:] if argv is None else argv)
    cfg = Config(spool_dir=args.spool_dir, staging_dir=args.staging_dir, home_dir=args.home_dir,
                 timeout_s=args.timeout, staging_ttl_s=args.staging_ttl_hours * 3600.0)
    if args.ytdlp:
        cfg.ytdlp_prefix = [args.ytdlp]
    svc = Service(cfg)
    signal.signal(signal.SIGTERM, lambda *_: svc.stop.set())
    signal.signal(signal.SIGINT, lambda *_: svc.stop.set())
    svc.prepare()
    if args.once:
        svc.run_until_empty()
    else:
        svc.run_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
