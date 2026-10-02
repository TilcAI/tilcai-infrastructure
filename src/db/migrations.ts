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
];
