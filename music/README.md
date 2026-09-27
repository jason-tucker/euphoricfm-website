# EFM Music Portal (`music/`)

`https://music.euphoric.fm`: members of the EuphoricFM Discord server submit music and file edit or removal requests, and staff review them. Each batch or request becomes a ticket through the euphoric-tickets Integration API. Approved songs are finalized by the network-less probe and ingested into AzuraCast station 1; approved edits, moves, archives, restores and album art are applied there by the worker.

The design contract is the vault plan **"EFM Music Portal — Plan"** (v3.2, with its changelog amendments) and the album-art contract of 2026-09-27. This directory is the **integrated v0.2.0**, plus WAV uploads (v0.3.0, see [WAV uploads](#wav-uploads-v030)):

- **P2 foundation** (auth, CSRF, headers, authz, tus, probe, path builder, the AzuraCast wrapper, album-art uploads) with its fix round;
- **P3** review and ingest (decisions, new artists, the ingest pipeline with post-scan re-verify and lost-row recovery, library sync, ticket posts, batch summary, auto-close);
- **P4** requests and library management (edit/removal requests, manager edits, playlist merges, archive/restore, `apply_art`, admin settings and role bindings);
- the **UI** (every page).

**P5** (SoundCloud fetch, the site entry) is not in this build: `music-fetch` is still a stub.

This is a separate package from the Astro site. It has its own `package.json`, `pnpm-lock.yaml`, Dockerfile and compose project (`efm-music`). The site build ignores `music/` (see the root `tsconfig.json` and `.dockerignore`).

## Containers

| Service | Image target | Networks | Holds |
|---|---|---|---|
| `music-web` | `web` (Next.js 15.5 standalone) | `music-int`, `efm-music-hooks` (external) | `web.env`: Auth.js, the Discord app, `APP_ENC_KEY`, the tickets **guild:read** key and the webhook secret. **No AzuraCast key and no `tickets:*` key.** It refuses to start if it sees either. |
| `music-worker` | `worker` | `music-int`, `efm-public-net` (external), `worker-egress` (172.31.252.0/24) | `worker.env`: the AzuraCast key and the tickets write key. It refuses to start if it sees web secrets. It runs the job queue and the periodic duties (library sync, batch summaries, auto-close, final-file cleanup, disk push, the batch contract check, parked-request sweep). |
| `music-probe` | `probe` (ffprobe/ffmpeg/rsvg-convert, music-metadata, node-id3) | `network_mode: none` | Nothing. It has no env_file and refuses secret-like env. |
| `music-db` | `postgres:16-alpine` | `music-int` (internal) | `db.env` |
| `music-migrate` | `worker` (`node migrate.mjs`), one-shot | `music-int` | `migrate.env`: the owner URL, the `music_app` password and `SEED_REVIEW_ROLE_IDS` |
| `music-init` | `worker` (`init-dirs.sh`), one-shot, root, no network | none | Nothing |
| `music-fetch` | `fetch`, a **stub** until P5 | not in compose | |

Every service runs as uid 1000 with a read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, `init: true`, a hard `mem_limit` and a Node heap cap. Watchtower is **off**.

The web service is published only on `127.0.0.1:6096`. The Cloudflare tunnel sends `music.euphoric.fm` there, and the edge must answer 404 for `^/api/hooks/`.

### Pinned mounts

These are the plan's §3 mounts, from `${MUSIC_DATA_DIR:-./data}`:

| Container | Mount |
|---|---|
| web | `staging/uploads` rw (tus), `staging/art-in` rw (raw album art), `staging/art` **ro**, `spool/probe/in-web` rw, `spool/probe/out` **ro** |
| worker | `staging/final` **ro**, `staging/art` **ro**, `spool/probe/in-worker` rw, `spool/fetch/in` rw, `spool/probe/out` **ro**, `spool/fetch/out` **ro** |
| probe | `staging/uploads`, `staging/final`, `staging/work`, `staging/art` rw, `staging/art-in` **ro** (not `staging/fetch`), `spool/probe` rw |

The probe also enforces **which request types each inbox may carry**:

- `in-web` may carry `probe`, `art` and `art_release` only.
- `in-worker` may carry `finalize`, `cover`, `probe_fetch` and `cleanup_final` (the worker's mount of `staging/final` is read-only, so the probe deletes finalized files 7 days after they went live or failed).

Every result records the inbox it came from.

`test/run.sh` proves the mount rules on the real compose definitions:

- web cannot see `in-worker`, and cannot write `out`, `final` or `art`;
- the worker cannot write `final`, `out` or `art`, can read `art`, and cannot see `uploads` or `art-in`;
- the probe has no network and cannot write `art-in`.

## Security model

For each control, the table gives the plan section and the code that implements it.

| Control | Plan | Code |
|---|---|---|
| Discord OAuth (`identify guilds.members.read`), database sessions (7 d), `__Host-` cookies, tokens encrypted with AES-256-GCM (AAD = provider:account:column) | §3.1, §3.2 | `src/server/auth/config.ts`, `auth/tokens.ts`, `crypto.ts` |
| Guild gate: a 404 or `pending` member is denied. Re-checks after 10 min (member) and 60 s (review/manage/admin). A 404 or 401 on re-check, a pending member, or a failed refresh **deletes all sessions**. Fallback is `GET /api/v1/members/:id` with the web guild:read key. | §3.2 | `src/server/auth/membership.ts` |
| `admin` comes only from `PORTAL_OWNER_IDS`. Reviewer roles come from `role_bindings`, seeded once from `SEED_REVIEW_ROLE_IDS`. | §3.1, §3.3 | `authz/permissions.ts`, `migrate/main.ts` |
| `requirePermission` plus ownership predicates on every route. Not-owned rows return 404. Transitions are conditional UPDATEs, and a lost race returns **409**. | §3.3 | `authz/viewer.ts`, `authz/predicates.ts`, `authz/transitions.ts`, `submissions.ts` |
| CSRF: unsafe methods need `Origin: https://music.euphoric.fm` **and** `Sec-Fetch-Site: same-origin`. The only exemption is the exact path `/api/hooks/tickets`. Checked in middleware **and** again in every handler. | §3.2 | `http/csrf.ts`, `middleware.ts`, `http/route.ts`, the tus route |
| A nonce CSP (exactly the plan's directives), HSTS, nosniff, `Referrer-Policy: same-origin`. Media gets `sandbox`. | §3.2 | `http/csp.ts`, `middleware.ts`, `next.config.ts` |
| 1 MB body cap on everything except tus (declared length and a streamed count). Rate limits keyed on `cf-connecting-ip`: 20/min on `/api/auth/*`, 30/min on mutations. | §3.2 | `http/body.ts`, `http/ratelimit.ts` |
| tus: Upload-Length 1 B to 35 MB, or to 250 MB (`caps.maxWavUploadBytes`, admin-lowerable) when the creation's Upload-Metadata **declares** `filetype` audio/wav (x-wav, wave, vnd.wave); missing, malformed or repeated metadata counts as MP3. The probe caps again by the **actual** type, so the effective limit is the stricter of the two. Defer-length, concatenation and creation-with-upload are off. Chunks are capped at 8 MB. The **DB owner is checked on every method**, and client metadata is discarded. GET is never served. Caps are 1 GB in flight and 3 concurrent uploads per user, and 5 GB globally. Uploads pause above 85 % disk. Retention runs on a timer. | §3.4 | `uploads/caps.ts`, `uploads/tus.ts`, `uploads/retention.ts`, `app/api/uploads/*` |
| Probe checks, in order: magic bytes (plus a second-frame check), then ID3 ≤5 MB with no compressed or encrypted frames, then `ffprobe -f mp3 -protocol_whitelist file,pipe -threads 1` under `timeout` + an address-space limit (`prlimit --as`, no shell), then music-metadata in a heap-capped child. Covers are re-encoded to a JPEG ≤1000 px, with raster dimensions bounded first and SVG rasterised. Then sha256 and `finalize`. A `RIFF....WAVE` input takes the WAV path instead (below). A rejected upload's bytes are deleted by the probe at once (`released`) and released from the staging quota by the worker. | §3.4 | `src/probe/*` |
| WAV (v0.3.0): type by magic bytes only (RF64/BW64/RIFX refused); a bounded RIFF walk in JS before any parser (every chunk inside the RIFF and the RIFF inside the file, ≤64 KiB trailing, ≤64 chunks, one `fmt ` before one `data`, LIST ≤1 MiB with INFO items tiling it exactly, other chunks ≤16 MiB, an `id3 ` chunk through the MP3 ID3 pre-scan); PCM only (`pcm_u8/s16le/s24le/s32le/f32le/f64le`, incl. WAVE_FORMAT_EXTENSIBLE with the PCM/float GUID; ADPCM, MP3-in-WAV, A-law, GSM … refused), 1–8 channels, 8–192 kHz, 30 s – 15 min; `ffprobe -f wav` must agree with the header; music-metadata reads LIST/INFO + `id3 ` (same `clipTag`, same cover path); `nice -n 19 ffmpeg -f wav … -c:a libmp3lame -b:a 320k` under prlimit (256 MiB AS) + timeout (300 s), 1 thread; the MP3 is checked like an upload (magic, `ffprobe -f mp3`, 320 kbps, duration ±1 s, ≤35 MB) and replaces the WAV under the upload id. | v0.3.0 | `src/probe/wav.ts`, `src/probe/probe.ts` |
| Probe containment: each parser child is its own process group and the **whole group** is SIGKILLed on timeout, on output overflow and as soon as the child exits; the parsers get a per-job private work dir with a read-only (0400) copy of the input; the probe mounts only `staging/{uploads,final,work}` and `spool/probe`. After **every** job the probe compares the process table with its start-up baseline (tini + itself): any other live process (e.g. a `setsid` escapee) is killed, the job's result is replaced by `containment_breach`, and the probe exits so Docker restarts the container and the kernel tears down its PID namespace. **Residual:** parsers still run as the probe's uid, so *during* a job (≤ ~45 s; a WAV conversion job up to ~6 min, measured 14–26 s for the largest inputs on one vCPU) a compromised parser can write what the probe can write (`staging/final`, `spool/probe/out`, other staged uploads) and could `ptrace`/signal the probe loop. Closing that needs a second uid (CAP_SETUID/SETGID in the probe, today `cap_drop: ALL` + `no-new-privileges`) or Landlock (ENOSYS on the test host; botvps unverified), i.e. a separate parse-only container. A `docker exec` into the probe container also counts as a stray and restarts it after the next job. | §3.4, §8 | `src/probe/exec.ts`, `src/probe/containment.ts`, `src/probe/main.ts` |
| Path builder: every destination and source assertion, the collision walk ` (2)`…` (9)`, and the `Portal-Test/` root. | §3.5 | `paths/builder.ts` |
| Decisions: a reviewer may decide (or edit the metadata / art of) an item only once its batch was **submitted with the rights attestation**: `assertBatchDecidable` for the readable 409, `BATCH_DECIDABLE_SQL` inside every conditional UPDATE and in the review queue, so an unsubmitted draft never shows up to reviewers. Approving a song copies the **probe-time** sha256 and enqueues `ingest`; approving a `new_artist` item creates the artist with a folder from the strict sanitizer (or links an existing one) and ungates the batch's songs. Public comments on a draft wait for submit. | §3.3, §3.4 | `submissions.ts`, `library/artists.ts`, `ui/queries.ts` |
| Mutation safety: every AzuraCast-writing job kind is in `MUTATING_JOB_KINDS` (`ingest`, `ingest_verify`, `move`, `archive`, `restore`, `apply_edit`, `apply_art`, `set_playlists`, `recovery`, `reverify`, `reconcile_archive`). While `settings.queues_paused` is set (contract drift, an unverifiable spec, a failed key self-check, a behavioural batch drift, or an operator) they are not claimed, every handler re-checks `assertQueuesNotPaused` right before its writes, and the wrapper's write gate refuses every write. A paused job is parked without spending an attempt. Waits (scan window, on air, pacing, a ticket not open yet) throw `RetryLater`: no attempt is spent, bounded by the job's age. | §3.7 | `pause.ts`, `worker/main.ts`, `worker/handlers.ts` |
| Scan window (one module for ingest and P4): a mutation may start only when `now ≥ :x1 + scan_end_offset_s + 20 s` and `now + 30 s < :x6` (clock only, the accepted residual); a misconfigured offset holds and alerts. Moves, archives and restores also wait while the song is now playing or playing next. Ingest is serial: ≥ 90 s apart and ≤ 6 per hour. | §3.7, P0d-A | `worker/ingest/window.ts` |
| Ingest: artist gate → `finalize` in the probe (verifies `approved_sha256`, strips and re-tags, embeds the **effective cover**: custom art, else the embedded cover) → the worker re-hashes `final.mp3` → window + pacing → path build and collision walk → `POST /files` (re-hashed in the wrapper) → playlists (assignable ∩ station ids) → GET verify and snapshot → `verifying` → a re-verify after the next two scans → `live`, or recovery. | §3.7 | `worker/ingest/pipeline.ts` |
| Lost-row recovery (ingest and P4 re-verify share it): poll by path (≥ 3 cycles and ≥ 20 min), then the snapshot **metadata** first and the snapshot playlists, then remap the media id in `library_cache`, `items`, `requests`, `archive`, `media_snapshots`, `ingest_runs` and queued jobs' payloads, and alert. A re-verify re-applies only while its snapshot is the media's latest APPLIED one (the `after_*` snapshot of a newer portal mutation supersedes it; a failed operation's `before_*` snapshot never does, and recovery never re-applies one) and re-adds missing playlists by merge. An archived file (`Removed/<id>/`) is only re-linked. | §3.7 | `worker/library/recovery.ts` |
| Requests and library management: targets only `Music/Artists/<folder>/<file>` rows of `library_cache` that are not archived; one open request per song and kind, 10 per kind per day; `proposed` is strict `{title?, artist?, album?, genre?, artId?}` (a ready art upload of the member's own). Manager edits, playlist merges (memberships outside the assignable set are kept; foreign-station ids are never sent), archive (refused up front if the song is in an Events playlist; an `archiving` row with the snapshot first, then `playlists:[]`, verify zero station memberships, move to `Removed/<media_id>/`; resumable from where the file really is, with the Events refusal repeated on a resume, and the playlists are re-applied only if it verifiably did not move) and restore (exact recorded paths, snapshot playlists merged; resumable via `restoring`) are queued for the worker and audited. While a song has an `archiving` / `restoring` row every other mutation of it (edit, move, playlists, art, re-verify and ingest-verify repairs) waits; the `reconcile_archive` job (a 10-minute sweep, for rows untouched for 30 min with no queued or running archive/restore job, or a manager's **Resolve** / **Restore** under Archived songs) finishes an archive whose file reached `Removed/<id>/`, rolls back one whose file is still in the library, puts a restore that never moved the file back to `archived`, finishes one whose file is back, and alerts with the paths on anything else. An edit that changes the main artist to an unknown one parks on a new-artist approval. | §3.3, §3.5, §3.7 | `requests/*`, `worker/requests/*` |
| Admin: settings have a zod schema per key (caps can only be lowered; the attestation version must pass the submit check); role bindings are admin-only and audited; `admin` itself comes only from `PORTAL_OWNER_IDS`. | §3.1, §3.3 | `admin/settings.ts` |
| AzuraCast wrapper: the raw transport is **private** (tests use the `TEST_SEND` seam, which runs the same checks and refuses outside vitest). Every request passes an async `validate()`: an allowlist of (method, path template, query, body schema); `sid == STATION_ID`; the profile guard re-asserted on every call; the prefix guard on every write; **every** metadata PUT first GETs its id and requires the prefix and the `Music/Artists/<folder>/<file>` pattern; a playlist batch must carry the caller's allowed id set and stay inside it. `delete`, `queue`, `immediate`, `reprocess`, any other `do`, a non-empty `dirs`, `path` or `playlists` in a file PUT, and string playlist ids are all refused. The self-check expects station 1 → 200 and station 7 → 403. The contract drift probe compares against the P0d baseline. | §3.7 and amendments | `azuracast/client.ts`, `azuracast/guard.ts`, `azuracast/contract.ts` |
| Album art (contract 2026-09-27): `POST /api/uploads/art` (multipart, exactly one `art` file, ≤5 MB, JPEG/PNG/WebP by magic bytes, never SVG/GIF; header dims ≤12 MP and a complete file checked before spooling) → 202 `{artId}`; `GET /api/uploads/art/:artId` (uploader or `review`, else 404) → `processing`/`ready`/`rejected` + a signed 5-min `previewUrl` (`/api/media/art/:id`, `image/jpeg`, nosniff, `CSP: sandbox`). Raw bytes live in `staging/art-in` (web rw); the probe alone writes `staging/art/<artId>/cover.jpg` (web + worker ro), a ≤1000 px baseline JPEG under the same decode bounds as embedded covers; the web re-hashes it before recording `jpeg_sha256`. Unreferenced art expires after 7 days (the probe deletes the JPEG on an `art_release` request). The worker's `uploadArt(mediaId, jpegPath, expectedSha256)` reads only `<STAGING_ART_DIR>/<uuid>/cover.jpg` (no symlinks), re-hashes it, and posts it through `validate()` (the media id must be a `Music/Artists` file under the prefix; write gate; station). | contract | `server/art/*`, `app/api/uploads/art/*`, `app/api/media/art/*`, `probe/art.ts`, `azuracast/client.ts` |
| Album art on songs: `PUT`/`DELETE /api/items/:id/art` (owner while the batch is a draft, a reviewer while the item is pending in a submitted batch; the upload must be the viewer's own and ready) sets `items.custom_art_id` (FK to `art_uploads`, `ON DELETE SET NULL`). `/api/media/cover/:id` and the signed preview serve the **effective cover** with the same session, owner-or-review predicate and viewer-bound signature. Edit requests may propose art; managers set it directly (`PUT /api/library/:mediaId/art`); the worker's `apply_art` snapshots, runs `uploadArt` and verifies `art_updated_at` moved. Art referenced by an open item, request or queued `apply_art` job is kept. | contract | `submissions.ts`, `media/cover.ts`, `requests/*`, `worker/requests/jobs.ts`, `art/retention.ts` |
| The tickets client (worker only) never forwards a staff comment. The webhook receiver enforces ±300 s, HMAC over the raw bytes checked with `timingSafeEqual` **before** parsing, delivery-id dedupe in the same transaction, and anchoring only within the ticket's own batch. | §3.1, §4.5 | `tickets/client.ts`, `hooks/*` |
| `audit_log` is append-only by trigger. Web and worker connect as the **non-owner** `music_app` role (DML only; `audit_log` is SELECT + INSERT only). | §3.1 | `drizzle/0001_audit_append_only.sql`, `migrate/main.ts` |

### Worker profile guard, as amended

| Setting | Rule |
|---|---|
| `MUSIC_PROFILE` | Required; `prod` or `test`. |
| `STATION_ID` | Must be `1` in **both** profiles. |
| `PORTAL_TEST_PREFIX` (e.g. `Portal-Test/`) | Optional in `prod`, and set for the first live verifications. Required in `test`. When it is set, every write path must start with it. A metadata PUT (which names only an id) first GETs the id and checks its path. |

The worker refuses to start on any violation. It also refuses to start if the key can read the canary station (7).

## WAV uploads (v0.3.0)

Members may upload a WAV instead of an MP3 (WAV only: no FLAC, AIFF or M4A). The probe converts it, in its network-less container, to a **CBR 320 kbps MP3** (libmp3lame): 44.1 and 48 kHz are kept, multiples of 48 kHz (96, 192 kHz) become 48 kHz and every other rate 44.1 kHz; more than two channels are downmixed to stereo, mono stays mono. The MP3 **replaces the WAV** under the same upload id (tmp file + rename, then re-hashed), so the item's source, the preview, finalize (ID3 + APIC), the AzuraCast upload, the library and edit/remove requests are unchanged; the WAV never leaves the probe and never reaches AzuraCast. The item records `input_format = 'wav'` and the UI shows "Converted from WAV (320 kbps MP3)".

- **Sizes.** A WAV may be up to 250 MB (`caps.maxWavUploadBytes`, admins may lower it; the page, the tus admission and the probe request all use the loaded value, and the compiled 250 MB is the ceiling). An MP3 stays at 35 MB. The tus creation is capped by the type it **declares** (Upload-Metadata `filetype`, sent by the submit page from the file's name / MIME type); the probe caps again by the type the **bytes** show (an MP3 declared as a WAV and over 35 MB is refused `mp3_too_large`; a WAV declared as an MP3 can only be ≤35 MB and is converted). A name or declared type never decides the format.
- **Duration.** A WAV may be 30 s to **15 min** (MP3: 20 min): a 320 kbps MP3 of 15 min is ~36.0 MB, the most that still fits the 35 MiB per-file cap that finalize and the worker's final-file cap are sized for. Longer songs must be uploaded as MP3.
- **Staging quota.** A WAV is charged at its full length (per-user in-flight and global `maxStagingBytes`) until the worker collects the probe result, which re-charges the upload row at the MP3's size; a rejected upload's bytes are deleted by the probe and the upload marked `expired`. While a WAV is being probed the probe's private copy in `staging/work` (up to 250 MB + the MP3) is on the same disk but not in the quota; the probe runs one job at a time, so that is bounded by one WAV.
- **Cost on botvps.** Measured with the real probe image under the compose limits plus `--cpus 1` (2.1 GHz Xeon E5-2620 v4 core): a 250 MB 24-bit/96 kHz WAV (7.6 min) takes 19.5 s end to end (ffmpeg 13.7 s), a 151 MB 16-bit/44.1 kHz WAV of 15 min (the longest encode) 26.2 s (ffmpeg 22.3 s); ffmpeg's peak RSS is ~40 MiB and the cgroup's anonymous memory peaks at ~34 MiB (page cache fills the rest of the 256 MB limit and is reclaimed, no OOM). ffmpeg runs at nice 19, so the Discord bots keep the CPU when they need it; the probe processes nothing else during a conversion.

## Database migrations

`drizzle/` holds `0000_init`, `0001_audit_append_only` (the append-only trigger, hand-written), `0002_foundation_art` (album-art uploads) and `0003_integration` (P3 + P4, generated by drizzle-kit from the merged `schema.ts` on the 0002 snapshot: `ingest_runs`, `batches.attest_version`, `items.custom_art_id` with its FK, the P4 request and snapshot columns). `music-migrate` applies them as the owner, then (re)grants `music_app`. `schema.ts` and the migrations are equivalent (drizzle-kit `generate` reports no changes; a migrated database matches one built from `schema.ts` column for column, apart from the 0001 triggers). drizzle-kit `push` always proposes re-setting the five `'{}'::int[]` / `'{}'::text[]` array defaults: that is a drizzle-kit comparison artefact that does not converge and was already present at 0002, not drift. Later releases add `0004_v021_worker`, `0005_v022_archive_reconcile` and `0006_v030_wav_input` (`items.input_format`, generated by drizzle-kit from `schema.ts`).

## Deploy (botvps, as botuser)

```sh
cd <checkout>/music
cp env/*.env.example env/        # then rename each to *.env, fill in, chmod 600
cp .env.example .env              # MUSIC_TAG=<git short sha>, MUSIC_DATA_DIR=./data
docker compose -p efm-music up -d
```

- **Roll back:** set the previous `MUSIC_TAG`, then `up -d`.
- **Images:** CI pushes `ghcr.io/jason-tucker/euphoricfm-website-music:{web,worker,probe}-<sha7>` and `-latest`. Only images that passed `test/run.sh` are pushed.
- **Networks:** `efm-music-hooks` must exist first. The main session creates it at P1-net/Deploy-1:

  ```sh
  docker network create --subnet 172.31.250.0/24 efm-music-hooks
  ```

  `efm-public-net` already exists.

### DOCKER-USER egress rules (applied on botvps by `efm-music-egress.service`, not by this repo)

`compose.yml` pins `worker-egress` to **172.31.252.0/24** (a plain bridge, not internal). On botvps the persistent systemd unit **`efm-music-egress.service`** installs the DOCKER-USER guard for that fixed subnet, and for **172.31.251.0/24** (`fetch-egress`, P5): traffic from those subnets to RFC1918 (10/8, 172.16/12, 192.168/16), 169.254.0.0/16 (cloud metadata) and 100.64.0.0/10 (CGNAT / Tailscale) is dropped, with established return traffic allowed first. This repo does not apply or persist any iptables rule.

- Change the `worker-egress` subnet only together with that unit; otherwise the worker runs without the guard.
- The worker reaches tickets-web over `efm-public-net`, whose traffic stays on its own bridge and is not affected.
- The test harness (`test/compose.test.yml`) overrides `worker-egress` without a fixed subnet, so a test stack never takes the production range.

## Tests

Everything runs in Docker; the host needs no Node.

```sh
sh music/test/run.sh
```

- `KEEP=1` leaves the stack up; `DOCKER_COMPOSE` overrides the compose command.
- `MUSIC_TEST_PROJECT=<name>` (default `efm-music-test`) isolates parallel runs from different worktrees: compose project, networks, and the test and runtime image tags. `MUSIC_TEST_TAG` overrides the runtime image tag.
- The test web has no host port. `MUSIC_TEST_WEB_PORT=<port>` publishes it on `127.0.0.1:<port>` for a browser (through `test/compose.webport.yml`).

The harness builds the images, starts Postgres, the mocks and the real containers (the worker runs its real job loop against the mocks), and then runs:

- `vitest` (unit, DB and e2e for every phase: foundation, ingest, requests, UI page smoke);
- the mount checks;
- the worker start-up refusals.

Finally it prints idle `docker stats`. The web's own retention sweeper is off in the harness (`MUSIC_DISABLE_SWEEPER=1`), because the retention tests call it directly.

The UI component and route tests run without the stack (jsdom): `pnpm test:ui` (`vitest.ui.config.ts`).

The mocks in `test/mocks/server.mjs` stand in for Discord OAuth and the member API, the tickets Integration API, AzuraCast (per the P0d and P0d-B contracts, **upstream-faithful**: a batch skips a missing source silently and a move overwrites an occupied destination, so the wrapper's own checks are what the tests exercise), and an egress canary. Controls cover seeding, per-record batch errors, the next move failing, a lost or dropped row, now-playing, drift, and art uploads. **No production credential is used anywhere in the tests.**

## Pages and client notes

- Pages: landing and denied, dashboard (own batches and requests), submit, batch detail, review queue and item, request review, library (browse, song, archived), admin.
- Import server helpers only from server components, route handlers and server actions.
- **CSP:** there is no `'unsafe-inline'`: no inline `<script>` and no `style={{…}}` attributes. Next stamps the nonce on its own scripts. `img-src` allows `https://euphoric.fm` for AzuraCast's public art (`library_cache.art_url`).
- Mutations from the browser are same-origin `fetch` or forms, which send `Origin` and `Sec-Fetch-Site` automatically.
- Preview audio and cover URLs come from `GET /api/items/:id/preview`: signed, 5 minutes, bound to the viewer. The cover is the effective one.
- **tus client:** `endpoint: '/api/uploads'`, `chunkSize: 8 * 1024 * 1024`, `metadata: { filetype: 'audio/wav' | 'audio/mpeg' }` (the declared type the server caps by), and **no** `uploadDataDuringCreation`. Then `POST /api/batches/:id/items {uploadId}`.
- **Album art:** `POST /api/uploads/art` with a `FormData` holding one file field `art`; poll `GET /api/uploads/art/:artId` until it leaves `processing` (`ready` → `previewUrl`; `rejected` or `expired` → `reason`), then attach the id.
