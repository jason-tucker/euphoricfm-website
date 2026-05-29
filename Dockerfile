FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
ARG PUBLIC_GIT_SHA=dev
ARG PUBLIC_BUILD_TIME=unknown
ARG PUBLIC_BASE_URL=https://info.euphoric.fm
ENV PUBLIC_GIT_SHA=$PUBLIC_GIT_SHA
ENV PUBLIC_BUILD_TIME=$PUBLIC_BUILD_TIME
ENV PUBLIC_BASE_URL=$PUBLIC_BASE_URL
# Webhook URLs are NOT build args — they're injected at runtime by Caddy
# rendering /runtime-config.js from the container's env vars. The built image
# contains zero webhook URLs.
RUN pnpm build

FROM caddy:2.10-alpine
COPY --from=build /app/dist /srv/site
COPY Caddyfile /etc/caddy/Caddyfile

ARG PUBLIC_GIT_SHA=dev
ARG PUBLIC_BUILD_TIME=unknown
LABEL org.opencontainers.image.title="euphoricfm-website" \
      org.opencontainers.image.source="https://github.com/jason-tucker/euphoricfm-website" \
      org.opencontainers.image.revision="${PUBLIC_GIT_SHA}" \
      org.opencontainers.image.created="${PUBLIC_BUILD_TIME}"

# Caddy listens on 80 (ACME HTTP-01 + http→https redirect) and 443 (TLS).
EXPOSE 80 443
