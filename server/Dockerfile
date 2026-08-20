# efm-requests — shared pending-requests store for info.euphoric.fm.
# Single-file Node 24 service, zero deps, ~5MB image after alpine base.

FROM node:24-alpine

WORKDIR /app

# Two-file service (index.mjs + stats.mjs) — still no package.json, no
# install step needed.
COPY index.mjs stats.mjs /app/

# Persistence dir for /data/pending.json + /data/stats.json. The named
# volume mounted here in docker-compose survives container recreation, so
# neither store is wiped every watchtower-driven redeploy.
RUN mkdir -p /data && chown node:node /data /app

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    STORE_PATH=/data/pending.json \
    NOWPLAYING_URL=https://euphoric.fm/api/nowplaying/euphoricfm \
    AZURACAST_API_BASE=https://euphoric.fm/api \
    STATION_ID=euphoricfm \
    STATS_STORE_PATH=/data/stats.json \
    STATS_TZ=America/New_York \
    STATS_BACKFILL_START=2023-01-01
# AZURACAST_API_KEY / STATS_BACKFILL_RESET are runtime-only, set from .env —
# never baked into the image (see the /stats.mjs header + CLAUDE.md Rule 7).

EXPOSE 3000

# wget is in busybox in the alpine base — no extra package needed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider --tries=1 --timeout=2 http://127.0.0.1:3000/requests/health || exit 1

CMD ["node", "/app/index.mjs"]
