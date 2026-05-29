# euphoricfm-website — AI coding instructions

These apply to Claude Code and any AI coding tool working in this repo.

## Mandatory rules

### 1. Always update CHANGELOG.md
Every meaningful change adds a line under a **real semver heading**, never
`## [Unreleased]`. If your PR is the first change since the last release,
create the next section: `## [0.2.0] — YYYY-MM-DD` at the top. Bump
`package.json` "version" in the same commit.

### 2. Commit often
Small, focused commits. Each commit message starts with a verb in present
tense ("add", "fix", "wire up").

### 3. Project board card per PR
Every PR gets a card on the dedicated **euphoricfm-website** Project board
before the PR is opened. Link them via `gh project item-add`.

### 4. Caddy IS the public ingress (changed in 0.4.0)
As of 0.4.0 Caddy binds `0.0.0.0:80` + `0.0.0.0:443` directly on the host
and terminates TLS via Let's Encrypt. **No Cloudflare proxy.** This
project is the exception to the account-wide "loopback only" rule because
the primary use case — a custom in-game phone CEF iframe — couldn't load
Cloudflare-fronted content. Container hardening compensates for the wider
exposure: `cap_drop ALL` + `cap_add NET_BIND_SERVICE` +
`no-new-privileges:true` + `read_only: true` + tmpfs `/tmp` + named
volumes only for `/data` and `/config` (LE cert persistence).

### 5. Iframe-safe by default
This site is embedded inside the in-game phone's iframe browser. The Caddyfile
emits `Content-Security-Policy: frame-ancestors *` and does NOT set
`X-Frame-Options`. Don't add framebusting code, don't use `window.top`, and
don't break out of the iframe.

### 6. Phone-sized everything
Design for ~360–400px wide and a mouse cursor. 48px tap targets minimum. No
hover-only affordances. Use the `.phone` container utility for max-width.

### 7. Editable copy stays in `src/site.config.ts`
About text, business AD info, station name, webhook URLs, etc. live there.
Don't sprinkle copy across components.

## Architecture

```
src/
  layouts/BaseLayout.astro     window.__EFM_CONFIG__ injected here
  pages/index.astro            composes the page top-to-bottom
  site.config.ts               single source of truth for editable strings
  scripts/nowplaying.ts        client-side polling + RAF progress bar
  lib/azuracast.ts             TS types + URL helpers
  lib/version.ts               version + sha for footer
  components/*.astro
public/
  fonts/                       Begaron (Euphoric) + Cortado Script (FM)
  favicon.svg
Dockerfile                     multi-stage: pnpm build → caddy static
Caddyfile                      iframe-safe CSP, cache headers
docker-compose.yml             web + watchtower
.github/workflows/build-and-publish.yml
```

## Stack (locked)

- Astro 6 (static, no SSR) · Tailwind 3 · TypeScript strict
- Caddy 2 in front · cloudflared on the host (remote-managed tunnel) for public ingress
- pnpm 10 · Node 24
- Watchtower for auto-deploy on new GHCR images

## Deployment

`main` → CI builds + pushes `ghcr.io/jason-tucker/euphoricfm-website:latest` →
watchtower (in compose) auto-pulls within ~60s. Push to `main` → live in
~60–90s. The footer of every page displays `v<package.json version> · <short SHA>`
so you always know which build is running.

## AzuraCast specifics

- Station shortcode: `euphoricfm`. The numeric internal ID is `1`, surfaced in
  request URLs (e.g. `/api/station/1/request/<id>`) — don't hardcode `1`, use
  `request_url` from the requests endpoint payload instead.
- The `now_playing` object includes `sh_id` (unique per playback), `played_at`
  (unix seconds), `duration`, and `elapsed`. Use `played_at` + `duration` for
  client-side progress interpolation, and `sh_id` for track-change detection.
- Listener count is `listeners.current`. History is `song_history[]`.

## Discord webhooks

The "submit a song" and "contact us" forms POST to existing Discord webhooks
configured in `src/site.config.ts` (with `PUBLIC_DISCORD_*_WEBHOOK` env-var
overrides). Match the embed shape that AzuraCast's existing button uses —
`username`, `avatar_url`, `thread_name`, `embeds[{ title, description, fields,
color, timestamp, footer }]` — so the team's existing Discord thread routing
keeps working.
