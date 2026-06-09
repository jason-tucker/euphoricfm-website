# Test Results — euphoricfm-website

All commands below were actually executed in the review environment
(Node v22.22.2, pnpm 10.33.0).

## Build
```
$ pnpm install --frozen-lockfile --ignore-scripts   → done (327 pkgs)
$ pnpm build                                         → ✅ Complete (1 page, ~3s, static)
```
The build passes with `--ignore-scripts`, confirming no dependency lifecycle
script is required to build.

## Dependency audit
```
$ pnpm audit            → No known vulnerabilities found
$ pnpm audit --prod     → No known vulnerabilities found
```

## Server test suite (the fixes proven)
```
$ node --test server/*.test.mjs
ok 1  - sanitizeArt allows absolute http(s) and root-relative URLs
ok 2  - sanitizeArt strips attribute-breakout / XSS payloads to empty
ok 3  - sanitizeText removes control chars and caps length
ok 4  - clientIp uses the rightmost (trusted) X-Forwarded-For, else the socket peer
ok 5  - a spoofed X-Forwarded-For prefix cannot evade the rate limiter
ok 6  - POST then GET round-trips a sanitised entry
ok 7  - stored XSS in art is neutralised end-to-end
ok 8  - POST without an id is rejected 400
ok 9  - resubmitting the same id dedupes
ok 10 - the pending list is capped at MAX_ENTRIES
ok 11 - oversized bodies are rejected (not stored)
ok 12 - writes are rate-limited per IP (429 past the window cap)
ok 13 - health endpoint reports the pending count
ok 14 - unknown routes return 404
ok 15 - prune drops entries whose song has aired (injected fetch)
# tests 15
# pass 15
# fail 0
```

## Config validation
```
$ docker compose config -q     → exit 0 (valid)
$ caddy validate               → not run (docker daemon unavailable in review env;
                                  now gated in CI via the caddy:2.10-alpine image)
```

## Mapping fixes → tests
| Fix | Test(s) |
|---|---|
| F1 stored XSS (server allow-list + client escape) | #1, #2, #7 |
| F3 rate limiting | #12 |
| Rate-limiter IP source + XFF spoof resistance | #4, #5 |
| F11 body-size limit | #11 |
| F12 control-char strip | #3 |
| dedupe / cap / prune / routes (behaviour preserved) | #6, #8, #9, #10, #13, #14, #15 |

## Not run (and why)
- **DAST / ZAP** — no authorised running target in this environment.
- **CodeQL / gitleaks** — defined in `security.yml`; they run in GitHub Actions,
  not locally here.
- **caddy validate** — requires the docker daemon (unavailable); CI covers it.
