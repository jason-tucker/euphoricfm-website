# Changelog

All notable changes to **euphoricfm-website**. Each PR adds a line under a real
semver heading — never `[Unreleased]` — and bumps `package.json` "version" in
the same commit. The footer on every page renders `v<version> · <sha>` so you
can always tell which build is live.

## [0.22.3] — 2026-09-29 — Contact forms relayed server-side

### Security
- **The contact webhook is no longer handed to every visitor.** `/efm-runtime-config.js` served the full Discord webhook URL (id + token), and anyone holding it can post as the webhook (including `@everyone`), rename it or delete it — silently breaking both forms. The "Contact us" and /events inquiry forms now POST their fields as JSON to the same-origin relay (`/contact/message`, `/contact/event`) in the `efm-requests` sidecar, which validates them (required fields, length caps, control characters stripped, the NewDayRP profile pattern), builds the same embeds the pop-ups built before, adds `allowed_mentions: {parse: []}` and forwards them to `DISCORD_CONTACT_WEBHOOK` — a runtime-only env var on `efm-requests` that is never logged and never sent to a browser. Each IP gets 5 sends per 10 minutes across both forms (Caddy's own `X-Forwarded-For`, rightmost entry). Replies: 204 sent, 400 invalid, 413 too large, 429 rate limited (`Retry-After`), 502 Discord failed or timed out (10 s), 503 not configured.
- `/efm-runtime-config.js` answers an uncached **410**; no page loads it any more. The CSP `connect-src` drops `https://discord.com`. Caddy caps `/contact/*` bodies at 32 KB (the sidecar at 16 KiB).
- **Deploy note:** set `DISCORD_CONTACT_WEBHOOK` in the host `.env` and give `efm-requests` the compose line **before** this version goes live (`docker compose up -d efm-requests`; a restart keeps the old env). `PUBLIC_DISCORD_CONTACT_WEBHOOK` is no longer read. Rotate the webhook afterwards — the old URL was public.

### Changed
- Both forms keep their success and error messages; a 429 now reads "You've sent a few messages already — please wait about N minutes and try again." The inputs carry `maxlength`s matching the relay's limits. Line breaks in the message / event details survive (other control characters are stripped).
- `/contact/` (trailing slash) 301s to `/#contact` like `/contact`.

### Tests
- `server/index.test.mjs` (injected fetch only, never a real webhook): both payloads field for field incl. `allowed_mentions`, username/avatar/thread name/colour/footer, the 1024-char clip; required / too long / wrong type / bad profile / bad JSON / non-JSON content type → 400 and nothing forwarded; 413 with and without Content-Length; 5 per IP per 10 min shared by both forms, spoofed XFF prefixes don't help, the window rolls over; upstream HTTP error, network error and timeout → 502; unset or non-https webhook → 503 with a log line; no response or log line ever contains the webhook URL/token or a submitted field.
- `test/caddy-player.sh` runs a stub `efm-requests` on a throwaway network and pins `euphoric.fm` to 127.0.0.1 (no request reaches production): `POST /contact/message` and `/contact/event` reach the sidecar with Caddy's `X-Forwarded-For` (a client-supplied one is dropped), a 40 KB body is a 413 from Caddy, `/api/station/…` still goes to the AzuraCast upstream, `/contact` and `/contact/` stay redirects, `/efm-runtime-config.js` is a `no-store` 410 with no webhook, the CSP has no discord.com.
- `test/site-build.test.mjs`: no built page contains `discord.com`, a webhook path or the runtime-config script; the forms post to `/contact/message` / `/contact/event`; the relay's avatar URL, station name and profile pattern equal `site.config.ts`.

## [0.22.2] — 2026-09-29 — Second pass: fresh pages after a deploy, offline state, copy

### Fixed
- **Returning visitors no longer get a broken page after a deploy.** Pages were served with no `Cache-Control`, so browsers guessed a freshness lifetime of hours and kept an HTML page whose `/_astro/*` files the deploy had already deleted; the SPA fallback then answered those missing scripts and stylesheets with the home page (refused under `nosniff`) — and marked it `immutable` for a year. Now pages carry `Cache-Control: no-cache` (revalidate every visit; the ETag makes it a cheap 304), a missing `/_astro`, `/fonts` or `/images` file is a plain uncached 404, and the immutable / max-age headers only apply to files that exist.
- **Station offline state.** When the AzuraCast API can't be reached (network error, timeout, 5xx) the home card and `/player/` show **"Station offline — retrying"** with the OFFLINE pill instead of a live-looking "Loading…" and AUTO DJ forever; the stream is stopped, Up next and Recently played say so too, and the next good poll repaints everything. Each now-playing request times out after 8 s (`AbortSignal.timeout`), only one is ever in flight, and after three misses in a row the retry slows to every 30 s.
- **A refused Play now says so**: when the browser rejects `audio.play()` the transport resets and a toast reads "Couldn't start the stream. Try again in a moment." (both players).
- **Home card matches the Web Player:** ads and station imaging show as "Station break / EuphoricFM" and are left out of Recently played; the times row can no longer read "3:15 / 3:10".
- **`/player/#history`** (the home card's Song history link) opens the full list on phones and tablets instead of three rows.
- **Old section URLs:** `/stats`, `/stats/`, `/about`, `/listen` and `/contact` 301 to the one-page anchors (`/#stats` …) instead of the home page under the wrong URL or the stats API's JSON 404; `/stats/summary` and the rest of `/stats/*` still reach the sidecar.
- **`/robots.txt` is a real file** (it was the whole home page via the SPA fallback).
- **The shared top bar fits 320–359 px phones** (right gutter and the whole Menu button kept): tighter gap and Web Player padding below 360 px, a slightly smaller wordmark below 340 px. The portal picks it up through `music/src/shared/`.

### Changed
- **Copy:** the spelling is "EuphoricFM" everywhere (the events page, its meta / OG description, the event inquiry pop-up); `/events/` and the pop-up headings are in sentence case like the home ("Plan your event", "How it works", "Request a song", "Contact us", "Plan an event with EuphoricFM" …); the FAQ points at the **Requested** tab.
- **Every Submit music button** (top bar, #music, footer) goes to `music.euphoric.fm/submit`; the footer's "Fix or remove a song" keeps `?intent=edit` like the #music links. The shared bar and phone menu name the product **EuphoricFM Music Portal** (`shared/nav.json`).
- **Wordmark font:** the "FM" script face is served as a 18,992-byte WOFF2 subset (space, A–Z, a–z, with the `kern` + `calt` features the wordmark's contextual "M" needs) instead of the 521 KB TTF, which stays as the last fallback and for `docs/og/og-image.html`. Both wordmark fonts are preloaded. Made from `public/fonts/` with fontTools 4.66 (`pip install fonttools brotli`):
  `pyftsubset CortadoScript-Regular.ttf --unicodes="U+0020,U+0041-005A,U+0061-007A" --layout-features="kern,calt" --no-hinting --flavor=woff2 --output-file=CortadoScript-Regular.woff2`
  (the full basic-Latin range with `calt` came to 28.6 KB; glyph outlines and positions for "FM", "EuphoricFM" and a pangram were checked identical to the TTF with HarfBuzz).
- **`og.png` is 99,895 bytes** (was 329,620): the same 1200×630 image as a dithered 192-colour palette PNG; the Pillow command is in `docs/og/og-image.html`. One `og:image`, still a PNG.
- **Lighter polling:** `/requests/pending` refreshes on a track change, right after a request and every 30 s (skipped while hidden) instead of on every 5 s now-playing poll; `/efm-runtime-config.js` is loaded with `defer` so it no longer blocks the first paint.

### Removed
- The dead PWA files `public/manifest.webmanifest` and `public/icon.svg` (nothing links them since the CEF first-paint fix). `public/cef-test.html` stays as the in-game iframe diagnostic; its copy is corrected.

### Dev
- `@types/node` in devDependencies, so `astro check` is clean and can become a real CI gate.

### Tests
- `test/caddy-player.sh`: `/`, `/player/` and the fallback are `no-cache`; real `/_astro/*.css` and `.js` are immutable; `/_astro/nope.js`, `/_astro/nope.css`, `/fonts/nope.woff2`, `/images/nope.png` are 404 with no `immutable` and no HTML; the WOFF2 is served as `font/woff2`; `/robots.txt` is the file; the five section redirects, `/stats/summary` still proxied and `/aboutx` untouched.
- `test/site-build.test.mjs`: no "Euphoric FM" on any built page; sentence-case headings and the Requested-tab FAQ; every Submit music → `/submit`; the product name in `nav.json`; the phone-bar row budget; the now-playing poller with a failing fetch (5xx, network, timeout → offline; slower retry; recovery) and its in-flight guard; the offline copy and play-failure toast wiring on both players; break filter, clamp and 30 s pending refresh on the home card; `/player/#history` expansion; deferred runtime config; `og.png` ≤ 100 KB; `dist/robots.txt` starts with `User-agent`; no manifest or `icon.svg`; the WOFF2 ≤ 20 KB, listed before the TTF and preloaded.

## [0.22.1] — 2026-09-28 — Up next all song long, one songs card

### Changed
- **Up next shows the whole time.** The player's Up next row shows the next song (art, title, artist, REQUESTED badge and an "in m:ss" countdown) from the start of the current one — AzuraCast cues it at song start — instead of only in the last ~40 s. The reveal delay and the "Shows here near the end of this song" placeholder are gone. When there's no song to show, the same fixed-height row says so in one line: "Station break next" when an ad / station ID is next (same break filter as the Web Player), "Choosing the next song…" when nothing is cued yet, and "Back to the playlist after the live set" during a live set. The Web Player already showed Up next straight away; unchanged.
- **Recently played and Requested songs are one card with two tabs** — *Recently played* (selected by default) and *Requested* with a count badge (a filled badge when something is waiting, a quiet 0 otherwise). The card keeps one constant height (four rows, so on desktop it is exactly as tall as the player beside it and leaves no empty band under the player) on both tabs, so requests arriving or leaving never move anything, and the empty box the old Requested card reserved is gone. The Requested tab lists pending requests (more scroll inside) or, when empty, "No requests right now" with a **Request a song** button that opens the request pop-up. The tabs are bordered buttons with hover / pressed / focus-ring states and full ARIA tabs semantics (←/→, Home/End). Same card, same height, under the player on phones and tablets. `/requests/pending` polling is unchanged.

### Fixed
- **Long titles no longer push the REQUESTED badge and the countdown out of the Up next row.** The row's grid had no column template, so its implicit column grew to the full title width and the title never truncated; the badge and "in m:ss" were clipped off the row's edge (phones for titles like "Fuck You (I Wanna Love Me and Love You)", desktop for ~80-character titles). The column is now `minmax(0, 1fr)`: the title ellipsises and the badge and countdown always stay visible.

### Removed
- `RecentlyPlayed.astro` and `RequestedSongs.astro` (merged into `SongsCard.astro`) and their CSS.

### Tests
- `test/site-build.test.mjs`: no Up next reveal constant or "near the end" copy, the neutral Up next lines and break filter are wired, the songs card is a single sidebar card with a two-tab ARIA tablist (Recently played selected, roving tabindex, panels labelled by their tabs, arrow-key handling), and no standalone Requested card remains; the Up next row's grid column can shrink (`minmax(0, 1fr)`).

## [0.22.0] — 2026-09-28 — One-page radio-first home

### Added
- **The home page is one radio-first page** (Release 4 of the approved redesign), in this order, with ids matching the shared top bar:
  1. **`#listen`** — tagline "San Andreas pop, all day." over the player card (compact on phones, so Play and **Request a song** are on the first screen), with **Request a song** · **Web Player** · **Ways to listen** under it and Recently played + Requested songs beside it on desktop (below it on phones). Requested songs now always shows, with a fixed-height body (room for three requests, more scroll inside it; the empty note sits in the same box), so nothing below it moves when requests come or go. The player's Up next row always shows too: "Shows here near the end of this song" until the next track is known, then the track fades in over it.
  2. **`#about`** — "What is EuphoricFM?" (the existing text) beside a **live station facts** card from the stats sidecar: on air since, listens all-time, tracks by N artists, listener requests played, peak listeners (with month), 24/7 · auto DJ, around the clock. A fact with no data is hidden, never shown as 0; with JavaScript off only the 24/7 fact shows.
  3. **`#events`** — events teaser with **Plan your event** (opens the existing event inquiry form; links to `/events/` without JavaScript), **How events work** (→ `/events/`) and the live Happening now / On the calendar status from the events script.
  4. **`#music`** — "Get your music on EuphoricFM": four steps, **Submit music** (→ music.euphoric.fm), and "Already on the station? Fix a song's info or cover / ask to remove a song" (→ the portal library with the edit / remove intent).
  5. **`#ways`** — Listen anywhere: Right here (back to the player and start it), Web Player (Open / Pop out), Your music app (`.pls` / `.m3u` built from the station's real mounts, same helpers as the Web Player) and the direct stream URL with a **Copy** button (falls back to select + copy, then "Press Ctrl+C", for the in-game browser).
  6. **`#stats`** — condensed Station stats: range tabs, 4 KPI tiles, the Listeners chart and the top 5 tracks and artists, with **Show full stats** revealing the existing Listens and Rhythm charts and the longer top lists (same `stats.ts`, no rewrite).
  7. **`#contact`** — Get in touch: Contact us (existing contact form), Advertise your business (existing Business AD pop-up; its in-universe copy is unchanged, including "Average of 120,000 listeners per day") and Book an event.
  8. **`#faq`** — six questions as native `<details>`: requesting, in-game phone listening, why the title changes before the song, getting your music played (→ Music Portal), advertising, and who runs EuphoricFM.
  9. **Footer** with Listen / Station / Music / Contact columns, the Effects switch and the version link.
- **Share previews work:** a real 1200×630 `og:image` at `/images/og.png` (rendered from `docs/og/og-image.html` with the site's own logo fonts and colours), plus `og:image:width/height/alt` and `twitter:image`. It used to point at a missing `/images/og.jpg`, which the SPA fallback answered with HTML.
- `test/site-build.test.mjs`: the home sections exist once each and in order, no duplicate ids, every section's key pieces (portal links, playlist files, stats toggle, pop-ups, six FAQ entries, the ad copy), pop-ups outside `<main>` and above the bar, **no "discord" anywhere in the built `/`, `/events/` and `/player/`**, `stats.ts` not in the home entry script, and a real 1200×630 PNG share image; the Requested songs body and Up next row reserve their space, the live facts and `<button data-open>` controls are JS-only, and no page uses a View Transition. `test/shared-drift.test.mjs`: every `/#…` anchor in `nav.json` is a real, unique element id on the home page. `test/caddy-player.sh`: `/images/og.png` is served as an image and the runtime config uses the neutral key.

### Changed
- **The old button row is gone**; each button moved into the section it belongs to. Pop-ups open from any `data-open="request|contact|business|event-inquiry"` control through the new `ModalControls.astro` (on every full-site page; on a page without that pop-up a link simply navigates).
- **Contact** in the top bar now goes to the Get in touch section (`/#contact`) instead of opening the contact form directly.
- **Controls look clickable:** every `.btn` has a visible edge, hover tint, pressed state and the focus ring; new `btn-ghost` / `btn-outline` / `btn-sm` variants. Stats top-track and top-artist rows are bordered rows with a hover tint and a chevron. Pop-up close buttons are 44px bordered buttons (were a bare 28×20 "×").
- **Lighter first load:** `stats.ts` (the biggest script, ~10 KB gzip) loads only when `#stats` nears the viewport or Show full stats is pressed; `/stats/summary` is fetched once and shared by the facts card and the stats section. Home entry JS ~19 KB → ~13 KB gzip.
- Station stats render their skeleton at full size from the start (no layout shift), and show a short note instead of hiding when the stats service is unavailable. The Stats section's element id is now `stats` (was `stats-section`), so `/#stats` from the bar lands on it.
- **Pop-ups open instantly:** they no longer go through a View Transition (`document.startViewTransition`), which snapshots the whole page first and held a pop-up back 1.5–4 s on the long one-page home in a loaded browser. The pop-up card keeps its CSS fade-in. Same for the event inquiry pop-up on `/events/`.
- **No dead controls with JavaScript off:** the pre-paint script marks `html.efm-js`; without it, `<button data-open>` controls (they only open pop-ups), the live facts and the player's Play/volume are hidden, and the player says it needs JavaScript and links to the stream links in Listen anywhere.
- The contact webhook is handed out as `window.__EFM_CONFIG__.contact.webhook` (was `….discord.contactWebhook`) and the rate-limit message no longer names the provider, so the built info pages never say "Discord" (owner decision). Same env var, same webhook.

### Fixed
- **Pop-up close buttons were hidden under the sticky top bar on phones** (from 0.21.0): the pop-ups lived inside `<main>`, a `z-[1]` stacking context, so they could never cover the bar. They now render in a new `overlays` slot of `BaseLayout` outside `<main>` at `z-[70]` (request, contact, business, event inquiry, and the stats detail pop-up, which moved to `StatsDetailModal.astro`).
- The `/#stats` top-bar link had no target (the section's id was `stats-section`).
- Layout shifts at 320px: the album line reserves its height, and on phones the stats range tabs always take their own row (they used to wrap below the heading once filled).

## [0.21.0] — 2026-09-28 — Shared top bar on both sites

### Added
- **One top bar for info.euphoric.fm and music.euphoric.fm** (Release 3 of the approved redesign), identical on both sites and for every role: EuphoricFM logo (→ info home) · Listen · About · Events · Stats · **Music ▾** · Contact, plus a gold **Web Player** button (→ `/player/`). Sticky, solid dark (no blur: the in-game browser paints blur black), 64px (56px on phones).
  - **Music ▾** opens a panel with a gold **Submit music** button (→ `music.euphoric.fm/submit`), **My music** (→ `/dashboard`) and **Library** (→ `/library`) on the portal. Staff items (Review, Admin) never appear in the top bar; nothing in it mentions Discord.
  - **Phones (<768px):** logo · gold Web Player · **Menu**, which opens a full-width sheet with every item (EuphoricFM: Listen, About, Events, Stats, Contact, Web Player; Music portal: Submit music, My music, Library). Below 380px the Menu button keeps only its icon.
  - **Works without JavaScript** (the in-game CEF browser): Music ▾ and Menu are `<details>/<summary>`. A small script only adds closing on outside click, Escape (focus returns to the button) and after following a link.
  - Current page marked with `aria-current`: Listen on the home page, Events on `/events/`, Web Player on `/player/`; jumping to a home section (`/#about` …) moves the mark there.
  - **Contact** opens the existing contact modal on the home page; elsewhere it links to `/#contact`, and the home page opens the modal when it is loaded with `#contact` (so Contact works the same from `/events/`, `/player/` and the portal).
  - Home page anchors: `#listen` (player + recently played), `#about`, `#stats`, `#contact` (the action row). In-page jumps land below the sticky bar (`scroll-padding-top`).
- **Shared files** in `shared/`: `nav.json` (every item, label, target and icon) and `efm-bar.css` (the bar's styles; `efmh-` / `efms-` prefixed plain CSS on the shared colour tokens). The Astro header imports them directly; the portal (Docker context `music/`) keeps byte-for-byte copies in `music/src/shared/`, refreshed with `pnpm sync:shared` (`node shared/sync.mjs`).
- **Drift test** `test/shared-drift.test.mjs` (in `pnpm test:site`, run by CI): fails if a portal copy differs from `shared/`, if the portal's colour tokens differ from `src/styles/tokens.css`, if the bar CSS uses blur/filter or a non-shared token, if `nav.json` loses an approved item or gains Discord/staff/Schedule items, or if any built page (`/`, `/events/`, `/player/`) renders a bar that is not exactly `nav.json` (every link's text and absolute target, in order). The portal's `test/ui/site-bar.test.tsx` checks its rendered bar against the same expected list.

### Changed
- The old centred wordmark header on `/`, `/events/` and `/player/` is replaced by the shared bar (the home page keeps its tagline as a small line under the bar; `/events/` keeps a visually hidden page heading). The Web Player's own slim bar (logo · Web Player · Full site) is gone: the full player uses the shared bar with Web Player marked, and the pop-out strip stays chrome-free.
- Page content (`.phone`) is capped at the bar's width (72rem) so it lines up under the bar on wide screens instead of running edge to edge.
- `BaseLayout` has a `header` slot, rendered outside `<main>`.

### Fixed
- **Home page layout shift on phones.** Recently Played now renders five placeholder rows the same height as the real ones (one of them says "Loading recent tracks…"), so the list no longer pushes About, Stats and the footer down when the history arrives. Home-page CLS at 800px viewport height: 320px 0.15 → 0.000, 390px 0.108 → 0.000, 600px 0.127 → 0.000.
- **Section links from other pages land on the section on phones.** Arriving on `/#about`, `/#stats` … keeps the section under the bar while late content (recently played, requested songs, stats) loads, and stops as soon as the visitor scrolls, taps or types (or after 8 seconds). Needs JavaScript; without it the browser's normal jump applies.
- **Home page no longer scrolls sideways at 320px** (pre-existing: the hero grid column grew to its widest child, 357px). The hero column is `minmax(0, 1fr)`.
- **Web Player lines up under the bar**: from 1100px the player uses the bar's width (72rem) and side gutter (content x = 88..1192 at 1280, same as the bar), and the sticky Song history panel sits below the sticky bar instead of sliding under it.
- The bar reserves the logo's loaded width, so the web-font swap no longer nudges the nav and buttons sideways.

## [0.20.0] — 2026-09-28 — Web Player at /player/

### Added
- **Web Player — `info.euphoric.fm/player/`** (Release 2 of the approved redesign). A real built page (`dist/player/index.html`) with its own title/description, its own slim top bar (logo → home · "Web Player" · **Full site** button; the shared site header is Release 3) and no Discord anywhere on it:
  - large album art, station name + description, AUTO DJ / ON AIR / OFFLINE pill, listener count, title / artist / album, progress with elapsed and duration;
  - transport: 80px play/pause, mute + a volume slider with a 44px hit area (6px track, 20px thumb; hidden on iOS where page volume can't be set), and a **stream quality picker built from the station's real mounts** (`station.mounts`, only https URLs on the stream's own origin, default first; remembered per browser);
  - Up next card with countdown (hidden during a live set and for ad/imaging rows) and REQUESTED badges;
  - actions: **Request a song** (the existing request modal and flow), **Playlist** (download `.pls` or `.m3u` built from the same mounts), **Pop out** (`window.open('/player/?popout=1', 'efm-player', 'popup,width=360,height=200')`, falling back to a normal link when blocked; the pop-out takes over playback, and clicking Pop out again just focuses a running pop-out instead of reloading it), and **Song history** (last 15 with art, time ago, REQUESTED badges; ads and station imaging filtered with the same rules as the stats sidecar).
  - Responsive by available space: ≥1100px card + history side panel; 700–1099px art beside the details with history below in two columns (8 rows + "Show all"); <700px stacked phone layout with history collapsed to 3 rows + "Show all 15"; **pop-out strip** for `?popout=1` or any viewport ≤ 420×260 (small art, title/artist, progress, play/pause, mute, Up next line, "Open the full player"; long titles and Up next lines are cut with an ellipsis so every control stays inside the strip). Action-button labels wrap inside the button rather than clipping when a wide system font (e.g. DejaVu Sans) is in use.
  - Live DJ state: solid ON AIR pill, "Live Broadcast · <DJ>" line, streamer art when AzuraCast sends it, indeterminate ruby bar with `LIVE · h:mm:ss`. Media Session metadata and hardware media keys as on the home page; tab title shows `▶ Title – Artist` while playing; Space toggles play.
  - Effects toggle, reduced motion and the in-game CEF safe mode are respected (no blur/filter in the page CSS; Pop out and Playlist are hidden in-game, where pop-up windows and downloads don't exist).
- **"Web Player" button on the home page** (action row, sunburst outline + gold play dot) linking to `/player/` until the shared header lands. The row now has six buttons laid out 2×3, 3×2 or in one row — chosen by the row's own width (container query; viewport breakpoints as the fallback) so labels like "Request a song" stay on one line — and no button (previously Business AD) is left alone on a row.
- Tests: `test/site-build.test.mjs` (`pnpm test:site`, now run in CI after the build) checks the built player page (title, meta, canonical, its own script bundle, no "discord", no webhook runtime config), the home Web Player link, that the player's break filter matches the stats sidecar's exclude list, and unit-tests the mount/playlist/break helpers. `test/caddy-player.sh` validates the Caddyfile and asserts `/player/` (and `?popout=1`) serves the player — not the SPA-fallback home — and that `/player` 308s to `/player/` (query kept) like `/events`.

### Changed
- The now-playing poller and the stream audio engine are now shared modules (`src/scripts/np-core.ts`, `src/scripts/stream-audio.ts`, pure helpers in `src/lib/player-data.ts`). The home `PlayerCard` and `nowplaying.ts` use them with unchanged behaviour (same 5 s poll, hidden-tab pause, `?t=` cache-busted stream, analyser, effects gating, Media Session); the Media Session "play" action now only starts playback instead of toggling.
- `BaseLayout` takes `scripts="site" | "none"`; the Web Player loads only its own entry script and skips `/efm-runtime-config.js` (it has no contact modal).
- The request modal's close control is now a bordered 44px button instead of a bare 28×20 "×".
- No Caddyfile routing or CSP change was needed: `try_files {path} {path}/` already serves `/player/`, and the stream, API, art and playlist `data:` downloads all fit the existing policy. Only the fallback comment was updated.

## [0.19.2] — 2026-09-28 — tickets.euphoric.gg: 404 the machine-only APIs at Caddy

### Fixed
- **`tickets.euphoric.gg` no longer exposes `/api/internal/*` or `/api/v1/*`.** The `.gg` Caddy block now answers a plain 404 (site headers kept) for `path_regexp (?i)^/api/(internal|v1)(/.*)?$` before proxying to `tickets-web:3000`, matching rule #5 of the `tickets.euphoric.fm` Cloudflare tunnel, so both hostnames expose the same surface. Before this, `/api/internal/notify` was reachable on `.gg` (GET 405 / POST 401, guarded only by `INTERNAL_TOKEN`). The bot and the music portal call these routes over the private docker networks at `tickets-web:3000`, never through the public hostnames, so nothing legitimate is affected. The match runs on Caddy's decoded, cleaned path, so encoded (`/api/%69nternal`, `/api/internal%2fnotify`), dot-segment and doubled-slash forms are blocked too; `/api/internalx` and `/api/v10` are not.
- `test/caddy-tickets-internal-block.sh` — runs the Caddyfile in `caddy:2.10-alpine` next to a stub `tickets-web` on a throwaway docker network and asserts every blocked form (including the bypass attempts) gets 404 without reaching the stub, and that normal pages, auth and `/_next/static` still proxy through.

## [0.19.1] — 2026-09-27 — Listeners graph shows peak listeners

- The Listeners graph now plots each bucket's **peak** listener count (the full number tuned in at the busiest moment of that day/hour) instead of the average across it. The table's first value column is now Peak, and Avg stays as the second column.

## [0.19.0] — 2026-09-27 — Music portal entry: /music redirect and Submit music button

### Added
- **`info.euphoric.fm/music` → the music portal.** A new Caddy block matches ONLY `path /music /music/*` and always answers with a 302 (`Cache-Control: no-store`) to the fixed host: `/music` → `https://music.euphoric.fm/`, `/music/<rest>` → `https://music.euphoric.fm/<rest>` (query kept). The target is the literal host followed by the prefix-stripped `{uri}` only when that stripped URI starts with `/`; otherwise it is the plain root redirect. The guard is needed because Caddy matches the *decoded* path but strips `/music` from the *raw* one: `/music%2f@evil.com/pwn` matches `/music/*` yet leaves `%2f@evil.com/pwn`, and appending that to the host would send browsers to `evil.com`. It now goes to `https://music.euphoric.fm/`, so the authority can't be extended or replaced. `/music.evil.com`, `/music@evil.com` and `/musicx` never match and fall through to the normal site; `/music//evil.com` stays on music.euphoric.fm. There is no in-game or iframe special-casing: framed and CitizenFX requests get the same redirect (if the portal doesn't load in the in-game phone, that's handled later).
- **"Submit music" button** in the homepage action row (where "Submit a song" was): a plain link to `https://music.euphoric.fm/` with `target="_blank" rel="noopener"`, the same everywhere, in-game included.
- `test/caddy-music-redirect.sh` — runs the Caddyfile in `caddy:2.10-alpine` against `dist/` and asserts every positive and negative redirect case (including encoded-slash `/music%2f@evil.com` variants, and framed/CitizenFX requests getting the same 302) and that the runtime config no longer serves the submission webhook.

### Removed
- **`SubmitSongModal`**, which posted straight to a public Discord webhook. `/efm-runtime-config.js` now serves only `contactWebhook`; `PUBLIC_DISCORD_REQUEST_WEBHOOK` is dropped from `docker-compose.yml`, `.env.example` and the docs. The old URL is still in git history (root commit) — rotate it in Discord after this ships. The contact webhook is still public by design (ContactModal + /events inquiry); moving it behind the `efm-requests` sidecar is tracked separately.

## [0.18.0] — 2026-09-27 — EFM Music Portal core (music/)

### Added
- **`music/`**: the EFM Music Portal (`music.euphoric.fm`), phase P2 security foundation. It is its own package, lockfile and compose project (`efm-music`), so the Astro site build is untouched. See `music/README.md` and `music/CHANGELOG.md`.
- A CI job, `build-music`: `pnpm audit --prod`, a typecheck, and the Docker test harness (`music/test/run.sh`, mocks only). On `main` it pushes the tested images as `ghcr.io/jason-tucker/euphoricfm-website-music:{web,worker,probe}-<sha7>` (plus `-latest`). Watchtower stays off for these images.

### Changed
- The site's `tsconfig.json` and `.dockerignore` exclude `music/`.

## [0.17.0] — 2026-09-26 — Stats count listens instead of plays

### Changed
- **"Plays" are now listens.** Each song play counts as the number of listeners tuned in when it started (the history row's `listeners_start`; on the live 30s poll, `listeners.current` — the now-playing row is first seen within ~30s of its start). A song with 3 listeners followed by one with 2 is 5 listens. Applies to every play-derived number: the total, per-day chart, rhythm heatmap, top tracks/artists and the per-month drill-downs. API field names (`plays`, `p`, `n`) are unchanged and now carry listens.
- **Ads don't count.** Rows from the `2Ads`, `3EFM/Free Ads`, `5Local Ads`, `Go Vote` and `4EuphoricFM` playlists are skipped on every ingest path (live, gap sync, backfill); override with the new `STATS_EXCLUDE_PLAYLISTS` env var. Rows with no title and no artist (untagged ~25s imaging clips, 817 in the history) are skipped the same way — they were not songs and would otherwise rank near the top by listens.
- **Requests KPI** still counts requested songs, but its sub-line is now "{pct}% of songs played" — requests ÷ raw songs played (new `totals.songs` / per-day `s` in `/stats/summary`), not ÷ listens.
- All user-facing "Plays" copy in the stats section now says "Listens".
- **Stats store schema 1 → 2.** A schema-1 `stats.json` is not loaded into the new semantics: the sidecar starts fresh and first copies the old file to `stats.json.schema1.bak` (never overwritten). The full history is rebuilt offline by replaying AzuraCast history rows (with `listeners_start` + `playlist`) through `ingestNowPlaying`.

## [0.16.1] — 2026-08-20 — Merge day-crossover events into one calendar entry

### Fixed
- **A booking that crosses midnight no longer shows as two events.** The events station's schedule API splits a cross-midnight booking into per-day rows (…–23:59, then 00:00–…); `events.ts` now merges contiguous rows of the same playlist (gap ≤ 5 minutes) into a single event spanning the full range before rendering. The ON AIR card shows the complete time span, and the post-midnight half can never appear as a duplicate "On the Calendar" row while the first half is broadcasting. Exact duplicate rows collapse through the same merge; genuinely separate sessions of the same playlist (hours apart, e.g. a daily slot) stay separate rows.

## [0.16.0] — 2026-08-20 — Live events calendar from the station schedule

### Added
- **`EventStatus` is now live**, driven by the dedicated Euphoric Events AzuraCast station (shortcode `event`)'s public schedule endpoint (`GET /api/station/event/schedule` — unauthenticated, CORS-open, no Caddyfile change). New `src/scripts/events.ts` polls it every 60s (paused on `visibilitychange` hidden, same start/stop pattern as `nowplaying.ts`) and toggles between an ON AIR card (reusing the solid-ruby pulse pill styling) and the existing off-air empty state, both now rendered server-side with stable ids and `hidden`-toggled rather than an either/or template branch.
- **"On the Calendar"** — a new list under the status card showing the next 5 upcoming schedule entries (event name left, right-aligned day + time, "Today"/"Tomorrow"/"Wed, Aug 26" via `Intl.DateTimeFormat` in the station's timezone), collapsing recurring-playlist duplicates and hiding entirely when nothing's upcoming.
- **Manual override preserved.** `site.events.status.current` (still `null` by default) continues to render exactly as it did in 0.15.0 when set — `EventStatus.astro` stamps `data-override="1"` on `#evst-card` in that case and `events.ts` bails immediately, so config always wins over the live feed.
- New `site.config.ts` `events.station` (apiBase, stationId, publicPlayerUrl, timezone, scheduleRows, pollMs) and `events.calendar` (title, listen, today, tomorrow) blocks — every new visible string is config-driven; schedule entry names are staff-authored in-universe data and render verbatim via `textContent`, same as track titles elsewhere on the site.

## [0.15.0] — 2026-08-20 — Euphoric FM Events page

### Added
- **New `/events` page** for booking Euphoric FM to bring curated music and radio programming to a venue: a hero (heading, body, "Plan Your Event" / "Listen to Euphoric FM" CTAs), a three-step "How It Works" walkthrough, a services rundown (curated music, event radio programming, announcements, venue-wide radio, live changes) with a "Good for" chip list (grand openings, club nights, private parties, car meets, business events, community events, special events), and an `EventStatus` section — new components `EventsHero.astro`, `EventsHowItWorks.astro`, `EventsServices.astro`, `EventStatus.astro`, `EventInquiryModal.astro`, mirroring `index.astro`'s composition through `BaseLayout`.
- **Event inquiry modal reuses the existing contact webhook pipeline** (`window.__EFM_CONFIG__.discord.contactWebhook`, still runtime env-injected, no new env var) but posts a distinguished sunburst-coloured embed (`username: 'EuphoricFM Events'`, `📅 Euphoric FM Event Inquiry`, thread named after the event) so staff can tell an event booking apart from a general contact message at a glance. Since `/events` doesn't mount `ActionRow`, the modal ships fully self-contained — its own open listener, close/backdrop/Escape handling, loading/success/error states — rather than relying on `ActionRow`'s shared close-handling script.
- **Config-driven, future-ready `EventStatus`.** The section reads `site.events.status.current` (`null` today) and renders a polished "nothing on the calendar" empty state with its own "Plan Your Event" CTA; the fully-styled active-broadcast branch (status pill, name, venue, times, description, optional image, Listen link) is ready to light up the moment an event is set in config, no code changes needed later.
- **Events link on the homepage.** `ActionRow` gains a third `Events` button (outline `btn-events` style, tokens only) alongside Request / Submit / Contact / Business AD, routing to `/events`.
- All Events copy — hero, how-it-works, services, good-for chips, status states, and inquiry form strings — lives in `src/site.config.ts`'s new `events` block, matching the rest of the site's editable-copy convention.

### Fixed
- **Rhythm heatmap read as broken on live data.** Cell intensity was `value / max`, but a 24/7 station's per-hour totals all sit at 60–100% of the peak — every cell painted near-full-strength orange and switching the Plays/Listeners basis looked like it did nothing. Intensity is now min–max normalized across the rendered cells (a genuinely flat series gets a uniform mid tone), so the daily rhythm is actually visible and the basis toggle visibly changes the pattern. The fallback heat strips' cells also swap `aspect-square` for a fixed strip height — the 7-cell "By day" row rendered as giant ~44px blocks. The stats module also now skips its `/stats/summary` fetch entirely on pages without the stats section (e.g. `/events`).

## [0.14.0] — 2026-08-20 — Synced stats ranges, rhythm heatmap, and ten review fixes

### Added
- **One synced range filter across the whole stats section.** A shared `[7D · 30D · 90D · 1Y · ALL]` preset selection now drives the KPI tiles, the listeners and plays charts, and the top-tracks/top-artists lists together — a primary tab row above the tiles plus the per-chart rows, all reflecting one state. Presets only appear once the data coverage actually spans the next-smaller window (fresh installs show no range buttons at all until there's something to compare), and a row with fewer than two eligible presets hides entirely. Tiles compute plays/requests/peak exactly from the dense per-day series; tracks/artists counts and both leaderboards come from new per-range rollups in `/stats/summary` (`ranges.{7d,30d,90d,1y}` — month-floored windows, labelled "since <Mon YYYY>" wherever shown).
- **Rhythm card is now a percentage heatmap.** Weekday × hour heat cells (plays as a share of all plays, listeners as a share of the peak hour) with per-cell tooltips and a `[Plays · Listeners]` basis toggle, replacing the column charts. A new 168-cell day-of-week × hour accumulator (`grid`) feeds the full 7×24 matrix; stores that predate it render two heat strips from the existing by-hour/by-day aggregates until the matrix accumulates — or immediately after a one-time `STATS_BACKFILL_RESET` re-run repopulates it from history.
- **Coverage captions under every chart** stating the exactly-rendered window ("Jul 21 – Aug 20, 2026" / "Since Aug 2023"), and the coverage line + backfill state now survive removing the API key after a completed backfill (the persisted done state is reported, not the key's presence).

### Fixed
Ten findings from an adversarial multi-lens review of 0.13.0, each independently verified:
- **Server:** the track-cap eviction was a no-op that also paid an event-loop-blocking O(n) scan per insert past the cap (now updates-before-evict, batch eviction); `syncRecent` read only the first history page while advancing the watermark, permanently losing plays after longer outages (now drains pagination first); deterministic backfill errors (4xx, page overflow) retried forever every 15s (now halt with `STATS_BACKFILL_RESET` as the recovery path; transient errors get exponential backoff, and `/stats/health` exposes the status-code-level `lastError` plus sync health); the upstream-supplied `links.next` URL was followed with the API key attached regardless of origin — a credentialed SSRF primitive (now same-origin-only); artist leaderboards silently rewrote on restart after artist-metadata corrections (incremental attribution now matches the rebuild's latest-artist-wins semantics); a successful sync erased the reason a halted backfill halted; a post-reset re-backfill double-folded listener readings (reset now clears the listener aggregates it refeeds, keeping rings + peak); listener series are served time-sorted with duplicate buckets merged (clock-step safety).
- **Charts:** dead hover strips between rhythm columns snapped the tooltip to the wrong bucket (nearest-center fallback); listener-series downtime gaps were drawn as a continuous line (densified as real gaps); slow responses could render a stale range or stale detail view over what the user had since selected (generation guards); resizing never adapted tick density (points rebuild per draw); small y-maxima produced duplicate/rounded-wrong gridline labels; zero-play months were skipped in drill-down charts; the detail overlay chart lacked its table twin; the rhythm subtitle hardcoded "(ET)" instead of deriving the station timezone's name.

## [0.13.0] — 2026-08-20 — Full-time station stats area

### Added
- **New stats section at the bottom of the page** (below About, above Footer): interactive area graphs for listeners and plays, four KPI tiles (total plays, peak listeners, tracks played, requests played), rhythm charts (plays/listeners by hour-of-day and day-of-week), and clickable top-tracks/top-artists lists with drill-down detail (monthly plays chart, first/last played, top tracks per artist). Hand-rolled SVG charts (no libraries) with crosshair/tooltip and an accessible `<details>` table twin per chart. Stays hidden gracefully when `/stats/summary` is unreachable (e.g. `pnpm dev`, no sidecar).
- **`server/stats.mjs`** — the `efm-requests` sidecar now also serves `/stats/*`: 30s listener-count sampling (5-min/1-hour ring buffers), watermarked live play ingestion off the existing nowplaying poll, and — when `AZURACAST_API_KEY` is set — full-history backfill from AzuraCast's auth-only history API back to `STATS_BACKFILL_START` (2023 by default), running in gentle ~15s-cadence windows with a frozen forward-region boundary so backfill and live ingestion can never double-count. A broken/unauthorized key degrades gracefully — live stats accumulate regardless after a few failed sync attempts, they just lack pre-boot history. State persists to `stats.json` (atomic tmp+rename writes) alongside the existing `pending.json`. Per-IP rate limiting mirrors the existing `/requests/*` limiter.
- **Caddy `/stats/*` route** — reverse-proxies to `efm-requests:3000` with the same `X-Forwarded-For` passthrough as `/requests/*` (load-bearing for the sidecar's per-IP rate limit). No CSP change: `connect-src 'self'` already covers same-origin fetches.
- **New env vars** (`.env` / `docker-compose.yml`): `AZURACAST_API_KEY` (enables backfill; empty = live-only accumulation, never sent to clients), `AZURACAST_API_BASE`, `STATION_ID`, `STATS_TZ` (station timezone for day/hour/month bucketing, default `America/New_York`), `STATS_BACKFILL_START`, and `STATS_BACKFILL_RESET` (set to any new value + `docker compose up -d` to wipe and re-backfill without volume surgery on the `read_only` container).

## [0.12.0] — 2026-08-01 — Live streaming special-event mode

### Added
- **Live DJ broadcasts now get the special-event treatment.** When AzuraCast reports `live.is_live`, the player card slides open a **Special Event banner** (pulsing dot, streamer name, editable tagline — same CEF-safe max-height/opacity reveal as Up Next), the status pill switches to **ON AIR** with a solid-ruby soft-pulse treatment, and the "Now Playing" eyebrow becomes "Live Broadcast". All copy (eyebrow, pills, label, tagline, fallback streamer name, elapsed prefix) is editable in `site.config.ts` `liveEvents`; the runtime fields flow to `nowplaying.ts` through `clientConfig`/`window.__EFM_CONFIG__`.
- **The idle pill now reads AUTO DJ instead of LIVE.** "Live" wording is reserved for actual live broadcasts; autopilot rotation shows AUTO DJ (editable as `liveEvents.idlePill`).
- **Indeterminate live progress bar.** Track duration is meaningless mid-broadcast, so `.np-live` on the card hides the position fill and runs a transform-only ruby sweep on the track (GPU-composited, CEF-safe). `html.efm-fx-off` and `prefers-reduced-motion` both swap the sweep for a static ruby fill — the global reduced-motion rule alone would strand the sweep mid-track. The times row shows broadcast elapsed off `broadcast_start` (`LIVE · 1:23:45`, hours segment past 1h; bare `LIVE` when AzuraCast sends no start), clamped against client clocks behind the server's.
- **Live-aware chrome.** Up Next stays shut during a set (`playing_next` is meaningless with a DJ; normal ≤40s reveal resumes on exit), Media Session artist credits the DJ (`LIVE: <name>`, restored after), and `document.title` gets a live variant. Both is_live flips replay the card's `np-flash` — except on first poll, so loading mid-event doesn't flash. `is_online: false` overrides `is_live` (a dead stream is never "on air"). Streamer name renders via `textContent` only (remote data).

### Fixed
- **`#np-live-dot` no longer destroyed on the first poll.** `setOnline()` assigned `textContent` on the pill itself, wiping the dot span that `PlayerCard.astro` renders inside it — so the dot never survived past page load. The pill now has a dedicated `#np-status-text` child for the label; the dot is class-toggled (and hides while OFFLINE). Also pre-emptively dropped the dot's redundant `inline-block` so the `hidden` toggle can't lose the Tailwind v4 utility-order tie (the 0.11.1 badge bug).

## [0.11.2] — 2026-07-06 — Docs pass: README catches up to Tailwind v4 + directory tree

### Changed
- **`README.md` Stack section corrected from "Tailwind 3" to "Tailwind 4"** (CSS-first `@theme` config, no `tailwind.config.mjs`) — stale since the 0.11.0 Tailwind v3→v4 migration.
- **Architecture directory tree updated:** added `src/styles/tokens.css` (centralised colour tokens, previously missing from the README tree though already documented in `CLAUDE.md`), clarified `global.css`'s description to match its actual v4 `@theme` content, and added `public/cef-test.html` (the plain-HTML no-JS CEF-reachability diagnostic page) and `public/sw.js` (service-worker killswitch, not an active PWA worker).
- Cross-checked the rest of `README.md` (AzuraCast integration details, `site.config.ts` fields, Caddy/Compose deployment description, `efm-requests` sidecar, `tickets.euphoric.gg` second vhost) against the current code — all still accurate, no further changes needed.

## [0.11.1] — 2026-07-05 — Fix always-on REQUESTED badge; pin wordmark; GPU-cheap bloom; dark color-scheme

### Fixed
- **REQUESTED badge showed on every song.** Tailwind v4 emits `.inline-block` after `.hidden`, so on the two badge spans (which carried both classes) `inline-block` won the tie and the badge could never hide, regardless of `is_request`. Removed the redundant `inline-block` (both badges sit in flex rows, where flex-item blockification applies anyway); the `hidden` toggle in `nowplaying.ts` works again. Regression from the 0.11.0 Tailwind v3→v4 migration.
- **Header wordmark no longer moves.** Removed the honey-float translate + bass scale from `header h1 span` — the deepest-parallax wordmark read as the whole page shifting. The bass text-shadow glow stays (brightens in place, no movement).
- **Modals and the blob backdrop now anchor to the viewport.** The old `body { filter }` (even at brightness(1)) silently made `<body>` the containing block for every `position: fixed` element, so on a scrolled page the modal overlays measured against the document instead of the viewport. With the filter gone they center correctly — standards behaviour, and what CEF (which always had `filter: none`) already did.

### Changed
- **Bass bloom is now GPU-composited.** The now-playing card's halo moved to a `::before` pseudo-element with fixed shadow geometry and bass-driven *opacity*, replacing the animated blur/spread/offset box-shadow that repainted a large region every frame and made the halo visibly travel downward on kicks. The card's redundant `overflow-hidden` was dropped so the halo can paint outside the card box (everything inside that needs clipping — the up-next reveal, the progress track — clips itself). Also dropped the whole-page `body { filter: brightness() }` energy tint (full-document filter pass per tick) and the album art's per-frame `brightness()` filter (scale pulse kept). Together these were the main sources of slow/janky motion. The `html.efm-cef` `#np-art` filter override is gone (nothing to guard), but the CEF `body { filter: none !important }` guard stays permanently — a body filter is the exact failure that blanked the phone in 0.7.3/0.8.0.
- **Dark-first document.** Declared `color-scheme: dark` (`<meta name="color-scheme" content="dark">` + `html { color-scheme: dark }`) so UA-rendered UI — form controls like the volume slider and modal inputs, scrollbars, the pre-CSS canvas — defaults to dark instead of light. No theme-color/PWA meta re-added (CEF first-paint safety).

## [0.11.0] — 2026-06-14 — Migrate Tailwind CSS v3 → v4 (CSS-first config)

### Changed
- **Migrated Tailwind CSS from v3 to v4.** Replaced the JS-config + PostCSS plugin model with v4's CSS-first model and Vite plugin. No visual design change is intended — the compiled CSS is equivalent. **Not yet deployed: needs visual review on the live in-game CEF iframe before merge.**
  - **`package.json`**: dropped `@astrojs/tailwind` and `tailwindcss@^3.x`; added `tailwindcss@^4.3.0` + `@tailwindcss/vite@^4.3.0` (devDependencies).
  - **`astro.config.mjs`**: removed the `@astrojs/tailwind` integration; registered `@tailwindcss/vite` under `vite.plugins` (merged with the existing `vite.server.allowedHosts`).
  - **`src/styles/global.css`**: swapped the three `@tailwind base/components/utilities` directives for a single `@import "tailwindcss";`, then ported the old `theme.extend` into a CSS-first `@theme` block — brand colours as full `rgb(var(--efm-*-rgb))` (so `color-mix()` alpha modifiers like `bg-ruby/20` keep resolving off the channel tokens in `tokens.css`), the `lemon`→gold legacy alias, the `body`/`euphoric`/`fm` font families, and the `soft-pulse` animation. The `soft-pulse` keyframes are plain CSS; `max-w-phone`, `max-w-frame`, and `bg-efm-aurora` (which v4 has no `@theme` namespace for) are `@utility` blocks.
  - **`tailwind.config.mjs`**: deleted — v4 ignores it; everything it defined is ported into `global.css`.
- **`tokens.css`, `site.config.ts`, the Caddyfile, and all iframe/CSP behaviour are untouched.** `frame-ancestors *` stays; no framebusting introduced.

### Notes
- v4 emits only the unprefixed `::placeholder` selector (the v3 build also emitted `::-moz-placeholder`); modern Chromium/CEF support unprefixed `::placeholder`, so the input placeholder styling is unchanged in practice.
- The compiled CSS gzips slightly larger (~25%) than v3 because v4 ships its `@layer properties` `@property` polyfill. Verified locally: `astro build` passes clean, the `color-mix()` alpha modifiers, font utilities, the aurora gradient, and the custom max-width utilities all compile as expected; `pnpm test` (server sidecar) passes 15/15.

v0.11.0 · f2b3219

## [0.10.3] — 2026-06-14 — Bump Astro to 6.4.6; resolve esbuild advisory (GHSA-gv7w-rqvm-qjhr)

### Changed
- **Bumped `astro` 6.3.8 → 6.4.6** (npm-minor-patch group, Dependabot #7). Patch-level fixes only — `addAttribute` hardening against invalid attribute names, prerendered-error-page origin validation against `allowedDomains`, image HMR crash fix. Tailwind 3 unchanged, so no styling impact; `astro build` verified clean.

### Security
- **Resolved the high-severity `esbuild` advisory GHSA-gv7w-rqvm-qjhr** (missing binary integrity verification, vulnerable `>=0.17.0 <0.28.1`) that was failing the `audit` CI gate. Added a `pnpm.overrides` entry (`"esbuild@<0.28.1": ">=0.28.1"`) so the transitive `astro > esbuild` dependency resolves to the patched 0.28.1. The advisory pre-dated this PR (it also affected `main`); `pnpm audit --audit-level=high` now reports no known vulnerabilities.

v0.10.3 · 4607b7e

## [0.10.2] — 2026-06-13 — CLAUDE.md: agent usage policy, ingress corrections, sidecar docs, build commands

### Changed
- **Added `## Agent usage` section to CLAUDE.md** with the standard agent-delegation policy (Haiku for lookups, Sonnet for coding, Opus for planning) and delegation guidelines.
- **Corrected the Cloudflare/cloudflared ingress description** in the Stack and Deployment sections: replaced stale "cloudflared on the host (remote-managed tunnel) for public ingress" text with the accurate statement that Caddy 2 binds 0.0.0.0:80+443 directly and terminates TLS via Let's Encrypt — no cloudflared, no Cloudflare proxy (Rule 4 was always correct; Stack and Deployment were stale).
- **Fixed Rule 7** to accurately state that webhook URLs are runtime env-injected by Caddy (not stored in `src/site.config.ts`). `site.config.ts` holds editable copy (about text, station name, AD info, `discord.avatarUrl`); webhook URLs live in `.env` and are templated into `/efm-runtime-config.js` at request time. Also updated the `## Discord webhooks` section to match.
- **Documented the `efm-requests` Node sidecar** in the Architecture tree: `server/index.mjs` (pending song-request queue), `server/index.test.mjs` (test suite), `server/Dockerfile` (separate GHCR image), and the parallel `build-requests` CI job.
- **Added `src/scripts/effects.ts`** to the Architecture tree (music-reactive effects: spring physics, album-art OKLCH theming, effects master toggle — imported in BaseLayout alongside `nowplaying.ts`).
- **Added `src/styles/tokens.css`** to the Architecture tree (centralised CSS colour tokens).
- **Added cross-repo operational dependency note**: the Caddyfile's second virtual host (`tickets.euphoric.gg`) reverse-proxies to `tickets-web:3000` on `efm-public-net` — the euphoric-tickets-web app.
- **Added build/dev commands table**: `pnpm dev`, `pnpm build`, `pnpm preview`, `pnpm test`; noted that there is no `typecheck` script — type-checking is `pnpm exec astro check` (CI runs it with `continue-on-error: true`).

v0.10.2 · 4c8a764

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
