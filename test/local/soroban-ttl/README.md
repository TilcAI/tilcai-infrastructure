# Local Soroban TTL investigation

These scripts use **only** literal loopback URLs, the standalone network passphrase,
a synthetic local root, a native SAC and synthetic balances. They do not read `.env`.
No public Stellar network or production USDC is used. The production Vault source is unchanged.
Run from repository root, with Node dependencies installed, Docker and Stellar CLI available.

The image is pinned by digest. `settings.json` comes from Stellar Quickstart commit
`b75f815383a938d2a7ebf2f10728939d91f3b63a`,
`local/core/etc/config-settings/p26/testnet.json`; only state-archival test parameters change:
max TTL 1,054,080 (the Core minimum), min TTL 16 and eviction scan level 1.
Upstream source: https://github.com/stellar/quickstart . Apache-2.0.

Use a fresh checkout/workspace and ensure the dedicated container name is unused:

```bash
bash test/local/soroban-ttl/bootstrap.sh
node test/local/soroban-ttl/prepare.mjs
node test/local/soroban-ttl/renew-dependencies.mjs
node test/local/soroban-ttl/duplicate-before.mjs
node test/local/soroban-ttl/prepare-boundary.mjs
node test/local/soroban-ttl/boundary.mjs
# Wait for getHealth healthy and getAccount to succeed after snapshot recovery.
node test/local/soroban-ttl/archive.mjs
node test/local/soroban-ttl/renew-dependencies.mjs
docker exec tilcai-ttl-p26 supervisorctl restart stellar-core stellar-rpc
node test/local/soroban-ttl/restart.mjs
```

`renew-dependencies` waits 128 local ledgers after the payout before renewal, leaving
headroom for recovery. It explicitly excludes Payout(id). The two boundary transactions
are prepared before the jump and submitted at last-live and first-expired ledgers.
`boundary` uses Core's RUN_STANDALONE/MANUAL_CLOSE API; it never deletes a payout.
The RPC database is preserved under `/opt/stellar/ttl-before-boundary` and rebuilt from
a fresh checkpoint because the jump does not generate a million contiguous RPC records.
Check timestamps/limits and dependency TTLs when changing the sequence or network settings.

Export the two boundary results from the **Core history archive**: the new RPC starts after
those ledgers and its transaction database may not include them. For a checkpoint hex `H`
(8 digits), the file is `results/HH/HH/HH/results-H.xdr.gz`, using H's first three byte pairs.
Decode with `gzip -dc ... | stellar-xdr decode --type TransactionHistoryResultEntry --input stream-framed`.
Compare transaction hashes against `scratch/ttl/boundary-submissions.json`.

The committed evidence documents the actual exploratory execution (including an intermediate
jump before the boundary and 89 ledgers between payout and dependency renewal). The combined
fresh-run scripts above incorporate the synchronization lessons and were syntax checked;
the entire combined sequence has not been rerun in a second fresh container. All recorded
archive/restore/restart assertions were executed against the real local Core/RPC.

Validate committed transaction evidence without Docker or any network:

```bash
node --test test/local/soroban-ttl/evidence.test.mjs
```

Preserve state and logs on any failure; do not blindly repeat deployment/transaction phases.
`bootstrap` refuses existing state. Once evidence is exported, stop the dedicated container
with `docker stop tilcai-ttl-p26`. Delete it only after deciding its data is no longer needed.
