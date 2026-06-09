# Security Changelog — 0.10.0 (2026-06-09)

Security-relevant changes from this remediation pass. Mirrors the `Security`
section of the main `CHANGELOG.md`.

## Fixed
- **[Critical] Stored XSS via `/requests/track` `art` field (CWE-79).** The
  public, unauthenticated request-tracking endpoint stored `art` verbatim and
  the client rendered it unescaped into `<img src="${art}">` for every visitor.
  Fixed with a server-side URL allow-list (`sanitizeArt`) **and** client-side
  HTML-escaping (defence in depth).
- **[Medium] Missing rate limiting on the public write endpoint (CWE-770).**
  Added a per-IP fixed-window limiter (20/min → HTTP 429), with the real client
  IP forwarded by Caddy via `X-Forwarded-For {remote_host}`.
- **[Medium] Weak CSP.** Replaced `frame-ancestors *`-only with a
  behaviour-compatible policy allow-listing exactly the origins the app uses
  (`self`, `euphoric.fm`, `discord.com`, `data:`), plus `object-src 'none'` and
  `base-uri 'self'`. `frame-ancestors *` retained for the in-game-phone iframe.
- **[Low] No graceful shutdown / imprecise body limit / control chars stored** —
  added SIGTERM/SIGINT flush, byte-accurate body-size enforcement, and
  control-char stripping on stored text.

## Added
- **First test suite** (`server/index.test.mjs`, 15 `node:test` cases) proving
  the XSS sanitiser, rate limiting, dedupe, cap, body limits, and prune.
- **CI security scanning** (`.github/workflows/security.yml`): CodeQL, gitleaks
  secret scan, `pnpm audit --audit-level=high`, server tests, `caddy validate`.
  (dependency-review is left out until the repo's Dependency Graph is enabled.)
- **Dependabot** (`.github/dependabot.yml`) for npm + GitHub Actions.
- **`--ignore-scripts`** on the CI build install (matches the Dockerfile).

## Operator follow-ups (not code)
- Rotate the Discord webhook URLs committed in history (`5f27e19`).
- Enable GitHub secret scanning + push protection and branch protection on `main`.
- Confirm the CSP in a real FiveM CEF client before promoting.
- Decide on the watchtower `:latest` + docker.sock blast-radius trade-off.

## Not done (by policy)
- No git-history rewrite (would require a force-push).
- No production deploy (no authorised target; requires explicit approval).
