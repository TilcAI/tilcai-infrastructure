# Tenants (SCA phase M1 · data and quotas: Jhamil · authentication and API: Omar)

A tenant is a third party (Optus is the first) that asks TilcAI to issue and sponsor accounts and to move
payments. It replaces the flat `TILCAI_API_KEYS` list: a key now says **who** is calling, **what** it may do
and **how much** sponsoring it may use per day. Plan ADR-13 and `fase SCA §7`.

```
ports.ts       TenantRegistry (what the API consumes) · TenantAdmin (what the CLI uses) · LEGACY_TENANT_ID
registry.ts    SqliteTenantRegistry: tenants, hashed keys, quota counters
quota.ts       consumeQuotaSql: the single statement that counts a unit or refuses
keys.ts        key generation, SHA-256, constant-time comparison
admin-cli.ts   `npm run tenant -- …`
../accounts/   SmartAccountRepository · DelegationRepository (same database, same rules)
```

## Keys

- Format `tilc_test_<43 chars>` (256 random bits). Only its **SHA-256** is stored, plus the first 14 characters as
  a hint for lists. The key is shown once, when it is issued.
- `authenticate(key)` finds the row by hash and compares the digests in constant time (also on a miss). A revoked
  key, a suspended tenant or an unknown key all answer `undefined`: the caller cannot tell them apart.
- Scopes: `payments`, `accounts:read`, `accounts:write`. Checking them is the API's job (Omar); the registry only
  returns them.

## The legacy tenant

Migration 3 creates `tenant_legacy` and gives it every quote and payment that existed. The keys in
`TILCAI_API_KEYS` are synced to it with scope `payments` **every time a process starts** (`createAppContext`):
new keys are added, keys removed from the variable are revoked, so rotating a key out of the list works as before.
Optipagos and optus-agentBE need no change. Its quota is 1 000 000 per day: today's sponsored burns and mints are
not limited per tenant.

## Quotas

One counter per tenant, UTC day and kind (`account`, `operation`). `consumeQuota` is **one SQL statement**: it counts
or refuses, so two requests (or two processes) cannot both take the last unit. A refusal leaves no trace. A suspended
or unknown tenant is a refusal. `usage(id)` reads today's counters without counting.

- Creating an account: use `SmartAccountRepository.insert(…, { chargeQuota: true })`. It stores the account and counts
  the quota **in the same transaction**: no quota → nothing stored; an idempotent replay or a conflict → nothing
  counted. Check the idempotency key first (`getByIdempotencyKey`) and answer a replay without inserting.
- Any other sponsored action (a delegation, a UserOperation, a burn): call `consumeQuota(id, "operation")` right
  before asking the relayer.

## Isolation, for whoever writes the API

- Every read for a request goes through a `…ForTenant(tenantId, …)` method, or through the crosschain service with
  `tenantId`. Another tenant's object is **"not found"**, never "forbidden", so ids cannot be probed.
- `CrosschainPaymentService.quote / createPayment / getQuote / mustGet / view / attachBurn / submitAuthorization`
  take `tenantId` (last argument, or in the input). **If it is omitted the legacy tenant is assumed**: a call that
  forgets it fails closed (not found), it does not leak. The HTTP API still calls them without it; passing the
  authenticated tenant is part of the API work.
- `SmartAccountRepository.get / findByAddress / listDue` and `DelegationRepository.get / listDue` are for the worker
  and payment routing and are **not** scoped: never feed them an id from a request without checking `tenantId`.
- Idempotency keys are per tenant. Accounts: `UNIQUE(tenant_id, idempotency_key)`. Payments keep their global unique
  column, so a non-legacy tenant's key is stored as `<tenantId>:<key>` (clients cannot forge it: keys only allow
  letters, digits, `_` and `-`); the legacy tenant's keys are stored as sent so old replays still work.

## CLI

```sh
npm run tenant -- create --name Optus [--accounts-per-day 20] [--ops-per-day 200]
npm run tenant -- key --tenant tenant_… --label "backend" --scopes accounts:read,accounts:write
npm run tenant -- list            # tenants and key hints, never keys
npm run tenant -- revoke-key --key tenant_key_…
npm run tenant -- suspend --tenant tenant_…     # also: activate
```

It talks to the database directly (`DATABASE_PATH`), so run it where the file is. In a container:
`docker compose -f deploy/docker-compose.yml exec tilcai npm run tenant -- list` (not tried in a container yet).
Add `--json` for machine output. Defaults for a new tenant: 20 accounts and 200 sponsored operations per day.

## Tests

`test/unit/repository-sqlite.test.ts` runs `test/support/repository-contract.ts`, written only against the
interfaces: phase 2 runs the same suite against Postgres (ADR-04). `migration-3.test.ts` migrates a phase-1 database,
including two processes starting at once. `crosschain-tenancy.test.ts`, `tenant-cli.test.ts` and
`app-context-tenants.test.ts` cover the rest.
