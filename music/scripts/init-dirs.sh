#!/bin/sh
# music-init (one-shot, root, network none): creates the bind-mounted spool
# and staging tree and hands it to uid 1000 (every music container runs as
# the image's `node` user). The per-container mounts in compose.yml decide
# who can see/write which subdirectory; this only makes them exist.
set -eu
umask 027
for d in \
  /data/staging/uploads /data/staging/final /data/staging/work /data/staging/fetch \
  /data/spool/probe/in-web /data/spool/probe/in-worker /data/spool/probe/out /data/spool/probe/claimed \
  /data/spool/fetch/in /data/spool/fetch/out; do
  mkdir -p "$d"
done
chown -R 1000:1000 /data/staging /data/spool
chmod 0750 /data/staging /data/spool /data/spool/probe /data/spool/fetch
echo "[init] staging/spool tree ready"
