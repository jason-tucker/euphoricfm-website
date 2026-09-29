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
#   - /images/og.png is served as an image, and the runtime config hands the
#     contact webhook out under the neutral `contact` key
#   - cache policy: pages are `no-cache` (revalidate), real /_astro/* files are
#     immutable, and a MISSING /_astro, /fonts or /images file is a plain 404
#     (never the home page, never marked immutable)
#   - /robots.txt is the real file, and the old section URLs (/stats, /stats/,
#     /about, /listen, /contact) 301 to the one-page anchors while
#     /stats/summary still goes to the stats sidecar
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
# shellcheck disable=SC2086
docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:80" $ENVS \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$PWD/dist:/srv/site:ro" \
  "$IMG" >/dev/null
BODY=$(mktemp)
trap 'docker stop "$NAME" >/dev/null 2>&1 || true; rm -f "$BODY"' EXIT
i=0; until curl -s -o /dev/null "http://127.0.0.1:$PORT/" -H 'Host: info.euphoric.fm'; do
  i=$((i+1)); [ $i -gt 50 ] && { echo "caddy did not start"; docker logs "$NAME"; exit 2; }; sleep 0.2
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
# No sidecar in this test, so the proxied stats API answers 502 — the point is
# that it is NOT one of the exact-path redirects above.
check "/stats/summary → sidecar"     /stats/summary      502 -                   -
check "/aboutx is not redirected"    /aboutx             200 -                   home

echo
echo "Headers on /player/:"
H=$(curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/player/" -H 'Host: info.euphoric.fm' | tr -d '\r')
printf '%s\n' "$H" | grep -i -E '^(content-type|content-security-policy|x-frame-options):'
printf '%s\n' "$H" | grep -qi '^content-type: text/html' || { echo "FAIL content-type"; FAIL=1; }
printf '%s\n' "$H" | grep -qi "^content-security-policy: .*media-src https://euphoric.fm;.*frame-ancestors \*" || { echo "FAIL CSP"; FAIL=1; }
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
echo "Share image and runtime config:"
OG=$(curl -s -D - -o "$BODY" "http://127.0.0.1:$PORT/images/og.png" -H 'Host: info.euphoric.fm' | tr -d '\r')
printf '%s\n' "$OG" | grep -i -E '^(HTTP|content-type):'
printf '%s\n' "$OG" | grep -qi '^content-type: image/png' || { echo "FAIL og.png is not served as an image (SPA fallback?)"; FAIL=1; }
# The contact webhook sits under a neutral key: the info site never says "Discord".
RC=$(curl -s "http://127.0.0.1:$PORT/efm-runtime-config.js" -H 'Host: info.euphoric.fm')
echo "$RC"
echo "$RC" | grep -q '__EFM_CONFIG__.contact={webhook:' || { echo "FAIL runtime config key"; FAIL=1; }
echo "$RC" | grep -qi discord && { echo "FAIL runtime config mentions discord"; FAIL=1; }

[ "$FAIL" = 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
