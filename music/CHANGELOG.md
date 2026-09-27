# Changelog — EFM Music Portal (`music/`)

## [0.2.1] — 2026-09-27 — v0.2.0 verification fixes

### Web / probe / deploy

#### Security
- **Album-art uploads cannot exhaust music-web's memory (SEC-1).** `POST /api/uploads/art` now takes an in-flight slot (1 per member, 3 per process; `429 art_upload_in_progress` / `503 art_uploads_busy`) and runs the quota pre-check before reading any body byte; those refusals carry `Connection: close`. The body is read into one buffer of its `Content-Length` (required: `411 content_length_required`; still ≤ 5 MB + 64 KB) and the single multipart file part is parsed in place (`server/art/multipart.ts`) instead of through `Response.formData()` + `File.arrayBuffer()` (about four copies per request before). A body still incomplete after 120 s is `408 body_timeout`, a disconnect ends the read, and the slot is released in `finally`. Worst case about 15 MB of art bodies in flight.
- **Album-art caps (SEC-2).** Per member per rolling 24 h: 30 uploads and 50 MB (`429 art_daily_quota`); globally 512 MB of processing + ready art (`503 art_storage_full`). Art bytes (processing, and ready JPEGs kept 7 days, charged at the uploaded size) now count toward `maxStagingBytes` for both art and tus admissions, all under the one staging advisory lock; the art row is inserted by that locked admission before the raw file is written. New caps `artUploadsPerUserPerDay`, `artBytesPerUserPerDay`, `maxArtBytes` (admins may lower them; optional in the admin schema so older saved caps stay valid).
- **One metadata character rule (SEC-3).** `PATCH /api/items/:id` uses the edit-request rule (`requests/common.ts` `metaText`: NFC, trimmed, length counted after NFC, no `\p{Cc}` incl. `\n`/`\t`, no `\p{Cf}`, no U+2028/U+2029). A newline or tab accepted here used to fail finalize after approval (`bad_finalize_request`), and bidi / zero-width characters reached the on-air ID3. The probe's pre-fill (`probe/tags.ts` `clipTag`) turns controls and separators into a space, drops `\p{Cf}`, applies NFC and never cuts a surrogate pair, so an untouched pre-fill always finalizes.

#### Deploy
- **`MUSIC_APP_DB_PASSWORD` must be URL-safe (F1):** 24–128 characters of `[A-Za-z0-9_.-]`; `/`, `+` and `=` (base64) are refused because the same value goes into `DATABASE_URL`. Generate it with `openssl rand -hex 24`. **Upgrade note:** a deployment whose password contains `+` or `=` (which the URL tolerated) must rotate it in `migrate.env`, `web.env` and `worker.env` before this migrate step runs.
- **First boot cannot race initdb (F2):** the `music-db` healthcheck uses TCP (`pg_isready -h 127.0.0.1`), which the entrypoint's socket-only initdb server does not answer, and `music-migrate` retries its first connect for up to 60 s on "not reachable / starting up" errors only (a bad password or SQL error still fails at once).

## [0.2.0] — 2026-09-27 — Integrated portal: P3 ingest, P4 requests, UI, album art

One deployable build: the P2 foundation (0.1.1) with P3 (`feat/music-ingest`), P4 (`feat/music-requests`) and the UI (`feat/music-ui`) merged. P5 (SoundCloud) is not included. Where the branches overlapped, the foundation's version was kept.

### Added
- **Review and ingest (P3).** New-artist items (one per unknown main artist, created at submit) and their approval with a reviewer-confirmed folder from the strict sanitizer; `PATCH /api/items/:id` metadata overrides; `attestVersion` recorded with the attestation; year in the probe prefill. Approving a song enqueues `ingest`: artist gate → probe `finalize` (effective cover) → worker re-hash → scan window + pacing (≥ 90 s, ≤ 6/h) → path build + collision walk → upload → playlists → verify + snapshot → post-scan re-verify → `live`, with lost-row recovery. `library_cache` sync every 10 min (artist seeding, `station_playlist_ids`, `art_url`), per-item ticket posts (live / failed), the batch summary with `completed`, 7-day auto-close, final-file cleanup through the probe (`cleanup_final`), an optional Kuma disk push, and a behavioural `/files/batch` contract check.
- **Requests and library management (P4).** Edit and removal requests (one ticket each, `songedit` / `songremoval`, current → proposed card; `Music/Artists/<folder>/<file>` targets only, not archived; 10 per kind per day; one open per song and kind), request decisions and the new-artist approval an edit parks on; manager edits, playlist merges, archive and restore; admin settings (zod per key, caps only lowered) and role bindings. Worker jobs `apply_edit`, `apply_art`, `move`, `archive`, `restore`, `set_playlists` and `reverify`, never while the song is on air.
- **Album art.** `PUT`/`DELETE /api/items/:id/art` (`items.custom_art_id`, FK to `art_uploads`); edit requests may propose `artId`; managers set art directly; `apply_art` pushes the probe JPEG through the wrapper's `uploadArt` and verifies it. `/api/media/cover/:id` and the signed preview serve the effective cover (custom, else embedded). Art still referenced by an open item, request or queued `apply_art` job is kept.
- **UI.** Landing, denied, dashboard, submit (tus, per-song art prompt, the no-art list in the confirm dialog), batch detail, review queue and item, request review, library (browse, song, archived) with manager tools, admin; CSP-safe error pages.
- Migration `0003_integration` (generated from the merged schema on the foundation's 0002 snapshot).
- Harness: `MUSIC_TEST_TAG`, optional `MUSIC_TEST_WEB_PORT` (`test/compose.webport.yml`); `pnpm test:ui` (jsdom).

### Security
- One mutation-safety path for every AzuraCast-writing job: all P3/P4 kinds are in `MUTATING_JOB_KINDS`; handlers re-check the foundation's `assertQueuesNotPaused` right before writes and the wrapper's write gate refuses writes while paused; a paused job is parked without an attempt (P4 no longer fails a request on a pause). Waits use the foundation's age-bounded `RetryLater`.
- No branch reaches the raw AzuraCast transport; P3's own `setPlaylistsReply` (which bypassed the allowed-playlist-set check) is replaced by the foundation's.
- Decisions and reviewer edits require a batch submitted with the attestation (`BATCH_DECIDABLE_SQL` in every conditional UPDATE and in the review queue); drafts never reach the review surface, and reviewer duplicate hints skip other members' drafts.
- One scan-window / now-playing module and one recovery implementation (remaps every table incl. `ingest_runs`); an archived file is only re-linked during recovery.
- Art ids are UUIDs; art is read from the real `art_uploads` table (no raw-SQL guesses, no test stub tables); `apply_art` refusals from `uploadArt` (sha mismatch, missing JPEG) fail the request.
- `worker-egress` is pinned to 172.31.252.0/24, the subnet botvps's `efm-music-egress.service` DOCKER-USER guard matches.

### Changed
- The admin `rights_attestation.version` must pass the submit route's version check.
- The mock AzuraCast stays upstream-faithful; P3/P4 tests that relied on its old safety nets were adjusted in their setup.

## [0.1.1] — 2026-09-27 — P2 review fix round + album-art foundation

### Security
- AzuraCast wrapper: the transport is private; every metadata PUT (and art POST) resolves its media id and must target a `Music/Artists` file under the prefix; playlist batches must stay inside the caller's allowed set; `moveFile` refuses occupied destinations and missing sources itself and verifies the moved id (upstream `doMove` checks neither); the body sent is exactly the body validated; the base URL must be a bare origin; more canary stations, re-checked daily.
- The contract-drift pause is enforced (claim filter, per-job re-check, a write gate on every AzuraCast write) and the probe fails closed (`contract_unverified`, `self_check_failed`).
- review/manage/admin are never granted from membership older than 60 s (a stale submit-level viewer loses them; privileged checks fail closed with 503).
- Reviewers cannot decide items of an unsubmitted draft batch.
- The 1 GB per-member in-flight cap counts finished and undecided uploads; drafts expire after 7 days.
- Probe: parser process groups are killed as a whole, a post-job process-table check restarts the probe on any escapee, parsers get read-only private copies, and the probe no longer mounts all of `/staging`. Cover decoding is bounded (IHDR-first PNG, single-SOF JPEG, VP8 headers, 12 MP, `-max_pixels`, 224 MiB vmem, no swap).
- Ticket comments post as the author only when the tickets API allows it, and otherwise (or after `actor_forbidden`) post once as the integration with the author's name; dependency waits no longer spend job attempts; draft comments wait for submit.
- The body cap drains instead of cancelling (no unhandled AbortError, no reset keep-alive socket); rate limits bucket IPv6 per /64; `/api/auth/*` needs Content-Length; webhook sources are allowlisted and early deliveries are retried; `AUTH_URL` is required; path segments reject `\p{C}`, dot/space-only names and edge whitespace; the first reviewer seed must name a role.

### Added
- Album-art foundation (art contract): `art_uploads` + `library_cache.art_url`, `POST /api/uploads/art`, `GET /api/uploads/art/:artId`, signed `/api/media/art/:id`, the probe `art`/`art_release` requests, pinned `staging/art` + `staging/art-in` mounts, the wrapper's `uploadArt(mediaId, jpegPath, expectedSha256)` and `setPlaylistsReply`, the CSP `img-src https://euphoric.fm`, and mock AzuraCast art endpoints.

## [0.1.0] — 2026-09-27 — P2 portal core (security foundation)

### Added
- Next.js 15.5.26 / React 19.2.8 app (App Router, Tailwind 4 with the site's tokens), Drizzle + postgres-js, zod, Auth.js v5 with DATABASE sessions (7 days), `__Host-` cookies and OAuth tokens encrypted with AES-256-GCM (`APP_ENC_KEY`).
- Discord sign-in restricted to EFM guild members (`GET /users/@me/guilds/{g}/member`; a 404 or pending member is denied), with TTL re-checks (10 min for members, 60 s for review, manage and admin), session revocation on leave, 401 or a failed refresh, and a fallback to the tickets `GET /api/v1/members/:id`.
- The §3.1 data model with an append-only `audit_log` (trigger) and a least-privilege `music_app` runtime role. Reviewer roles are seeded once (EFM - Manager, Euphoric Board, EFM - Staff → review + manage); `admin` comes only from `PORTAL_OWNER_IDS`.
- CSRF (exact Origin + `Sec-Fetch-Site: same-origin`), nonce CSP, HSTS, nosniff, `Referrer-Policy: same-origin`, a 1 MB body cap, and rate limits keyed on `cf-connecting-ip`.
- The authz matrix as `requirePermission` plus ownership predicates, and conditional state transitions that return 409 on a race.
- tus uploads (35 MB, 8 MB chunks, an owner check on every method, per-user and global caps, a disk pause) with retention sweeps.
- A network-less `music-probe` (magic bytes, ID3 pre-scan, forced-mp3 ffprobe, music-metadata child, cover → JPEG, sha256) and `finalize`. The inbox-typed spool protocol has pinned mounts.
- The path builder with every §3.5 assertion and a flushCache collision walk.
- The AzuraCast wrapper: allowlist, station guard, `MUSIC_PROFILE`/`STATION_ID=1`/`PORTAL_TEST_PREFIX` guard, a start-up key self-check (station 1 → 200, station 7 → 403), and a contract drift probe against the P0d baseline. The P0d-B contracts are built in.
- The tickets Integration API client (worker) and the signed webhook receiver at `/api/hooks/tickets`.
- `compose.yml` (project `efm-music`) and the Dockerfile targets `web`, `worker`, `probe`, `fetch` (stub) and `test`.
- A Docker-only test harness (`test/run.sh`) with mocks for Discord, the tickets API and AzuraCast: 160 vitest tests, plus mount and start-up-guard checks.
