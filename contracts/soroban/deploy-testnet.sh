#!/usr/bin/env bash
# Validates all inputs before build/upload/deploy. See DEPLOY_RECOVERY.md.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 deploy_testnet.py "$@"
