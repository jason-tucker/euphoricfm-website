#!/bin/sh
# Integration test for the tickets.euphoric.gg block's machine-API 404 rule.
#
# Runs the repo's Caddyfile in caddy:2.10-alpine (plain-HTTP test hostnames, no
# ACME) on a throwaway docker network next to a stub upstream aliased
# `tickets-web` (node, answers 200 on :3000 and logs every request it gets).
# Every /api/internal and /api/v1 form, including encoding / dot-segment /
# slash-merging bypass attempts, must get Caddy's 404 and never reach the stub;
# everything else must be proxied to the stub and come back 2xx.
# Exits non-zero if any check fails. Needs no dist/ build.
#
#   sh test/caddy-tickets-internal-block.sh
set -eu
cd "$(dirname "$0")/.."

PORT="${PORT:-18081}"
TAG="efm-caddy-tickets-test-$$"
NET="$TAG-net"
STUB="$TAG-stub"
CADDY="$TAG-caddy"
EMPTY=$(mktemp -d)
cleanup() {
  docker stop "$CADDY" "$STUB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rmdir "$EMPTY" 2>/dev/null || true
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --rm --name "$STUB" --network "$NET" --network-alias tickets-web \
  node:24-alpine node -e '
    require("http").createServer((q, s) => {
      console.log("HIT " + (q.headers["x-test-id"] || "-") + " " + q.method + " " + q.url);
      s.writeHead(200, { "content-type": "text/plain" });
      s.end("stub " + q.method + " " + q.url + "\n");
    }).listen(3000);' >/dev/null
docker run -d --rm --name "$CADDY" --network "$NET" -p "127.0.0.1:$PORT:80" \
  -e SITE_HOSTNAME=http://info.euphoric.fm \
  -e TICKETS_GG_HOSTNAME=http://tickets.euphoric.gg \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$EMPTY:/srv/site:ro" \
  caddy:2.10-alpine >/dev/null
i=0; until [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" -H 'Host: tickets.euphoric.gg')" = 200 ]; do
  i=$((i+1)); [ $i -gt 100 ] && { echo "caddy/stub did not start"; docker logs "$CADDY"; docker logs "$STUB"; exit 2; }; sleep 0.2
done

FAIL=0
N=0
# check <label> <block|allow> <path> [curl args...]
check() {
  label="$1" want="$2" p="$3"; shift 3
  N=$((N+1)); id="t$N"
  st=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "http://127.0.0.1:$PORT$p" \
    -H 'Host: tickets.euphoric.gg' -H "X-Test-Id: $id" "$@")
  sleep 0.05
  if docker logs "$STUB" 2>&1 | grep -q "^HIT $id "; then hit=upstream; else hit=caddy; fi
  ok=PASS
  case "$want" in
    block) [ "$st" = 404 ] && [ "$hit" = caddy ] || ok=FAIL ;;
    allow) case "$st" in 2??) ;; *) ok=FAIL ;; esac; [ "$hit" = upstream ] || ok=FAIL ;;
  esac
  [ "$ok" = PASS ] || FAIL=1
  printf '%-4s %-5s %-40s %-40s -> %s via %s\n' "$ok" "$want" "$label" "$p" "$st" "$hit"
}

echo "RESULT want  label path -> status via"
check "notify GET"                     block /api/internal/notify
check "notify POST"                    block /api/internal/notify -X POST -H 'Content-Type: application/json' -d '{}'
check "internal tickets"               block /api/internal/tickets/open
check "v1 tickets"                     block /api/v1/tickets
check "v1 tickets POST"                block /api/v1/tickets -X POST -d '{}'
check "bare /api/v1"                   block /api/v1
check "bare /api/internal"             block /api/internal
check "leading //"                     block //api/internal/notify
check "// after /api"                  block /api//internal/notify
check "// after internal"              block /api/internal//notify
check "%69 encoded i"                  block /api/%69nternal/notify
check "%2f encoded slash"              block /api/internal%2fnotify
check "%2F encoded slash (upper)"      block /api/internal%2Fnotify
check "dot segment"                    block /api/./internal/notify
check "dotdot segment"                 block /x/../api/internal/notify
check "bare query"                     block '/api/internal/notify?x'
check "trailing slash"                 block /api/internal/notify/
check "bare trailing slash"            block /api/v1/
# Next.js routes are case-sensitive, so the app itself would 404 /API/...;
# the (?i) rule blocks it at Caddy anyway.
check "uppercase /API"                 block /API/internal/notify
check "mixed case /Api/V1"             block /Api/V1/tickets
check "v1 %2f encoded slash"           block /api/v1%2ftickets
check "%2e%2e encoded dotdot"          block /x/%2e%2e/api/v1/tickets

check "root"                           allow /
check "login"                          allow /login
check "health"                         allow /api/health
check "auth csrf"                      allow /api/auth/csrf
check "auth callback"                  allow '/api/auth/callback/discord?code=x'
check "auth session"                   allow /api/auth/session
check "new ticket"                     allow /t/new
check "board ticket"                   allow /b/euphoricfm/tickets/1
check "next static"                    allow /_next/static/x.js
check "/api/internalx not a prefix"    allow /api/internalx
check "/api/v10 not a prefix"          allow /api/v10
check "/api/v1x not a prefix"          allow /api/v1x

echo
echo "Headers on a blocked response (site headers must still apply):"
H=$(curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/api/internal/notify" -H 'Host: tickets.euphoric.gg' | tr -d '\r')
echo "$H" | grep -i -E '^HTTP/|^(strict-transport-security|x-content-type-options|content-security-policy|server):' || true
echo "$H" | grep -qi '^strict-transport-security:' || { echo "FAIL blocked 404 lost the site headers"; FAIL=1; }
echo "$H" | grep -qi '^server:' && { echo "FAIL Server header present"; FAIL=1; }

[ "$FAIL" = 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
