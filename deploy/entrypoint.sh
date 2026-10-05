#!/bin/sh
# Container entrypoint for TilcAI.
#
#   TILCAI_ROLE              all (default: API + worker) | api | worker
#   PORT                     honoured when API_PORT is not set (Cloud Run, App Runner…)
#   LITESTREAM_REPLICA_URL   optional. gcs://bucket/path, s3://bucket/path or abs://…
#                            Restores the SQLite database from object storage on start and
#                            replicates every change back to it. Use it wherever the disk
#                            does not survive a restart (Cloud Run). Run ONE instance.
#
# Any arguments replace the server: `docker run … tilcai npm run relayer:check`.
set -eu

export API_HOST="${API_HOST:-0.0.0.0}"
export API_PORT="${API_PORT:-${PORT:-8787}}"
export DATABASE_PATH="${DATABASE_PATH:-/data/tilcai.db}"

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

role="${TILCAI_ROLE:-all}"
case "$role" in
  all) app="src/apps/all-in-one.ts" ;;
  api) app="src/apps/api/main.ts" ;;
  worker) app="src/apps/worker/main.ts" ;;
  *)
    echo "tilcai: TILCAI_ROLE must be all, api or worker (got '$role')" >&2
    exit 64
    ;;
esac

if [ -z "${TILCAI_API_KEYS:-}" ] && [ "$role" != "worker" ]; then
  echo "tilcai: TILCAI_API_KEYS is empty. Without keys the API only answers loopback" >&2
  echo "tilcai: requests, so nothing outside this container can use it." >&2
fi

if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  # Bring the database back if this is a fresh disk, then run the app under Litestream,
  # which forwards signals and exits with the app.
  litestream restore -if-db-not-exists -if-replica-exists \
    -o "$DATABASE_PATH" "$LITESTREAM_REPLICA_URL"
  exec litestream replicate -exec "node --import tsx $app" \
    "$DATABASE_PATH" "$LITESTREAM_REPLICA_URL"
fi

exec node --import tsx "$app"
