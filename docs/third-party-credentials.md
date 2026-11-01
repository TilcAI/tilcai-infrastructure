# Third-party credentials: implemented contract and deployment

Branch: feat/third-party-credentials, based on 73805cc (Vault/Soroban fixes).

## Implemented

Operator CLI creates tenants, issues expiring/scoped keys and rotates/revokes them. New keys
are restricted to the configured testnet/mainnet environment. SQLite migration 7 is additive;
key events contain IDs, kinds and timestamps only. Authentication reads revocation, expiry
and tenant status each time; last-use updates are throttled to once a minute.

`GET /v1/auth/context` returns:

```json
{
  "tenantId": "tenant_example",
  "tenantName": "Fexpo",
  "scopes": ["payments"],
  "environment": "testnet",
  "credential": {
    "id": "tenant_key_example", "tenantId": "tenant_example", "hint": "tilc_test_abcd",
    "label": "backend", "scopes": ["payments"], "source": "issued",
    "environment": "testnet", "createdAt": "2026-11-01T00:00:00.000Z",
    "expiresAt": "2027-01-30T00:00:00.000Z"
  }
}
```

The hint is a short partial identifier, not a usable secret. Legacy dev loopback has
credential=null. Authentication errors use 401; scope or operator restriction failures use
403. Invalid presented credentials cannot become the development operator. GET doesn't consume
sponsored-operation quota. There is no key-management privilege for a tenant.

## Onboarding Optipagos/Fexpo

Create separate tenants and issue payments keys only for their backend integrations. Add
accounts:read/write only where needed. Give each environment and service a separate secret,
transport using HTTPS and a secret manager, confirm tenant/scope/environment with introspection,
then configure the SDK or MCP. Existing data assigned to tenant_legacy is not transferred
merely by issuing a new tenant key: reconcile ownership and plan migration explicitly if
partners need access to historical payments.

Deploy backend migration before SDK/MCP introspection usage. Back up SQLite, verify migration
ID availability (6 is reserved for the existing QR branch; this change uses 7), run migration on a restored copy,
then confirm legacy operator and one test tenant. Restoring old code would ignore new expiry
and environment rules; do not roll back to an auth implementation that bypasses those rules.
A rollback requires revoking affected secrets and restoring a reviewed compatible release.

Do not create partner keys against the production DB as part of tests. Test tenants in this
change exist only in disposable databases. No production credentials were issued.

## SDK and MCP

SDK 0.3.0 adds `tilcai.auth.context()` and `apiKeyProvider` (sync or async) resolved on each
request/retry; it takes priority over static/environment key. On provider failure no request
is sent and details are redacted. Authenticated requests and event streams reject redirects.

Existing tilcai-mcp adds `tilcai_auth_context`, accepts TILCAI_API_KEY or
TILCAI_API_KEY_FILE (mutually exclusive), and rereads the file on every protected request.
Update mounted secrets atomically and with restrictive permissions. Tool errors omit raw
exception text. Issuance/revocation are not model tools. Existing payment tools and their
signing behavior remain; the new auth work does not make them an OAuth delegation system.

MCP transport remains stdio. Remote multiuser MCP requires a separately designed OAuth
resource server and authorization code/PKCE with token audience validation; API keys here
serve the configured backend integration, not individual user consent.

## Verification

Backend: 206 unit tests, typecheck, plus prior 5 Python deploy and 12 Rust Vault tests.
SDK: 85 tests, typecheck, ESM/CJS build and smoke package checks.
MCP: 7 tests, typecheck and build; in-memory MCP transport exercises tools/list and tools/call,
credential file rotation and secret-free outputs. No public network financial tests run.

No rate limiter is added here: existing daily sponsorship quotas are not request-rate limits.
Set gateway per-tenant request limits and alert on expiry/revocation during rollout. Audit
covers issue/revoke/rotate operations from the operator CLI; env-key synchronization keeps
its existing configuration-driven lifecycle.

Comprobación adicional: backend local real + SDK + cliente MCP pasaron introspección, rotación mediante proveedor dinámico y rechazo 401 de la clave anterior. El ejecutable MCP compilado pasó initialize/tools/list/tools/call mediante stdio sin acceder a una red pública.
