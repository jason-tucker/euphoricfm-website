# euphoricfm-website

The in-game phone site for **EuphoricFM**, the pop radio station of a GTA5
roleplay server. Lives at [info.euphoric.fm](https://info.euphoric.fm) and is
embedded inside the in-game phone's iframe browser.

Drives all UI from AzuraCast's public JSON (`/api/nowplaying/euphoricfm` and
`/api/station/euphoricfm/requests`). Discord webhooks handle the "submit a
new song" and "contact us" flows.

## Stack

- **Astro 6** static + **Tailwind 3** — single page, mobile-first at ~360–400px.
- **Caddy 2** serving the build out of an alpine image.
- **Docker Compose** with **Watchtower** for auto-deploy from GHCR.
- **Cloudflare Tunnel** on the VPS is the only public ingress.

## Local development

```sh
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # writes ./dist
```

## Deploy

Push to `main` → GitHub Actions builds the multi-stage Docker image and pushes
to `ghcr.io/jason-tucker/euphoricfm-website:latest` → Watchtower on the VPS
auto-pulls within ~60s. Total round-trip: ~60–90 seconds.

The footer of every page shows `v<package.json version> · <short SHA>` so you
always know which build is running.

### One-time setup on the VPS

```sh
cd ~/stacks/euphoricfm-website
cp .env.example .env
# edit .env — set PORT, IMAGE, and (optionally override) the webhook URLs
docker compose up -d
```

Then add `info.euphoric.fm → http://localhost:6094` in the Cloudflare Zero
Trust dashboard (the cloudflared container on this VPS uses host network mode
and a remote-managed tunnel via `TUNNEL_TOKEN`).

After editing `.env`, ALWAYS run `docker compose up -d` (not `restart`) —
Compose only re-reads `.env` on `up`.

## Editing copy

Almost every string and URL lives in [`src/site.config.ts`](src/site.config.ts):

- Station name + tagline
- "What is EuphoricFM?" paragraphs (`aboutText`)
- Business AD price, perks, and note
- AzuraCast API base + station shortcode + stream URL
- Discord webhook URLs (or override at runtime via `PUBLIC_DISCORD_*_WEBHOOK` env vars)

To change a webhook without rebuilding the image, edit `.env` on the host and
`docker compose up -d`.

## Architecture

```
src/
  layouts/BaseLayout.astro    HTML shell + window.__EFM_CONFIG__ injection
  pages/index.astro           composes the whole single-page site
  site.config.ts              one source of truth for editable strings + URLs
  lib/version.ts              footer version + sha
  lib/azuracast.ts            TS types + URL helpers for the AzuraCast API
  scripts/nowplaying.ts       polling + animated progress bar (client-side)
  styles/global.css           Tailwind base + @font-face + component layer
  components/
    Header.astro              wordmark (Begaron + Cortado Script)
    NowPlaying.astro          live now-playing card skeleton
    ListenButton.astro        HTML5 audio + volume
    ActionRow.astro           four CTAs that dispatch efm:open-* events
    RecentlyPlayed.astro      empty list, hydrated by nowplaying.ts
    About.astro               "What is EuphoricFM?" blurb
    RequestModal.astro        AzuraCast library search + POST request
    SubmitSongModal.astro     Discord webhook — artist song submission
    ContactModal.astro        Discord webhook — general contact form
    BusinessAdModal.astro     static pricing + perks
    Footer.astro              copyright + v<version> · <sha>
public/fonts/                  Begaron + Cortado Script TTFs/WOFF2
Dockerfile                     node:24-alpine build → caddy:2.10-alpine serve
Caddyfile                      static, iframe-safe CSP, long cache headers
docker-compose.yml             web + watchtower, 127.0.0.1:${PORT}
.github/workflows/build-and-publish.yml
```

## License

Private. EuphoricFM brand and content © its respective owners.
