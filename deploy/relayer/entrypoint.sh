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
evm_mainnet_keystore=/app/config/keys/evm-mainnet-signer.json
stellar_mainnet_keystore=/app/config/keys/stellar-mainnet-signer.json

if [ -n "${KEYSTORE_JSON_B64:-}" ]; then
  (umask 077 && printf '%s' "$KEYSTORE_JSON_B64" | base64 -d > "$keystore")
elif [ -n "${KEYSTORE_JSON:-}" ]; then
  (umask 077 && printf '%s' "$KEYSTORE_JSON" > "$keystore")
fi
# The plugin runtime inherits the environment; it has no use for the keystore.
unset KEYSTORE_JSON_B64 KEYSTORE_JSON

# Mainnet uses independent identities. These variables are intentionally different from the
# testnet ones, and config.mainnet.json never references local-signer.json.
if [ -n "${MAINNET_EVM_KEYSTORE_JSON_B64:-}" ]; then
  (umask 077 && printf '%s' "$MAINNET_EVM_KEYSTORE_JSON_B64" | base64 -d > "$evm_mainnet_keystore")
fi
if [ -n "${MAINNET_STELLAR_KEYSTORE_JSON_B64:-}" ]; then
  (umask 077 && printf '%s' "$MAINNET_STELLAR_KEYSTORE_JSON_B64" | base64 -d > "$stellar_mainnet_keystore")
fi
unset MAINNET_EVM_KEYSTORE_JSON_B64 MAINNET_STELLAR_KEYSTORE_JSON_B64

if [ "${CONFIG_FILE_NAME:-config.json}" = "config.mainnet.json" ]; then
  for mainnet_keystore in "$evm_mainnet_keystore" "$stellar_mainnet_keystore"; do
    if [ ! -s "$mainnet_keystore" ] || [ ! -r "$mainnet_keystore" ]; then
      echo "relayer: missing a readable, independent Mainnet signer file; mount both files or use the two MAINNET_*_KEYSTORE_JSON_B64 variables." >&2
      exit 78
    fi
  done
else

if [ ! -s "$keystore" ]; then
  echo "relayer: no signer keystore at $keystore." >&2
  echo "relayer: mount it there or set KEYSTORE_JSON_B64 (base64 of the keystore file)." >&2
  exit 78
fi
if [ ! -r "$keystore" ]; then
  echo "relayer: $keystore is not readable by uid $(id -u); fix its owner or mode." >&2
  exit 78
fi
fi

# Cloud Run and friends dictate the port through $PORT.
export APP_PORT="${PORT:-${APP_PORT:-8080}}"

exec /app/openzeppelin-relayer "$@"
