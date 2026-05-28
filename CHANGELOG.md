# Changelog

All notable changes to **euphoricfm-website**. Each PR adds a line under a real
semver heading — never `[Unreleased]` — and bumps `package.json` "version" in
the same commit. The footer on every page renders `v<version> · <sha>` so you
can always tell which build is live.

## [0.3.1] — 2026-05-28

- Up Next slide-down is now timed: reveals only when ≤40s remain on the
  current track (within the 30–45s window the user wanted) and slides back
  out when a new song starts. Panel content is primed on every poll so the
  reveal is instant when the threshold crosses. Lives inside the RAF tick
  so it lines up smoothly with the progress bar, not the 5s poll cadence.

## [0.3.0] — 2026-05-28

Major UX upgrade — site now scales gracefully from in-game phone iframe to
tablet to desktop, and ships a pile of modern web platform features ("tech
demo" mode).

- **Unified PlayerCard** — merged the separate Now Playing + Listen Button
  cards into a single integrated player. Old `NowPlaying.astro` and
  `ListenButton.astro` removed.
- **Up Next slide-down** — when AzuraCast reports a `playing_next` track,
  a panel slides down inside the player showing the next song's art, title,
  and artist. Hides automatically when nothing is queued.
- **Responsive layout** — phone (default, max 24rem), tablet (md/lg, max
  2xl with larger type), desktop (lg+, 12-column hero grid: big now-playing
  on the left, sticky Recently Played sidebar on the right).
- **Web Audio API visualizer** — real-time 48-bar FFT analyser drawing to
  canvas at requestAnimationFrame rate while the stream is playing.
  AzuraCast sends `Access-Control-Allow-Origin: https://info.euphoric.fm`
  on the stream, so we get genuine PCM access. CSS-only pulsing fallback
  if AudioContext creation fails.
- **Media Session API** — track title/artist/album/artwork pushed to the OS
  every time `sh_id` changes, so EuphoricFM shows up on phone lock screens,
  desktop system trays, and hardware media keys / bluetooth headset
  play/pause buttons work.
- **PWA, installable everywhere** — `manifest.webmanifest` + `sw.js`. Service
  worker caches the shell (network-first HTML, cache-first static assets,
  passthrough for `/efm-runtime-config.js` and cross-origin). Display modes:
  `window-controls-overlay` → `standalone` → `minimal-ui` (in order). An
  install banner appears in normal web mode (Chrome/Edge) when the page is
  eligible; dismissal is sticky via localStorage.
- **PWA compact mode** — when running in any standalone display mode (or
  when `body.pwa-mode` is set after `appinstalled`), the site hides every
  `.efm-extras` block (action row, recently played, about) and shows only
  the player. Window stays resizable; the player itself flexes to fit.
- **View Transitions API** — modal open/close uses `document.startViewTransition`
  on supporting browsers for a smooth crossfade. Falls back to plain show/hide.
- **Vinyl-spin album art** — the now-playing artwork rotates while the
  stream is playing; stops when paused. Disabled under
  `prefers-reduced-motion`.
- **OKLCH aurora background** — subtle radial gradient wash using
  `color-mix(in oklch, ...)` for richer color interpolation on supporting
  browsers (Chrome 111+, Safari 16.4+, Firefox 113+).
- **Backdrop-filter glass cards** + hover lift on `(hover: hover)` devices.
- **prefers-reduced-motion** respected globally.
- **Apple touch icon + status bar style** for iOS Add-to-Home-Screen.

## [0.2.1] — 2026-05-28

- Rename runtime-config endpoint `/runtime-config.js` → `/efm-runtime-config.js`
  to bust a Cloudflare-cached 404 (Cloudflare cached the 404 from before the
  endpoint existed with its default 4-hour TTL on errors). Verified via
  `cf-cache-status: BYPASS` on the new path.
- Add `Cache-Control: no-store, max-age=0` on the Caddy `handle_errors` 404
  response so future 404s don't get cached by Cloudflare's edge.

## [0.2.0] — 2026-05-28

- Strip Discord webhook URLs out of source code, build args, and CI secrets.
  They're now templated into `/runtime-config.js` by Caddy at request time
  from the container's `PUBLIC_DISCORD_*_WEBHOOK` env vars (set in `.env` on
  the host). The built image contains zero webhook URLs — swapping a webhook
  is a `.env` edit + `docker compose up -d`, no rebuild needed.
- Modals read webhook URLs from `window.__EFM_CONFIG__.discord.*` at submit
  time and surface a friendly error if they aren't configured.
- Caddyfile uses the `templates` directive scoped to `/runtime-config.js`
  with `Cache-Control: no-store` so changes propagate immediately.

## [0.1.0] — 2026-05-28

Initial release of the in-game phone site for EuphoricFM, served at
[info.euphoric.fm](https://info.euphoric.fm).

- Astro 6 + Tailwind 3 single-page site sized for the in-game phone iframe
  (~360–400px wide). Mobile-first layout, 48px tap targets, no horizontal
  scrolling.
- Live now-playing card driven by AzuraCast's public `/api/nowplaying/euphoricfm`
  endpoint. 5-second polling with a `requestAnimationFrame`-animated progress
  bar so the UI feels real-time without SSE through the Cloudflare tunnel.
  Track changes flash the card via `sh_id` diffing. Recently-played list shows
  the last 8 entries with album art and time-ago labels.
- Built-in stream player using the `https://euphoric.fm/listen/euphoricfm/radio.mp3`
  shoutcast endpoint, with volume slider and tap-to-play (autoplay is blocked
  in iframes — that's by design).
- Four-button action row: **Request a song** (search the AzuraCast library
  and `POST` directly to `/api/station/euphoricfm/request/{id}`),
  **Submit a song** (Discord webhook for artists submitting new tracks for the
  rotation), **Contact us** (Discord webhook with NewDayRP profile URL
  validation), **Business AD info** ($8,000/month static info + cross-link
  to Contact).
- Iframe-safe: Caddy emits `Content-Security-Policy: frame-ancestors *` and
  does NOT set `X-Frame-Options`, so the in-game phone browser can embed the
  page without framebusting issues.
- Custom wordmark: "Euphoric" in Begaron (sunburst yellow `#FEB139`), "FM" in
  Cortado Script (ruby red `#D61C4E`). Brand palette also includes midnight
  blue `#293462` and lemon glow `#FFF80A`.
- Single Caddy container serving static Astro output; binds to
  `127.0.0.1:6094` on the host. Cloudflare Tunnel is the only public ingress.
  Long cache headers on `/_astro/*`, `/fonts/*`, and `/images/*`.
- GitHub Actions builds + pushes `ghcr.io/jason-tucker/euphoricfm-website:latest`
  on every merge to `main`. Watchtower (bundled in compose) auto-pulls within
  ~60s — push to `main` → live in ~60–90s.
