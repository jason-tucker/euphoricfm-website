# music-fetch changelog

Service-local history. The repo-level `CHANGELOG.md` entry and the `package.json` version bump are added when this directory is merged into the portal.

## [0.1.0] — 2026-09-27 — SoundCloud import service (plan P5)

### Added
- **Spool service** `/spool/fetch/{in,claimed,out}`. It processes one job at a time, claims requests by rename, reads them with `O_NOFOLLOW` and size caps, never overwrites a result, and turns a leftover claim into an `interrupted` result at startup.
- **§3.6 URL validation.** Strict printable-ASCII parsing. The URL given to yt-dlp is always rebuilt from the validated parts.
- **Shortlink resolution without yt-dlp.** At most 5 redirects. Every hop's host is checked before it is requested, and the final host and path are re-validated.
- **Connect-time public-IP guard** on fetch's own HTTP requests.
- **Pinned yt-dlp 2026.8.19** with the exact §3.6 flags, and this supervision:
  - a 10-minute timeout;
  - a process-group kill;
  - a job-directory size cap, backed by `RLIMIT_FSIZE`;
  - an early stop on `too_long` and on playlists, decided from the info JSON;
  - a child environment of exactly `{PATH, HOME=/tmp}`.
- **Magic-byte allowlist**: mp3, mp4, ogg, opus, wav and flac, checked for consistency with the file extension. The service computes `rawSha256` and emits `ffmpegFormat` so music-probe can force `-f`.
- **Artwork** is fetched only from `https://*.sndcdn.com`. It is capped at 5 MiB, redirects are not followed, and the file is stored raw and never decoded.
- **Startup refusal** (exit 78) if the environment holds any unexpected variable name.
- **24-hour sweep** of stale `/staging/fetch/<uuid>/` directories.
- **Dockerfile**: a digest-pinned `python:3.13-alpine` base and hash-locked yt-dlp, with pip removed. It runs as uid 1000 with `python -I -B`, and has a test stage.
- **68 stdlib tests**, run under the runtime constraints.
