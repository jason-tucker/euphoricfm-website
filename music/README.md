# EFM Music Portal (`music/`)

`https://music.euphoric.fm`: members of the EuphoricFM Discord server submit music and file edit or removal requests, and staff review them. Each batch or request becomes a ticket through the euphoric-tickets Integration API. Approved songs are finalized by the network-less probe and ingested into AzuraCast station 1; approved edits, moves, archives, restores and album art are applied there by the worker.

The design contract is the vault plan **"EFM Music Portal — Plan"** (v3.2, with its changelog amendments) and the album-art contract of 2026-09-27. This directory is the **integrated v0.2.0**, plus WAV uploads (v0.3.0, see [WAV uploads](#wav-uploads-v030)):

- **P2 foundation** (auth, CSRF, headers, authz, tus, probe, path builder, the AzuraCast wrapper, album-art uploads) with its fix round;
- **P3** review and ingest (decisions, new artists, the ingest pipeline with post-scan re-verify and lost-row recovery, library sync, ticket posts, batch summary, auto-close);
- **P4** requests and library management (edit/removal requests, manager edits, playlist merges, archive/restore, `apply_art`, admin settings and role bindings);
- the **UI** (every page).

**P5** (v0.4.0): members can also add a song from a **SoundCloud link**; `music-fetch` downloads it and the probe converts it (see [SoundCloud links](#soundcloud-links-v040)).

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
| `music-fetch` | `fetch/` (own Dockerfile: Python stdlib + hash-locked yt-dlp on a digest-pinned base; target `runtime`) | `fetch-egress` only (172.31.251.0/24, bridge `br-efm-fetch`) | Nothing: no env_file, no environment (it exits 78 on any unexpected variable name), no database, no port. One job at a time. |

Every service runs as uid 1000 with a read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, `init: true`, a hard `mem_limit` and a Node heap cap. Watchtower is **off**.

The web service is published only on `127.0.0.1:6096`. The Cloudflare tunnel sends `music.euphoric.fm` there, and the edge must answer 404 for `^/api/hooks/`.

### Pinned mounts

These are the plan's §3 mounts, from `${MUSIC_DATA_DIR:-./data}`:

| Container | Mount |
|---|---|
| web | `staging/uploads` rw (tus), `staging/art-in` rw (raw album art), `staging/art` **ro**, `spool/probe/in-web` rw, `spool/probe/out` **ro** |
| worker | `staging/final` **ro**, `staging/art` **ro**, `spool/probe/in-worker` rw, `spool/fetch/in` rw, `spool/probe/out` **ro**, `spool/fetch/out` **ro** |
| probe | `staging/uploads`, `staging/final`, `staging/work`, `staging/art` rw, `staging/art-in` **ro**, `staging/fetch` **ro** (v0.4.0), `spool/probe` rw |
| fetch | `spool/fetch` rw (`in`, its own `claimed`, `out`), `staging/fetch` rw. Nothing else. |

The probe also enforces **which request types each inbox may carry**:

- `in-web` may carry `probe`, `art` and `art_release` only.
- `in-worker` may carry `finalize`, `cover` (reserved, answered `not_implemented`), `probe_fetch` (v0.4.0: convert a SoundCloud download) and `cleanup_final` (the worker's mount of `staging/final` is read-only, so the probe deletes finalized files 7 days after they went live or failed).

Every result records the inbox it came from.

`test/run.sh` proves the mount rules on the real compose definitions:

- web cannot see `in-worker`, and cannot write `out`, `final` or `art`;
- the worker cannot write `final`, `out` or `art`, can read `art`, and cannot see `uploads` or `art-in`;
- the probe has no network and cannot write `art-in`;
- (v0.4.0) the probe can read but not write `staging/fetch`; the worker cannot see it, can write `spool/fetch/in` and cannot write `spool/fetch/out`; web sees neither; music-fetch sees nothing but its spool and staging dir, has a read-only rootfs, has no network in the test stack, and refuses an unexpected env var (exit 78, name only).

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
| tus: Upload-Length 1 B to 100 MB (`caps.maxMp3UploadBytes`, admin-lowerable; v0.3.5), or to 250 MB (`caps.maxWavUploadBytes`, admin-lowerable) when the creation's Upload-Metadata **declares** `filetype` audio/wav (x-wav, wave, vnd.wave); missing, malformed or repeated metadata counts as MP3. The probe caps again by the **actual** type, so the effective limit is the stricter of the two. Defer-length, concatenation and creation-with-upload are off. Chunks are capped at 8 MB. The **DB owner is checked on every method**, and client metadata is discarded. GET is never served. Caps are 1 GB in flight and 3 concurrent uploads per user, and 5 GB globally. Uploads pause above 85 % disk. Retention runs on a timer. | §3.4 | `uploads/caps.ts`, `uploads/tus.ts`, `uploads/retention.ts`, `app/api/uploads/*` |
| Probe checks, in order: magic bytes (plus a second-frame check), then ID3 ≤5 MB with no compressed or encrypted frames, then `ffprobe -f mp3 -protocol_whitelist file,pipe -threads 1` under `timeout` + an address-space limit (`prlimit --as`, no shell), then music-metadata in a heap-capped child. Covers are re-encoded to a JPEG ≤1000 px, with raster dimensions bounded first and SVG rasterised. Then sha256 and `finalize`. A `RIFF....WAVE` input takes the WAV path instead (below). A rejected upload's bytes are deleted by the probe at once (`released`) and released from the staging quota by the worker. | §3.4 | `src/probe/*` |
| WAV (v0.3.0): type by magic bytes only (RF64/BW64/RIFX refused); a bounded RIFF walk in JS before any parser (every chunk inside the RIFF and the RIFF inside the file, ≤64 KiB trailing that is all zero or chunks under the same rules (ffmpeg reads to EOF), a size of 0 / 0xFFFFFFFF refused as `wav_unfinalized`, ≤64 chunks, one `fmt ` before one `data`, LIST ≤1 MiB with INFO items tiling it exactly, other chunks ≤16 MiB, an `id3 ` chunk through the MP3 ID3 pre-scan, holding exactly one tag + zero padding and no ID3 header where ffmpeg would look for a next tag); PCM only (`pcm_u8/s16le/s24le/s32le/f32le/f64le`, incl. WAVE_FORMAT_EXTENSIBLE with the PCM/float GUID; ADPCM, MP3-in-WAV, A-law, GSM … refused), 1–8 channels, 8–192 kHz, 30 s – 24 min (v0.3.5); `ffprobe -f wav` must agree with the header; music-metadata reads LIST/INFO + `id3 ` (same `clipTag`, same cover path); `nice -n 19 ffmpeg -f wav … -c:a libmp3lame -b:a <ladder rate>` under prlimit (256 MiB AS) + timeout (600 s), 1 thread; the MP3 is checked like an upload (magic, `ffprobe -f mp3`, the chosen CBR rate, duration ±1 s, ≤ the audio budget) and replaces the WAV under the upload id. | v0.3.0 | `src/probe/wav.ts`, `src/probe/probe.ts` |
| Fit-to-size (v0.3.5): the final MP3 must fit the 35 MiB final-file cap WITH its cover (≤2 MiB) and tags, so the audio gets 34,586,624 B (`src/lib/fit.ts`). An MP3 whose audio (without its leading ID3 tag) fits is kept byte for byte; a bigger MP3 (≤100 MB) or any WAV is encoded CBR at the highest of 320 / 256 / 192 kbps that fits (≤14.4 / 18.0 / 24.0 min); longer than 24 min is refused. The MP3 re-encode decodes untrusted audio only after the magic gate, the ID3 pre-scan and `ffprobe -f mp3` (duration bound), with a forced demuxer and decoder (`-f mp3 -c:a mp3float`), non-audio streams discarded at the demuxer, `-t` capped, under the WAV conversion's prlimit / timeout / nice; tags and cover come from the original. `items.transcode_kbps` records the rate; the UI, the review queue and the ticket card show it. | v0.3.5 | `src/lib/fit.ts`, `src/probe/transcode.ts`, `src/probe/probe.ts` |
| Probe containment: each parser child is its own process group and the **whole group** is SIGKILLed on timeout, on output overflow and as soon as the child exits; the parsers get a per-job private work dir with a read-only (0400) copy of the input; the probe mounts only `staging/{uploads,final,work}` and `spool/probe`. After **every** job the probe compares the process table with its start-up baseline (tini + itself): any other live process (e.g. a `setsid` escapee) is killed, the job's result is replaced by `containment_breach`, and the probe exits so Docker restarts the container and the kernel tears down its PID namespace. **Residual:** parsers still run as the probe's uid, so *during* a job (≤ ~45 s; a WAV conversion job up to ~6 min, measured 14–26 s for the largest inputs on one vCPU) a compromised parser can write what the probe can write (`staging/final`, `spool/probe/out`, other staged uploads) and could `ptrace`/signal the probe loop. Closing that needs a second uid (CAP_SETUID/SETGID in the probe, today `cap_drop: ALL` + `no-new-privileges`) or Landlock (ENOSYS on the test host; botvps unverified), i.e. a separate parse-only container. A `docker exec` into the probe container also counts as a stray and restarts it after the next job. | §3.4, §8 | `src/probe/exec.ts`, `src/probe/containment.ts`, `src/probe/main.ts` |
| Path builder: every destination and source assertion, the collision walk ` (2)`…` (9)`, and the `Portal-Test/` root. | §3.5 | `paths/builder.ts` |
| Decisions: a reviewer may decide (or edit the metadata / art of) an item only once its batch was **submitted with the rights attestation**: `assertBatchDecidable` for the readable 409, `BATCH_DECIDABLE_SQL` inside every conditional UPDATE and in the review queue, so an unsubmitted draft never shows up to reviewers. Approving a song copies the **probe-time** sha256 and enqueues `ingest`; approving a `new_artist` item creates the artist with a folder from the strict sanitizer (or links an existing one) and ungates the batch's songs. Public comments on a draft wait for submit. | §3.3, §3.4 | `submissions.ts`, `library/artists.ts`, `ui/queries.ts` |
| Mutation safety: every AzuraCast-writing job kind is in `MUTATING_JOB_KINDS` (`ingest`, `ingest_verify`, `move`, `archive`, `restore`, `apply_edit`, `apply_art`, `set_playlists`, `recovery`, `reverify`, `reconcile_archive`, `import_legacy_archive`). While `settings.queues_paused` is set (contract drift, an unverifiable spec, a failed key self-check, a behavioural batch drift, or an operator) they are not claimed, every handler re-checks `assertQueuesNotPaused` right before its writes, and the wrapper's write gate refuses every write. A paused job is parked without spending an attempt. Waits (scan window, on air, pacing, a ticket not open yet) throw `RetryLater`: no attempt is spent, bounded by the job's age. | §3.7 | `pause.ts`, `worker/main.ts`, `worker/handlers.ts` |
| Scan window (one module for ingest and P4): a mutation may start only when `now ≥ :x1 + scan_end_offset_s + 20 s` and `now + 30 s < :x6` (clock only, the accepted residual); a misconfigured offset holds and alerts. Moves, archives and restores also wait while the song is now playing or playing next. Ingest is serial: ≥ 90 s apart and ≤ 6 per hour. | §3.7, P0d-A | `worker/ingest/window.ts` |
| Ingest: artist gate → `finalize` in the probe (verifies `approved_sha256`, strips and re-tags, embeds the **effective cover**: custom art, else the embedded cover) → the worker re-hashes `final.mp3` → window + pacing → path build and collision walk → `POST /files` (re-hashed in the wrapper) → playlists (assignable ∩ station ids) → GET verify and snapshot → `verifying` → a re-verify after the next two scans → `live`, or recovery. | §3.7 | `worker/ingest/pipeline.ts` |
| Lost-row recovery (ingest and P4 re-verify share it): poll by path (≥ 3 cycles and ≥ 20 min), then the snapshot **metadata** first and the snapshot playlists, then remap the media id in `library_cache`, `items`, `requests`, `archive`, `media_snapshots`, `ingest_runs` and queued jobs' payloads, and alert. A re-verify re-applies only while its snapshot is the media's latest APPLIED one (the `after_*` snapshot of a newer portal mutation supersedes it; a failed operation's `before_*` snapshot never does, and recovery never re-applies one) and re-adds missing playlists by merge. An archived file (`Removed/<id>/`) is only re-linked. | §3.7 | `worker/library/recovery.ts` |
| Requests and library management: targets only `Music/Artists/<folder>/<file>` rows of `library_cache` that are not archived; one open request per song and kind, 10 per kind per day; `proposed` is strict `{title?, artist?, album?, genre?, artId?}` (a ready art upload of the member's own). Manager edits, playlist merges (memberships outside the assignable set are kept; foreign-station ids are never sent), archive (refused up front if the song is in an Events playlist; an `archiving` row with the snapshot first, then `playlists:[]`, verify zero station memberships, move to `Removed/<media_id>/`; resumable from where the file really is, with the Events refusal repeated on a resume, and the playlists are re-applied only if it verifiably did not move) and restore (exact recorded paths, snapshot playlists merged; resumable via `restoring`) are queued for the worker and audited. While a song has an `archiving` / `restoring` row every other mutation of it (edit, move, playlists, art, re-verify and ingest-verify repairs) waits; the `reconcile_archive` job (a 10-minute sweep, for rows untouched for 30 min with no queued or running archive/restore job, or a manager's **Resolve** / **Restore** under Archived songs) finishes an archive whose file reached `Removed/<id>/`, rolls back one whose file is still in the library, puts a restore that never moved the file back to `archived`, finishes one whose file is back, and alerts with the paths on anything else. An edit that changes the main artist to an unknown one parks on a new-artist approval. | §3.3, §3.5, §3.7 | `requests/*`, `worker/requests/*` |
| Admin: settings have a zod schema per key (caps can only be lowered; the attestation version must pass the submit check); role bindings are admin-only and audited; `admin` itself comes only from `PORTAL_OWNER_IDS`. | §3.1, §3.3 | `admin/settings.ts` |
| AzuraCast wrapper: the raw transport is **private** (tests use the `TEST_SEND` seam, which runs the same checks and refuses outside vitest). Every request passes an async `validate()`: an allowlist of (method, path template, query, body schema); `sid == STATION_ID`; the profile guard re-asserted on every call; the prefix guard on every write; **every** metadata PUT first GETs its id and requires the prefix and the `Music/Artists/<folder>/<file>` pattern; a playlist batch must carry the caller's allowed id set and stay inside it. `delete`, `queue`, `immediate`, `reprocess`, any other `do`, a non-empty `dirs`, `path` or `playlists` in a file PUT, and string playlist ids are all refused. The self-check expects station 1 → 200 and station 7 → 403. The contract drift probe compares against the P0d baseline (v0.3.6 adds the `/files/rename` path slice, taken from the live 0.21.0 build). v0.3.6: a batch may name `<root>UNRELEASED-DO NOT ADD TO ROTATION/…` (`.mp3`/`.m4a`) only when built by `setLegacyPlaylists()` / `moveLegacyToArchive()` (its memberships, and a move to `Removed/<id>` only); `PUT /files/rename` only through `renameInArchive()`, inside one `Removed/<id>/` folder with the same extension, destination checked free, id re-read. | §3.7 and amendments | `azuracast/client.ts`, `azuracast/guard.ts`, `azuracast/contract.ts` |
| Album art (contract 2026-09-27): `POST /api/uploads/art` (multipart, exactly one `art` file, ≤5 MB, JPEG/PNG/WebP by magic bytes, never SVG/GIF; header dims ≤12 MP and a complete file checked before spooling) → 202 `{artId}`; `GET /api/uploads/art/:artId` (uploader or `review`, else 404) → `processing`/`ready`/`rejected` + a signed 5-min `previewUrl` (`/api/media/art/:id`, `image/jpeg`, nosniff, `CSP: sandbox`). Raw bytes live in `staging/art-in` (web rw); the probe alone writes `staging/art/<artId>/cover.jpg` (web + worker ro), a ≤1000 px baseline JPEG under the same decode bounds as embedded covers; the web re-hashes it before recording `jpeg_sha256`. Unreferenced art expires after 7 days (the probe deletes the JPEG on an `art_release` request). The worker's `uploadArt(mediaId, jpegPath, expectedSha256)` reads only `<STAGING_ART_DIR>/<uuid>/cover.jpg` (no symlinks), re-hashes it, and posts it through `validate()` (the media id must be a `Music/Artists` file under the prefix; write gate; station). | contract | `server/art/*`, `app/api/uploads/art/*`, `app/api/media/art/*`, `probe/art.ts`, `azuracast/client.ts` |
| Album art on songs: `PUT`/`DELETE /api/items/:id/art` (owner while the batch is a draft, a reviewer while the item is pending in a submitted batch; the upload must be the viewer's own and ready) sets `items.custom_art_id` (FK to `art_uploads`, `ON DELETE SET NULL`). `/api/media/cover/:id` and the signed preview serve the **effective cover** with the same session, owner-or-review predicate and viewer-bound signature. Edit requests may propose art; managers set it directly (`PUT /api/library/:mediaId/art`); the worker's `apply_art` snapshots, runs `uploadArt` and verifies `art_updated_at` moved. Art referenced by an open item, request or queued `apply_art` job is kept. | contract | `submissions.ts`, `media/cover.ts`, `requests/*`, `worker/requests/jobs.ts`, `art/retention.ts` |
| The tickets client (worker only) never forwards a staff comment. The webhook receiver enforces ±300 s, HMAC over the raw bytes checked with `timingSafeEqual` **before** parsing, delivery-id dedupe in the same transaction, and anchoring only within the ticket's own batch. | §3.1, §4.5 | `tickets/client.ts`, `hooks/*` |
| SoundCloud links (v0.4.0): the web checks the link's shape only and never contacts SoundCloud or music-fetch; the worker writes music-fetch's request and reads its result with a strict schema, re-deriving every path; music-fetch (the only container with internet egress) holds nothing and never decodes media; the network-less probe decodes only AAC-in-MP4 / Opus-in-Ogg / MP3 with forced demuxers and decoders, `-protocol_whitelist file`, under prlimit / timeout / nice, from a read-only mount. Per-member limits, a global one-at-a-time queue and a kill switch. | P5 | `lib/soundcloud.ts`, `server/soundcloud.ts`, `server/spool/fetch.ts`, `worker/soundcloud.ts`, `probe/fetched.ts`, `fetch/` |
| `audit_log` is append-only by trigger. Web and worker connect as the **non-owner** `music_app` role (DML only; `audit_log` is SELECT + INSERT only). | §3.1 | `drizzle/0001_audit_append_only.sql`, `migrate/main.ts` |

### Worker profile guard, as amended

| Setting | Rule |
|---|---|
| `MUSIC_PROFILE` | Required; `prod` or `test`. |
| `STATION_ID` | Must be `1` in **both** profiles. |
| `PORTAL_TEST_PREFIX` (e.g. `Portal-Test/`) | Optional in `prod`, and set for the first live verifications. Required in `test`. When it is set, every write path must start with it. A metadata PUT (which names only an id) first GETs the id and checks its path. |

The worker refuses to start on any violation. It also refuses to start if the key can read the canary station (7).

## WAV uploads (v0.3.0)

Members may upload a WAV instead of an MP3 (WAV only: no FLAC, AIFF or M4A). The probe converts it, in its network-less container, to a **CBR MP3** (libmp3lame) at the highest of 320 / 256 / 192 kbps that fits the final-file cap (v0.3.5; see Fit-to-size above): 44.1 and 48 kHz are kept, multiples of 48 kHz (96, 192 kHz) become 48 kHz and every other rate 44.1 kHz; more than two channels are downmixed to stereo, mono stays mono. The MP3 **replaces the WAV** under the same upload id (tmp file + rename, then re-hashed), so the item's source, the preview, finalize (ID3 + APIC), the AzuraCast upload, the library and edit/remove requests are unchanged; the WAV never leaves the probe and never reaches AzuraCast. The item records `input_format = 'wav'` and `transcode_kbps`, and the UI shows e.g. "Converted from WAV (256 kbps MP3)".

- **Sizes.** A WAV may be up to 250 MB (`caps.maxWavUploadBytes`, admins may lower it; the page, the tus admission and the probe request all use the loaded value, and the compiled 250 MB is the ceiling). An MP3 may be up to 100 MB (`caps.maxMp3UploadBytes`, v0.3.5; one that does not fit the final-file cap is re-encoded down). The tus creation is capped by the type it **declares** (Upload-Metadata `filetype`, sent by the submit page from the file's name / MIME type); the probe caps again by the type the **bytes** show (an MP3 declared as a WAV and over 100 MB is refused `mp3_too_large`; a WAV declared as an MP3 can only be ≤100 MB and is converted). A name or declared type never decides the format.
- **Duration.** A WAV or an MP3 may be 30 s to **24 min** (v0.3.5; was 15 / 20 min): the longest song whose 192 kbps MP3 still fits the 35 MiB final-file cap with a 2 MiB cover and its tags.
- **Staging quota.** A WAV (or an MP3 too big to fit, v0.3.5) is charged at its full length (per-user in-flight and global `maxStagingBytes`) until the worker collects the probe result, which re-charges the upload row at the MP3's size; a rejected upload's bytes are deleted by the probe and the upload marked `expired`. While a WAV is being probed the probe's private copy in `staging/work` (up to 250 MB + the MP3) is on the same disk but not in the quota; the probe runs one job at a time, so that is bounded by one WAV, and at start-up it removes the job dirs a restart mid-job left there (an interrupted probe's upload is released like a rejected one). Every refusal, including a timeout, deletes the upload: a rejected item is never re-probed, so keeping the bytes would only hold staging quota.
- **Cost on botvps.** Measured with the real probe image under the compose limits plus `--cpus 1` (2.1 GHz Xeon E5-2620 v4 core; v0.3.5, CHANGELOG has the table): a 250 MiB 24-bit/48 kHz WAV (15.2 min → 256k) takes 32.1 s end to end (ffmpeg 24.8 s), a 242 MiB 16-bit/44.1 kHz WAV of 24 min (the longest encode, → 192k) 38.4 s (ffmpeg 33.7 s), a 57.5 MB 320k MP3 of 24 min re-encoded to 192k 41.7 s (ffmpeg 38.7 s; 3 m 5 s with a CPU hog on the same core); ffmpeg's peak RSS is ~40 MiB and the cgroup's anonymous memory peaks at ~34 MiB (page cache fills the rest of the 256 MB limit and is reclaimed, no OOM). The probe container has `cpu_shares: 256` (cgroup weight ~10 vs ~39 for a default container), so a conversion and the copy / hash around it yield the CPU to the Discord bots; ffmpeg also runs at nice 19, which only matters inside the probe's own cgroup. The probe processes nothing else during a conversion.

## SoundCloud links (v0.4.0)

Owner request: "Direct SoundCloud links auto-download the MP3 plus info, which the user can edit." Any **public** SoundCloud track, in the browser, with the same rights attestation at submit.

**Flow.**

1. The member pastes a link under **Add from a SoundCloud link** on the submit page. The page checks its shape (the server does again), then `POST /api/batches/:id/soundcloud {url}`.
2. **Web** (`server/soundcloud.ts`): only `https://soundcloud.com/<user>/<track>` (also on `www.` or `m.`, sent on as `soundcloud.com`) or `https://on.soundcloud.com/<id>` (SoundCloud's share parameters and a short fragment such as `#t=1:23` are dropped; the URL is rebuilt from the validated parts). Sets, playlists, likes, reposts, profiles and secret links are refused (`sc_not_a_track`), anything else too (`sc_bad_url`). It records a `probing` item (`source 'soundcloud'`, `fetch_stage 'queued'`), an upload row for the future MP3 (charged 60 MiB for now) and a `soundcloud_fetch` job. The web has no egress to SoundCloud and never talks to music-fetch.
3. **Worker** (`worker/soundcloud.ts`): writes `/spool/fetch/in/<id>.json`, one link at a time for the whole portal (`fetch_stage 'fetching'`). music-fetch validates the URL again, resolves a shortlink with its own redirect checks, runs the pinned yt-dlp and writes `/spool/fetch/out/<id>.json` plus `/staging/fetch/<id>/audio.<ext>` (+ `artwork.raw`). See `fetch/README.md`.
4. The worker reads the result with a strict schema and re-checks every path, the format (AAC in MP4, Opus in Ogg or MP3 only), the canonical URL and the duration (≤ 24 min). The metadata becomes the pre-fill (title; uploader → artist; genre; cleaned with `clipTag`; the description is ignored), the license is kept, and it writes a `probe_fetch` request (`fetch_stage 'converting'`).
5. **Probe** (`probe/fetched.ts`, network none, `staging/fetch` read-only): copies and re-hashes the download, checks the container by magic bytes, decodes it with a forced demuxer and decoder (file protocol only, prlimit / timeout / nice 19) and encodes a CBR MP3 on the fit ladder (320 / 256 / 192 kbps, the highest that fits the 35 MiB final file; an MP3 that already fits is kept untouched), published as `/staging/uploads/<upload>`. The artwork goes through the album-art path (JPEG / PNG / WebP only, → JPEG ≤ 1000 px).
6. The worker collects the result like an upload's: the item becomes `pending` with the pre-fill, the upload row is charged the MP3's size, and it writes `/spool/fetch/in/<id>.release`: music-fetch deletes the raw download at once. A rejected link gets the marker too; for a job music-fetch has not started, the marker cancels it, and for the job it is fetching, the marker waits for that job's result. The worker re-issues the markers of the last 28 h's finished SoundCloud items at start-up and every 30 min, so a marker lost to a restart only delays the cleanup.
7. The member edits the fields and submits with the rights attestation. Reviewers see **From SoundCloud (<license>)** and the source URL (review queue, item page, batch page, the ticket card).

**Limits.** Per member: 10 attempts a minute, `caps.fetchesPerUserPerDay` links a day (default 20, Admin → Settings; every link counts), 3 in progress. Globally: one link at a time (a link waits at most 3 h for its turn). Duration 30 s – 24 min (the fit ladder's floor), media ≤ 60 MiB (music-fetch). music-fetch gives up after 10 min (`sc_timeout`); the worker gives up 15 min after its request with no answer (`sc_fetch_unanswered`, alerted). Every failure code has a message (`components/messages.ts`, `sc_*`).

**Turn it off quickly** (kill switch), any of:

- Admin → Settings → untick **Allow "Add from a SoundCloud link"** → Save. New links get `503 sc_disabled`; queued links are rejected instead of being fetched; songs already fetched are unaffected.
- The same from the database (owner): `INSERT INTO settings (key, value) VALUES ('soundcloud_fetch_enabled', 'false') ON CONFLICT (key) DO UPDATE SET value = 'false';` (turn it on again with `'true'`, or delete the row).
- Stop the container: `docker compose -p efm-music stop music-fetch`. Links already sent are rejected after 15 min (`sc_fetch_unanswered`); use the setting too, or new links pile up in the queue until then.

**Operations.**

- **Egress.** `music-fetch` is alone on `fetch-egress` (172.31.251.0/24, bridge `br-efm-fetch`, no IPv6) and on no other network, so it cannot reach `music-db` or any container. yt-dlp talks to SoundCloud's API and CDN **directly** (only the shortlink and artwork requests go through music-fetch's in-process address guard), so the host rules are the only guard for yt-dlp's own connections, and they are **required**: see [Pre-deploy: fetch-egress host rules](#pre-deploy-fetch-egress-host-rules-v040-required). music-fetch must not run on a host where they are missing.
- **The monthly yt-dlp bump** (next review 2026-10-27; sooner for a yt-dlp security release or when SoundCloud extraction breaks): follow `fetch/README.md` → "Version pins and the monthly bump" (new version and wheel hash from PyPI, OSV check, `requirements.txt`, re-pin the base image digest, rebuild, run the test stage under the runtime constraints, check the pinned flags offline, `fetch/CHANGELOG.md`). Dependabot opens monthly PRs for `music/fetch` (pip + docker). A bump ships like any release: CI tests it and pushes `fetch-<sha7>`; set `MUSIC_TAG`, `up -d`.
- **Memory** (v0.4.0 measurements in `CHANGELOG.md`): `mem_limit: 160m`. Check `memory.peak` of the container after the first real fetches (only a loopback HLS origin was measured).
- **Logs.** `docker compose -p efm-music logs music-fetch`: one line per job (`<uuid> ok mp4 <bytes> <s>` or `<uuid> error <code>`), `released`, `swept`. The worker alerts on `sc_fetch_unanswered`.

## Unreleased songs: the UNRELEASED folder import (v0.3.6)

Station 1's pre-portal folder `UNRELEASED-DO NOT ADD TO ROTATION/` (storage 2) is moved, once, into the portal archive: every `.mp3` / `.m4a` media row in it (loose or up to three folders below, e.g. `Music/KOKORO/`) goes to `Removed/<media_id>/<same name>` by a **same-id** AzuraCast batch move (media id, `unique_id` and the DB metadata stay; tags are never rewritten; nothing is deleted; the emptied folder stays). A song that was in a station-1 playlist leaves rotation: its memberships are cleared first (REPLACE `[]`, station-scoped) and kept in its `before_archive` snapshot. Each one becomes an archive row with `origin = 'legacy_unreleased'`, shown as **Unreleased** under Archived songs.

- **Import job.** `import_legacy_archive` (one job per file, in `MUTATING_JOB_KINDS`) runs the v0.2.x archive machinery: scan window, pause + write gate, the file's path must still be the planned one, refused **with an alert and nothing written** if the song is in any Events (station 14) playlist, deferred (no attempt spent) while it is now playing or playing next, **one file per scan-window slot**, then the `before_archive` snapshot and the `archiving` row before the first write, clear → verify → Events re-check → move → verify → `archived` + `after_archive` + re-verify. A crash or lost reply resumes from where the file really is (never re-snapshotting); a row whose job is gone is finished or rolled back by the reconciler (memberships put back on the file still in UNRELEASED). Re-running an imported file is a no-op. Only this job may name the folder: the wrapper's `setLegacyPlaylists()` / `moveLegacyToArchive()` are the only requests allowed a legacy source (and only for its memberships and the move to `Removed/<id>`); every other method and any hand-built batch still refuse it.
- **Release, not restore.** A manager's **Release…** puts an Unreleased song into `Music/Artists/<artist>/` (an existing active artist, or a new one only with the explicit "Create this new artist" tick; the strict sanitizer's folder, refused if another artist owns it) with the playlists chosen explicitly (none pre-selected; its old memberships are only a hint). The name is kept unless the folder has it, then ` (2)` … ` (9)`: the file is renamed inside `Removed/<id>/` first (`PUT /files/rename`, the wrapper's `renameInArchive()`, allowed only within one `Removed/<id>/` folder with the same extension, destination checked free), then moved; nothing is ever overwritten and no metadata is written (its re-verify never writes metadata either: a difference alerts). Restore of a legacy row is refused (`409 release_required`).
- **Who sees archived songs** (every archive row, old and new): staff (review or manage) see all; a member sees a song only if they uploaded it through the portal (an item of a batch they own has that media id) or a manager **linked** them to it (Archived songs → Link a member…, any user who has signed in; `archive.link` / `archive.unlink` audited). Members get title, artist, date and the Unreleased/Removed label, nothing else; the reason is staff-only (a manager's archive reason or someone else's removal request), except the reason of the member's own removal request (their own words). Otherwise their row says "Removed from the station" (or "from the UNRELEASED folder"). Restore, Release, Resolve and links are manager-only.

**Dry run and run (managers).** Admin, or Library → *Archived songs* (for a manager who is not an admin) → *Archive the UNRELEASED folder: dry run*: the worker lists the folder read-only (`legacy_import_plan`) and the page shows every planned move (source → `Removed/<id>/<name>`), the playlists each file loses, and what is refused or skipped. *Confirm* queues exactly that plan (only a ready plan ≤ 60 min old, never twice, never while import jobs are still queued), one job per file, 5 minutes apart: 50 files take about 4 h 10 min. The same from the worker container (operator):

```sh
docker compose -p efm-music exec music-worker node /app/legacy-import.mjs dry-run    # read-only, prints the plan
docker compose -p efm-music exec music-worker node /app/legacy-import.mjs run --yes  # queues the printed plan
docker compose -p efm-music exec music-worker node /app/legacy-import.mjs status     # rows by status, jobs by status
```

**Verify.** `status` shows `{"archived":50}` and the jobs `done`; a new dry run lists no media file; in AzuraCast the folder is empty and every id is under `Removed/<id>/`; `SELECT media_id, original_path, archived_path, status FROM archive WHERE origin = 'legacy_unreleased' ORDER BY id;` and, for 5112, `SELECT playlist_ids FROM media_snapshots WHERE media_id = 5112 AND reason = 'before_archive';` → `{2}` while its station playlists are now empty. Alerts name every refusal (`import_legacy_archive failed (in_events_playlists)`) and anything a human must settle.

**Stop / roll back.** To stop part way: `UPDATE jobs SET status = 'done' WHERE kind = 'import_legacy_archive' AND status = 'queued';` (or set `settings.queues_paused`); a file in flight finishes or is rolled back by the reconciler. Per song, the supported way back is **Release** into an artist folder. A full return to UNRELEASED is manual and not a portal action: move `Removed/<id>/<name>` back to its `archive.original_path` folder with AzuraCast's own file manager (a batch move keeps the id), re-add the `before_archive` snapshot's playlists (only 5112 had one: playlist 2), then close the row as the DB owner: `UPDATE archive SET status = 'restored', restored_at = now(), updated_at = now() WHERE id = <archive id> AND origin = 'legacy_unreleased';`.

## Events portal (v0.5.0)

`https://events.euphoric.fm` is a **second instance of this app** (same images and `MUSIC_TAG`, same database, same Discord app) with `PORTAL_SITE=events`. Plan: vault **"EFM Events Portal — Plan"** (v2.1); names and shapes: the events contract (`src/events/contract/`).

| Service | Image | Networks | Holds | Budget |
|---|---|---|---|---|
| `events-web` | `web` | `music-int`, `worker-egress` | `events-web.env` (below). No AzuraCast key, no tickets key of either portal: it refuses to start on `AZURACAST_API_KEY`, `TICKETS_WRITE_KEY`, `EVENTS_AZURACAST_API_KEY` or `EVENTS_TICKETS_WRITE_KEY`. Published on `127.0.0.1:6097` only. | 192m, heap 128 |
| `events-worker` | `worker`, `command: node /app/events-worker.mjs` | `music-int`, `efm-public-net`, `worker-egress` | `events-worker.env`: the **events** AzuraCast key (station 14 only) and the **efm-events** tickets key. Refuses the music keys and every web secret. Claims only `event_jobs`. | 160m, heap 96 |
| `events-probe` | `probe` | `network_mode: none` | Nothing (no env_file). Unchanged probe code on the events tree. | 256m |

**Data root** `${MUSIC_DATA_DIR}/events/`, created (uid 1000) by `music-init`: `staging/{uploads,final,work}` and `spool/probe/{in-web,in-worker,out,claimed}`. No art or fetch dirs. Pinned mounts:

| Container | Mount |
|---|---|
| events-web | `events/staging/uploads` rw (tus), `events/spool/probe/in-web` rw, `events/spool/probe/out` **ro** |
| events-worker | `events/staging/final` **ro**, `events/spool/probe/in-worker` rw, `events/spool/probe/out` **ro** |
| events-probe | `events/staging/{uploads,final,work}` rw, `events/spool/probe` rw |

No events service mounts anything of music's tree, and no music service mounts `events/` (`test/compose-events.test.ts`, and the mount checks in `test/run.sh`).

**Site gate** (`src/server/http/site-gate.ts`): on events, `/x` renders `app/ev/x`; only `/api/ev/**`, `/api/auth/**`, `/api/health` and the tus routes (`/api/uploads`, `/api/uploads/<id>`) exist; everything else is a 404. Music 404s `/ev/**` and `/api/ev/**`.

### Env files and secrets

On botvps the secrets live in **`/home/botuser/secrets/efm-events/`** (mode 700, files 600, owner botuser); `env/events-web.env` and `env/events-worker.env` in the checkout are copies of (or symlinks to) those files. Templates: `env/events-web.env.example`, `env/events-worker.env.example`.

| Key | `events-web.env` | Rule |
|---|---|---|
| `DATABASE_URL`, `AUTH_DISCORD_ID`, `AUTH_DISCORD_SECRET`, `APP_ENC_KEY`, `DISCORD_GUILD_ID`, `PORTAL_OWNER_IDS` | **same as music's `web.env`** | both webs read and refresh the same encrypted `account` tokens |
| `PORTAL_ORIGIN`, `AUTH_URL` | `https://events.euphoric.fm` | must differ; `AUTH_URL` must equal `PORTAL_ORIGIN` |
| `AUTH_SECRET` | its own (`openssl rand -base64 33`) | never music's |
| `TICKETS_WEBHOOK_SECRET` | random, registered nowhere (`openssl rand -hex 32`) | the schema requires one; v1 has no inbound webhook |
| `TICKETS_GUILD_READ_KEY` | empty | sign-in relies on Discord's member lookup only |
| `PORTAL_SITE` | set by `compose.yml` | — |

`events-worker.env`: `DATABASE_URL`, `AZURACAST_BASE_URL` and `TICKETS_API_BASE` as in music's `worker.env`; `EVENTS_STATION_ID=14` (anything else refuses to start); `EVENTS_AZURACAST_API_KEY` (dedicated Events user, station 14 media + playlists + broadcasting); `EVENTS_CANARY_STATION_IDS=1,7` (each must answer 403 at start-up); `EVENTS_TICKETS_WRITE_KEY` (integration `efm-events`: `tickets:write` + `tickets:close`, category `eventrequest`, link origin `https://events.euphoric.fm`, no actor impersonation); `PORTAL_ORIGIN=https://events.euphoric.fm`.

**Music's env files must hold no `EVENTS_*` variable at all** (music-web and music-worker refuse the whole prefix). Set `AZURACAST_EXTRA_CANARY_STATION_IDS=14` in music's `worker.env` (it is the default; set it explicitly), so an events key pasted into the wrong file refuses to start.

### Deploy additions

1. Create the two env files (above) from the secrets dir; `chmod 600`.
2. `docker compose -p efm-music up -d`: `music-init` re-runs and creates the `events/` tree (it is idempotent; to re-run it alone: `docker compose -p efm-music up music-init`), `music-migrate` applies `0010`.
3. Cloudflare: `events.euphoric.fm → http://localhost:6097`, and the edge answers 404 for `events.euphoric.fm/api/hooks/`.
4. **Egress probe from events-web** (before go-live, and after each botvps reboot or Docker upgrade until the unit has been seen to restore the rules). events-web sits on `worker-egress` (172.31.252.0/24), so `efm-music-egress.service` already confines it; verify. `IP` values: the music-worker's address on worker-egress (`docker inspect efm-music-music-worker-1 --format '{{(index .NetworkSettings.Networks "efm-music_worker-egress").IPAddress}}'`) and tickets-web's address (`docker inspect tickets-web --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'`):

   ```sh
   docker compose -p efm-music exec -T events-web node -e '
   const net = require("node:net");
   const t = [["MUSIC_WORKER_IP",3000],["169.254.169.254",80],["100.100.100.100",53],["TICKETS_WEB_IP",3000],["10.0.0.1",80],["discord.com",443],["euphoric.fm",443]];
   (async () => { for (const [h,p] of t) await new Promise((r) => { const s = net.connect({host:h,port:p,timeout:3000});
     s.on("connect",()=>{console.log(h,"OPEN");s.destroy();r()}); s.on("timeout",()=>{console.log(h,"blocked: timeout");s.destroy();r()});
     s.on("error",(e)=>{console.log(h,"blocked:",e.code);r()}) }) })()'
   ```

   **Only `discord.com` and `euphoric.fm` may print `OPEN`.** A worker port that is not listening prints `ECONNREFUSED` if the packet got through: that counts as **not** blocked (a DROP shows as a timeout). Anything else reachable → `docker compose -p efm-music stop events-web`, fix the rules, re-verify; record the result in the vault's botvps note.

### Tests

The harness runs the three events services with test constants (`test/compose.test.yml`): events-web reaches the mock Discord over `worker-egress`, events-worker the mock AzuraCast with a **second key that only reaches station 14** (stations 1 and 7 answer 403) and the mock tickets API with the `efm-events` key (category `eventrequest`, events link origin). The station-14 mock keeps playlists with schedule rows, order entries, a queue and restarts; its `files/batch do=playlist` **replaces only the file's station-14 memberships** (station 1's stay), like upstream. Anything the events wrapper's allowlist forbids is recorded in `GET /__mock/az/station14/violations` and not applied; `GET /__mock/az/station14/state` shows the whole station.

`e2e-events-*.test.ts` and `compose-events.test.ts` tag each test with what it needs: **[W0]** (contract commit only: compose, site gate, sign-in, tus flag/site/sweepers, library sync, set_playlists merge), **[A]** (the events API) or **[A+C]** (the API and the events worker). A failing [A] or [A+C] test on a branch without that code is expected.

## Database migrations

`drizzle/` holds `0000_init`, `0001_audit_append_only` (the append-only trigger, hand-written), `0002_foundation_art` (album-art uploads) and `0003_integration` (P3 + P4, generated by drizzle-kit from the merged `schema.ts` on the 0002 snapshot: `ingest_runs`, `batches.attest_version`, `items.custom_art_id` with its FK, the P4 request and snapshot columns). `music-migrate` applies them as the owner, then (re)grants `music_app`. `schema.ts` and the migrations are equivalent (drizzle-kit `generate` reports no changes; a migrated database matches one built from `schema.ts` column for column, apart from the 0001 triggers). drizzle-kit `push` always proposes re-setting the five `'{}'::int[]` / `'{}'::text[]` array defaults: that is a drizzle-kit comparison artefact that does not converge and was already present at 0002, not drift. Later releases add `0004_v021_worker`, `0005_v022_archive_reconcile`, `0006_v030_wav_input` (`items.input_format`), `0007_v032_transcode_kbps` (`items.transcode_kbps`) `0008_v036_archive_legacy` (`archive.origin` enum `portal` / `legacy_unreleased`, `reason`, `linked_user_id` → `user`, `release_artist_id` → `artists`, `release_playlist_ids`, `restore_path`) and `0009_v040_soundcloud` (`items.fetch_request_id`, `fetch_stage`, `fetch_requested_at`, `source_url`, `fetch_license`), each generated by drizzle-kit from `schema.ts`.

## Deploy (botvps, as botuser)

```sh
cd <checkout>/music
cp env/*.env.example env/        # then rename each to *.env, fill in, chmod 600
cp .env.example .env              # MUSIC_TAG=<git short sha>, MUSIC_DATA_DIR=./data
docker compose -p efm-music up -d
```

- **Roll back:** set the previous `MUSIC_TAG`, then `up -d`.
- **Images:** CI pushes `ghcr.io/jason-tucker/euphoricfm-website-music:{web,worker,probe,fetch}-<sha7>` and `-latest`. Only images that passed `test/run.sh` are pushed.
- **v0.4.0:** `compose.yml` creates `fetch-egress` itself (172.31.251.0/24): check that the subnet is free on botvps first (`docker network inspect`). **Do not `up -d` v0.4.0 before the [fetch-egress host rules](#pre-deploy-fetch-egress-host-rules-v040-required) are in place and verified.**
- **Networks:** `efm-music-hooks` must exist first. The main session creates it at P1-net/Deploy-1:

  ```sh
  docker network create --subnet 172.31.250.0/24 efm-music-hooks
  ```

  `efm-public-net` already exists.

### Pre-deploy: fetch-egress host rules (v0.4.0, REQUIRED)

`music-fetch` is the only container with internet egress, and yt-dlp inside it connects to whatever SoundCloud's API, a redirect or a playlist names (only shortlink resolution and the artwork request go through music-fetch's own public-address check). Two host rules keep a steered or compromised yt-dlp away from everything that is not the public internet; both are **required before music-fetch starts**, and a deploy that cannot show them stops here (leave `soundcloud_fetch_enabled` false and `music-fetch` stopped).

1. **DOCKER-USER** (forwarded traffic): `efm-music-egress.service` runs `/usr/local/sbin/efm-music-egress.sh`, whose `EFM-MUSIC-EGRESS` chain DROPs 10/8, 172.16/12, 192.168/16, 100.64/10 and 169.254/16 from `172.31.251.0/24` (and from worker-egress and music-web; see "Host firewall on botvps" below).
2. **INPUT** (traffic to the host itself: the bridge gateway `172.31.251.1`, the droplet's public IP, `docker0`, any host-bound service; DOCKER-USER never sees it): the same script keeps an `EFM-MUSIC-INPUT` chain, jumped from `INPUT`, with `-i br-efm-fetch -m conntrack --ctstate NEW -j DROP`. Applied on botvps 2026-09-28; the interface need not exist yet. Container DNS is unaffected: Docker's embedded resolver answers inside the container's own namespace and forwards from the host.

**Verify, before `up -d`** (root on botvps):

```sh
iptables -S EFM-MUSIC-EGRESS | grep -c -- '-s 172.31.251.0/24 .* -j DROP'   # 5
iptables -S EFM-MUSIC-INPUT | grep -- '-i br-efm-fetch'                       # present
iptables -S INPUT | grep -c -- '-j EFM-MUSIC-INPUT'                           # 1
systemctl is-enabled efm-music-egress.service                                 # enabled
```

**Verify, after `up -d`** (the subnet and bridge now exist): `docker network inspect efm-music_fetch-egress --format '{{(index .IPAM.Config 0).Subnet}} {{index .Options "com.docker.network.bridge.name"}}'` prints `172.31.251.0/24 br-efm-fetch`, then run the connect probe from `fetch/README.md` ("Only `1.1.1.1` may print `OPEN`"), adding the droplet's public IP (`("<public IP>",22)`) to its list. Anything else `OPEN` → `docker compose -p efm-music stop music-fetch`, set the kill switch, fix the rules, re-verify. Re-run both checks after every botvps reboot or Docker upgrade until the unit has been seen to restore them. Record the result in the vault's botvps note.

### DOCKER-USER egress rules (applied on botvps by `efm-music-egress.service`, not by this repo)

`compose.yml` pins `worker-egress` to **172.31.252.0/24** (a plain bridge, not internal). On botvps the persistent systemd unit **`efm-music-egress.service`** installs the DOCKER-USER guard for that fixed subnet, and for **172.31.251.0/24** (`fetch-egress`, P5): traffic from those subnets to RFC1918 (10/8, 172.16/12, 192.168/16), 169.254.0.0/16 (cloud metadata) and 100.64.0.0/10 (CGNAT / Tailscale) is dropped, with established return traffic allowed first. This repo does not apply or persist any iptables rule.

- Change the `worker-egress` subnet only together with that unit; otherwise the worker runs without the guard.
- The worker reaches tickets-web over `efm-public-net`, whose traffic stays on its own bridge and is not affected.
- The test harness (`test/compose.test.yml`) overrides `worker-egress` and `fetch-egress` without a fixed subnet or bridge name, so a test stack never takes the production range, and runs `music-fetch` with `network_mode: none`.

## Tests

Everything runs in Docker; the host needs no Node.

```sh
sh music/test/run.sh
```

- `KEEP=1` leaves the stack up; `DOCKER_COMPOSE` overrides the compose command.
- `MUSIC_TEST_PROJECT=<name>` (default `efm-music-test`) isolates parallel runs from different worktrees: compose project, networks, and the test and runtime image tags. `MUSIC_TEST_TAG` overrides the runtime image tag.
- The test web has no host port. `MUSIC_TEST_WEB_PORT=<port>` publishes it on `127.0.0.1:<port>` for a browser (through `test/compose.webport.yml`).

The harness builds the images, starts Postgres, the mocks and the real containers (the worker runs its real job loop against the mocks), and then runs:

- music-fetch's own unit suite (`fetch/tests`, network none, runtime constraints);
- `vitest` (unit, DB and e2e for every phase: foundation, ingest, requests, UI page smoke, SoundCloud links);
- the mount checks;
- the worker start-up refusals (v0.5.0: also the events worker's: the music AzuraCast key or a station other than 14 refuses, and music-worker refuses any `EVENTS_*` key).

Finally it prints idle `docker stats`. The web's own retention sweeper is off in the harness (`MUSIC_DISABLE_SWEEPER=1`), because the retention tests call it directly.

The UI component and route tests run without the stack (jsdom): `pnpm test:ui` (`vitest.ui.config.ts`).

**No test contacts SoundCloud or any production system.** The test stack runs the real `music-fetch` image with `network_mode: none` and a launcher (`test/fetch-fake/`) that replaces only its network seams: a fake yt-dlp that plays fixture files the tests write (`/data/fetch-fixtures`), and fixture artwork and shortlinks.

The mocks in `test/mocks/server.mjs` stand in for Discord OAuth and the member API, the tickets Integration API, AzuraCast (per the P0d and P0d-B contracts, **upstream-faithful**: a batch skips a missing source silently and a move overwrites an occupied destination, so the wrapper's own checks are what the tests exercise), and an egress canary. Controls cover seeding, per-record batch errors, the next move failing, a lost or dropped row, now-playing, drift, and art uploads. **No production credential is used anywhere in the tests.**

## Pages and client notes

- Pages: landing and denied, dashboard (own batches and requests), submit, batch detail, review queue and item, request review, library (browse, song, archived: members see their own / linked archived songs), admin.
- Import server helpers only from server components, route handlers and server actions.
- **CSP:** there is no `'unsafe-inline'`: no inline `<script>` and no `style={{…}}` attributes. Next stamps the nonce on its own scripts. `img-src` allows `https://euphoric.fm` for AzuraCast's public art (`library_cache.art_url`).
- Mutations from the browser are same-origin `fetch` or forms, which send `Origin` and `Sec-Fetch-Site` automatically.
- Preview audio and cover URLs come from `GET /api/items/:id/preview`: signed, 5 minutes, bound to the viewer. The cover is the effective one.
- **tus client:** `endpoint: '/api/uploads'`, `chunkSize: 8 * 1024 * 1024`, `metadata: { filetype: 'audio/wav' | 'audio/mpeg' }` (the declared type the server caps by), and **no** `uploadDataDuringCreation`. Then `POST /api/batches/:id/items {uploadId}`.
- **Album art:** `POST /api/uploads/art` with a `FormData` holding one file field `art`; poll `GET /api/uploads/art/:artId` until it leaves `processing` (`ready` → `previewUrl`; `rejected` or `expired` → `reason`), then attach the id.

### Host firewall on botvps (efm-music-egress.service)

`/usr/local/sbin/efm-music-egress.sh` (run by `efm-music-egress.service` after docker) keeps two chains:
- `EFM-MUSIC-EGRESS` (from `DOCKER-USER`): drops RFC1918, 169.254.0.0/16 and 100.64.0.0/10 from worker-egress (172.31.252.0/24), fetch-egress (172.31.251.0/24) and music-web (pinned **172.31.250.10** on `efm-music-hooks`; its own /24 — tickets-web — stays reachable).
- `EFM-MUSIC-INPUT` (from `INPUT`): drops NEW connections from `br-efm-fetch` to the host itself.
Keep the compose pins (`worker-egress`/`fetch-egress` subnets, `br-efm-fetch` bridge name, music-web `ipv4_address`) in sync with that script.
