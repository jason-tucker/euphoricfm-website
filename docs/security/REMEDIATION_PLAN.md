# Remediation Plan — euphoricfm-website

Fixes were applied in priority order (secrets/credential exposure → injection →
CI/CD → infra → validation → reliability → hygiene). All changes are on
`claude/intelligent-albattani-kuoj5a` as small, revertible commits and preserve
existing app behaviour.

## Done in this pass

| Priority | Finding | Action | Files | Verification |
|---|---|---|---|---|
| 1 | F1 Stored XSS (Critical) | Server URL allow-list (`sanitizeArt`) + client HTML-escape of `art` everywhere it is rendered | `server/index.mjs`, `src/scripts/nowplaying.ts`, `src/components/RequestModal.astro` | test #6 + #2; build pass |
| 2 | F4 Secrets in history (High) | gitleaks in CI; **rotation is an operator action** (documented) | `.github/workflows/security.yml` | gitleaks job |
| 3 | F3 No rate limit | Per-IP fixed-window limiter (20/min) + real client IP via Caddy XFF | `server/index.mjs`, `Caddyfile` | test #11 |
| 4 | F2 Secondary XSS sinks | Escape AzuraCast-sourced `art` | `nowplaying.ts`, `RequestModal.astro` | build pass |
| 5 | F7 Weak CSP | Behaviour-compatible CSP allow-list | `Caddyfile` | `caddy validate` (CI) + origin trace |
| 6 | F5 No CI security gates | CodeQL + gitleaks + `pnpm audit` + tests + `caddy validate`; `--ignore-scripts` | `.github/workflows/security.yml`, `build-and-publish.yml` | workflow runs on PR |
| 7 | F6 Mutable action tags | Dependabot (npm + github-actions) | `.github/dependabot.yml` | — |
| 8 | F10 No graceful shutdown | SIGTERM/SIGINT flush + close | `server/index.mjs` | manual |
| 9 | F11/F12 Body accounting + control chars | Byte-accurate limit + `sanitizeText` | `server/index.mjs` | tests #10, #3 |
| — | Testing gap | First test suite (15 cases) | `server/index.test.mjs` | `pnpm test` |

## Deliberately NOT changed (documented, needs human decision)

- **F8** `astro check` `continue-on-error: true` — flipping to blocking could
  break the live deploy on pre-existing type debt. A separate `test` job now
  gates independently. Decide whether to make typecheck blocking.
- **F9** Watchtower `:latest` + RW docker.sock — inherent to the auto-deploy
  design; watchtower requires a writable socket. Options: pin images to digests,
  use a scoped GHCR token, or gate redeploys behind a manual approval.
- **F13** Broad `/api/*` → euphoric.fm passthrough — tightening to e.g.
  `handle /api/station/*/request/* /api/nowplaying/* /api/station/*/requests`
  risks breaking the request-submit flow; verify against AzuraCast first.
- **Git history rewrite for F4** — requires a force-push (forbidden by this
  pass's safety rules). Rotation is the pragmatic mitigation.

## Rollback
Every change is isolated; `git revert <commit>` restores prior behaviour. The
highest-risk-to-revert item is the CSP (`Caddyfile`) — revert that one line if a
CEF client misbehaves. See `DEPLOYMENT_AND_ROLLBACK.md`.
