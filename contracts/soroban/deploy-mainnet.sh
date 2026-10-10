#!/usr/bin/env bash
# Stellar Mainnet deployment preparation. Phase 2 deliberately contains no transaction path.
#
#   ./deploy-mainnet.sh preflight
#   ./deploy-mainnet.sh dry-run --deployer G… --owner G…|C… --operator G…|C… --max 100 --daily 1000
#   ./deploy-mainnet.sh deploy     # always blocked in phase 2
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
command="${1:-dry-run}"
shift || true

if [[ "$command" == "deploy" ]]; then
  echo "Stellar Mainnet deployment is deliberately blocked in phase 2; no upload/deploy/invoke command was run." >&2
  exit 78
fi
if [[ "$command" == "preflight" ]]; then
  cd "$repo"
  exec npm run mainnet:preflight -- "$@"
fi
if [[ "$command" != "dry-run" ]]; then
  echo "usage: $0 preflight | dry-run --deployer G… --owner G…|C… --operator G…|C… [--max 100 --daily 1000] | deploy(blocked)" >&2
  exit 64
fi

DEPLOYER="" OWNER="" OPERATOR="" MAX="100" DAILY="1000"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployer) DEPLOYER="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --operator) OPERATOR="$2"; shift 2 ;;
    --max) MAX="$2"; shift 2 ;;
    --daily) DAILY="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
[[ "$DEPLOYER" =~ ^G[A-Z2-7]{55}$ ]] || { echo "--deployer must be a public G… account" >&2; exit 64; }
[[ "$OWNER" =~ ^[GC][A-Z2-7]{55}$ ]] || { echo "--owner must be a public G… or C… address" >&2; exit 64; }
[[ "$OPERATOR" =~ ^[GC][A-Z2-7]{55}$ ]] || { echo "--operator must be a public G… or C… address" >&2; exit 64; }
[[ "$DEPLOYER" != "$OWNER" ]] || { echo "deployer must not be the final vault owner" >&2; exit 64; }
[[ "$OWNER" != "$OPERATOR" ]] || { echo "owner and operator must be independent" >&2; exit 64; }
[[ "$MAX" =~ ^[0-9]+([.][0-9]{1,7})?$ && "$DAILY" =~ ^[0-9]+([.][0-9]{1,7})?$ ]] || { echo "limits must be positive decimals with at most 7 digits" >&2; exit 64; }
atomic_limits="$(node -e '
  const toAtomic = (value) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * 10000000n + BigInt((fraction + "0000000").slice(0, 7));
  };
  const [max, daily] = process.argv.slice(1).map(toAtomic);
  if (max <= 0n || max > daily || daily > (1n << 127n) - 1n) process.exit(1);
  process.stdout.write(`${max} ${daily}`);
' "$MAX" "$DAILY")" || {
  echo "limits must satisfy 0 < max <= daily <= i128 max" >&2
  exit 64
}
read -r MAX_ATOMIC DAILY_ATOMIC <<< "$atomic_limits"
node -e '
  const { StrKey } = require("@stellar/stellar-sdk");
  const [deployer, owner, operator] = process.argv.slice(1);
  const validRole = (value) => StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
  if (!StrKey.isValidEd25519PublicKey(deployer) || !validRole(owner) || !validRole(operator)) process.exit(1);
' "$DEPLOYER" "$OWNER" "$OPERATOR" || {
  echo "public Stellar address has an invalid StrKey checksum or type" >&2
  exit 64
}

WASM="$here/target/wasm32v1-none/release"
names=(tilcai_account tilcai_ed25519_verifier tilcai_webauthn_verifier tilcai_account_factory tilcai_vault)
for name in "${names[@]}"; do
  file="$WASM/$name.wasm"
  [[ -s "$file" ]] || { echo "missing $file; run a local stellar contract build first" >&2; exit 66; }
done

echo "MODE=DRY_RUN_NO_BROADCAST"
echo "NETWORK=mainnet"
echo "PASSPHRASE=Public Global Stellar Network ; September 2015"
echo "USDC_SAC=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
echo "DEPLOYER=$DEPLOYER"
echo "VAULT_OWNER=$OWNER"
echo "VAULT_OPERATOR=$OPERATOR"
echo "MAX_PER_DISBURSEMENT_ATOMIC=$MAX_ATOMIC"
echo "DAILY_LIMIT_ATOMIC=$DAILY_ATOMIC"
echo ""
echo "ORDER (review only; none of these operations is executed):"
echo "1 upload tilcai_account.wasm and record its returned WASM hash"
echo "2 deploy tilcai_ed25519_verifier.wasm"
echo "3 deploy tilcai_webauthn_verifier.wasm"
echo "4 deploy tilcai_account_factory.wasm with the hash and both verifier IDs"
echo "5 deploy tilcai_vault.wasm with USDC SAC, owner, operator and limits"
echo ""
echo "LOCAL WASM SHA-256:"
for name in "${names[@]}"; do sha256sum "$WASM/$name.wasm"; done
echo ""
echo "PENDING: simulate resource fees, minimum account reserve and TTL footprint with an approved public source account."
echo "No upload, deploy, invoke, signature or transaction was performed."
