export const MIGRATIONS: ReadonlyArray<{ id: number; sql: string }> = [
  {
    id: 1,
    sql: `
CREATE TABLE route_quotes (
  id TEXT PRIMARY KEY,
  source_network TEXT NOT NULL,
  destination_network TEXT NOT NULL,
  source_domain INTEGER NOT NULL,
  destination_domain INTEGER NOT NULL,
  pay_to TEXT NOT NULL,
  destination_amount_atomic TEXT NOT NULL,
  burn_amount_atomic TEXT NOT NULL,
  max_fee_atomic TEXT NOT NULL,
  fee_bps_hundredths TEXT NOT NULL,
  finality INTEGER NOT NULL,
  burn_token TEXT NOT NULL,
  mint_recipient TEXT NOT NULL,
  destination_caller TEXT NOT NULL,
  hook_data TEXT NOT NULL,
  preflight_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE crosschain_payments (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES route_quotes(id),
  state TEXT NOT NULL,
  uncertain INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL,
  payer TEXT,
  order_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  source_network TEXT NOT NULL,
  burn_tx_hash TEXT,
  burn_block TEXT,
  cctp_nonce TEXT,
  message TEXT,
  attestation TEXT,
  fee_executed_atomic TEXT,
  mint_submitter TEXT,
  mint_submission_id TEXT,
  mint_requested_at TEXT,
  mint_tx_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT NOT NULL,
  last_error TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);
-- One burn can satisfy at most one payment; one CCTP nonce at most one settlement.
CREATE UNIQUE INDEX ux_payments_burn ON crosschain_payments(source_network, burn_tx_hash) WHERE burn_tx_hash IS NOT NULL;
CREATE UNIQUE INDEX ux_payments_nonce ON crosschain_payments(cctp_nonce) WHERE cctp_nonce IS NOT NULL;
CREATE INDEX ix_payments_due ON crosschain_payments(state, next_check_at);
-- A route quote is consumed by exactly one payment attempt.
CREATE UNIQUE INDEX ux_payments_quote ON crosschain_payments(quote_id);

CREATE TABLE payment_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL REFERENCES crosschain_payments(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  note TEXT NOT NULL,
  data_json TEXT,
  at TEXT NOT NULL
);
CREATE INDEX ix_events_payment ON payment_events(payment_id, seq);

CREATE TABLE payment_receipts (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES crosschain_payments(id),
  order_id TEXT,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    sql: `
ALTER TABLE crosschain_payments ADD COLUMN burn_submission_id TEXT;
ALTER TABLE crosschain_payments ADD COLUMN burn_auth_json TEXT;
ALTER TABLE crosschain_payments ADD COLUMN burn_requested_at TEXT;
`,
  },
  {
    // SCA phase M1 (fase SCA §7.2, plan ADR-13): third parties, their keys and quotas, issued accounts and delegations.
    // Phase-1 rows are not rewritten: `tenant_id` is added with a default, so every existing quote and payment
    // belongs to the legacy tenant, which owns the keys of TILCAI_API_KEYS (see TenantAdmin.syncLegacyKeys).
    id: 3,
    sql: `
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED')),
  quota_accounts_per_day INTEGER NOT NULL CHECK (quota_accounts_per_day >= 0),
  quota_sponsored_ops_per_day INTEGER NOT NULL CHECK (quota_sponsored_ops_per_day >= 0),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_tenants_name ON tenants(lower(name));

-- Owner of everything created before tenants existed. Its quota is far above any real use: today's
-- sponsored burns and mints are not limited per tenant.
INSERT INTO tenants (id, name, status, quota_accounts_per_day, quota_sponsored_ops_per_day, created_at)
VALUES ('tenant_legacy', 'legacy', 'ACTIVE', 1000000, 1000000, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Only the SHA-256 of a key is stored. "env" keys mirror TILCAI_API_KEYS and follow it; "issued" ones come from the CLI.
CREATE TABLE tenant_api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_hash TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'issued' CHECK (source IN ('issued','env')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX ux_tenant_api_keys_hash ON tenant_api_keys(key_hash);
CREATE INDEX ix_tenant_api_keys_tenant ON tenant_api_keys(tenant_id);

-- One counter per tenant, UTC day and kind. Incremented only through a single statement that also checks the quota.
CREATE TABLE tenant_usage (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('account','operation')),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (tenant_id, day, kind)
) WITHOUT ROWID;

CREATE TABLE smart_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  external_ref TEXT NOT NULL,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  owner_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('DEPLOYING','ACTIVE','FAILED')),
  code_ref TEXT NOT NULL,
  salt TEXT NOT NULL,
  deploy_submission_id TEXT,
  deploy_tx_hash TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);
-- One address per network (EVM addresses compare ignoring case); one external ref per tenant and network;
-- one creation key per tenant (two tenants may reuse the same key without seeing each other).
CREATE UNIQUE INDEX ux_accounts_address ON smart_accounts(network, lower(address));
CREATE UNIQUE INDEX ux_accounts_external_ref ON smart_accounts(tenant_id, network, external_ref);
CREATE UNIQUE INDEX ux_accounts_idempotency ON smart_accounts(tenant_id, idempotency_key);
CREATE INDEX ix_accounts_due ON smart_accounts(state, next_check_at);
CREATE INDEX ix_accounts_tenant ON smart_accounts(tenant_id, created_at);

CREATE TABLE account_delegations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES smart_accounts(id),
  rule_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('AWAITING_OWNER','SUBMITTED','ACTIVE','REVOKING','REVOKED','FAILED')),
  onchain_ref TEXT,
  sign_request_json TEXT,
  submission_id TEXT,
  idempotency_key TEXT,
  request_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);
-- One on-chain rule per account; one creation key per account when the client sends one.
CREATE UNIQUE INDEX ux_delegations_onchain ON account_delegations(account_id, onchain_ref) WHERE onchain_ref IS NOT NULL;
CREATE UNIQUE INDEX ux_delegations_idempotency ON account_delegations(account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ix_delegations_due ON account_delegations(state, next_check_at);
CREATE INDEX ix_delegations_account ON account_delegations(account_id, created_at);

-- Events of an account and of its delegations. Insert-only: the triggers below refuse UPDATE and DELETE.
CREATE TABLE account_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES smart_accounts(id),
  delegation_id TEXT REFERENCES account_delegations(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  note TEXT NOT NULL,
  data_json TEXT,
  at TEXT NOT NULL
);
CREATE INDEX ix_account_events_account ON account_events(account_id, seq);
CREATE TRIGGER trg_account_events_no_update BEFORE UPDATE ON account_events
BEGIN SELECT RAISE(ABORT, 'account_events is insert-only'); END;
CREATE TRIGGER trg_account_events_no_delete BEFORE DELETE ON account_events
BEGIN SELECT RAISE(ABORT, 'account_events is insert-only'); END;

-- An account never changes tenant, network, address or external reference.
CREATE TRIGGER trg_accounts_identity BEFORE UPDATE ON smart_accounts
WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.network IS NOT OLD.network
  OR lower(NEW.address) IS NOT lower(OLD.address) OR NEW.external_ref IS NOT OLD.external_ref
BEGIN SELECT RAISE(ABORT, 'smart_accounts identity is immutable'); END;

-- Quotes and payments get their tenant. The default gives every existing row to the legacy tenant without
-- rewriting it. A column added with a non-NULL default cannot carry a REFERENCES clause, so the triggers
-- stand in for the foreign key and make the tenant immutable.
ALTER TABLE route_quotes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_legacy';
ALTER TABLE crosschain_payments ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_legacy';
CREATE INDEX ix_quotes_tenant ON route_quotes(tenant_id, created_at);
CREATE INDEX ix_payments_tenant ON crosschain_payments(tenant_id, created_at);

CREATE TRIGGER trg_quotes_tenant_insert BEFORE INSERT ON route_quotes
WHEN NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'unknown tenant'); END;
CREATE TRIGGER trg_quotes_tenant_immutable BEFORE UPDATE OF tenant_id ON route_quotes
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN SELECT RAISE(ABORT, 'tenant_id is immutable'); END;
CREATE TRIGGER trg_payments_tenant_insert BEFORE INSERT ON crosschain_payments
WHEN NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'unknown tenant'); END;
CREATE TRIGGER trg_payments_tenant_immutable BEFORE UPDATE OF tenant_id ON crosschain_payments
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN SELECT RAISE(ABORT, 'tenant_id is immutable'); END;
`,
  },
];
