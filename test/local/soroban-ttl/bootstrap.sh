#!/usr/bin/env bash
# Local-only research. Run from the repository root in a fresh checkout/workspace.
set -euo pipefail
if docker container inspect tilcai-ttl-p26 >/dev/null 2>&1 || test -e scratch/ttl; then
  echo 'Existing research state: preserve it; use a fresh workspace and a dedicated container.' >&2
  exit 1
fi
mkdir -p scratch/ttl
stellar contract build --manifest-path contracts/soroban/vault/Cargo.toml --locked --package tilcai-vault
docker run -d --name tilcai-ttl-p26 \
  -p 127.0.0.1:18004:8000 -p 127.0.0.1:18629:11626 \
  -v "$PWD/test/local/soroban-ttl/settings.json:/opt/stellar-default/local/core/etc/config-settings/p26/testnet.json:ro" \
  stellar/quickstart@sha256:2aac78f5af01ea8a5f7b04d9419afa1c5bfb869ba4049793368cf965d6befedc \
  --local --protocol-version 26 --enable rpc
node --input-type=module - <<'JS'
const url='http://127.0.0.1:18004/rpc';
let ready=false;
for(let i=0;i<180;i++){
 try{
  const r=await(await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getHealth'})})).json();
  if(r.result?.status==='healthy'){ready=true;break;}
 }catch{}
 await new Promise(r=>setTimeout(r,1000));
}
if(!ready)throw new Error('Local RPC startup timed out; preserve container logs');
JS
# Friendbot otherwise submits transactions from the same synthetic root account.
docker exec tilcai-ttl-p26 supervisorctl stop friendbot
