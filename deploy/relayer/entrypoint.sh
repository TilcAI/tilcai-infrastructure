#!/bin/sh
# Entrypoint of the TilcAI relayer image.
#
# The signer keystore is a file (config.json points at config/keys/local-signer.json).
# Platforms that hand out secrets as environment variables (Cloud Run, App Runner,
# Container Apps…) can pass it instead as:
#   KEYSTORE_JSON_B64   the keystore file, base64-encoded        (recommended)
#   KEYSTORE_JSON       the keystore file as raw JSON
# It is written with owner-only permissions before the relayer starts. If the file is
# already there (a mounted volume or secret), it is used as is.
set -eu

keystore=/app/config/keys/local-signer.json

if [ -n "${KEYSTORE_JSON_B64:-}" ]; then
  (umask 077 && printf '%s' "$KEYSTORE_JSON_B64" | base64 -d > "$keystore")
elif [ -n "${KEYSTORE_JSON:-}" ]; then
  (umask 077 && printf '%s' "$KEYSTORE_JSON" > "$keystore")
fi
# The plugin runtime inherits the environment; it has no use for the keystore.
unset KEYSTORE_JSON_B64 KEYSTORE_JSON

if [ ! -s "$keystore" ]; then
  echo "relayer: no signer keystore at $keystore." >&2
  echo "relayer: mount it there or set KEYSTORE_JSON_B64 (base64 of the keystore file)." >&2
  exit 78
fi
if [ ! -r "$keystore" ]; then
  echo "relayer: $keystore is not readable by uid $(id -u); fix its owner or mode." >&2
  exit 78
fi

# Cloud Run and friends dictate the port through $PORT.
export APP_PORT="${PORT:-${APP_PORT:-8080}}"

exec /app/openzeppelin-relayer "$@"
