# euphoricfm-website

The in-game phone site for **EuphoricFM**, the pop radio station of a GTA5
roleplay server. Lives at [info.euphoric.fm](https://info.euphoric.fm), embedded
inside the in-game phone's iframe browser.

## Overview

EuphoricFM is a single-page Astro site sized for a phone screen (~360–400px) and
designed to render inside a FiveM in-game phone's CEF iframe browser. It drives
all of its UI from AzuraCast's public JSON and lets listeners interact without
leaving the phone:

- **Live now-playing** — current track, album art, animated progress bar,
  listener count, "up next" reveal, and a recently-played list, all polled from
  AzuraCast every 5 seconds.
- **Song requests** — search the AzuraCast library and enqueue a request, with a
  shared "Requested Songs" list every visitor sees.
- **Submit a song / Contact us** — forms that post to Discord webhooks for
  artist submissions and general contact.
- **Iframe-first** — explicitly embeddable from anywhere, no framebusting, no
  PWA bits that trip up CEF, served direct (no Cloudflare proxy) so the in-game
  phone can load it.

The footer of every page renders `v<version> · <short SHA>` so you can always
tell which build is live.

## Architecture

Static Astro build composed from a single page and a set of `.astro`
components, hydrated by two client scripts.

```
src/
  layouts/BaseLayout.astro    HTML shell; injects window.__EFM_CONFIG__ +
                              loads /efm-runtime-config.js (webhooks) + the
                              effects backdrop + client scripts
  pages/index.astro           composes the single page top-to-bottom
  site.config.ts              one source of truth for editable strings + URLs
  lib/azuracast.ts            TS types + URL helpers for the AzuraCast API
  lib/version.ts              footer version + sha (reads package.json + env)
  scripts/nowplaying.ts       polling + RAF progress bar + recently-played +
                              up-next + pending-requests + Media Session
  scripts/effects.ts          spring "honey float", music reactivity, album-art
                              colour theming, the footer Effects toggle
  styles/tokens.css           centralised CSS colour tokens — brand palette
                              (RGB channels) + semantic surface/text/accent roles
  styles/global.css           Tailwind v4 CSS-first @theme config + @font-face
                              + component layer (colours resolve to tokens.css)
  components/
    Header.astro              wordmark (Begaron + Cortado Script)
    PlayerCard.astro          live player: now-playing, progress, play/volume,
                              up-next, Web Audio analyser feeding --efm-* vars
    ListenButton.astro        HTML5 audio + volume (merged into PlayerCard)
    ActionRow.astro           four CTAs that dispatch efm:open-* events
    RecentlyPlayed.astro      list skeleton, hydrated by nowplaying.ts
    RequestedSongs.astro      shared pending-requests card, hydrated client-side
    About.astro               "What is EuphoricFM?" blurb (aboutText)
    RequestModal.astro        AzuraCast library search + same-origin POST
    SubmitSongModal.astro     Discord webhook — artist song submission
    ContactModal.astro        Discord webhook — general contact form
    BusinessAdModal.astro     static pricing + perks
    Footer.astro              copyright + Effects toggle + v<version> · <sha>
public/fonts/                 Begaron + Cortado Script TTFs/WOFF2
public/cef-test.html          plain-HTML no-JS diagnostic page for confirming
                              the in-game CEF iframe can reach the origin
public/sw.js                  service-worker killswitch (unregisters any SW
                              from an older PWA-era build; no active SW today)
server/                       efm-requests — tiny zero-dep Node service holding
                              the shared pending-requests list (own image)
Dockerfile                    node:24-alpine build → caddy:2.x-alpine serve
Caddyfile                     static + iframe-safe CSP + Let's Encrypt + proxies
docker-compose.yml            efm-web + efm-requests + watchtower
.github/workflows/build-and-publish.yml
```

**How the page composes:** `index.astro` wraps everything in `BaseLayout`, which
injects `window.__EFM_CONFIG__` (API base, station shortcode, poll interval) and
loads `/efm-runtime-config.js` — a tiny script Caddy renders from env at request
time so Discord webhook URLs are never baked into the bundle. `nowplaying.ts`
then polls `/api/nowplaying/<station>` on a 5s interval; between polls a
`requestAnimationFrame` loop interpolates the progress bar from the
server-provided `played_at` + `duration`, so the UI feels real-time without SSE.
Track changes are detected via `sh_id`. `effects.ts` owns the optional visual
layer (music reactivity, "honey float" physics, album-art theming) and degrades
to a clean static look inside the iframe or when the Effects toggle is off.

## Stack

Locked — don't swap these without a deliberate decision:

- **Astro 6** static (no SSR) · **Tailwind 4** (CSS-first `@theme` config, no
  `tailwind.config.mjs`) · **TypeScript strict**
- **Caddy 2** in front, serving the static build and terminating TLS
- **Direct ingress** — Caddy binds the host's public 80/443 (no Cloudflare
  proxy; see [Deployment](#deployment))
- **pnpm 10** · **Node 24**
- **Docker Compose** with **Watchtower** for auto-deploy from GHCR

## Quick start

Local development:

```sh
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # writes ./dist
pnpm preview      # serve the built ./dist locally
```

> Note: now-playing, the stream, song requests, and album art all call the live
> AzuraCast instance at `euphoric.fm` directly in `pnpm dev`. The same-origin
> `/api/*`, `/efm-art/*`, `/static/*`, and `/requests/*` proxies only exist in
> the Caddy layer, so request submission and album-art colour theming behave
> fully only against a Caddy/Docker build, not the bare dev server.

## Configuration

Almost every string and URL lives in
[`src/site.config.ts`](src/site.config.ts) — keep editable copy there, don't
sprinkle it across components:

- Station name + tagline + description
- "What is EuphoricFM?" paragraphs (`aboutText`)
- Business AD price, perks, and note
- AzuraCast API base + station shortcode + stream URL
- Poll mode + interval (`realtime`)
- Discord avatar URL + NewDayRP profile validation pattern

**Discord webhooks are NOT in `site.config.ts`.** They're injected at runtime by
Caddy, which renders `/efm-runtime-config.js` from the container's env vars so no
webhook URL is ever baked into the static bundle. Set them in `.env` on the host:

| Env var | Used by |
| --- | --- |
| `PUBLIC_DISCORD_REQUEST_WEBHOOK` | "Submit a song" modal |
| `PUBLIC_DISCORD_CONTACT_WEBHOOK` | "Contact us" modal |
| `SITE_HOSTNAME` | hostname Caddy serves + provisions a Let's Encrypt cert for |
| `TICKETS_GG_HOSTNAME` | second reverse-proxied host (`tickets.euphoric.gg`) |

To change a webhook without rebuilding the image, edit `.env` on the host and run
`docker compose up -d` (Compose only re-reads `.env` on `up`, not `restart`).

## Usage / Integrations

### AzuraCast

Everything visible on the page comes from AzuraCast's public, unauthenticated
JSON for the station shortcode **`euphoricfm`**:

- **Now playing** — `GET /api/nowplaying/euphoricfm`. The `now_playing` object
  carries `sh_id` (unique per playback, used for track-change detection),
  `played_at` (unix seconds), `duration`, and `elapsed`. The client interpolates
  the progress bar from `played_at` + `duration` rather than waiting on the next
  poll. Listener count is `listeners.current`; the recently-played list is
  `song_history[]`; the up-next reveal uses `playing_next`. `is_request` drives
  the REQUESTED badge.
- **Requests** — `GET /api/station/euphoricfm/requests` returns the requestable
  library; each entry has a `request_url`. **POST to that `request_url`, don't
  hardcode the numeric station id** (it's `1` internally, but the payload's
  `request_url` is the source of truth). See `absoluteRequestUrl()` in
  `lib/azuracast.ts`.
- **Album art** comes from `euphoric.fm` (cross-origin) and that origin sends no
  `Access-Control-Allow-Origin`, so reading it onto a `<canvas>` for colour
  theming would taint it. The client rewrites art URLs to the same-origin
  `/efm-art/*` proxy; the art endpoint 302-redirects to a relative `/static/...`
  path, which is why `/static/*` is proxied too (see Caddyfile).

### Iframe / CEF constraint

This site is embedded inside the in-game phone's CEF iframe browser, so:

- Caddy emits `Content-Security-Policy: frame-ancestors *` and does **not** set
  `X-Frame-Options` — embeddable from anywhere.
- No framebusting, no `window.top`, no breaking out of the iframe.
- Phone-sized layout: design for ~360–400px wide with a mouse cursor, 48px
  minimum tap targets, no hover-only affordances. Use the `.phone` container.
- No render-blocking external fonts/CDNs, no PWA manifest/service worker — older
  CEF builds failed to first-paint with those present (the wordmark fonts are
  self-hosted from `/fonts/`).

### Discord webhooks

The "Submit a song" and "Contact us" modals POST directly to the configured
Discord webhooks (read from `window.__EFM_CONFIG__.discord.*` at submit time).
The payload matches the embed shape AzuraCast's own button uses —
`username`, `avatar_url`, `thread_name`, and
`embeds[{ title, description, fields, color, timestamp, footer }]` — so the
team's existing Discord thread routing keeps working. Posting straight from the
browser (rather than proxying through Caddy) is deliberate: Discord sees real
user IPs for its own per-user rate limiting.

## Deployment

Push to `main` → GitHub Actions builds the multi-stage Docker image and pushes
`ghcr.io/jason-tucker/euphoricfm-website:latest` (and, in parallel, the
`euphoricfm-website-requests` image) → Watchtower on the VPS auto-pulls within
~60s. Push to `main` → live in ~60–90s. The footer shows `v<version> · <sha>` so
you always know which build is running.

### Direct Caddy ingress (the account-wide exception)

As of 0.4.0 this stack's Caddy binds the host's public **`0.0.0.0:80` +
`0.0.0.0:443`** directly and terminates TLS via Let's Encrypt — **no Cloudflare
proxy.** This repo is the deliberate exception to the account-wide "loopback
only / Cloudflare in front" rule, because the primary use case — the custom
in-game phone CEF iframe — couldn't load Cloudflare-fronted content (CF's
bot-detection layer silently rejected CEF's TLS fingerprint). Going direct
removes that layer. Notable consequences baked into the config:

- TLS forces an **RSA cert** (`key_type rsa2048`) so the chain goes via ISRG
  Root X1, and **HTTP/3 is disabled** — some CEF builds hung negotiating QUIC.
- Caddy also reverse-proxies the requests API (`/requests/*` →
  `efm-requests:3000`), the request-submit + library (`/api/*`), and album art
  (`/efm-art/*`, `/static/*`) — all same-origin workarounds for CORS.
- A second host block serves `tickets.euphoric.gg` → `tickets-web:3000` over the
  shared external `efm-public-net` bridge.

Because of the wider exposure, the container is hardened: `cap_drop: ALL` +
`cap_add: NET_BIND_SERVICE` (just enough to bind privileged ports),
`no-new-privileges: true`, `read_only: true` rootfs, tmpfs `/tmp`, named volumes
only for Let's Encrypt cert persistence (`/data`, `/config`), and Caddy's admin
API off.

### One-time setup on the VPS

```sh
docker network create efm-public-net      # shared bridge (first time only)
cd ~/stacks/euphoricfm-website
cp .env.example .env
# edit .env — set the webhook URLs (and any hostname overrides)
docker compose up -d
```

Point DNS for `info.euphoric.fm` (and `tickets.euphoric.gg`) at the VPS public
IP with the **Cloudflare proxy OFF (gray cloud / DNS-only)** so the CEF iframe
can reach the origin directly. Caddy provisions the Let's Encrypt cert the moment
DNS resolves.

After editing `.env`, always run `docker compose up -d` (not `restart`) —
Compose only re-reads `.env` and adds new services on `up`.

## Conventions

- **CHANGELOG + version.** Every meaningful change adds a line under a **real
  semver heading** (never `[Unreleased]`) and bumps `package.json` "version" in
  the same commit. Dated sections, newest at the top. The footer renders
  `v<version> · <sha>`.
- **Iframe-safe by default.** Don't add framebusting, don't use `window.top`,
  keep `frame-ancestors *` / no `X-Frame-Options`. The site must keep loading
  inside the in-game phone's CEF iframe.
- **Phone-sized everything.** Design for ~360–400px wide and a mouse cursor.
  48px tap targets minimum, no hover-only affordances, use the `.phone`
  container.
- **Editable copy stays in `src/site.config.ts`.** About text, business AD info,
  station name, URLs, etc. live there — not scattered through components.
- **Commit often.** Small, focused commits, messages starting with a
  present-tense verb ("add", "fix", "wire up").
- **Project board card per PR.** Every PR gets a card on the dedicated
  euphoricfm-website Project board before it's opened.

See [`CLAUDE.md`](CLAUDE.md) for the full set of AI-coding instructions.

## License

Private. EuphoricFM brand and content © its respective owners.
