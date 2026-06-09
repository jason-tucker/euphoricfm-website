# Threat Model — euphoricfm-website

Modelled as internet-facing with untrusted, hostile users.

## System map

| Component | Tech | Exposure | Trust |
|---|---|---|---|
| Static site | Astro 6 build, served by Caddy from `/srv/site` | Public `:80/:443` | content is build-time, trusted |
| `efm-web` (Caddy) | Caddy 2, hardened container | Public ingress, terminates TLS | trusted edge |
| `efm-requests` | Node 24, zero-dep `server/index.mjs` | **Internal only** (no host port), reached via Caddy `/requests/*` | semi-trusted (processes anonymous input) |
| Pending store | `/data/pending.json`, ≤50 entries | container volume | data is attacker-influenced |
| `tickets-web` | separate app on `efm-public-net` | proxied at `tickets.euphoric.gg` | **out of scope** (different project) |
| AzuraCast | `euphoric.fm` API/stream/art | external, public | external dependency |
| Discord | webhook endpoints | external | external sink |
| Watchtower | auto-deploy, mounts docker.sock | host | high-privilege automation |

## Assets
- Integrity of content rendered to every visitor (the in-game phone audience).
- Availability of the now-playing/request experience.
- The Discord webhook URLs (low-value — public by design, but abusable for spam).
- The host (via the watchtower/docker.sock + `:latest` auto-deploy path).
- CI/CD integrity (GHCR push → auto-deploy).

## Trust boundaries
1. Browser ↔ Caddy (public internet).
2. Caddy ↔ `efm-requests` (internal docker network; XFF trust established here).
3. Caddy ↔ `euphoric.fm` / Discord (egress to third parties).
4. GitHub → GHCR → Watchtower → host (the supply-chain → production path).

## Attackers & primary abuse cases
- **Anonymous web attacker** → the high-value path was POST `/requests/track`
  with a crafted `art` to achieve **stored XSS against all visitors** (F1, fixed),
  or flooding it to deface/spam the shared list (F3, rate-limited).
- **Malicious dependency / compromised CI / GHCR push** → host RCE via
  Watchtower `:latest` + RW docker.sock (F9, documented). Mitigated by
  `--ignore-scripts`, dependency pinning/lockfile, CI scanning, minimal deps.
- **CSP/exfil** → without a real CSP any injected script had free egress (F7,
  fixed via allow-list CSP).
- **Header spoofing** → forging `X-Forwarded-For` to evade the rate limiter; not
  possible because Caddy overwrites it with the true `{remote_host}` and the
  service has no other ingress.
- **SSRF via the proxies** → `/api`, `/efm-art`, `/static` reverse-proxy with the
  upstream **host pinned** to `euphoric.fm`, so the path is attacker-controlled
  but the destination host is not → not a generic SSRF (F13, broad-but-bounded;
  documented).

## Data flows
- Read path: browser → `euphoric.fm` (CORS now-playing/library) + Caddy
  `/efm-art` (same-origin art) + `/requests/pending` (shared list).
- Write path: browser → Caddy `/api/*` → AzuraCast (enqueue) and →
  `/requests/track` (record pending) and → Discord (submit/contact webhook).
- Background: `efm-requests` polls AzuraCast now-playing every 30s to prune aired
  requests; 6h TTL evicts stragglers.

## Non-applicable classes (verified, not skipped)
No DB/ORM (no SQL/NoSQL injection), no auth/sessions/JWT/OAuth (no authn/authz,
IDOR, or tenant isolation), no file uploads/parsing, no deserialization, no
templating of untrusted input server-side, **no AI/LLM/RAG/agents/model files**
(grep-confirmed: no `openai`/`anthropic`/`langchain`/`torch`/`pickle`/embeddings).

## High-risk components (post-fix, by residual risk)
1. Watchtower + docker.sock + `:latest` (host blast radius) — **documented**.
2. `efm-requests` write endpoint (only anonymous-input processor) — **hardened**.
3. The broad `/api/*` passthrough — **documented**, host-pinned.
