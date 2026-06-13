# euphoricfm-website — AI coding instructions

These apply to Claude Code and any AI coding tool working in this repo.

## Agent usage

Always spawn agents to do work. Haiku for lookups. Sonnet for coding. Opus for planning.

Use agents proactively — delegation is the default, not a fallback. Match the model to the task:

- **Haiku** — file discovery, repository searches, quick lookups, lightweight analysis, and simple verification.
- **Sonnet** — coding, implementation, refactoring, debugging, writing tests, editing documentation, and normal technical work.
- **Opus** — architecture, complex planning, cross-repository strategy, high-risk changes, difficult debugging strategy, and final reconciliation.

How to delegate well:

- Run independent work in parallel; serialize only when there is a real dependency.
- Give every delegated task a precise scope and a concrete expected output.
- Require every agent to cite the paths, symbols, commands, or repository evidence behind its conclusions.
- Demand actionable results, not generic summaries.
- Never let two agents edit the same file at once — assign explicit file ownership and coordinate overlaps through the orchestrator.
- Resolve conflicting recommendations with repository evidence, not preference.
- Validate every agent's output before accepting it; re-run or re-scope on doubt.
- Use agents to improve speed or quality — not to create pointless duplication.
- The orchestrator reviews all delegated work and remains responsible for final correctness.

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

### 7. Editable copy stays in `src/site.config.ts`; webhook URLs are runtime env-injected
About text, business AD info, station name, `discord.avatarUrl`, and other editable strings live in `src/site.config.ts`. Don't sprinkle copy across components.

Webhook URLs (`PUBLIC_DISCORD_REQUEST_WEBHOOK`, `PUBLIC_DISCORD_CONTACT_WEBHOOK`) are **never** hardcoded or build-time inlined. Caddy templates them into `/efm-runtime-config.js` at request time from the container's env vars (set in `.env` on the host). The modals read them off `window.__EFM_CONFIG__.discord.{requestWebhook,contactWebhook}`. To rotate a webhook: edit `.env` + `docker compose up -d` — no rebuild needed.

## Architecture

```
src/
  layouts/BaseLayout.astro     window.__EFM_CONFIG__ injected here; imports nowplaying.ts + effects.ts
  pages/index.astro            composes the page top-to-bottom
  site.config.ts               single source of truth for editable strings (NOT webhook URLs)
  scripts/nowplaying.ts        client-side polling + RAF progress bar
  scripts/effects.ts           music-reactive visual effects (spring physics, album-art theming,
                               OKLCH colour extractor, effects master toggle)
  lib/azuracast.ts             TS types + URL helpers
  lib/version.ts               version + sha for footer
  styles/tokens.css            centralised CSS colour tokens (brand palette + semantic roles)
  components/*.astro
public/
  fonts/                       Begaron (Euphoric) + Cortado Script (FM)
  favicon.svg
server/                        efm-requests Node sidecar — shared pending song-request queue
  index.mjs                    zero-dep HTTP service (pending list, rate limiting, pruning)
  index.test.mjs               test suite (run with `pnpm test` via node:test)
  Dockerfile                   separate image: ghcr.io/jason-tucker/euphoricfm-website-requests
Dockerfile                     multi-stage: pnpm build → caddy static
Caddyfile                      iframe-safe CSP, runtime-config endpoint, reverse-proxy rules,
                               tickets.euphoric.gg second virtual host
docker-compose.yml             efm-web (Caddy) + efm-requests + watchtower
.github/workflows/build-and-publish.yml
                               parallel jobs: `build` (site) + `build-requests` (server sidecar)
```

### Cross-repo operational dependency

The Caddyfile serves a second virtual host (`{$TICKETS_GG_HOSTNAME:tickets.euphoric.gg}`) that reverse-proxies to `tickets-web:3000` on the shared `efm-public-net` Docker network. This is the **euphoric-tickets-web** app. Both stacks must be on `efm-public-net` for the proxy to resolve. DNS for `tickets.euphoric.gg` must point directly at the VPS IP with Cloudflare proxy **off** (same CEF iframe constraint as `info.euphoric.fm`). The `.fm` sibling (`tickets.euphoric.fm`) goes through the existing cloudflared tunnel and is NOT served by this Caddy.

## Stack (locked)

- Astro 6 (static, no SSR) · Tailwind 3 · TypeScript strict
- Caddy 2 binds 0.0.0.0:80+443 directly and terminates TLS via Let's Encrypt — no cloudflared, no Cloudflare proxy (in-game CEF iframe compatibility; see Rule 4)
- pnpm 10 · Node 24
- Watchtower for auto-deploy on new GHCR images

## Deployment

`main` → CI builds + pushes `ghcr.io/jason-tucker/euphoricfm-website:latest` (site) and
`ghcr.io/jason-tucker/euphoricfm-website-requests:latest` (server sidecar) in parallel jobs →
watchtower (in compose) auto-pulls within ~60s. Push to `main` → live in ~60–90s. Public ingress is
Caddy 2 binding 0.0.0.0:80+443 directly and terminating TLS via Let's Encrypt — no cloudflared,
no Cloudflare proxy (in-game CEF iframe compatibility; see Rule 4). The footer of every page
displays `v<package.json version> · <short SHA>` so you always know which build is running.

## Build and dev commands

| Command | What it does |
|---|---|
| `pnpm dev` | `astro dev` — local dev server |
| `pnpm build` | `astro build` — production static build |
| `pnpm preview` | `astro preview` — preview the production build locally |
| `pnpm test` | `node --test server/*.test.mjs` — server sidecar test suite (node:test, zero deps) |

There is **no `typecheck` script** in `package.json`. Type-checking runs as `pnpm exec astro check`. CI runs it with `continue-on-error: true` — type errors warn but do not fail the build.

## AzuraCast specifics

- Station shortcode: `euphoricfm`. The numeric internal ID is `1`, surfaced in
  request URLs (e.g. `/api/station/1/request/<id>`) — don't hardcode `1`, use
  `request_url` from the requests endpoint payload instead.
- The `now_playing` object includes `sh_id` (unique per playback), `played_at`
  (unix seconds), `duration`, and `elapsed`. Use `played_at` + `duration` for
  client-side progress interpolation, and `sh_id` for track-change detection.
- Listener count is `listeners.current`. History is `song_history[]`.

## Discord webhooks

The "submit a song" and "contact us" forms POST to Discord webhooks. Webhook URLs are
**runtime env-injected** (see Rule 7): Caddy serves `/efm-runtime-config.js` which templates
`PUBLIC_DISCORD_REQUEST_WEBHOOK` and `PUBLIC_DISCORD_CONTACT_WEBHOOK` from the container env into
`window.__EFM_CONFIG__.discord`. The modals read them at submit time from that object. They are
never baked into the static build. Match the embed shape that AzuraCast's existing button uses —
`username`, `avatar_url`, `thread_name`, `embeds[{ title, description, fields,
color, timestamp, footer }]` — so the team's existing Discord thread routing
keeps working.
