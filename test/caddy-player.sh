#!/bin/sh
# Integration test for how the Caddyfile serves the Web Player (/player/).
#
# Runs the repo's Caddyfile in caddy:2.10-alpine against a built dist/ (run
# `pnpm build` first) with plain-HTTP test hostnames (no ACME), validates the
# config, then asserts:
#   - /player/ (and ?popout=1) returns the PLAYER page, not the SPA-fallback home
#   - /player and /player?popout=1 get a 308 to the slash form (like /events)
#   - the home page and the unknown-path fallback still serve the home page
#   - /player/ carries the site's security headers (CSP unchanged, framable)
#   - /images/og.png is served as an image
#   - the contact relay: POST /contact/message and /contact/event reach the
#     efm-requests sidecar (a stub here, aliased `efm-requests` on a throwaway
#     network) with Caddy's own X-Forwarded-For, /api/* still goes to the
#     AzuraCast upstream and not the sidecar, the retired /efm-runtime-config.js
#     is an uncached 410 with no webhook in it, and the CSP has no discord.com
#   - cache policy: pages are `no-cache` (revalidate), real /_astro/* files are
#     immutable, and a MISSING /_astro, /fonts or /images file is a plain 404
#     (never the home page, never marked immutable)
#   - /robots.txt is the real file, and the old section URLs (/stats, /stats/,
#     /about, /listen, /contact) 301 to the one-page anchors while
#     /stats/summary still goes to the stats sidecar
# The AzuraCast upstream (euphoric.fm) is pinned to 127.0.0.1 inside the Caddy
# container, so a proxied /api/* call answers 502 and nothing here ever
# reaches production. Needs the node:24-alpine image for the stub.
# Exits non-zero if any check fails.
#
#   sh test/caddy-player.sh
set -eu
cd "$(dirname "$0")/.."
[ -f dist/player/index.html ] || { echo "dist/ not built (need dist/player/index.html)"; exit 2; }

IMG=caddy:2.10-alpine
ENVS="-e SITE_HOSTNAME=http://info.euphoric.fm -e TICKETS_GG_HOSTNAME=http://tickets.euphoric.gg"

echo "caddy validate:"
# shellcheck disable=SC2086
docker run --rm $ENVS -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" "$IMG" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1

PORT="${PORT:-18081}"
NAME="efm-caddy-player-test-$$"
NET="$NAME-net"
STUB="$NAME-sidecar"
BODY=$(mktemp)
cleanup() {
  docker stop "$NAME" "$STUB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -f "$BODY"
}
trap cleanup EXIT
docker network create "$NET" >/dev/null
# Stand-in for the efm-requests sidecar: logs every request it gets (test id,
# method, path, X-Forwarded-For) and answers 204 to POST /contact/*, 200 else.
docker run -d --rm --name "$STUB" --network "$NET" --network-alias efm-requests \
  node:24-alpine node -e '
    require("http").createServer((q, s) => {
      q.resume();
      q.on("end", () => {
        console.log("HIT " + (q.headers["x-test-id"] || "-") + " " + q.method + " " + q.url + " xff=" + (q.headers["x-forwarded-for"] || "-"));
        if (q.method === "POST" && q.url.startsWith("/contact/")) { s.writeHead(204); s.end(); return; }
        s.writeHead(200, { "content-type": "application/json" });
        s.end("{\"stub\":true}");
      });
    }).listen(3000);' >/dev/null
# shellcheck disable=SC2086
docker run -d --rm --name "$NAME" --network "$NET" -p "127.0.0.1:$PORT:80" $ENVS \
  --add-host euphoric.fm:127.0.0.1 \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$PWD/dist:/srv/site:ro" \
  "$IMG" >/dev/null
i=0; until curl -s -o /dev/null "http://127.0.0.1:$PORT/" -H 'Host: info.euphoric.fm' &&
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/requests/health" -H 'Host: info.euphoric.fm')" = 200 ]; do
  i=$((i+1)); [ $i -gt 100 ] && { echo "caddy/stub did not start"; docker logs "$NAME"; docker logs "$STUB"; exit 2; }; sleep 0.2
done

FAIL=0
# check <label> <path> <expected-status> <expected-location or -> <expected page: player|home|->
check() {
  label="$1" p="$2" est="$3" eloc="$4" epage="$5"
  hdrs=$(curl -s -D - -o "$BODY" --path-as-is "http://127.0.0.1:$PORT$p" -H 'Host: info.euphoric.fm')
  st=$(printf '%s' "$hdrs" | head -1 | awk '{print $2}')
  loc=$(printf '%s' "$hdrs" | grep -i '^location:' | cut -d' ' -f2- | tr -d '\r')
  page=-
  grep -q 'id="efmp"' "$BODY" && page=player
  grep -q 'id="np-card"' "$BODY" && page=home
  [ "$eloc" = "-" ] && eloc=""
  ok=PASS
  [ "$st" = "$est" ] || ok=FAIL
  [ "$loc" = "$eloc" ] || ok=FAIL
  [ "$epage" = "-" ] || [ "$page" = "$epage" ] || ok=FAIL
  [ "$ok" = PASS ] || FAIL=1
  printf '%-4s %-36s %-22s -> %s %s %s\n' "$ok" "$label" "$p" "$st" "${loc:--}" "$page"
}

echo "RESULT label path -> status location page"
check "player page"                  /player/            200 -                   player
check "player pop-out"               '/player/?popout=1' 200 -                   player
check "no slash → 308 to slash"      /player             308 /player/            -
check "no slash keeps the query"     '/player?popout=1'  308 '/player/?popout=1' -
check "index.html serves the player" /player/index.html  200 -                   player
check "events still 308s"            /events             308 /events/            -
check "home page"                    /                   200 -                   home
check "unknown path → home fallback" /nope               200 -                   home
check "under /player/ → home"        /player/nope        200 -                   home
check "missing asset → 404"          /_astro/nope.js     404 -                   -
check "missing font → 404"           /fonts/nope.woff2   404 -                   -
check "missing image → 404"          /images/nope.png    404 -                   -
check "/stats → #stats"              /stats              301 /#stats             -
check "/stats/ → #stats"             /stats/             301 /#stats             -
check "/about → #about"              /about              301 /#about             -
check "/listen → #listen"            /listen             301 /#listen            -
check "/contact → #contact"          /contact            301 /#contact           -
check "/contact?x keeps no query"    '/contact?x=1'      301 /#contact           -
check "/contact/ → #contact"         /contact/           301 /#contact           -
# The stub sidecar answers 200 — the point is that it is NOT one of the
# exact-path redirects above (the relay section checks which backend answered).
check "/stats/summary → sidecar"     /stats/summary      200 -                   -
check "/aboutx is not redirected"    /aboutx             200 -                   home

echo
echo "Headers on /player/:"
H=$(curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/player/" -H 'Host: info.euphoric.fm' | tr -d '\r')
printf '%s\n' "$H" | grep -i -E '^(content-type|content-security-policy|x-frame-options):'
printf '%s\n' "$H" | grep -qi '^content-type: text/html' || { echo "FAIL content-type"; FAIL=1; }
printf '%s\n' "$H" | grep -qi "^content-security-policy: .*media-src https://euphoric.fm;.*frame-ancestors \*" || { echo "FAIL CSP"; FAIL=1; }
printf '%s\n' "$H" | grep -i '^content-security-policy:' | grep -qi 'discord' && { echo "FAIL CSP still allows discord"; FAIL=1; }
printf '%s\n' "$H" | grep -qi "^content-security-policy: .*connect-src 'self' https://euphoric.fm;" || { echo "FAIL CSP connect-src"; FAIL=1; }
printf '%s\n' "$H" | grep -qi '^x-frame-options:' && { echo "FAIL X-Frame-Options present"; FAIL=1; }

echo
echo "Cache policy:"
# hcheck <label> <path> <grep -E pattern the headers must match> [pattern they must NOT match]
hcheck() {
  H=$(curl -s -D - -o "$BODY" "http://127.0.0.1:$PORT$2" -H 'Host: info.euphoric.fm' | tr -d '\r')
  ok=PASS
  printf '%s\n' "$H" | grep -qiE "$3" || ok=FAIL
  [ -z "${4:-}" ] || ! printf '%s\n' "$H" | grep -qiE "$4" || ok=FAIL
  [ "$ok" = PASS ] || FAIL=1
  printf '%-4s %-30s %-44s %s\n' "$ok" "$1" "$2" "$(printf '%s\n' "$H" | grep -i '^cache-control:' | tr '\n' ' ')"
}
CSS=$(cd dist && ls _astro/*.css | head -1)
JS=$(cd dist && ls _astro/*.js | head -1)
hcheck "home revalidates"        /                    '^cache-control: no-cache$'
hcheck "player revalidates"      /player/             '^cache-control: no-cache$'
hcheck "fallback revalidates"    /nope                '^cache-control: no-cache$'
hcheck "real css is immutable"   "/$CSS"              '^cache-control: public, max-age=31536000, immutable$'
hcheck "real js is immutable"    "/$JS"               '^cache-control: public, max-age=31536000, immutable$'
hcheck "missing js: no immutable" /_astro/nope.js     '^HTTP/[0-9.]+ 404' 'immutable|^content-type: text/html'
hcheck "missing css: no immutable" /_astro/nope.css   '^HTTP/[0-9.]+ 404' 'immutable|^content-type: text/html'
hcheck "woff2 wordmark font"     /fonts/CortadoScript-Regular.woff2 '^content-type: font/woff2' 'no-cache'
hcheck "font is immutable"       /fonts/CortadoScript-Regular.woff2 '^cache-control: public, max-age=31536000, immutable$'
hcheck "sw.js stays uncached"    /sw.js               '^cache-control: no-cache, no-store, must-revalidate$'
hcheck "robots.txt is the file"  /robots.txt          '^content-type: text/plain' 'no-cache'
head -c 10 "$BODY" | grep -q '^User-agent' || { echo "FAIL robots.txt body is not a robots file"; FAIL=1; }

echo
echo "Share image:"
OG=$(curl -s -D - -o "$BODY" "http://127.0.0.1:$PORT/images/og.png" -H 'Host: info.euphoric.fm' | tr -d '\r')
printf '%s\n' "$OG" | grep -i -E '^(HTTP|content-type):'
printf '%s\n' "$OG" | grep -qi '^content-type: image/png' || { echo "FAIL og.png is not served as an image (SPA fallback?)"; FAIL=1; }

echo
echo "Contact relay and the retired runtime config:"
# rcheck <label> <sidecar|caddy> <expected status> <path> [curl args...]
# "sidecar" = the stub logged this request; "caddy" = it never reached it.
N=0
rcheck() {
  label="$1" want="$2" est="$3" p="$4"; shift 4
  N=$((N+1)); id="r$N"
  st=$(curl -s -o "$BODY" -w '%{http_code}' --path-as-is "http://127.0.0.1:$PORT$p" \
    -H 'Host: info.euphoric.fm' -H "X-Test-Id: $id" "$@")
  sleep 0.1
  line=$(docker logs "$STUB" 2>&1 | grep "^HIT $id " || true)
  if [ -n "$line" ]; then hit=sidecar; else hit=caddy; fi
  ok=PASS
  [ "$st" = "$est" ] || ok=FAIL
  [ "$hit" = "$want" ] || ok=FAIL
  [ "$ok" = PASS ] || FAIL=1
  printf '%-4s %-36s %-30s -> %s via %s\n' "$ok" "$label" "$p" "$st" "$hit"
}
JSON='-H Content-Type:application/json'
# shellcheck disable=SC2086
rcheck "contact message → sidecar"   sidecar 204 /contact/message -X POST $JSON -d '{"name":"t","subject":"t","message":"t"}' -H 'X-Forwarded-For: 1.2.3.4'
# Caddy replaces a client-supplied X-Forwarded-For with the real peer, so the
# sidecar's per-IP limit can't be dodged by sending a fresh value each time.
XFF=$(docker logs "$STUB" 2>&1 | grep "^HIT r1 " | sed 's/.* xff=//')
case "$XFF" in *1.2.3.4*|-|"") echo "FAIL sidecar saw a spoofable X-Forwarded-For: $XFF"; FAIL=1 ;; *) echo "PASS sidecar X-Forwarded-For is Caddy's ($XFF)" ;; esac
# shellcheck disable=SC2086
rcheck "event inquiry → sidecar"     sidecar 204 /contact/event -X POST $JSON -d '{}'
rcheck "contact query kept → sidecar" sidecar 204 '/contact/message?x=1' -X POST -d '{}'
rcheck "GET /contact/x → sidecar"    sidecar 200 /contact/x
# 40 KB is over the request_body cap: Caddy refuses it, the sidecar never sees it.
head -c 40000 /dev/zero | tr '\0' 'a' > "$BODY.big"
# shellcheck disable=SC2086
rcheck "oversized contact → 413"     caddy   413 /contact/message -X POST $JSON --data-binary "@$BODY.big"
rm -f "$BODY.big"
# /api/* is still the AzuraCast proxy, not the relay (upstream pinned to
# 127.0.0.1 here, so it answers 502 — GET only, never a request submit).
rcheck "/api/station → upstream"     caddy   502 /api/station/euphoricfm/requests
rcheck "/contact stays a redirect"   caddy   301 /contact
rcheck "runtime config → 410"        caddy   410 /efm-runtime-config.js
grep -qi 'discord' "$BODY" && { echo "FAIL retired runtime config mentions discord"; FAIL=1; }
grep -q 'api/webhooks' "$BODY" && { echo "FAIL retired runtime config carries a webhook"; FAIL=1; }
RC=$(curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/efm-runtime-config.js" -H 'Host: info.euphoric.fm' | tr -d '\r')
printf '%s\n' "$RC" | grep -qi '^cache-control: no-store$' || { echo "FAIL runtime config 410 is cacheable"; FAIL=1; }

[ "$FAIL" = 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
