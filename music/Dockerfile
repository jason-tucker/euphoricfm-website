# EFM Music Portal — one Dockerfile, four runtime targets (plan §3):
#   web     Next.js standalone (music-web)
#   worker  job runner + migrator (music-worker, music-migrate, music-init)
#   probe   ffprobe/ffmpeg/rsvg-convert + music-metadata/node-id3 (music-probe)
#   fetch   STUB until P5 (not wired into compose)
# plus `test` (vitest + ffmpeg) used by test/run.sh and CI.
#
# Compilation happens here (CI runner), never on the 2 GB VPS.

ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: no dependency lifecycle scripts (matches the site build).
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec next build && node scripts/bundle.mjs

# ---------------------------------------------------------------- web ----
FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=160
# Code stays root-owned: the app (uid 1000) cannot rewrite itself.
COPY --from=build /build/.next/standalone ./
COPY --from=build /build/.next/static ./.next/static
COPY --from=build /build/public ./public
RUN mkdir -p /app/.next/cache && chown node:node /app/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]

# ------------------------------------------------------------- worker ----
FROM ${NODE_IMAGE} AS worker
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=96
COPY --from=build /build/dist/worker/ ./
COPY --from=build /build/drizzle ./drizzle
COPY scripts/init-dirs.sh ./init-dirs.sh
USER node
CMD ["node", "/app/worker.mjs"]

# -------------------------------------------------------------- probe ----
FROM ${NODE_IMAGE} AS probe
# util-linux-misc: prlimit, which applies RLIMIT_AS / RLIMIT_CORE to every
# parser child without a shell (src/probe/exec.ts).
RUN apk add --no-cache ffmpeg rsvg-convert util-linux-misc
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=64
COPY --from=build /build/dist/probe/ ./
USER node
CMD ["node", "/app/probe.mjs"]

# -------------------------------------------------------------- fetch ----
# P5 (SoundCloud via yt-dlp) — intentionally a stub; not in compose yet.
FROM ${NODE_IMAGE} AS fetch
USER node
CMD ["node", "-e", "console.error('music-fetch is not implemented until P5'); process.exit(1)"]

# --------------------------------------------------------------- test ----
FROM deps AS test
RUN apk add --no-cache ffmpeg rsvg-convert util-linux-misc
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN node scripts/bundle.mjs
CMD ["pnpm", "exec", "vitest", "run"]
