# music-fetch

The SoundCloud import service for the EFM Music Portal. This is phase **P5**, and plan §3 and §3.6 describe it. It lives in its own directory with its own Dockerfile, so you can copy or merge it into the portal without conflicts.

It takes one request at a time from a spool directory. For each request it validates the URL, resolves a shortlink if there is one, runs a pinned **yt-dlp**, checks the result, and writes the raw media under `/staging/fetch/<uuid>/`. **Transcoding and probing happen in `music-probe`, not here.**

- Language: Python standard library plus `yt-dlp`, with no other packages.
- Idle memory: about **14.6 MiB** (cgroup) and 23 MB RSS, measured with `docker stats` on the hardened runtime container.
- Secrets, database access and inbound ports: none.

## Spool protocol

| Path | Writer | Reader | Contents |
|---|---|---|---|
| `/spool/fetch/in/<uuid>.json` | music-worker | fetch | `{"uuid", "url", "requestedBy"}`, with an optional `"v": 1`. **Any other key is rejected.** |
| `/spool/fetch/claimed/<uuid>.json` | fetch | fetch | The job in progress. fetch creates this directory itself. |
| `/spool/fetch/out/<uuid>.json` | fetch | music-worker (ro) | The result, written once and never overwritten. |
| `/staging/fetch/<uuid>/` | fetch | music-probe | `audio.<ext>` and an optional `artwork.raw`. Both files are mode 0440. |

**Request rules:**
- `uuid` must be a lowercase v4 UUID and must equal the file name.
- `requestedBy` must match `[A-Za-z0-9_.:-]{1,64}`.
- The request is at most 4 KiB.
- Write it atomically: create a tmp file in `in/`, then rename it to `<uuid>.json`. The portal's `writeSpoolRequest` already works this way.

**Processing:**
- One job at a time, oldest first by mtime.
- fetch claims a request with `rename`, and reads it with `O_NOFOLLOW` and a size cap.
- The job directory must be **new**. If it already exists, fetch returns `bad_request` and leaves the directory alone.
- On any error, fetch removes the job directory it created.
- On startup, a leftover claim becomes an `interrupted` result, and its partial directory is removed.

**An `ok` result:**

```json
{
  "v": 1, "uuid": "…", "status": "ok", "errorCode": null,
  "files": { "audio": "/staging/fetch/<uuid>/audio.m4a", "artwork": "/staging/fetch/<uuid>/artwork.raw" },
  "meta": { "title": "…", "uploader": "…", "duration": 141.379, "genre": "…", "description": "…",
            "artworkSourceHost": "i1.sndcdn.com", "license": "cc-by", "trackId": "675426677" },
  "rawSha256": "<sha256 of the audio file>",
  "audioBytes": 2855902,
  "container": "mp4",
  "ffmpegFormat": "mp4",
  "artworkSha256": "<sha256 of artwork.raw>",
  "canonicalUrl": "https://soundcloud.com/<user>/<track>",
  "warnings": []
}
```

- `files.artwork`, `artworkSha256`, `meta.genre`, `meta.description`, `meta.license` and `meta.trackId` appear only when they exist.
- `meta.artworkSourceHost` is `null` when there is no artwork.
- The `meta` strings come from the uploader, and are **untrusted**. fetch has already:
  - applied NFC normalisation;
  - removed control, format, bidi, private-use and line-separator characters;
  - capped the lengths: title and uploader at 200, genre at 100, description at 4000, with newlines kept only in the description.
- The whole document stays well under the portal's 64 KiB spool-document cap.
- `license` is SoundCloud's license id, such as `cc-by` or `all-rights-reserved`. It is useful next to the rights-attestation flag.
- `warnings` lists skipped artwork, for example `artwork_too_large`, `artwork_not_image`, `artwork_http_302` or `artwork_timeout`.

**An `error` result:**

```json
{"v":1,"uuid":"…","status":"error","errorCode":"too_long","files":null,"meta":null,"rawSha256":null}
```

### Error codes

The first eight codes are the contract from plan §3.6 and the P5 brief. The last four are additions, for failures the contract list does not name.

| Code | Meaning |
|---|---|
| `bad_url` | The URL is not `https://soundcloud.com/<user>/<track>` or `https://on.soundcloud.com/<id>`. This covers a disallowed query key, a fragment, userinfo, a port, non-ASCII, a shortlink that does not redirect, and more than 5 redirects. |
| `not_a_track` | A set, playlist, likes, reposts, user page, secret-token URL or site section. Also returned when the info JSON is a playlist or comes from a different extractor, or when yt-dlp reports "Unsupported URL" or "No suitable extractor". |
| `redirect_host` | A shortlink hop left `on.soundcloud.com`, `soundcloud.com` or `m.soundcloud.com`, or was not https. Every hop is checked **before** it is requested. |
| `too_large` | The media is over 60 MiB. This fires on yt-dlp's own `--max-filesize` check, on the job-directory size poll, on `RLIMIT_FSIZE` (EFBIG or SIGXFSZ), or on the final size check. |
| `too_long` | The info JSON duration is over 1200 s. The download is stopped as soon as the info JSON appears. |
| `timeout` | yt-dlp ran past 10 minutes, or shortlink resolution ran past 30 s. |
| `extractor_failed` | yt-dlp failed, the info JSON is missing, unparseable or has no duration, there is no audio, or there are unexpected files in the job directory. |
| `artwork_host` | The info JSON's artwork URL is not `https://<label>.sndcdn.com/…`, where the host may have several labels but no port or userinfo. |
| `bad_request` *(addition)* | A malformed spool document, a mismatch between the uuid and the file name, a symlinked request, or an existing job directory. |
| `bad_media` *(addition)* | The magic bytes are outside mp3/mp4/ogg/opus/wav/flac, the extension does not match the container, or the audio is a symlink or a hard link. |
| `interrupted` *(addition)* | A SIGTERM arrived mid-job, or startup recovery found a leftover claim. |
| `internal` *(addition)* | An unexpected exception. The traceback goes to the container log. |

## URL handling (§3.6)

- The input is parsed with a strict regex over **printable ASCII only**, not with `urllib.parse`. This rejects IDN lookalikes and fullwidth or ideographic dots before any structural parsing happens.
- The host must be exactly `soundcloud.com` or `on.soundcloud.com`. The URL may not contain `@`, `:`, `%` or `[` in the authority, and may not contain a backslash or a fragment.
- The path segments must match `[A-Za-z0-9_-]`. The track form needs **exactly two** segments, and neither segment may be a reserved word. Examples: `sets`, `likes`, `reposts`, `tracks`, `albums`, `you`, `discover`, `search`.
- The query may contain only SoundCloud's own share keys, each at most once: `si`, `utm_*`, `ref`, `p`, `c` and `in`. The query is then **discarded**.
- **yt-dlp only ever receives a URL rebuilt from the validated parts: `https://soundcloud.com/<user>/<track>`.**
- **Shortlinks** are resolved without yt-dlp:
  - with a GET, where the body is never read;
  - with at most 5 redirects, and relative `Location` headers allowed;
  - every hop's host is checked **before** it is requested, and only `on.soundcloud.com` is ever requested;
  - the final URL must be https on `soundcloud.com` or `m.soundcloud.com` (normalised) with exactly two path segments, and its query and fragment are dropped.
- **Connect-time guard:** for the shortlink and artwork requests, every address the name resolves to must be publicly routable. Loopback, RFC1918, CGNAT, link-local and metadata, multicast, reserved, and IPv4-mapped forms of those are refused. This is the in-process second layer. The `fetch-egress` rules below are the first.

## The yt-dlp invocation

```
python -I -B -m yt_dlp --ignore-config --no-cache-dir --use-extractors soundcloud --no-playlist \
  --max-filesize 60M --restrict-filenames --no-exec --no-write-comments --no-mtime \
  -o '/staging/fetch/<uuid>/audio.%(ext)s' --write-info-json -- <canonical url>
```

- `python -I -m yt_dlp` is the same program as the `yt-dlp` console script. `-I` ignores `PYTHON*` variables and keeps the current and script directories off `sys.path`.
- The environment is exactly `{PATH=/usr/local/bin:/usr/bin:/bin, HOME=/tmp}`. It is constructed, never copied from `os.environ`.
- stdin is `/dev/null`, fds are closed, and the working directory is `/tmp`.
- The child runs in its own session. The **whole process group** is SIGKILLed on a timeout, a size cap or SIGTERM, and also after a normal exit, so no grandchild survives.
- `--use-extractors soundcloud` is a full-match regex over extractor names. It loads **only** `SoundcloudIE`, so `soundcloud:set`, `soundcloud:user`, generic and the rest are never loaded. With the pinned version, a set URL fails with "No suitable extractor found", which was verified offline.
- **The info JSON is parsed as data only.** fetch reads `_type`, `entries`, `extractor`, `extractor_key`, `duration`, `title`, `uploader`, `genre` / `genres[0]`, `description`, `license`, `id`, `thumbnails` and `thumbnail`. Nothing from it is executed or used to build a path. It is deleted after parsing, so only media remains in staging.
- **ffmpeg is deliberately not in this image.** yt-dlp downloads SoundCloud's HLS formats with its native Python HLS downloader, and ffmpeg fix-up steps are skipped with a warning. The one real smoke run produced fragmented MP4 (`hls_aac_160k`), which `ffprobe -protocol_whitelist file -f mp4` reads correctly. This differs from the plan's "yt-dlp + ffmpeg" line in §3; see "Decisions for review".

## Artwork

- fetch picks one thumbnail, preferring `t500x500`, then `crop`, `t300x300` and `original`, then the `thumbnail` field.
- If that URL is not `https://*.sndcdn.com`, the **whole job fails** with `artwork_host`, and no request is made.
- The download uses no redirects, a 20 s socket timeout, a 30 s overall deadline, `Content-Type: image/*`, and a cap of **5 MiB**, checked against both Content-Length and the streamed byte count.
- The file is written with `O_EXCL|O_NOFOLLOW` as `artwork.raw`. **fetch never decodes it.**
- A transfer problem only drops the artwork and adds a warning.

## Integration

### 1. Compose service block

Add this to `music/compose.yml`. It reuses the file's `x-hardening` anchor.

```yaml
  music-fetch:
    <<: *hardening            # read_only, no-new-privileges, cap_drop ALL, watchtower off, log caps
    image: ghcr.io/jason-tucker/euphoricfm-website-music:fetch-${MUSIC_TAG:?set MUSIC_TAG in .env}
    init: true                # reaps orphans (python is not a PID-1 reaper)
    # NO env_file and NO environment: the service refuses to start (exit 78)
    # if any unexpected variable name is present.
    tmpfs:
      - /tmp:size=16m,uid=1000,gid=1000,mode=0700
    mem_limit: 160m
    pids_limit: 64
    # PINNED MOUNTS (plan §3): /staging/fetch and /spool/fetch ONLY.
    volumes:
      - ${MUSIC_DATA_DIR:-./data}/staging/fetch:/staging/fetch:rw
      - ${MUSIC_DATA_DIR:-./data}/spool/fetch:/spool/fetch:rw
    networks:
      - fetch-egress
    depends_on:
      music-init:
        condition: service_completed_successfully
```

And add this under the top-level `networks:` key:

```yaml
  fetch-egress:
    driver: bridge
    enable_ipv6: false
    driver_opts:
      com.docker.network.bridge.name: br-efm-fetch   # fixed name, so the INPUT rule below can match it
    ipam:
      config:
        - subnet: 172.31.251.0/24   # CHECK it is free on botvps first (docker network inspect), like P1-net
```

Notes:
- **Volumes.** `music/scripts/init-dirs.sh` already creates `staging/fetch`, `spool/fetch/in` and `spool/fetch/out`, owned by 1000:1000. fetch runs as uid 1000 and creates `spool/fetch/claimed` itself.
- **Worker mounts.** The `music-worker` mounts already match: `/spool/fetch/in` rw and `/spool/fetch/out` ro. The worker never mounts `/staging/fetch`.
- **Probe mounts.** `music-probe` sees `/staging/fetch/<uuid>/…` through its existing `/staging` rw mount.
- **Staging retention.** fetch sweeps `/staging/fetch/<uuid>/` directories whose mtime is more than 24 h old, checked every 10 minutes. Set this with `--staging-ttl-hours N`, where 0 disables it. The worker and probe need not delete them, but the probe may once it has transcoded to `/staging/uploads/sc-<uuid>.mp3`.
- **Memory.** Only idle use was measured. Peak memory during a real download was not measured; check it during P5 verification with `docker stats` or the cgroup `memory.peak`, and raise `mem_limit` if needed. yt-dlp is the peak consumer.
- **Command-line flags.** The service takes flags only, never environment variables: `--spool-dir`, `--staging-dir`, `--home-dir`, `--ytdlp PATH`, `--timeout S`, `--staging-ttl-hours H` and `--once`. The defaults are the production paths, so the compose file needs no `command:`.

### 2. CI and the image

Build this directory as its own context:

```
docker build -t ghcr.io/jason-tucker/euphoricfm-website-music:fetch-<sha> music/fetch
```

- This replaces the `fetch` stub target in `music/Dockerfile`: delete that stub, or leave it unused.
- Add a CI step that runs the test stage under the runtime constraints:

```
docker build --target test -t fetch-test music/fetch
docker run --rm --read-only --tmpfs /tmp:size=64m,uid=1000,gid=1000 --cap-drop ALL \
  --security-opt no-new-privileges:true --network none fetch-test
```

- The repo-level `CHANGELOG.md` entry and the `package.json` version bump are made at merge time. This directory's own history is in `music/fetch/CHANGELOG.md`.

### 3. Requirements on music-probe (the `probe_fetch` / `cover` types)

1. **Re-validate the path.** Accept only `files.audio` matching `^/staging/fetch/<the job's uuid>/audio\.(mp3|m4a|mp4|opus|ogg|oga|wav|flac)$`, opened with `O_NOFOLLOW`. Then re-hash the file and require it to equal `rawSha256` before parsing anything. The same applies to `artwork.raw` and `artworkSha256`.
2. **Force the demuxer** from the detected container: `-f <ffmpegFormat>`, where `ffmpegFormat` is one of `mp3`, `mp4`, `ogg`, `wav` or `flac`. Map it through the probe's own allowlist; never pass the field through unchecked. Plan §3.6 lists mp3/mp4/ogg. `wav` and `flac` can occur only through SoundCloud's "original download" format, and the probe decides whether to accept or reject them.
3. **Allow only the file protocol:** use `-protocol_whitelist file`, never `file,pipe`, for fetch output. The magic check identifies the container but does not guarantee the parser is safe. HLS playlists and MPEG-TS are already rejected here, and the forced `-f` and the whitelist make sure a playlist can never cause egress.
4. **Re-check the real duration** (30 s to 20 min) from the decoded stream. fetch trusts only the info JSON's duration.
5. **Artwork:** sniff the type (JPEG, PNG or WebP), force that decoder, and re-encode to JPEG of at most 1000 px, the same as uploads.
6. Verified on the smoke output with the portal's probe image: `ffprobe -hide_banner -protocol_whitelist file -f mp4 -threads 1 …` reads the fMP4 AAC with the correct duration.

### 4. Requirements on music-worker

- Read `out/<uuid>.json` with `O_NOFOLLOW` and the 64 KiB cap, and parse it with a strict schema. `status` must be `ok` or `error`, and `errorCode` must be one of the 12 codes above.
- Treat `meta.*` as untrusted display text.
- Submit `probe_fetch` to `/spool/probe/in-worker` only.

## Host step (not applied): DOCKER-USER egress rules for fetch-egress

These rules belong to P0b and Deploy-1, next to the worker-egress rules. **Apply them before the first real fetch** on botvps, as root:

```sh
SUBNET=172.31.251.0/24
# Forwarded traffic from fetch containers to private, CGNAT and link-local/metadata space
for NET in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  iptables -I DOCKER-USER -s "$SUBNET" -d "$NET" -j DROP
done
# Traffic addressed to the HOST itself (the bridge gateway 172.31.251.1, the droplet's public IP,
# docker0 and so on) goes through INPUT, not FORWARD, so DOCKER-USER never sees it. Block it too:
iptables -I INPUT -i br-efm-fetch -j DROP
```

- **DNS.** Container DNS goes to Docker's embedded resolver at 127.0.0.11, inside the container's namespace. If the droplet's upstream resolver is itself an RFC1918 or CGNAT address, add an `ACCEPT` for exactly that resolver's IP and port 53 **above** the DROP rules, then re-check. DigitalOcean's default resolvers (67.207.67.2 and .3) are public.
- **IPv6.** The network is created with `enable_ipv6: false`, so no ip6tables rules are needed.
- **Persistence.** DOCKER-USER survives Docker restarts but **not reboots**. Persist these rules with whatever mechanism P0b uses for the worker-egress rules, and record them in the vault.
- **Verification** (plan §6 P5, "egress to RFC1918 and metadata is blocked"):

```sh
docker exec efm-music-music-fetch-1 python -I -c '
import socket
for h,p in [("169.254.169.254",80),("10.0.0.1",80),("172.31.251.1",22),("192.168.1.1",80),("100.100.100.100",53),("1.1.1.1",443)]:
    s=socket.socket(); s.settimeout(3)
    try: s.connect((h,p)); print(h,"OPEN")
    except OSError as e: print(h,"blocked:",type(e).__name__)
    finally: s.close()'
```

Only `1.1.1.1` may print `OPEN`.

## Version pins and the monthly bump

| Pin | Value | Where |
|---|---|---|
| Base image | `python:3.13-alpine@sha256:79e7a9b9ff1cbceff819f856fb374477792a5967759d94df266de7b7b4120e6f` (Python 3.13.15, built 2026-09-17) | `Dockerfile` `ARG PYTHON_IMAGE` |
| yt-dlp | `2026.8.19`, wheel sha256 `1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf`, with no OSV advisories at pin time | `requirements.txt` |

**Do a monthly review, on or around the 27th. The next one is due 2026-10-27.** Bump sooner for any yt-dlp security release, and whenever SoundCloud extraction breaks. yt-dlp ships fixes for SoundCloud-side changes often.

1. Get the latest version and its wheel hash: `curl -s https://pypi.org/pypi/yt-dlp/json`, then read `info.version` and the `.whl` `digests.sha256`.
2. Check the version for advisories: `curl -s -d '{"package":{"name":"yt-dlp","ecosystem":"PyPI"},"version":"<v>"}' https://api.osv.dev/v1/query`.
3. Update `requirements.txt`, including the version, the hash, the "pinned" date and the "next review" line.
4. Re-pin the base image digest: `docker pull python:3.13-alpine`, then `docker image inspect --format '{{index .RepoDigests 0}}'`.
5. Rebuild, and run the test stage under the runtime constraints (see "CI and the image").
6. Check that the pinned flags still parse, offline:
   `docker run --rm --network none --entrypoint python <img> -I -m yt_dlp <pinned flags> -o '/tmp/x/audio.%(ext)s' --write-info-json -- https://soundcloud.com/a/sets/b`
   This must print `No suitable extractor found`, not an option error. If the wording changes, update the classifier in `service.py` and the `nosuitable` stub case.
7. Add a line to `CHANGELOG.md` in this directory.

The repo already uses Dependabot, which handles hash-locked `requirements.txt` and digest-pinned `FROM`. To automate the bump, add this to `.github/dependabot.yml` at integration time:

```yaml
  - package-ecosystem: pip
    directory: '/music/fetch'
    schedule:
      interval: monthly
  - package-ecosystem: docker
    directory: '/music/fetch'
    schedule:
      interval: monthly
```

The Renovate equivalent, if the repo moves to Renovate, is `{"matchFileNames": ["music/fetch/**"], "schedule": ["on the 27th day of the month"]}` with `pip_requirements` and `dockerfile` managers.

## Tests

The tests use the standard-library `unittest` and need no network and no real SoundCloud. **Run them in the test container**, not as root on a host. Some tests plant symlinks, although every symlink points only at decoys inside the temp tree.

```
docker build --target test -t efm-music-fetch:test music/fetch
docker run --rm --read-only --tmpfs /tmp:size=64m,uid=1000,gid=1000 --cap-drop ALL \
  --security-opt no-new-privileges:true --network none efm-music-fetch:test
```

| File | Covers |
|---|---|
| `test_urls.py` | Every accept and reject case. Includes `soundcloud.com.evil.com`, `evil.com/soundcloud.com`, `@` tricks, ports, IDN, punycode and fullwidth lookalikes, IP literals, encodings, query-parameter trickery, sets, likes, reposts and secret tokens. |
| `test_shortlink.py` | A **local redirect server**: chains, a relative `Location`, exactly 5 redirects allowed and a 6th never requested, and foreign, userinfo, port, http, metadata, IDN and api hosts refused before they are requested. Also covers 404, 200, 500, a timeout, and the connect-time public-IP guard (the production opener refuses `localhost`). |
| `test_spool_e2e.py` | The spool protocol end to end with `stub_ytdlp.py`, which emits fixture files. Covers every container type, timeout, too_large (directory cap, RLIMIT and yt-dlp's message), too_long (stopped early), playlists and foreign extractors, magic-byte rejects (HTML, HLS, MPEG-TS, mismatch, symlink, hard link), the artwork allowlist (no request made) and artwork skips, request-document validation, no clobbering, recovery, SIGTERM abort, grandchild kill, and the staging sweep. The stub also asserts the **exact pinned flags**. |
| `test_runner.py` | The pinned argv, the directory-cap kill, the timeout kill, the RLIMIT_FSIZE backstop, the bounded output tail, and stdin being closed. |
| `test_artwork.py` | The host allowlist and the capped, redirect-free download. |
| `test_magic.py` | Allowed and rejected containers. |
| `test_env_secrets.py` | Proof that no env secrets are read. **Static:** only `envguard.py` touches the environment, it reads names only, and every subprocess call passes `env=`. **Startup:** the real entry point exits 78 on an unexpected variable and prints the name, never the value. **Runtime:** through the real entry point, the child's execve environment is exactly `{PATH, HOME=/tmp}`. |

## Decisions for review

- **No ffmpeg in fetch**, although the plan's §3 table says "yt-dlp + ffmpeg". Leaving it out keeps a remote-input media parser out of the only container with internet egress. yt-dlp's native HLS downloader handles SoundCloud; the smoke output was fMP4 AAC and probes correctly. If a future SoundCloud format needs ffmpeg, adding it here is a plan change.
- **"Original download" format.** When an uploader enables downloads, yt-dlp prefers the original file (`format_id=download`, quality 10). That file can be a large WAV or FLAC, which fails with `too_large`, or AIFF, which fails with `bad_media`, even when a stream format would fit. Fixing this means adding `-f` to the pinned invocation, for example `-f 'bestaudio[format_id!=download]/bestaudio'`, which is a plan change.
- **Input host is strict.** `m.soundcloud.com` and `www.soundcloud.com` are rejected on **input**, following the brief's "accept only". `m.` is accepted only as a shortlink's final host. Relaxing the input rule is a one-line change in `urls.py`.
- **Artwork host violation fails the whole job**, because `artwork_host` is a contract error code. A transfer problem only drops the artwork.
