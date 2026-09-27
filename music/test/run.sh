#!/bin/sh
# Full P2 test harness, entirely in Docker (no node on the host):
#   builds web/worker/probe/test images, brings up postgres + mocks + the real
#   containers with their real mounts, runs vitest (unit + DB + e2e), then the
#   mount / worker-guard shell checks, then records idle `docker stats`.
# Usage: test/run.sh            (from music/ or anywhere)
# Env:   DOCKER_COMPOSE="docker compose" (override the compose command)
#        KEEP=1 to leave the stack up afterwards.
#        MUSIC_TEST_PROJECT / MUSIC_TEST_TAG isolate parallel runs (compose
#        project, networks, image tags); defaults efm-music-test / local-test.
set -eu
cd "$(dirname "$0")/.."
export MUSIC_TEST_PROJECT="${MUSIC_TEST_PROJECT:-efm-music-test}"
export MUSIC_TAG="${MUSIC_TEST_TAG:-local-test}"
P=$MUSIC_TEST_PROJECT
export MUSIC_DATA_DIR=./test/.out/data
DC="${DOCKER_COMPOSE:-docker compose} -p $P -f compose.yml -f test/compose.test.yml"

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    $DC --profile tests down -v --remove-orphans >/dev/null 2>&1 || true
    docker run --rm -v "$PWD/test/.out:/o" alpine:3 rm -rf /o/data >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

$DC --profile tests down -v --remove-orphans >/dev/null 2>&1 || true
mkdir -p test/.out/data
docker run --rm -v "$PWD/test/.out:/o" alpine:3 sh -c 'rm -rf /o/data && mkdir -p /o/data' >/dev/null

echo "== build"
$DC --profile tests build

echo "== up"
$DC up -d --wait music-web music-worker music-probe mocks || { $DC logs --no-color --tail 80; exit 1; }

status=0
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
check "web rootfs is read-only"             music-web   'touch /app/x' fail
[ $mc -eq 0 ] || status=1

echo "== worker start-up guard (real image)"
gc=0
guard() { # name, extra -e args..., expect refusal text
  name=$1; want=$2; shift 2
  out=$($DC run --rm --no-deps -T "$@" music-worker 2>&1) && rc=0 || rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -q "$want"; then echo "  PASS $name"; else echo "  FAIL $name (rc=$rc)"; echo "$out" | tail -3; gc=1; fi
}
guard "missing MUSIC_PROFILE refuses"      "MUSIC_PROFILE must be" -e MUSIC_PROFILE=
guard "STATION_ID=7 refuses"               "requires STATION_ID=1" -e STATION_ID=7
guard "test profile without prefix refuses" "requires PORTAL_TEST_PREFIX" -e MUSIC_PROFILE=test -e PORTAL_TEST_PREFIX=
guard "web secret in worker env refuses"   "another service" -e AUTH_SECRET=x
[ $gc -eq 0 ] || status=1

echo "== idle memory (docker stats)"
sleep 20
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' \
  $P-music-web-1 $P-music-worker-1 $P-music-probe-1 $P-music-db-1 | tee test/.out/stats.txt

if [ $status -ne 0 ]; then
  echo "== logs (failure)"
  $DC logs --no-color --tail 60 music-web music-worker music-probe || true
fi
exit $status
