# syntax=docker/dockerfile:1

# TilcAI (API + reconciliation worker) as a container.
#
# Build context is the PARENT directory holding both repos, because the app depends on
# `tilcai-core` through `file:../tilcai-core`:
#
#   tilcai/
#     tilcai-core/
#     tilcai-infrastructure/   ← this repo
#
#   docker build -f tilcai-infrastructure/deploy/Dockerfile -t tilcai .     (from tilcai/)
#   ./deploy/build.sh                                                        (does it for you)
#
# The image runs anywhere a container runs (Cloud Run, ECS/Fargate, Azure Container Apps,
# a VM with docker compose). State lives in a SQLite file under /data: mount a volume
# there, or set LITESTREAM_REPLICA_URL to keep it in object storage (see deploy/README.md).

ARG NODE_VERSION=24
ARG LITESTREAM_VERSION=0.3.13

FROM litestream/litestream:${LITESTREAM_VERSION} AS litestream

# ── Dependencies ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
# Same layout as on disk, so the `file:../tilcai-core` link resolves.
COPY tilcai-core /srv/tilcai-core
WORKDIR /srv/tilcai-infrastructure
COPY tilcai-infrastructure/package.json tilcai-infrastructure/package-lock.json ./
# tsx (a devDependency) is the runtime: the app runs its TypeScript sources directly.
RUN --mount=type=cache,target=/root/.npm npm ci

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# ca-certificates: Litestream talks TLS to the object store.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV TILCAI_ENV=testnet \
    API_HOST=0.0.0.0 \
    DATABASE_PATH=/data/tilcai.db \
    NO_COLOR=1

COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=deps --chown=node:node /srv/tilcai-core /srv/tilcai-core
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
