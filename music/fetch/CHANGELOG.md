# music-fetch changelog

Service-local history. The repo-level `CHANGELOG.md` entry and the `package.json` version bump are added when this directory is merged into the portal.

## [0.2.1] — 2026-09-29 — Second pass (music v0.4.1)

### Fixed
- **Start-up recovery keeps a finished job.** A crash between writing `out/<uuid>.json` and unlinking the claim used to delete the job's download and leave the ok result pointing at nothing (the member saw "The downloaded file went missing"). A leftover claim whose result already exists now only loses the claim.

### Added
- **Heartbeat** `out/.alive`, refreshed every 30 s by a thread (so it keeps beating during a 10-min job), created with `O_NOFOLLOW`. The worker checks it before it writes a request: with music-fetch stopped, links wait their turn instead of each burning the 15-min timeout and alerting. Both id listers ignore the name.
- **Spool sweep**: with the staging sweep (every 10 min, same 24 h TTL), results in `out/` and `.tmp-*` files a crash left in `in/`, `claimed/` and `out/` are unlinked (never followed). The heartbeat and requests are never swept.
- 6 new tests (82 in all).

## [0.2.0] — 2026-09-28 — Integrated into the portal (music v0.4.0)

### Changed
- **The duration cap is the portal's 24 min** (1440 s; was 20 min): `too_long` is now over 1440 s. The probe re-checks the decoded stream against the same cap.

### Added
- **Release markers**: the worker writes `in/<uuid>.release` once the probe has converted (or refused) a job's audio, or once it has given up on the job, and fetch deletes that job's staging directory at once (a finished job: a result in `out/` and no claim; the marker is never followed or read; the 24 h sweep stays as the backstop). A marker for a job still queued in `in/` **cancels** it (no download, no result), a marker for the claimed job is **kept** until its result is written and then released, and a marker for an unknown job is dropped, so a job the worker timed out never leaves its download behind. 8 new tests (76 in all).

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
