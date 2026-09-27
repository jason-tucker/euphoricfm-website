# EFM Music Portal (`music/`)

`https://music.euphoric.fm`: members of the EuphoricFM Discord server submit music, and staff review it. Each batch or request becomes a ticket through the euphoric-tickets Integration API, and approved files go to AzuraCast station 1.

The design contract is the vault plan **"EFM Music Portal — Plan"** (v3.2, with its changelog amendments). This directory is **phase P2**: the security foundation. The UI pages are a later pass.

This is a separate package from the Astro site. It has its own `package.json`, `pnpm-lock.yaml`, Dockerfile and compose project (`efm-music`). The site build ignores `music/` (see the root `tsconfig.json` and `.dockerignore`).

## Containers

| Service | Image target | Networks | Holds |
|---|---|---|---|
| `music-web` | `web` (Next.js 15.5 standalone) | `music-int`, `efm-music-hooks` (external) | `web.env`: Auth.js, the Discord app, `APP_ENC_KEY`, the tickets **guild:read** key and the webhook secret. **No AzuraCast key and no `tickets:*` key.** It refuses to start if it sees either. |
| `music-worker` | `worker` | `music-int`, `efm-public-net` (external), `worker-egress` | `worker.env`: the AzuraCast key and the tickets write key. It refuses to start if it sees web secrets. |
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
| web | `staging/uploads` rw (tus), `spool/probe/in-web` rw, `spool/probe/out` **ro** |
| worker | `staging/final` **ro**, `spool/probe/in-worker` rw, `spool/fetch/in` rw, `spool/probe/out` **ro**, `spool/fetch/out` **ro** |
| probe | `staging` rw, `spool/probe` rw |

The probe also enforces **which request types each inbox may carry**:

- `in-web` may carry `probe` only.
- `in-worker` may carry `finalize`, `cover` and `probe_fetch`.

Every result records the inbox it came from.

`test/run.sh` proves the mount rules on the real compose definitions:

- web cannot see `in-worker`, and cannot write `out` or `final`;
- the worker cannot write `final` or `out`, and cannot see `uploads`;
- the probe has no network.

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
| tus: Upload-Length 1 B to 35 MB. Defer-length, concatenation and creation-with-upload are off. Chunks are capped at 8 MB. The **DB owner is checked on every method**, and client metadata is discarded. GET is never served. Caps are 1 GB in flight and 3 concurrent uploads per user, and 5 GB globally. Uploads pause above 85 % disk. Retention runs on a timer. | §3.4 | `uploads/caps.ts`, `uploads/tus.ts`, `uploads/retention.ts`, `app/api/uploads/*` |
| Probe checks, in order: magic bytes (plus a second-frame check), then ID3 ≤5 MB with no compressed or encrypted frames, then `ffprobe -f mp3 -protocol_whitelist file,pipe -threads 1` under `timeout` + `ulimit -v`, then music-metadata in a heap-capped child. Covers are re-encoded to a JPEG ≤1000 px, with raster dimensions bounded first and SVG rasterised. Then sha256 and `finalize`. | §3.4 | `src/probe/*` |
| Path builder: every destination and source assertion, the collision walk ` (2)`…` (9)`, and the `Portal-Test/` root. | §3.5 | `paths/builder.ts` |
| AzuraCast wrapper: the raw transport is **private** (tests use the `TEST_SEND` seam, which runs the same checks and refuses outside vitest). Every request passes an async `validate()`: an allowlist of (method, path template, query, body schema); `sid == STATION_ID`; the profile guard re-asserted on every call; the prefix guard on every write; **every** metadata PUT first GETs its id and requires the prefix and the `Music/Artists/<folder>/<file>` pattern; a playlist batch must carry the caller's allowed id set and stay inside it. `delete`, `queue`, `immediate`, `reprocess`, any other `do`, a non-empty `dirs`, `path` or `playlists` in a file PUT, and string playlist ids are all refused. The self-check expects station 1 → 200 and station 7 → 403. The contract drift probe compares against the P0d baseline. | §3.7 and amendments | `azuracast/client.ts`, `azuracast/guard.ts`, `azuracast/contract.ts` |
| The tickets client (worker only) never forwards a staff comment. The webhook receiver enforces ±300 s, HMAC over the raw bytes checked with `timingSafeEqual` **before** parsing, delivery-id dedupe in the same transaction, and anchoring only within the ticket's own batch. | §3.1, §4.5 | `tickets/client.ts`, `hooks/*` |
| `audit_log` is append-only by trigger. Web and worker connect as the **non-owner** `music_app` role (DML only; `audit_log` is SELECT + INSERT only). | §3.1 | `drizzle/0001_audit_append_only.sql`, `migrate/main.ts` |

### Worker profile guard, as amended

| Setting | Rule |
|---|---|
| `MUSIC_PROFILE` | Required; `prod` or `test`. |
| `STATION_ID` | Must be `1` in **both** profiles. |
| `PORTAL_TEST_PREFIX` (e.g. `Portal-Test/`) | Optional in `prod`, and set for the first live verifications. Required in `test`. When it is set, every write path must start with it. A metadata PUT (which names only an id) first GETs the id and checks its path. |

The worker refuses to start on any violation. It also refuses to start if the key can read the canary station (7).

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

### DOCKER-USER egress rules (documented only; not applied by this repo)

Apply these in P0b/Deploy-1 on the host, after pinning the `worker-egress` subnet (give it `ipam` in `compose.yml`, or read it from `docker network inspect efm-music_worker-egress`).

```sh
W=<worker-egress subnet>
iptables -I DOCKER-USER -s "$W" -d 10.0.0.0/8      -j DROP
iptables -I DOCKER-USER -s "$W" -d 172.16.0.0/12   -j DROP
iptables -I DOCKER-USER -s "$W" -d 192.168.0.0/16  -j DROP
iptables -I DOCKER-USER -s "$W" -d 169.254.0.0/16  -j DROP   # cloud metadata
iptables -I DOCKER-USER -s "$W" -d 100.64.0.0/10   -j DROP   # CGNAT / Tailscale
# allow established return traffic before the drops:
iptables -I DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
```

`music-fetch` (P5) gets the same rules on its own `fetch-egress` network. The worker reaches tickets-web over `efm-public-net`, whose traffic stays on its own bridge and is not affected. Persist the rules the way the host already does, and record them in the vault.

## Tests

Everything runs in Docker; the host needs no Node:

```sh
sh music/test/run.sh            # KEEP=1 leaves the stack up; DOCKER_COMPOSE overrides the compose command
```

It builds the images, starts Postgres, the mocks and the real containers, and then runs:

- `vitest` (unit, DB and e2e);
- the mount checks;
- the worker start-up refusals.

Finally it prints idle `docker stats`.

The mocks in `test/mocks/server.mjs` stand in for Discord OAuth and the member API, the tickets Integration API, AzuraCast (per the P0d and P0d-B contracts), and an egress canary. **No production credential is used anywhere in the tests.**

## For the UI pass

- Import server helpers only from server components, route handlers and server actions:
  - `requirePermission` / `optionalViewer` from `@/server/authz/viewer`;
  - the action functions in `@/server/submissions`;
  - the DB types in `@/server/db/schema`.
- **CSP:** there is no `'unsafe-inline'`. That means no inline `<script>` and no `style={{…}}` attributes (style-src falls back to `'self'`). Next stamps the nonce on its own scripts.
- Mutations from the browser are same-origin `fetch` or forms, which send `Origin` and `Sec-Fetch-Site` automatically.
- Preview audio and cover URLs come from `GET /api/items/:id/preview`: they are signed, expire in 5 minutes, and are bound to the viewer.
- **tus client:** `endpoint: '/api/uploads'`, `chunkSize: 8 * 1024 * 1024`, and **no** `uploadDataDuringCreation`. Then `POST /api/batches/:id/items {uploadId}`.
