# Deployment & Rollback — euphoricfm-website

## Current state
- All changes on branch `claude/intelligent-albattani-kuoj5a`.
- **Not deployed.** No staging target was provided/authorised; no production
  deploy was performed (per the pass's safety rules).
- Version bumped `0.9.0 → 0.10.0` (footer renders `v0.10.0 · <sha>`).

## How this repo deploys (unchanged)
`push to main` → `build-and-publish.yml` builds + pushes
`ghcr.io/jason-tucker/euphoricfm-website:latest` (and a second image for
`server/`) → **Watchtower** on the VPS polls GHCR every 60s and recreates the
containers → live in ~60–90s. There is no separate staging environment.

## Recommended promotion path
1. Open a PR from `claude/intelligent-albattani-kuoj5a` → `main`.
2. Let the new `security` workflow + `build-and-publish` (PR build, no push) go
   green. Review the diff.
3. Before merge, **smoke-test the CSP in a real FiveM CEF client** if possible
   (the only change with any runtime-behaviour risk). A normal browser check:
   open the site, confirm now-playing loads, art renders, the audio stream
   plays, and submit/contact/request POSTs succeed — i.e. no CSP console
   violations for `euphoric.fm`, `discord.com`, `data:`, or `self`.
4. Merge → Watchtower auto-deploys within ~60–90s.
5. Post-deploy: watch `docker logs efm-web` / `efm-requests` for CSP report
   noise or 5xx; hit `/requests/health` (`{ok:true}`) and the home page.

## Rollback
- **Fastest (image):** re-pull the previous image digest and recreate, or
  `docker compose down efm-web && docker compose up -d efm-web` after repointing
  `IMAGE` to the prior `type=sha` tag (CI publishes short-SHA tags alongside
  `:latest`). Save the current digest before promoting:
  `docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/jason-tucker/euphoricfm-website:latest`.
- **Source:** `git revert <commit>` — changes are isolated per concern. The two
  most "live-behaviour" reverts, in order of likelihood:
  1. CSP — revert the `Content-Security-Policy` line in `Caddyfile` back to
     `frame-ancestors *`.
  2. `X-Forwarded-For` forward on `/requests/*` — harmless to revert (rate
     limiter falls back to the socket peer = Caddy's IP, i.e. a global cap).

## Health checks (already in compose)
- `efm-web`: `curl -fsS http://127.0.0.1:80/` (308 redirect counts as healthy).
- `efm-requests`: `wget --spider http://127.0.0.1:3000/requests/health`.

## Gating not yet satisfied for an unattended production deploy
- No authorised staging target → no smoke/DAST stage ran here.
- Branch protection + required checks on `main` not yet enabled (operator).
- These do not block a **manual, reviewed** merge — only an automated one.
