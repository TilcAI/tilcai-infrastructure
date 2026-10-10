#!/usr/bin/env bash
# Deploys the SCA phase contracts on Stellar Testnet and prints the lines for the .env of TilcAI.
#
#   ./deploy-testnet.sh --source <stellar-cli identity> --operator G… [--owner G…] [--max 100] [--daily 1000]
#                       [--only accounts|vault]
#
# --source    identity of the Stellar CLI that signs and pays the deployments (`stellar keys ls`).
# --operator  the relayer's Stellar account (the vault's operator): `npm run stellar -- relayer`.
# --owner     who can pause, change limits and withdraw. Defaults to the source's address. Use a
#             multisig or a smart account for anything that holds real funds.
# --max/--daily  vault limits in USDC per disbursement and per UTC day.
#
# Accounts: uploads the account wasm, deploys the two shared verifiers and the factory.
# Vault: deploys tilcai_vault for the testnet USDC asset contract.
set -euo pipefail
cd "$(dirname "$0")"

USDC_SAC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" # Circle USDC on testnet (src/config/networks.ts)
SOURCE="" OPERATOR="" OWNER="" MAX="100" DAILY="1000" ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --operator) OPERATOR="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --max) MAX="$2"; shift 2 ;;
    --daily) DAILY="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
[[ -n "$SOURCE" ]] || { echo "--source is required" >&2; exit 64; }
OWNER="${OWNER:-$(stellar keys address "$SOURCE")}"
# USDC on Stellar has 7 decimals.
atomic() { python3 -c "from decimal import Decimal; print(int(Decimal('$1') * 10**7))"; }
WASM=target/wasm32v1-none/release
NET=(--network testnet --source-account "$SOURCE")

stellar contract build >&2

if [[ "$ONLY" != "vault" ]]; then
  ACCOUNT_HASH=$(stellar contract upload "${NET[@]}" --wasm "$WASM/tilcai_account.wasm")
  ED25519=$(stellar contract deploy "${NET[@]}" --wasm "$WASM/tilcai_ed25519_verifier.wasm")
  WEBAUTHN=$(stellar contract deploy "${NET[@]}" --wasm "$WASM/tilcai_webauthn_verifier.wasm")
  FACTORY=$(stellar contract deploy "${NET[@]}" --wasm "$WASM/tilcai_account_factory.wasm" -- \
    --account_wasm_hash "$ACCOUNT_HASH" --ed25519_verifier "$ED25519" --webauthn_verifier "$WEBAUTHN")
  echo "# accounts: account wasm $ACCOUNT_HASH · ed25519 verifier $ED25519 · webauthn verifier $WEBAUTHN"
  echo "ACCOUNT_FACTORY_STELLAR=$FACTORY"
fi

if [[ "$ONLY" != "accounts" ]]; then
  [[ -n "$OPERATOR" ]] || { echo "--operator is required to deploy the vault" >&2; exit 64; }
  VAULT=$(stellar contract deploy "${NET[@]}" --wasm "$WASM/tilcai_vault.wasm" -- \
    --usdc "$USDC_SAC" --owner "$OWNER" --operator "$OPERATOR" \
    --max_per_disbursement "$(atomic "$MAX")" --daily_limit "$(atomic "$DAILY")")
  echo "# vault: owner $OWNER · operator $OPERATOR · $MAX USDC per disbursement · $DAILY USDC per day"
  echo "VAULT_STELLAR=$VAULT"
fi
