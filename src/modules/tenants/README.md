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
- Scopes: `payments`, `accounts:read`, `accounts:write`. The API checks them (`requirementOf` in `apps/api/server.ts`): `/v1/accounts`
  needs the accounts scopes, everything else `payments`, and the vault, the event log and the relayer status are
  reserved to the legacy tenant (the operator).

## The legacy tenant

Migration 5 creates `tenant_legacy` and gives it every quote and payment that existed. The keys in
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

## Credential lifecycle (2026-11-01)

REST partners use one tenant per organization and one key per backend/environment. New
issued keys expire after 90 days by default, at most 365 days; testnet uses `tilc_test_`,
mainnet `tilc_live_`. Only hashes are stored. Operator commands run against the configured
DATABASE_PATH and TILCAI_ENV; API key delivery belongs in a secret manager.

```sh
npm run tenant -- create --name Fexpo
npm run tenant -- key --tenant tenant_ID --label backend --scopes payments --json
npm run tenant -- rotate-key --key tenant_key_ID --overlap-seconds 3600 --json
npm run tenant -- revoke-key --key tenant_key_ID
```

Use the actual IDs returned by the preceding command. Issue with `--expires-at` for a shorter
canonical UTC expiry (`YYYY-MM-DDTHH:mm:ss.sssZ`). Rotation inherits permissions, tenant and
environment. With zero overlap, the previous key stops immediately; with overlap (maximum 24h)
it expires at the earlier of its previous expiry and the new deadline. Validate the new key
before revoking the old one. Lost output cannot be recovered: issue another key and revoke
unusable credentials. No HTTP or MCP route can issue keys.

`GET /v1/auth/context` accepts any authenticated key, including accounts:read only, and returns
its own tenant, scopes, environment and safe credential metadata with Cache-Control: no-store.
It never returns the full key or hash. No new scope grants operator Vault/monitor access.
Explicit invalid Authorization never falls back to the unauthenticated loopback dev operator.

Migration 7 adds environment/expiry/last-use columns and append-only lifecycle events.
Existing issued keys retain no expiry until rotated, remain testnet credentials, and must be
reissued explicitly for mainnet. TILCAI_API_KEYS legacy keys stay bound to their configured
instance and remain an operator compatibility bridge; don't share them with partners. Removing
an env key from that configuration is required for durable revocation across restarts.

The authentication branch starts from fixes 73805cc. The unrelated QR development branch already
uses migration 6; this branch reserves that ID and uses 7. Reconcile the ordered migration list before merging both branches;
never edit an already applied migration in an existing installation. Export applied migration
IDs and schema from the target database before deployment.

See [decision and plan](../../../docs/third-party-auth-plan.md) and
[runbook](../../../docs/third-party-credentials.md) for the OAuth boundary and integration.
