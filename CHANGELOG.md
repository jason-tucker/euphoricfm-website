# Changelog

All notable changes to **euphoricfm-website**. Each PR adds a line under a real
semver heading — never `[Unreleased]` — and bumps `package.json` "version" in
the same commit. The footer on every page renders `v<version> · <sha>` so you
can always tell which build is live.

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
