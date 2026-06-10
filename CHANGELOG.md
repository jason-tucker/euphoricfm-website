# Changelog

All notable changes to **euphoricfm-website**. Each PR adds a line under a real
semver heading — never `[Unreleased]` — and bumps `package.json` "version" in
the same commit. The footer on every page renders `v<version> · <sha>` so you
can always tell which build is live.

## [0.10.1] — 2026-06-10 — Any URL path now serves the landing page (in-game phone URL-suffix safety)

### Fixed
- **Unknown paths fall back to the landing page instead of 404.** The in-game
  phone hardcodes a single URL and may append suffixes we don't control (e.g. a
  `?mobile=true` flag — always harmless — but also potentially a *path* suffix
  like `/mobile`, which used to hit the custom 404 page). The Caddyfile's
  static-file serving now lives in a catch-all `handle` with
  `try_files {path} {path}/ /index.html`, so any path that isn't a real built
  file serves `index.html` — whatever the phone appends after `info.euphoric.fm`,
  the site renders. Real files (`/cef-test.html`, `/_astro/*`, `/fonts/*`,
  `/sw.js`) and the proxied prefixes (`/api/*`, `/requests/*`, `/efm-art/*`,
  `/static/*`, `/efm-runtime-config.js`) are matched first and unaffected.

## [0.10.0] — 2026-06-09 — Security hardening pass (stored-XSS fix, request-API hardening, CI scanning)

### Security
- **Fixed a stored XSS reachable by any anonymous visitor.** The shared
  pending-requests service (`server/index.mjs`, public + unauthenticated via
  Caddy `/requests/*`) stored the `art` field verbatim, and `nowplaying.ts`
  interpolated it **unescaped** into `<img src="${art}">` in the "Requested
  Songs" sidebar rendered to *every* visitor. With no `script-src` CSP, a
  payload like `art = 'x" onerror="…'` executed in every browser. Fixed on both
  sides (defence in depth): the client now HTML-escapes `art` everywhere it is
  interpolated (`nowplaying.ts` `renderPending`/`applyRecent`, `RequestModal`
  search results), and the server `sanitizeArt()` collapses anything that isn't
  a plain `http(s)`/root-relative URL to `''`. (CWE-79.)
- **Hardened the public `/requests/track` write endpoint.** Per-client-IP
  fixed-window rate limiting (20/min, `429` past the cap), control-char
  stripping on the free-text fields, byte-accurate body-size enforcement, and a
  graceful `SIGTERM`/`SIGINT` shutdown that flushes the store. Client IP is read
  from the `X-Forwarded-For` Caddy sets to the real `{remote_host}` (the service
  has no host-port binding, so the header is trustworthy). (CWE-770.)
- **Added a behaviour-compatible Content-Security-Policy** to the
  `info.euphoric.fm` site (was `frame-ancestors *` only): `default-src 'self'`,
  `script-src`/`style-src 'self' 'unsafe-inline'` (the page is inline-script
  heavy), `img-src 'self' data: https://euphoric.fm`, `connect-src 'self'
  https://euphoric.fm https://discord.com`, `media-src https://euphoric.fm`,
  `object-src 'none'`, `base-uri 'self'`, `frame-ancestors *` (iframe embedding
  is required). Reduces XSS/exfil blast radius without changing app behaviour.

### Added
- **First test suite (`server/index.test.mjs`, `pnpm test`).** 15 `node:test`
  cases (zero deps) covering the XSS sanitiser, rate limiting, dedupe, the
  50-entry cap, body-size limits, prune, and the HTTP endpoints. `index.mjs` was
  refactored to a side-effect-free factory (`createStore`) so it imports cleanly
  under test.
- **CI security scanning** (`.github/workflows/security.yml`): CodeQL, a
  gitleaks secret scan, the server test suite, a
  `pnpm audit --audit-level=high` gate, and a `caddy validate` check. Added
  `.github/dependabot.yml` (npm + github-actions) to keep dependencies and
  action versions patched, and added `--ignore-scripts` to the build install
  (matching the Dockerfile) so a malicious lifecycle script can't run in CI.

## [0.9.0] — 2026-06-09 — Colour-system overhaul + anti-clash safeguards

### Added
- **OKLCH "safe-gamut" sanitiser for album-art theming.** Album art is arbitrary, so the old extractor could publish a neon, near-black, near-white, or brand-fighting tint straight to `--efm-theme-*` — the root cause of colours occasionally clashing / over-contrasting. The new `effects.ts` pipeline works in OKLCH (perceptually uniform): it clamps chroma into a safe band (`0.05–0.15` → never washed-out, never neon) and lightness into `0.52–0.70` (always legible on the `#0a0a0a` surface, never a white-out), derives an **analogous dom/accent/mute triad from a single seed** so the three theme colours can never clash with *each other*, gamut-maps by scaling chroma down (not hard-clipping a channel, which would shift hue and undo the clamp), and blends each 12% toward the brand gold so a cool/odd cover can't drag the page out of EuphoricFM's warm orbit. Near-grayscale art (OKLCH chroma < 0.03) is left untinted → brand fallback. Verified headless across neon / near-black / near-white / grayscale / blue / pink / teal seeds: every output lands in-band and clears ≥3:1 contrast on the surface.
- **Centralised colour tokens (`src/styles/tokens.css`)** — the single source of truth for the whole palette. Brand anchors are stored as space-separated RGB channels so Tailwind's `/alpha` modifiers (`bg-ruby/20`, `text-cream/60`) and bespoke `rgb(var(--x) / a)` both read the same numbers, plus named semantic roles (surface / line / text / accent / live). Tailwind `colors` now resolve to these vars; no component hardcodes a hex any more (the lone exception — the `<html>` hard-fallback `#0a0a0a` — is intentionally a literal so the ultimate paint-guard never depends on a custom property having loaded).

### Changed
- **Retuned the neon "lemon" `#fff80a` → warm gold `#ffd23e`.** The old lemon's green-yellow cast clashed against the warm sunburst wherever the two sat adjacent (progress bar, button + toggle gradients); the new gold is the same family as sunburst, one step brighter — a smooth amber ramp instead of an orange→neon jump. `lemon` is kept as a Tailwind alias mapping to the gold, so existing `to-lemon` usages updated with zero churn.
- **Multi-hue brand gradients now interpolate `in oklch`** (with an sRGB `@supports` fallback for CEF / older browsers): the navy→red "Business AD" button and the album-themed progress-bar fill no longer dip through a muddy grey-brown midpoint.
- **Every brand colour literal across `global.css`, `Footer.astro`, and `PlayerCard.astro` now references the tokens** (aurora wash, themed scrollbar, now-playing flash, card halo / play-button glow, LIVE-dot twinkle, blob fallbacks, CEF panel fill, range slider, effects toggle). The careful CEF / `@supports` / `prefers-reduced-motion` fallback structure is unchanged — only the colour values were centralised.

### Notes
- No new dependencies; the OKLCH maths (~70 lines) is hand-written in `effects.ts`. All theme rules still read `var(--efm-theme-*, <brand>)`, so the effects-off look and the in-game-phone CEF path are unaffected. Safe-band constants (`BRAND_COHESION`, `C_MIN/MAX`, `L_MIN/MAX`, `SEED_GRAY_C`) are named at the top of the sanitiser for easy tuning.

## [0.8.3] — 2026-06-07 — Fix blank in-game phone (CEF) by disabling blur/filter effects it can't render

### Fixed
- **The site no longer renders blank inside the FiveM in-game phone.** The phone — this project's primary use case — embeds the page in an outdated CEF whose compositor can't render CSS blur/filter the way a normal browser does, which is exactly what 0.7.3/0.8.0 reintroduced: `body { filter: brightness() }` (a whole-page filter pass the software compositor drops → the entire page paints blank), `.card { backdrop-filter: blur() }` (no gameview behind the iframe to sample → solid black rectangles), and three fixed `filter: blur(64px)` background blobs (both of the above, plus very expensive). The page last first-painted cleanly in CEF at 0.3.8 when it was stripped of effects like these. Confirmed by FiveM's own NUI behaviour — see [citizenfx/fivem#3843](https://github.com/citizenfx/fivem/issues/3843).
  - A synchronous `<head>` script in `BaseLayout.astro` now detects FiveM's CEF before first paint via the `CitizenFX` token its NUI core stamps into the user agent ([NUIInitialize.cpp](https://github.com/citizenfx/fivem)) and adds `html.efm-cef`. New CSS under that class strips **only** the blur/filter compositing — it hides the `.efm-bg` blob layer (falling back to the body's static radial-gradient ambience, which is plain CSS and renders fine), drops the `<body>` filter, and removes `backdrop-filter` from `.card` (with a faintly solid panel fill so the cards still read). Layout, colours, and the box-shadow/transform audio reactions are untouched.
  - Normal browsers never match `html.efm-cef`, so the full desktop effects (fluid blurred blobs, frosted cards, body brightness pulse) are completely unaffected.
- **`/cef-test.html` now echoes the user agent and whether `CitizenFX` was detected**, so the in-game phone can confirm both that the iframe reached the site and that blur/filter safe mode will engage.

## [0.8.2] — 2026-06-04 — Restructure README to the shared section template

### Changed
- **README reorganised into the shared cross-repo structure** (Overview, Architecture, Stack, Quick start, Configuration, Usage / Integrations, Deployment, Conventions, License). Same accurate content, predictable order. Corrected the stale "Cloudflare Tunnel is the only public ingress" line — since 0.4.0 Caddy binds the host's public `0.0.0.0:80`/`443` directly with Let's Encrypt and **no Cloudflare proxy** (the account-wide exception, for the in-game phone CEF iframe). Documented the AzuraCast specifics (`request_url` over a hardcoded station id; `sh_id`/`played_at`/`duration` client-side progress), the iframe/CEF constraints, the Discord-webhook embed shape, the same-origin `/api`·`/efm-art`·`/static`·`/requests` proxies, and the container hardening.
- **Added a `description` to `package.json`** (it had none).

## [0.8.1] — 2026-06-02 — Fix album-art proxy redirect (0.8.0 broke the now-playing image)

### Fixed
- **Now-playing album art is no longer broken by the same-origin proxy.** 0.8.0 rewrote `song.art` to `/efm-art/...`, but AzuraCast's `/api/station/<id>/art/<hash>` endpoint 302-redirects to a **relative** `/static/uploads/<file>` path. The browser resolved that against our origin (`info.euphoric.fm/static/...`), which hit `file_server` and 404'd — so the player's main image vanished. Added a `handle /static/*` reverse-proxy to euphoric.fm so the whole redirect chain stays same-origin (we serve no `/static` assets ourselves, so mirroring AzuraCast's is safe). Also dropped the `Access-Control-Allow-Origin` header from the art proxy: euphoric.fm sends none, the read is same-origin now (so none is needed), and Caddy was emitting it twice — a `*, *` value some browsers reject.

## [0.8.0] — 2026-06-02 — Album-art theming, "honey float" physics, Effects toggle + "Requested Songs" rename

### Added
- **Album-art colour theming.** The player card (border, bass halo, play-button glow, progress-bar fill) **and the three floating background blobs** now retint to the current track's album art instead of the fixed brand palette. A tiny hand-written sampler (no library) downscales the art to a 24×24 canvas and derives a dominant / accent / muted swatch, published as `--efm-theme-dom/-accent/-mute` on `:root`. Every themed rule uses `var(--efm-theme-*, <brand>)`, so it falls back to brand colours on extraction failure, first paint, or when effects are off. Solid-colour cues (card border, halos) cross-fade on track change; gradient fills (bar, blobs) snap but are masked by blur/brevity.
  - Album art is cross-origin (`euphoric.fm`), which would taint the canvas. New Caddy `handle_path /efm-art/*` reverse-proxies art through our own origin (mirrors the existing `/api/*` proxy) so the read is clean; `nowplaying.ts` rewrites `song.art` → `/efm-art/...` and dispatches an `efm:track-art` event the theming module consumes.
- **"Honey float" spring physics.** The player card, background blobs, and header wordmark gently rubberband — as if suspended in honey on a couple feet of chain. A single shared spring RAF loop (slightly under-damped, hard ±9px clamp) is perturbed by pointer position and by the browser **window being physically moved** on desktop, and springs back. Per-element depth multipliers create parallax (card floats least, wordmark most). Inside the in-game phone iframe there's no hover/window-move, so it rests at 0 — graceful no-op; theming + audio reactivity still work there. Composed via a new `.efm-float` wrapper layer so orbit drift ⊕ float ⊕ audio reaction never clobber each other.
- **"Effects" master toggle** in the footer. One switch turns audio reactivity, float, blob motion, and album theming on/off; persisted in `localStorage` and applied before first paint (no flash) via a synchronous `<head>` script that sets `html.efm-fx-off`. Defaults **off** under `prefers-reduced-motion` unless the user has explicitly chosen. When off, the page settles to a clean static brand look (CSS-enforced) and the loops stop to reclaim CPU.

### Changed
- **Renamed the sidebar "Your Requests" card to "Requested Songs."** The label is rendered server-side, so it now reads the same on every device/browser (it was never per-browser).

### Notes
- New client module `src/scripts/effects.ts` owns the spring loop, toggle state, colour extractor, and the `window.__efmFx` bridge PlayerCard reads to gate its FFT writes (music keeps playing when visuals are off). No new npm dependencies.

### Changed
- **The music-reactive background is now actually visible and fluid.** 0.7.2 animated `background-position` on three viewport-sized radial gradients baked into `body`. Shifting a 70%-of-viewport soft wash by ±12px is imperceptible — the page tint barely nudged, which read as "nothing happens." Replaced the whole approach with **three real blurred-circle elements** (`.efm-bg` > `.efm-orbit` > `.efm-blob`, injected by `BaseLayout`):
  - Each blob is a heavily-blurred (`blur(64px)`) brand-colour radial disc that **drifts continuously** via a slow GPU `transform` keyframe orbit (26–38s, offset so they never sync), so the backdrop is fluidly alive even with audio paused.
  - On top of the orbit, each blob takes a **per-frame reactive `transform`** from the `--efm-*` vars: a band-driven translate shove (±~25px) plus a `scale(1 → ~1.5)` swell, and an `--efm-energy`-driven opacity pulse (0.42 → 0.76). Blue rides bass, pink rides highs/energy, gold rides mids. `transform`/`opacity` are GPU-composited, so the motion is large and smooth where `background-position` was not.
  - `.efm-bg` is `position: fixed; z-index: 0; pointer-events: none; contain: strict`; `#main` is bumped to `z-index: 1` so all content paints above. `body`'s static base gradient is kept as the at-rest ambience.
- The site-wide `prefers-reduced-motion: reduce` rule already zeroes the orbit animations and reactive transitions, so no extra opt-out was needed.

## [0.7.2] — 2026-06-01 — Fix widescreen Your-Requests cutoff + music-reactive background drift

### Fixed
- **Your Requests no longer gets cut off on widescreen.** Root cause: 0.6.0/0.7.0 tied the sidebar height to the player+buttons column via `align-items: stretch` + `height: 100%`, then split that space with Your Requests capped at 40%. After 0.7.0 removed the Stream/transport row the player column shrank to ~240–280px, so the 40% cap left ~100px for Your Requests — not even enough for a single entry's card chrome. Switched to **content-sized cards** instead: each card sizes to its own data, and a `max-height: 22rem` cap on the inner UL (with the themed scrollbar) handles overflow when a list is long. `.efm-hero` gets `align-items: start` so left and right columns are independent heights — no forced equal-row stretch. Dropped the `.efm-sidebar-section--fill` / `.efm-sidebar-section--natural` modifiers — same behaviour everywhere now. Mobile is unchanged (was always content-sized).

### Added
- **Music-reactive background drift.** `body` background gets a fluid `background-position` derived from the `--efm-bass` / `--efm-mid` / `--efm-high` / `--efm-energy` vars PlayerCard already publishes on `:root` every RAF frame. Each of the three radial-gradient layers drifts on its own axis pair (one driven by bass+mid, one by high+energy, one by mid+bass), giving the impression that the three light pools breathe independently with the track. Output range is ±half the multiplier so center-of-rest is (0,0) and audio-paused state (vars=0) lands exactly on the pre-0.7.2 look — zero risk of an idle page looking different. 80ms linear transition matches the existing player-card halo / progress-bar shimmer cadence. The site-wide `prefers-reduced-motion: reduce` rule already kills the transition, so no extra opt-out needed.

## [0.7.1] — 2026-06-01 — Fix efm-web healthcheck false-unhealthy from TLS-on-loopback

### Fixed
- **`efm-web` no longer reports unhealthy while the site is fine.** The compose healthcheck was `wget --spider http://127.0.0.1:80/`; busybox wget follows the 308 → `https://127.0.0.1/` and dies on `SSL alert number 80` (Caddy has no cert matching `127.0.0.1`). Site itself was always serving 200 — `docker ps` just lied about it. Swapped to `curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:80/`: without `-L` curl doesn't follow the redirect, `-f` doesn't fail on 3xx, so the 308 from Caddy returns exit 0. busybox wget doesn't support `--max-redirect=0` so curl was the cleanest path. Both curl and busybox wget+nc are already in the `caddy:2-alpine` image, no Dockerfile change needed.

## [0.7.0] — 2026-06-01 — Shared Your-Requests + player layout overhaul + REQUESTED badges + themed scrollbar

### Added
- **Shared pending requests** — new `efm-requests` Node service (`server/index.mjs`, ~140 lines, zero deps, node:http + global fetch) Caddy reverse-proxies at `/requests/*`. Replaces v0.6.0's per-browser localStorage so every visitor sees every pending request. Endpoints: `GET /requests/pending`, `POST /requests/track`, `GET /requests/health`. Server polls `/api/nowplaying/euphoricfm` every 30s and drops entries whose `song.id` appears in `now_playing` or `song_history`; 6h TTL + 50-entry cap as backstops. State persists in `/data/pending.json` (named volume `efm_requests_data`) so a Watchtower restart doesn't wipe the list.
- **REQUESTED badge.** When `now_playing.is_request === true`, a sunburst pill renders next to the LIVE/Now Playing chips. Same badge on the Up Next reveal driven by `playing_next.is_request`. Both toggle on every poll.
- New CI job `build-requests` builds + pushes `ghcr.io/jason-tucker/euphoricfm-website-requests:latest` in parallel with the existing site image (separate GHA cache scope so layer caches don't collide). Watchtower picks up both on each push to `main`.

### Changed
- **Player layout overhaul.** Removed the entire "Stream / Streaming live" transport row beneath the progress bar — the red/pink LIVE pill above already signals stream state, the extra label was redundant. Play/pause button now stacks above the volume slider in the top-right of the player card (compact transport column with `flex flex-col items-end`, `width: clamp(3rem, 8vw, 5rem)`). Volume icon dropped — the slider sits right under the play button and reads as a transport control without it.
- **Sidebar reflow — no blank space on Your Requests.** Old layout gave each sidebar card an equal `flex: 1 1 0` share, so a sparsely-populated Your Requests left a fat blank rectangle below it. Now Your Requests is `.efm-sidebar-section--natural` (`flex: 0 1 auto; max-height: 40%`) — it sizes to content with a 40% cap so a full pending list can't dominate. Recently Played is `.efm-sidebar-section--fill` (`flex: 1 1 0`) and absorbs whatever space Your Requests doesn't claim.
- **Themed scrollbar.** New `.efm-sidebar-scroll` rules set `scrollbar-color`/`scrollbar-width` for Firefox and `::-webkit-scrollbar*` for Chrome/Edge. Track is translucent midnight; thumb is the sunburst→ruby gradient with a `background-clip: padding-box` 2px transparent border so it doesn't hug the track edges. Replaces the default chrome scrollbar that looked jarring against the rest of the UI.

### Migration
- One-time on the VPS after this image lands: `docker compose up -d` (not just `restart`) to bring up the new `efm-requests` container and the `efm_requests_data` volume. Watchtower handles the rolling updates after that. Per [[feedback_docker_env_propagation]], `restart` does NOT add a new service from compose — only `up -d` does. The GHCR package `ghcr.io/jason-tucker/euphoricfm-website-requests` will need its visibility flipped to public the first time CI publishes it.

## [0.6.0] — 2026-05-30 — Your-Requests sidebar card + dynamic-height sidebar split

### Added
- **"Your Requests" card in the sidebar.** When a request POST succeeds, `RequestModal.astro` persists the song (`id`, `title`, `artist`, `art`, `ts`) to `localStorage["efm:pendingRequests"]` and fires an `efm:pending-changed` event. `nowplaying.ts` renders that list in a new `RequestedSongs.astro` card below Recently Played, sorted newest-first, with relative-time chips ("just now", "5m ago", "1h ago"). The card hides itself entirely when the pending list is empty so the sidebar doesn't carry dead chrome.
- **Pruning on every poll.** On each 5s `/api/nowplaying` poll, entries whose `song.id` appears in `now_playing.song.id` or `song_history[].song.id` get dropped (they aired). A 6-hour TTL also evicts stragglers — protects against requests that AzuraCast silently rejected. List is also capped at 10 entries on write so localStorage can't grow unbounded.
- AzuraCast's actual request queue requires auth, so this is intentionally a per-browser/per-device view of *your* requests — there's no public "all pending requests" feed to mirror.

### Changed
- **Sidebar height now tracks player+buttons.** Removed `align-items: start` from `.efm-hero` so in the 2-col (≥720px) layout the right column stretches to match the left column's height. New `.efm-sidebar` / `.efm-sidebar-section` / `.efm-sidebar-card` / `.efm-sidebar-scroll` rules give each card an equal flex share of that height with the inner UL scrolling when content overflows. The old `lg:max-h-[min(calc(100dvh-2rem),520px)]` hard cap on Recently Played is gone — when Your Requests is hidden, Recently Played gets the whole sidebar; when it's visible, they split. Narrow/phone layout (one column) is unchanged: cards take their natural content height.
- `RequestModal.astro` library buttons now carry `data-song-{id,title,artist,art}` so the click handler can hand a complete song record to `submitRequest()` for the pending-list write.

## [0.5.6] — 2026-05-30 — Actually wire up the 0.5.5 "Request a Song" fix

### Fixed
- **0.5.5 shipped the CHANGELOG entry and version bump but not the code change.** The `Caddyfile` `/api/*` proxy block and the `RequestModal.astro` same-origin POST rewrite never landed in 9b7ddce — only the docs/version did, so prod kept exhibiting the original "Network error submitting request." behaviour despite the footer reading `v0.5.5`. This commit lands the actual code described in the 0.5.5 entry.

## [0.5.5] — 2026-05-30 — Fix "Request a Song" silently failing with "Network error" toast

### Fixed
- **"Request a Song" modal now actually works.** AzuraCast's `POST /api/station/<id>/request/<songId>` returns its reply without `Access-Control-Allow-Origin` (OPTIONS preflight has it; the actual POST and the 500 "already requested" error responses don't). The cross-origin POST from `info.euphoric.fm` → `euphoric.fm` was reaching AzuraCast and queueing the song, but the browser blocked JS from reading the reply, so `fetch()` rejected and the modal flashed "Network error submitting request." every time — making it look broken when it half-worked. Fix: reverse-proxy `/api/*` through this Caddy to `https://euphoric.fm` (Host header rewritten) so the POST is same-origin; client now strips any host from `request_url` and POSTs to the relative path. The frequent now-playing/library GETs DO return ACAO and continue to call `euphoric.fm` directly, so this only adds VPS traffic for the rare request submissions.

## [0.5.4] — 2026-05-30 — Rename compose service `web` → `efm-web` to clear shared-network alias collision

### Changed
- **Compose service renamed `web` → `efm-web`.** Both this stack and `euphoric-tickets-web` previously auto-claimed the unqualified `web` alias on the shared `efm-public-net` (docker-compose adds the service-name as a network alias automatically). No internal consumer resolved plain `web` today (the Caddy here reverse-proxies to `tickets-web:3000`, and `efm-web` is reached by the host over port bindings, not the docker network), so this was a latent footgun — but anything new that joined the network and resolved `web` would round-robin between two backends. Same failure shape as the `db` collision that broke otterbot's `/oc` (28P01 auth fails) earlier today. After this commit the auto-alias on `efm-public-net` is `efm-web` — unique. Tickets-web's compose is renaming its own service `web` → `tickets-web` in lockstep. Container name changes from `euphoricfm-website-web-1` → `euphoricfm-website-efm-web-1`; brief downtime on `info.euphoric.fm` while `docker compose up -d` recreates it; Let's Encrypt cert volume is preserved.

## [0.5.3] — 2026-05-29

Removed the `tickets.euphoric.fm` Caddy block. `.fm` is served by the
existing cloudflared tunnel (terminates TLS at Cloudflare's edge, forwards
to `127.0.0.1:6095` directly) — no need for this Caddy to also try. Having
the block here just spammed logs with failing ACME HTTP-01 challenges
(DNS for `.fm` resolves to Cloudflare, not this VPS, so the challenge
can never succeed) and risked eating into the LE account-level rate limits
that `info.euphoric.fm` shares.

`tickets.euphoric.gg` block kept — it's the direct-DNS path and works
once the A record points at this VPS.

`info.euphoric.fm` is unchanged — its server block at the top of the
Caddyfile is independent of either tickets path.

## [0.5.2] — 2026-05-29

Split the combined `.fm` + `.gg` tickets block into two independent host
blocks (each importing a shared `(tickets-block)` Caddy snippet so they
don't drift). Provisioning a single cert with both as SANs was failing in
v0.5.1 because `tickets.euphoric.fm` currently resolves to Cloudflare's
edge (cloudflared tunnel), so LE's HTTP-01 challenge for `.fm` never reaches
this Caddy — and a combined cert refuses to issue if any SAN fails.

`info.euphoric.fm` is unaffected — its server block is separate at the top
of the Caddyfile and was not touched.

## [0.5.1] — 2026-05-29

This Caddy now also serves `tickets.euphoric.gg` — a second hostname for the
euphoric-tickets-web app, alongside the existing `tickets.euphoric.fm`.
`.fm` continues to be reachable via the cloudflared tunnel; `.gg` is direct
DNS A record → VPS IP → this Caddy.

- Caddyfile: the existing `tickets.euphoric.fm` server block now matches BOTH
  `tickets.euphoric.fm` AND `tickets.euphoric.gg` (one block, both SANs on
  the same auto-provisioned Let's Encrypt cert). Same TLS + iframe-safe
  headers + reverse-proxy to `tickets-web:3000` on `efm-public-net`.
- docker-compose.yml: new `TICKETS_HOSTNAME` and `TICKETS_GG_HOSTNAME` env
  passthroughs so either hostname can be overridden via `.env` on the VPS
  without rebuilding.

**Outside this repo you still need:**
1. DNS A record `tickets.euphoric.gg → <VPS IP>`, Cloudflare proxy OFF
   (the in-game phone CEF iframe can't load Cloudflare-fronted content).
2. `https://tickets.euphoric.gg/api/auth/callback/discord` added to the
   Discord application's OAuth2 → Redirects panel so OAuth completes when
   users sign in via the `.gg` hostname.

## [0.5.0] — 2026-05-29

This Caddy now reverse-proxies a second hostname: `tickets.euphoric.fm` is
the entry point for the new **euphoric-tickets-web** app. The static
`info.euphoric.fm` site is unchanged.

- Caddyfile: new server block for `tickets.euphoric.fm` with the same TLS,
  HSTS, and iframe-safe CSP defaults as the apex. Reverse-proxies to
  `tickets-web:3000` over the shared `efm-public-net` Docker bridge.
- docker-compose: joined `efm-public-net` (external) so Caddy can resolve
  the `tickets-web` alias defined in the euphoric-tickets-web stack.
- One-time host setup before deploying: `docker network create efm-public-net`.

## [0.4.3] — 2026-05-29

Fully fluid layout — no discrete Tailwind breakpoint jumps anywhere. The
site grows and shrinks smoothly with the viewport so it looks right from a
~320px in-game phone iframe up to a 4K monitor, no awkward gaps at the
in-between widths Tailwind's `lg:` etc. left behind.

- `.phone`: dropped fixed max-widths (`max-w-phone`/`sm:max-w-md`/`md:`/`lg:`).
  Now `width: 100%` + `padding: clamp(0.5rem, 2vw, 2rem)` so the frame
  always fills the available width with fluid breathing room.
- New `.efm-hero` grid for the hero layout: single column until 720px viewport,
  then `minmax(0, 2fr) minmax(16rem, 1fr)` so the Recently Played sidebar
  appears once there's actual room — no breakpoint cliff.
- Wordmark, card padding, section padding, album art size, track
  title/artist/album fonts, progress bar height, transport-row gap + play
  button + volume slider width, times row font — all switched to clamp()
  with sensible min/preferred(vw)/max so they interpolate smoothly.
- Action row: `grid-cols-2 lg:grid-cols-4` replaced with auto-fit
  `repeat(auto-fit, minmax(min(100%, 8rem), 1fr))` so buttons reflow naturally.
- Recently Played list capped at 5 songs (was 8) so the sidebar fits in the
  smaller fluid grid without scrolling on most screens.

## [0.4.2] — 2026-05-29

- Moved the play button off the album art (user feedback: didn't like the
  Spotify-style overlay). Album art is clean again, with the original
  prominent sunburst play button back in its own transport row below the
  progress bar. Volume slider stays restyled (slim custom thumb + filled
  track) and sits to the right of the "Stream / Tap play to tune in"
  label. Bass-driven sunburst glow halo on the play button kept — works
  even better against the bright sunburst fill.
- Listener count moved back to the right of the times row (same row as
  the elapsed/total timestamp).

## [0.4.1] — 2026-05-29

Custom in-game phone CEF iframe STILL wouldn't load after 0.4.0 even with
Cloudflare fully out of the path. Two TLS-layer fixes most likely to
matter for older / restrictive CEF builds:

- Force RSA cert (`tls { key_type rsa2048 }`). Was defaulting to ECDSA,
  which chains via the newer ISRG Root X2 (2020). RSA chains via R3/R10/R11
  → ISRG Root X1, universally trusted since ~2017. Some CEF CA bundles
  may not have X2 and silently fail TLS handshake on ECDSA chains.
- Disable HTTP/3 advertisement (`servers { protocols h1 h2 }`). Caddy was
  advertising HTTP/3 via `alt-svc: h3=":443"`. CEF builds that try QUIC
  and never fall back to HTTP/2 just hang.

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
