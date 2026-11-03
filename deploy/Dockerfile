# syntax=docker/dockerfile:1

# TilcAI (API + reconciliation worker) as a container.
#
# Build context: parent directory containing tilcai-infrastructure.
# Private package credentials are supplied only as a BuildKit npmrc secret.

ARG NODE_VERSION=24
ARG LITESTREAM_VERSION=0.3.13

FROM litestream/litestream:${LITESTREAM_VERSION} AS litestream

# ── Dependencies ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /srv/tilcai-infrastructure
COPY tilcai-infrastructure/package.json tilcai-infrastructure/package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true npm ci

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF
LABEL org.opencontainers.image.source=https://github.com/TilcAI/tilcai-infrastructure
# ca-certificates: Litestream talks TLS to the object store.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV TILCAI_ENV=testnet \
    API_HOST=0.0.0.0 \
    DATABASE_PATH=/data/tilcai.db \
    NO_COLOR=1

COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
WORKDIR /srv/tilcai-infrastructure
COPY --from=deps --chown=node:node /srv/tilcai-infrastructure/node_modules ./node_modules
COPY --chown=node:node tilcai-infrastructure/package.json tilcai-infrastructure/tsconfig.json ./
COPY --chown=node:node tilcai-infrastructure/src ./src
COPY --chmod=755 tilcai-infrastructure/deploy/entrypoint.sh /usr/local/bin/tilcai-entrypoint

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

# /health needs no key and reports whether the relayer is reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["tilcai-entrypoint"]
