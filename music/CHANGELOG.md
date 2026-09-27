# Changelog — EFM Music Portal (`music/`)

## [Unreleased] — P4 requests and library management

### Added
- Edit and removal requests (`request`): `POST /api/requests`, list/get, withdraw; one ticket each (`songedit` / `songremoval`) with a current → proposed card; targets only `Music/Artists/<folder>/<file>` in `library_cache`, not archived; 10 edits and 10 removals per member per day; one open request per song and kind.
- Review (`review`): `POST /api/requests/:id/decision` (409 on a race, deny needs a reason) and `POST /api/requests/artists/:id/decision` for the new-artist approval an edit is parked on.
- Manager actions (`manage`), each queued for the worker and audited: `PATCH /api/library/:mediaId`, `PUT /api/library/:mediaId/playlists` (merge), `POST /api/library/:mediaId/archive`, `POST /api/archive/:id/restore`, `GET /api/archive`.
- Admin (`admin`): `PUT /api/admin/settings` (zod schema per key; caps can only be lowered), `POST /api/admin/role-bindings`, `DELETE /api/admin/role-bindings/:id`. Seeded `playlist_names`, `rights_attestation`, `discord_invite_url`.
- Worker jobs `apply_edit`, `move`, `archive`, `restore`, `set_playlists`, `reverify` (post-scan, with lost-row recovery) and the request ticket posts. Moves run only inside the scan window and never while the song is playing or next; waiting does not spend attempts; `queues_paused` is re-checked before each write.
- Album art (art contract): edit requests accept `proposed.artId` (a ready upload of the member's own; the card says "New album art proposed"); manager `PUT /api/library/:mediaId/art {artId}`; worker `apply_art` (snapshot with had_art / old art hash, `uploadArt`, verify `art_updated_at`, ticket post; scan window and `queues_paused`), run after `apply_edit` and any move. `art_uploads` and `uploadArt` are stubbed until the foundation lands them.
- Migration `0002_p4_requests` (requests: snapshot, deny_reason, error, pending_artist_id, applied_at; media_snapshots: had_art, art_sha256). Web accepts an optional `PORTAL_TEST_PREFIX`.
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
