# syntax=docker/dockerfile:1

# OpenZeppelin Relayer for TilcAI: the relayer binary and its plugin runtime (built from the
# fork, see ../build.sh) plus TilcAI's configuration.
#
#   RELAYER_BASE  image built from the fork's Dockerfile.production. It carries the
#                 `x402` plugin (@rodacio/relayer-plugin-x402-facilitator) already installed.
#
# Nothing secret is baked in. At run time the container needs:
#   API_KEY               bearer key of the relayer API (32+ characters)
#   KEYSTORE_PASSPHRASE   passphrase of the signer keystore
#   the keystore itself   mounted at /app/config/keys/local-signer.json, or passed in
#                         KEYSTORE_JSON_B64 / KEYSTORE_JSON (see entrypoint.sh)
#   REDIS_URL             queues and, with REPOSITORY_STORAGE_TYPE=redis, state

ARG RELAYER_BASE=tilcai/oz-relayer-base:local
FROM ${RELAYER_BASE}

USER root
COPY --chown=nonroot:nonroot config/ /app/config/
COPY --chmod=755 entrypoint.sh /app/relayer-entrypoint.sh
RUN mkdir -p /app/config/keys /app/logs \
 && chown -R nonroot:nonroot /app/config /app/logs
USER nonroot
WORKDIR /app

ENV CONFIG_DIR=./config \
    CONFIG_FILE_NAME=config.json \
    LOG_MODE=stdout \
    QUEUE_BACKEND=redis \
    IN_DOCKER=true

EXPOSE 8080
ENTRYPOINT ["/app/relayer-entrypoint.sh"]
