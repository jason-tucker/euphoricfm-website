#!/bin/sh
# Integration test for the Caddyfile's /music → music.euphoric.fm routing.
#
# Runs the repo's Caddyfile in caddy:2.10-alpine against a built dist/ (run
# `pnpm build` first — e.g. in node:24-alpine) with plain-HTTP test hostnames
# (no ACME), then curls every positive/negative redirect case plus the
# iframe/CEF card cases. Exits non-zero on the first mismatch.
#
#   sh test/caddy-music-redirect.sh
set -eu
cd "$(dirname "$0")/.."
[ -f dist/music-card/index.html ] || { echo "dist/ not built (need dist/music-card/index.html)"; exit 2; }

PORT="${PORT:-18080}"
NAME="efm-caddy-music-test-$$"
docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:80" \
  -e SITE_HOSTNAME=http://info.euphoric.fm \
  -e TICKETS_GG_HOSTNAME=http://tickets.euphoric.gg \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$PWD/dist:/srv/site:ro" \
  caddy:2.10-alpine >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT
i=0; until curl -s -o /dev/null "http://127.0.0.1:$PORT/" -H 'Host: info.euphoric.fm'; do
  i=$((i+1)); [ $i -gt 50 ] && { echo "caddy did not start"; docker logs "$NAME"; exit 2; }; sleep 0.2
done

FAIL=0
# req <path> [curl header args...] → prints "status|location|cache-control|vary|is-card"
req() {
  p="$1"; shift
  hdrs=$(curl -s -D - -o /tmp/efm-body.$$ --path-as-is "http://127.0.0.1:$PORT$p" -H 'Host: info.euphoric.fm' "$@")
  st=$(printf '%s' "$hdrs" | head -1 | awk '{print $2}')
  loc=$(printf '%s' "$hdrs" | grep -i '^location:' | cut -d' ' -f2- | tr -d '\r')
  cc=$(printf '%s' "$hdrs" | grep -i '^cache-control:' | cut -d' ' -f2- | tr -d '\r')
  vary=$(printf '%s' "$hdrs" | grep -i '^vary:' | cut -d' ' -f2- | tr -d '\r' | paste -sd, -)
  card=no; grep -q 'Music submissions happen in your browser' /tmp/efm-body.$$ && card=yes
  printf '%s|%s|%s|%s|%s' "$st" "$loc" "$cc" "$vary" "$card"
}
# check <label> <expected-status> <expected-location or -> <expect-card yes/no> <path> [headers...]
check() {
  label="$1" est="$2" eloc="$3" ecard="$4" p="$5"; shift 5
  out=$(req "$p" "$@")
  st=$(echo "$out" | cut -d'|' -f1); loc=$(echo "$out" | cut -d'|' -f2); card=$(echo "$out" | cut -d'|' -f5)
  [ "$eloc" = "-" ] && eloc=""
  ok=PASS
  [ "$st" = "$est" ] || ok=FAIL
  [ "$loc" = "$eloc" ] || ok=FAIL
  [ "$card" = "$ecard" ] || ok=FAIL
  # Any Location header must be on music.euphoric.fm and nothing else.
  case "$loc" in ""|https://music.euphoric.fm/*) ;; *) ok=FAIL ;; esac
  [ "$ok" = PASS ] || FAIL=1
  printf '%-4s %-44s %-22s -> %s\n' "$ok" "$label" "$p" "$out"
}

P=https://music.euphoric.fm
echo "RESULT label path -> status|location|cache-control|vary|card"
check "root redirect"                 302 "$P/"             no  /music
check "trailing slash"                302 "$P/"             no  /music/
check "rest path"                     302 "$P/dashboard"    no  /music/dashboard
check "nested rest + query kept"      302 "$P/a/b?x=1&y=2"  no  '/music/a/b?x=1&y=2'
check "root + query"                  302 "$P/"             no  '/music?x=1'
# Caddy merges the duplicate slashes when stripping the prefix; either way the
# host is the literal music.euphoric.fm.
check "leading // stays on host"      302 "$P/evil.com"     no  //music//evil.com
check "//evil via rest stays on host" 302 "$P/evil.com"     no  /music//evil.com
check "///evil via rest stays on host" 302 "$P/evil.com"    no  /music///evil.com
check "@ in rest stays on host"       302 "$P/@evil.com"    no  /music/@evil.com
check "encoded slashes stay encoded"  302 "$P/%2F%2Fevil.com" no /music/%2F%2Fevil.com
check "backslash stays on host"       302 "$P/%5Cevil.com"  no  '/music/%5Cevil.com'
check "CRLF stays percent-encoded"    302 "$P/%0d%0aX-Evil:1" no '/music/%0d%0aX-Evil:1'
check "NEG /music.evil.com"           200 -                 no  /music.evil.com
check "NEG /music@evil.com"           200 -                 no  /music@evil.com
check "NEG /musicx"                   200 -                 no  /musicx
check "NEG /music-evil"               200 -                 no  /music-evil
# Caddy path matching is case-insensitive; still the fixed host.
check "case-insensitive /MUSIC"       302 "$P/"             no  /MUSIC
check "case-insensitive /Music/Foo"   302 "$P/Foo"          no  /Music/Foo
check "NEG /MUSIC.evil.com"           200 -                 no  /MUSIC.evil.com
check "NEG /music%2Eevil.com"         200 -                 no  /music%2Eevil.com
check "card: Sec-Fetch-Dest iframe"   200 -                 yes /music        -H 'Sec-Fetch-Dest: iframe'
check "card: iframe on rest path"     200 -                 yes /music/x/y    -H 'Sec-Fetch-Dest: iframe'
check "card: frame"                   200 -                 yes /music        -H 'Sec-Fetch-Dest: frame'
check "card: CitizenFX UA"            200 -                 yes /music        -A 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0 Safari/537.36 CitizenFX/1.0.0.12345'
check "card: citizenfx UA lowercase"  200 -                 yes /music/foo    -A 'mozilla citizenfx'
check "no card: Sec-Fetch-Dest doc"   302 "$P/"             no  /music        -H 'Sec-Fetch-Dest: document'
check "no card: iframe off /music"    200 -                 no  /musicx       -H 'Sec-Fetch-Dest: iframe'
check "card direct path"              200 -                 yes /music-card/

echo
echo "Headers on the card (framed):"
curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/music" -H 'Host: info.euphoric.fm' -H 'Sec-Fetch-Dest: iframe' \
  | grep -i -E '^(cache-control|vary|content-security-policy|x-frame-options|content-type):' | tr -d '\r'
echo "Headers on the redirect:"
curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/music/x" -H 'Host: info.euphoric.fm' \
  | grep -i -E '^(cache-control|vary|location):' | tr -d '\r'

# Card response must carry the required caching headers and stay framable.
H=$(curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/music" -H 'Host: info.euphoric.fm' -A 'CitizenFX')
echo "$H" | grep -qi '^cache-control: no-store' || { echo "FAIL card cache-control"; FAIL=1; }
echo "$H" | grep -qi '^vary: .*Sec-Fetch-Dest.*User-Agent' || { echo "FAIL card vary"; FAIL=1; }
echo "$H" | grep -qi 'frame-ancestors \*' || { echo "FAIL card CSP frame-ancestors"; FAIL=1; }
echo "$H" | grep -qi '^x-frame-options' && { echo "FAIL card has X-Frame-Options"; FAIL=1; }
grep -q 'window.top' dist/music-card/index.html && { echo "FAIL card references window.top"; FAIL=1; }
rm -f /tmp/efm-body.$$
[ "$FAIL" = 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
