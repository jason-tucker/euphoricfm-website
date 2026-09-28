#!/bin/sh
# Integration test for the Caddyfile's /music → music.euphoric.fm routing.
#
# Runs the repo's Caddyfile in caddy:2.10-alpine against a built dist/ (run
# `pnpm build` first — e.g. in node:24-alpine) with plain-HTTP test hostnames
# (no ACME), then curls every positive/negative redirect case, including framed
# (Sec-Fetch-Dest: iframe) and in-game (CitizenFX UA) requests, which get the
# SAME 302 as everyone else. Exits non-zero if any check fails.
#
#   sh test/caddy-music-redirect.sh
set -eu
cd "$(dirname "$0")/.."
[ -f dist/index.html ] || { echo "dist/ not built (need dist/index.html)"; exit 2; }

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
# req <path> [curl header args...] → prints "status|location|cache-control|vary"
req() {
  p="$1"; shift
  hdrs=$(curl -s -D - -o /tmp/efm-body.$$ --path-as-is "http://127.0.0.1:$PORT$p" -H 'Host: info.euphoric.fm' "$@")
  st=$(printf '%s' "$hdrs" | head -1 | awk '{print $2}')
  loc=$(printf '%s' "$hdrs" | grep -i '^location:' | cut -d' ' -f2- | tr -d '\r')
  cc=$(printf '%s' "$hdrs" | grep -i '^cache-control:' | cut -d' ' -f2- | tr -d '\r')
  vary=$(printf '%s' "$hdrs" | grep -i '^vary:' | cut -d' ' -f2- | tr -d '\r' | paste -sd, -)
  printf '%s|%s|%s|%s' "$st" "$loc" "$cc" "$vary"
}
# check <label> <expected-status> <expected-location or -> <path> [headers...]
check() {
  label="$1" est="$2" eloc="$3" p="$4"; shift 4
  out=$(req "$p" "$@")
  st=$(echo "$out" | cut -d'|' -f1); loc=$(echo "$out" | cut -d'|' -f2); cc=$(echo "$out" | cut -d'|' -f3)
  [ "$eloc" = "-" ] && eloc=""
  ok=PASS
  [ "$st" = "$est" ] || ok=FAIL
  [ "$loc" = "$eloc" ] || ok=FAIL
  # Every redirect carries no-store.
  [ -z "$loc" ] || [ "$cc" = "no-store" ] || ok=FAIL
  # Any Location header must be on music.euphoric.fm and nothing else.
  case "$loc" in ""|https://music.euphoric.fm/*) ;; *) ok=FAIL ;; esac
  [ "$ok" = PASS ] || FAIL=1
  printf '%-4s %-44s %-22s -> %s\n' "$ok" "$label" "$p" "$out"
}

P=https://music.euphoric.fm
echo "RESULT label path -> status|location|cache-control|vary"
check "root redirect"                 302 "$P/"             /music
check "trailing slash"                302 "$P/"             /music/
check "rest path"                     302 "$P/dashboard"    /music/dashboard
check "nested rest + query kept"      302 "$P/a/b?x=1&y=2"  '/music/a/b?x=1&y=2'
check "root + query"                  302 "$P/"             '/music?x=1'
# Caddy merges the duplicate slashes when stripping the prefix; either way the
# host is the literal music.euphoric.fm.
check "leading // stays on host"      302 "$P/evil.com"     //music//evil.com
check "//evil via rest stays on host" 302 "$P/evil.com"     /music//evil.com
check "///evil via rest stays on host" 302 "$P/evil.com"    /music///evil.com
check "@ in rest stays on host"       302 "$P/@evil.com"    /music/@evil.com
check "encoded slashes stay encoded"  302 "$P/%2F%2Fevil.com" /music/%2F%2Fevil.com
check "backslash stays on host"       302 "$P/%5Cevil.com"  '/music/%5Cevil.com'
check "CRLF stays percent-encoded"    302 "$P/%0d%0aX-Evil:1" '/music/%0d%0aX-Evil:1'
# Encoded slash DIRECTLY after /music: the matcher sees the decoded
# /music/@evil.com, but the raw-path strip leaves "%2f@evil.com" (no leading
# "/"), which must NOT be appended to the host → plain root redirect.
check "%2f@ right after /music"       302 "$P/"             '/music%2f@evil.com/pwn'
check "%2F@ right after /music"       302 "$P/"             '/music%2F@evil.com/'
check "%2f@ mixed case + port"        302 "$P/"             '/Music%2f@evil.com:443/x'
check "%2F@ uppercase /MUSIC"         302 "$P/"             '/MUSIC%2F@evil.com/x'
check "%2Fevil.com after /music"      302 "$P/"             /music%2Fevil.com
check "%2f alone after /music"        302 "$P/"             /music%2f
check "NEG %5C after /music"          200 -                 '/music%5C@evil.com'
check "NEG /music.evil.com"           200 -                 /music.evil.com
check "NEG /music@evil.com"           200 -                 /music@evil.com
check "NEG /musicx"                   200 -                 /musicx
check "NEG /music-evil"               200 -                 /music-evil
# Caddy path matching is case-insensitive; still the fixed host.
check "case-insensitive /MUSIC"       302 "$P/"             /MUSIC
check "case-insensitive /Music/Foo"   302 "$P/Foo"          /Music/Foo
check "NEG /MUSIC.evil.com"           200 -                 /MUSIC.evil.com
check "NEG /music%2Eevil.com"         200 -                 /music%2Eevil.com
# No in-game special-casing: framed and CitizenFX requests get the same 302.
check "framed (Sec-Fetch-Dest iframe)" 302 "$P/"             /music        -H 'Sec-Fetch-Dest: iframe'
check "framed on rest path"           302 "$P/x/y"          /music/x/y    -H 'Sec-Fetch-Dest: iframe'
check "Sec-Fetch-Dest frame"          302 "$P/"             /music        -H 'Sec-Fetch-Dest: frame'
check "CitizenFX UA"                  302 "$P/"             /music        -A 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0 Safari/537.36 CitizenFX/1.0.0.12345'
check "citizenfx UA on rest path"     302 "$P/foo"          /music/foo    -A 'mozilla citizenfx'
check "Sec-Fetch-Dest document"       302 "$P/"             /music        -H 'Sec-Fetch-Dest: document'
check "NEG framed /musicx"            200 -                 /musicx       -H 'Sec-Fetch-Dest: iframe'
check "NEG /music-card/ (removed)"    200 -                 /music-card/

echo
echo "Headers on the redirect (framed + CitizenFX):"
curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/music/x?y=1" -H 'Host: info.euphoric.fm' -H 'Sec-Fetch-Dest: iframe' -A 'CitizenFX' \
  | grep -i -E '^(cache-control|vary|location):' | tr -d '\r'

# The song-submission webhook must no longer be handed out to visitors.
RC=$(curl -s "http://127.0.0.1:$PORT/efm-runtime-config.js" -H 'Host: info.euphoric.fm')
echo "Runtime config: $RC"
echo "$RC" | grep -q requestWebhook && { echo "FAIL runtime config still serves requestWebhook"; FAIL=1; }
[ -e dist/music-card ] && { echo "FAIL dist/music-card still built"; FAIL=1; }
rm -f /tmp/efm-body.$$
[ "$FAIL" = 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
