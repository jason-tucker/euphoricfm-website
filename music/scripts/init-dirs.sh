#!/bin/sh
# music-init (one-shot, root, network none): creates the bind-mounted spool
# and staging tree and hands it to uid 1000 (every music container runs as
# the image's `node` user). The per-container mounts in compose.yml decide
# who can see/write which subdirectory; this only makes them exist.
# v0.5.0: the Events portal's own tree under /data/events (same layout, no
# art / fetch dirs), mounted only by events-web / events-worker / events-probe.
set -eu
umask 027
for d in \
  /data/staging/uploads /data/staging/final /data/staging/work /data/staging/fetch \
  /data/staging/art /data/staging/art-in \
  /data/spool/probe/in-web /data/spool/probe/in-worker /data/spool/probe/out /data/spool/probe/claimed \
  /data/spool/fetch/in /data/spool/fetch/out /data/spool/fetch/claimed \
  /data/events/staging/uploads /data/events/staging/final /data/events/staging/work \
  /data/events/spool/probe/in-web /data/events/spool/probe/in-worker /data/events/spool/probe/out /data/events/spool/probe/claimed; do
  mkdir -p "$d"
done
chown -R 1000:1000 /data/staging /data/spool /data/events
chmod 0750 /data/staging /data/spool /data/spool/probe /data/spool/fetch \
  /data/events /data/events/staging /data/events/spool /data/events/spool/probe
echo "[init] staging/spool tree ready (music + events)"
