#!/bin/sh
# Full test harness, entirely in Docker (no node on the host):
#   builds web/worker/probe/fetch/test images, brings up postgres + mocks + the
#   real containers with their real mounts, runs music-fetch's own unit suite
#   (network none), vitest (unit + DB + e2e), then the mount / start-up-guard
#   shell checks, then records idle `docker stats`.
#   Nothing here reaches SoundCloud or any production system: music-fetch runs
#   with network_mode none and a fake yt-dlp (test/fetch-fake).
# Usage: test/run.sh            (from music/ or anywhere)
# Env:   DOCKER_COMPOSE="docker compose" (override the compose command)
#        KEEP=1 to leave the stack up afterwards.
#        MUSIC_TEST_PROJECT=<name> (default efm-music-test) isolates parallel
#        runs from different worktrees (compose project, networks, test image
#        tag); MUSIC_TEST_TAG overrides the runtime image tag; the web gets no
#        host port unless MUSIC_TEST_WEB_PORT is set (127.0.0.1:<port>).
set -eu
cd "$(dirname "$0")/.."
export MUSIC_DATA_DIR=./test/.out/data
export MUSIC_TEST_PROJECT="${MUSIC_TEST_PROJECT:-efm-music-test}"
P=$MUSIC_TEST_PROJECT
# CI tags the images built under the default project (…:<target>-local-test).
if [ -n "${MUSIC_TEST_TAG:-}" ]; then export MUSIC_TAG="$MUSIC_TEST_TAG"
elif [ "$P" = efm-music-test ]; then export MUSIC_TAG=local-test
else export MUSIC_TAG="local-test-$P"; fi
FILES="-f compose.yml -f test/compose.test.yml"
if [ -n "${MUSIC_TEST_WEB_PORT:-}" ]; then export MUSIC_TEST_WEB_PORT; FILES="$FILES -f test/compose.webport.yml"; fi
DC="${DOCKER_COMPOSE:-docker compose} -p $P $FILES"

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    $DC --profile tests down -v --remove-orphans >/dev/null 2>&1 || true
    docker run --rm -v "$PWD/test/.out:/o" alpine:3 rm -rf /o/data >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

$DC --profile tests down -v --remove-orphans >/dev/null 2>&1 || true
mkdir -p test/.out/data
docker run --rm -v "$PWD/test/.out:/o" alpine:3 sh -c 'rm -rf /o/data && mkdir -p /o/data/fetch-fixtures' >/dev/null

# The PRODUCTION compose definitions, resolved (anchors merged), for the
# static checks in test/compose-fetch.test.ts. compose refuses missing
# env_files, so this renders a copy next to empty ones (nothing is started).
cfg=test/.out/prodcfg
rm -rf "$cfg" && mkdir -p "$cfg/env"
for f in db migrate web worker events-web events-worker; do : > "$cfg/env/$f.env"; done
cp compose.yml "$cfg/compose.yml"
MUSIC_TAG=static-check ${DOCKER_COMPOSE:-docker compose} -f "$cfg/compose.yml" config --format json > "$cfg/compose.prod.json"
# test/.out/data was just recreated as root by the alpine step above, so a
# non-root CI runner cannot write into it: copy the file in the same way.
docker run --rm -v "$PWD/test/.out:/o" alpine:3 sh -c 'cp /o/prodcfg/compose.prod.json /o/data/compose.prod.json && chmod 644 /o/data/compose.prod.json' >/dev/null

echo "== build"
$DC --profile tests build

echo "== up"
$DC up -d --wait music-web music-worker music-probe music-fetch events-web events-worker events-probe mocks || { $DC logs --no-color --tail 80; exit 1; }

status=0
echo "== music-fetch unit tests (its own suite: runtime constraints, network none)"
if docker build -q --target test -t "$P/fetch-test:local" fetch >/dev/null \
  && docker run --rm --read-only --tmpfs /tmp:size=64m,uid=1000,gid=1000 --cap-drop ALL \
       --security-opt no-new-privileges:true --network none "$P/fetch-test:local" > test/.out/fetch-unit.log 2>&1; then
  tail -3 test/.out/fetch-unit.log
else
  cat test/.out/fetch-unit.log; status=1
fi

echo "== vitest"
$DC --profile tests run --rm tests pnpm exec vitest run --reporter=default > test/.out/vitest.log 2>&1 || status=1
cat test/.out/vitest.log

echo "== mount checks (real compose mounts)"
mc=0
check() { # name, service, command, expect(ok|fail)
  if $DC run --rm --no-deps -T --entrypoint sh "$2" -c "$3" >/dev/null 2>&1; then got=ok; else got=fail; fi
  if [ "$got" = "$4" ]; then echo "  PASS $1"; else echo "  FAIL $1 (got $got, want $4)"; mc=1; fi
}
check "web cannot write in-worker"          music-web   'touch /spool/probe/in-worker/x' fail
check "web cannot see in-worker at all"     music-web   'test -e /spool/probe/in-worker' fail
check "web cannot write /spool/probe/out"   music-web   'touch /spool/probe/out/x' fail
check "web cannot write /staging/final"     music-web   'mkdir -p /staging/final && touch /staging/final/x' fail
check "web can write in-web"                music-web   'touch /spool/probe/in-web/.mc && rm /spool/probe/in-web/.mc' ok
check "worker cannot write /staging/final"  music-worker 'touch /staging/final/x' fail
check "worker cannot write /spool/probe/out" music-worker 'touch /spool/probe/out/x' fail
check "worker cannot see /staging/uploads"  music-worker 'test -e /staging/uploads' fail
check "worker can write in-worker"          music-worker 'touch /spool/probe/in-worker/.mc && rm /spool/probe/in-worker/.mc' ok
check "probe has no network"                music-probe 'wget -q -T 3 -O /dev/null http://mocks:4104/egress' fail
check "probe can read /staging/fetch"       music-probe 'test -d /staging/fetch && ls /staging/fetch' ok
check "probe cannot write /staging/fetch"   music-probe 'touch /staging/fetch/x' fail
check "worker cannot see /staging/fetch"    music-worker 'test -e /staging/fetch' fail
check "worker can write /spool/fetch/in"    music-worker 'touch /spool/fetch/in/.mc && rm /spool/fetch/in/.mc' ok
check "worker cannot write /spool/fetch/out" music-worker 'touch /spool/fetch/out/x' fail
check "worker cannot see fetch's claimed"   music-worker 'test -e /spool/fetch/claimed' fail
check "web cannot see /spool/fetch"         music-web   'test -e /spool/fetch' fail
check "web cannot see /staging/fetch"       music-web   'test -e /staging/fetch' fail
check "fetch has no network (test stack)"   music-fetch 'wget -q -T 3 -O /dev/null http://mocks:4104/egress' fail
check "fetch sees no probe spool, uploads, final or art" music-fetch 'test -e /spool/probe || test -e /staging/uploads || test -e /staging/final || test -e /staging/art' fail
check "fetch rootfs is read-only"           music-fetch 'touch /usr/local/x' fail
check "fetch can write its staging + spool" music-fetch 'touch /staging/fetch/.mc /spool/fetch/out/.mc && rm /staging/fetch/.mc /spool/fetch/out/.mc' ok
check "web rootfs is read-only"             music-web   'touch /app/x' fail
check "web can write art-in"                music-web   'touch /staging/art-in/.mc && rm /staging/art-in/.mc' ok
check "web cannot write /staging/art"       music-web   'touch /staging/art/x' fail
check "worker cannot write /staging/art"    music-worker 'touch /staging/art/x' fail
check "worker can read /staging/art"        music-worker 'test -d /staging/art && ls /staging/art' ok
check "worker cannot see art-in"            music-worker 'test -e /staging/art-in' fail
check "probe cannot write art-in"           music-probe 'touch /staging/art-in/x' fail
# v0.5.0 events services: their own tree, nothing of music's.
check "events-web can write its in-web"       events-web  'touch /spool/probe/in-web/.mc && rm /spool/probe/in-web/.mc' ok
check "events-web can write its tus dir"      events-web  'touch /staging/uploads/.mc && rm /staging/uploads/.mc' ok
check "events-web cannot write /spool/probe/out" events-web 'touch /spool/probe/out/x' fail
check "events-web cannot see in-worker"       events-web  'test -e /spool/probe/in-worker' fail
check "events-web cannot see final/art/fetch" events-web  'test -e /staging/final || test -e /staging/art || test -e /staging/art-in || test -e /staging/fetch || test -e /spool/fetch' fail
check "events-web rootfs is read-only"        events-web  'touch /app/x' fail
check "events-worker can write its in-worker" events-worker 'touch /spool/probe/in-worker/.mc && rm /spool/probe/in-worker/.mc' ok
check "events-worker cannot write final"      events-worker 'touch /staging/final/x' fail
check "events-worker cannot write out"        events-worker 'touch /spool/probe/out/x' fail
check "events-worker cannot see uploads/art/fetch" events-worker 'test -e /staging/uploads || test -e /staging/art || test -e /spool/fetch' fail
check "events-probe has no network"           events-probe 'wget -q -T 3 -O /dev/null http://mocks:4104/egress' fail
check "events-probe sees no art/fetch"        events-probe 'test -e /staging/art || test -e /staging/art-in || test -e /staging/fetch' fail
# The two trees are disjoint: a marker in music's in-web never shows up in
# the events in-web (and the reverse).
check "music in-web is not events in-web"     music-web   'touch /spool/probe/in-web/.iso-music' ok
check "events in-web does not see music's"    events-web  'test -e /spool/probe/in-web/.iso-music' fail
check "clean up the isolation marker"         music-web   'rm /spool/probe/in-web/.iso-music' ok
[ $mc -eq 0 ] || status=1

echo "== worker start-up guard (real image)"
gc=0
guard() { # name, expect refusal text, extra -e args... (service: $GUARD_SVC, default music-worker)
  name=$1; want=$2; shift 2
  out=$($DC run --rm --no-deps -T "$@" "${GUARD_SVC:-music-worker}" 2>&1) && rc=0 || rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -q "$want"; then echo "  PASS $name"; else echo "  FAIL $name (rc=$rc)"; echo "$out" | tail -3; gc=1; fi
}
guard "missing MUSIC_PROFILE refuses"      "MUSIC_PROFILE must be" -e MUSIC_PROFILE=
guard "STATION_ID=7 refuses"               "requires STATION_ID=1" -e STATION_ID=7
guard "test profile without prefix refuses" "requires PORTAL_TEST_PREFIX" -e MUSIC_PROFILE=test -e PORTAL_TEST_PREFIX=
guard "web secret in worker env refuses"   "another service" -e AUTH_SECRET=x
# v0.5.0 events worker: station 14 only, never the music keys.
GUARD_SVC=events-worker
guard "events-worker: music AzuraCast key refuses" "AZURACAST_API_KEY" -e AZURACAST_API_KEY=test-azuracast-key-0000
guard "events-worker: station 1 refuses" "EVENTS_STATION_ID must be 14" -e EVENTS_STATION_ID=1
GUARD_SVC=music-worker
guard "music worker: an EVENTS_* key refuses" "EVENTS_AZURACAST_API_KEY" -e EVENTS_AZURACAST_API_KEY=test-events-azuracast-key-0000
out=$($DC run --rm --no-deps -T -e AUTH_SECRET=x --entrypoint python music-fetch -I -B -m fetchsvc --once 2>&1) && rc=0 || rc=$?
if [ $rc -eq 78 ] && echo "$out" | grep -q "unexpected environment variables: AUTH_SECRET" && ! echo "$out" | grep -q "=x"; then echo "  PASS fetch refuses an unexpected env var (exit 78, name only)"; else echo "  FAIL fetch env guard (rc=$rc)"; echo "$out" | tail -3; gc=1; fi
[ $gc -eq 0 ] || status=1

echo "== idle memory (docker stats)"
sleep 20
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' \
  "$P-music-web-1" "$P-music-worker-1" "$P-music-probe-1" "$P-music-fetch-1" "$P-music-db-1" \
  "$P-events-web-1" "$P-events-worker-1" "$P-events-probe-1" | tee test/.out/stats.txt

if [ $status -ne 0 ]; then
  echo "== logs (failure)"
  $DC logs --no-color --tail 60 music-web music-worker music-probe music-fetch events-web events-worker events-probe || true
fi
exit $status
