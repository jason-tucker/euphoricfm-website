# Changelog

All notable changes to **euphoricfm-website**. Each PR adds a line under a real
semver heading — never `[Unreleased]` — and bumps `package.json` "version" in
the same commit. The footer on every page renders `v<version> · <sha>` so you
can always tell which build is live.

## [0.4.0] — 2026-05-29

Major: dropped Cloudflare proxy, Caddy now binds public 80/443 directly with
Let's Encrypt. Plus a player redesign with richer music reactivity.

### Infrastructure (breaking — requires DNS flip)
- Caddy binds `0.0.0.0:80` + `0.0.0.0:443` on the host. Was `127.0.0.1:6094`
  behind cloudflared. The in-game phone CEF iframe couldn't load
  Cloudflare-fronted content (Wix/WP sites worked in the same phone, so we
  isolated the difference to CF's bot-detection layer rejecting CEF's TLS
  fingerprint silently). Going direct removes that layer entirely.
- Let's Encrypt auto-provisioning via Caddy ACME. Certs persist in a named
  Docker volume so renewals survive container restarts. Will issue the
  moment DNS points at the VPS public IP.
- **DNS flip required**: in Cloudflare, change `info.euphoric.fm` A record
  to `147.182.169.215` and toggle it to **DNS-only (gray cloud)**. The site
  is offline for ~5 min during propagation, then comes back without CF in
  the path.

### Security review + hardening
- Container: `cap_drop ALL` + `cap_add NET_BIND_SERVICE` (just enough to
  bind privileged ports), `security_opt: no-new-privileges:true`,
  `read_only: true` rootfs, tmpfs `/tmp`, named volumes only for cert
  persistence. Watchtower also gets `no-new-privileges`.
- Security headers added: `Strict-Transport-Security: max-age=31536000`,
  `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` denying camera/mic/geo/payment/USB/etc.,
  `-Server` to strip Caddy's version, kept `frame-ancestors *` since the
  in-game phone iframe is the primary use case.
- Caddy admin API explicitly `admin off`.
- `/sw.js` now served with `no-cache, no-store, must-revalidate` so the
  0.3.7 killswitch SW always reaches clients fresh.
- Healthcheck added: hits Caddy on loopback so docker knows when the
  container is unhealthy.
- Documented in Caddyfile: webhook URLs in `/efm-runtime-config.js` ARE
  intentionally exposed client-side. Trade-off — proxying through Caddy
  would mean Discord sees only our IP for ALL posts, breaking per-user
  rate limits. If the webhooks ever get abused at scale, rotate them in
  Discord channel settings and update `.env`. Real abuse mitigation needs
  a rate-limit plugin (not stock Caddy) — punted for now.

### Player redesign
- Play button now overlays the album art (Spotify/Apple-Music style).
  Translucent ink-coloured disc with a bass-driven sunburst glow halo
  when playing — feels like one integrated component instead of three
  stacked rows.
- Volume slider moved inline with the listener count and restyled with a
  custom thumb + filled track. Slim, integrated, still 12px tappable thumb.
- Removed the standalone transport row. "Tap play to tune in" / "Streaming
  live" label moved next to the times below the progress bar.

### Richer music reactions
- Analyser now writes four CSS variables on `:root` every frame while
  playing: `--efm-bass` (kick), `--efm-mid` (vocals/instruments),
  `--efm-high` (cymbals), `--efm-energy` (overall). Anything on the page
  can react.
- Player card: bass-driven halo (kept), album art subtle bass pulse +
  energy brighten, play button bass glow, progress bar mid-frequency
  shimmer, LIVE dot high-frequency twinkle.
- Site-wide (kept subtle): wordmark `Euphoric`/`FM` gets a small
  bass-driven scale + sunburst text-shadow, body filter brightens ~3%
  with overall energy, action-row buttons + recently-played rows nudge
  up 1px with each kick.
- All reactions stop and CSS vars are removed when audio pauses, so the
  page settles back to its idle look.

## [0.3.8] — 2026-05-28

The custom in-game phone hardcodes the iframe URL so we can't divert to
/cef-test.html for diagnosis. Stripped `/` down to remove every external
dependency and every PWA bit that could plausibly block first-paint in CEF.

- Removed the render-blocking Google Fonts `<link rel="stylesheet">` for
  Inter. The body font-stack already has `system-ui, sans-serif` as a
  fallback, so the layout looks effectively identical without Inter loaded.
  In a CEF iframe that can't reach `fonts.googleapis.com` (sandboxed
  network, CSP, or a slow CDN), the page was blocking on this stylesheet
  before first-paint.
- Removed `<link rel="manifest">`, `<link rel="apple-touch-icon">`,
  `<meta name="theme-color">`, and the Apple mobile-web-app meta tags from
  the head. Some custom phone CEF builds were tripping on manifest parsing
  and refusing to first-paint the iframe.
- Removed the cross-origin `<link rel="preconnect">` lines for
  euphoric.fm + fonts.googleapis.com + fonts.gstatic.com. With no external
  stylesheet to load, none of these preconnects buys us anything.
- Removed the entire PWA install-banner DOM + script + CSS. The killswitch
  in sw.js (0.3.7) means no SW gets installed anyway; the banner was dead
  weight and one more inline script that could fail mid-execution.
- Removed the `pwa-mode` body class plumbing in CSS. Nothing applies it
  any more.

The wordmark fonts (Begaron, Cortado Script) stay — they're self-hosted
from `/fonts/` so they're same-origin and don't depend on any external CDN.

## [0.3.7] — 2026-05-28

In-game phone still wouldn't load after 0.3.6. Confirmed via curl that
Cloudflare is delivering 200 OK with `frame-ancestors *` to a FiveM
CitizenFX User-Agent on both http and https, so the page IS deliverable —
the iframe just never paints. Two diagnostic/defensive changes:

- Added `/cef-test.html` — a zero-JS, zero-fonts, zero-SW plain HTML page
  with inline CSS only. If the in-game phone CAN load this URL but can't
  load `/`, we know the root page's scripts/fonts/SW are at fault. If it
  can't load this either, the iframe never reaches our origin and the
  problem is on the phone resource side (CSP frame-src whitelist, cert
  trust, etc.) which we can't fix from here.
- Converted `public/sw.js` into a self-unregistering killswitch. The
  service worker turned out to be more trouble than it was worth for the
  in-game-phone primary use case: any previously-installed SW (cached in
  the CEF profile from earlier visits) could intercept requests and serve
  stale broken HTML. The new sw.js clears all caches and unregisters
  itself on activate, so the next update cycle leaves no SW behind for
  this origin.

## [0.3.6] — 2026-05-28

In-game phone (FiveM CEF iframe) was loading as a fully black frame. Three
fixes landed together:

- Body `min-height: 100dvh` was the only sizing rule; older CEF builds don't
  understand `dvh` so they dropped the declaration, body had no min-height,
  and the iframe rendered as an empty black rectangle. Now declares
  `min-height: 100vh` first (universal) with `100dvh` as a progressive
  upgrade. Also added an explicit `background-color: #0a0a0a` on `html` as a
  guaranteed fallback so the page never paints to a black void if any body
  styling fails.
- Removed `background-attachment: fixed` from body. CEF iframes don't own a
  scroll viewport, and the fixed-attached gradient layer can fail to paint
  entirely, leaving everything black behind the (transparent) content.
- Removed the `@media (display-mode: standalone | minimal-ui |
  window-controls-overlay)` rule that hid `.efm-extras`. CEF in the in-game
  phone (fullscreen overlay) can falsely match these display modes, which
  was hiding the Action row, Recently Played, and About sections. The
  `body.pwa-mode` JS-applied class still drives the real PWA-install
  behaviour, and the iframe branch in BaseLayout never applies it.
- UI: dropped the SVG icons from the four action-row buttons (Request /
  Submit / Contact / Business AD). Text-only fits the in-game phone width
  better and there's no longer an icon column competing with the label on
  narrow viewports.

## [0.3.5] — 2026-05-28

In-game phone loading reliability — the in-game phone is the most important
use case and the previous build's PWA bits were tripping it up.

- Detect iframe context up-front. Inside an iframe (which is exactly how the
  in-game phone loads this site), skip service worker registration and skip
  the `pwa-mode` class entirely. SWs in iframes can cache broken state across
  sessions in older CEF builds, and `display-mode` media queries can misfire
  and hide the player's surrounding UI.
- Auto-unregister any service worker that a previous build left behind in
  the iframe context — visitors who got stuck on a cached old version will
  clear themselves the next time they load the site.
- Wrap `color-mix(in oklch, ...)` rules in `@supports` blocks and provide
  plain `rgba()` fallbacks for the aurora background and the bass-glow
  halo. Older Chromium builds (pre-111) now render the page cleanly
  instead of dropping the rule.

## [0.3.4] — 2026-05-28

- Remove the spectrum bars and the vinyl-spin on album art (the art isn't
  circular so the spin looked wrong). The bass-driven sunburst glow on the
  player card stays — the Web Audio AnalyserNode now runs silently in the
  background just to feed the `--efm-bass` CSS variable. Cheaper too: fft
  size dropped 1024 → 256 since we only read the bottom 6% of bins.

## [0.3.3] — 2026-05-28

- **Audio spectrum properly reacts to the music**: explicit
  `audio.crossOrigin = 'anonymous'` in JS so the Origin header is sent
  on every stream fetch (AzuraCast already allow-lists info.euphoric.fm);
  explicit `audioCtx.resume()` after creation since Chrome creates the
  context suspended; FFT bumped 256 → 1024 for 512 bins; smoothing
  dropped 0.78 → 0.6 so transients hit visibly; min/max dB tuned for
  better dynamic range. Bars are now logarithmically-binned (bass gets
  more real estate, matching the ear), mirrored from a centerline for
  drama, and 56 bars wide instead of 48. Canvas grows to 80–96px tall.
- **Bass-kick glow**: every frame writes the average bass amplitude to a
  CSS variable on the player card, which drives an OKLCH-blended sunburst
  halo around the card. Pulses on the kick.
- **Recently Played "X minutes ago"** now measures from when the track
  *ended* (`played_at + duration`), not when it started. Tracks that just
  finished show "just ended" instead of an off-by-3-minutes start time.

## [0.3.2] — 2026-05-28

- Tighten desktop layout so the hero (header + player + action row + sticky
  Recently Played sidebar) fits above the fold on a typical 1080p viewport.
  Artwork stays side-by-side at every breakpoint instead of stacking on lg+
  (was making the card 600+px tall). Header wordmark capped at 5xl. Card
  padding evens out at lg. Frame cap dropped from 72rem to 64rem so the
  layout feels denser. Recently Played sidebar capped at 520px tall with
  internal scrolling.

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
