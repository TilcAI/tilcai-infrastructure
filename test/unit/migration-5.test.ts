import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { promisify } from "node:util";
import { migrate, openDatabase } from "../../src/db/sqlite.ts";
import { SqliteCrosschainRepository } from "../../src/modules/crosschain/repository.ts";
import { LEGACY_TENANT_ID } from "../../src/modules/tenants/ports.ts";
import { SqliteTenantRegistry } from "../../src/modules/tenants/registry.ts";
import { tempDir } from "../support/sca.ts";

type Row = Record<string, unknown>;
const run = promisify(execFile);

/** The migration under test: third parties, quotas, accounts and delegations (SCA phase M1). */
const SCA_MIGRATION = 5;
const BEFORE = Array.from({ length: SCA_MIGRATION - 1 }, (_, i) => i + 1);
const AFTER = [...BEFORE, SCA_MIGRATION];

/**
 * A database exactly as the release before the SCA phase left it: the phase-1 tables with their payments
 * (migrations 1 and 2) plus the vault (3) and the monitor and QR mock (4), which do not touch them.
 */
function phase1Db(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db, SCA_MIGRATION - 1);
  return db;
}

function insertQuote(db: DatabaseSync, id: string, payTo: string): void {
  db
      .prepare(
        `INSERT INTO route_quotes (id, source_network, destination_network, source_domain, destination_domain, pay_to, destination_amount_atomic,
          burn_amount_atomic, max_fee_atomic, fee_bps_hundredths, finality, burn_token, mint_recipient, destination_caller, hook_data, preflight_json, created_at, expires_at)
         VALUES (?, 'eip155:43113', 'stellar:testnet', 1, 27, ?, '1000000', '100000', '0', '0', 2000, '0x5425890298aed601595a70AB815c96711a31Bc65',
                 '0x3de8', '0x3de8', '0x00ff', '{"payToExists":true,"payToTrustline":true,"payToAuthorized":true}', '2026-10-05T10:00:00.000Z', '2026-10-05T10:15:00.000Z')`,
      )
      .run(id, payTo);
}

/** Quotes, payments in every kind of state, their events and a receipt, written without any notion of tenant. */
function seedPhase1(db: DatabaseSync): void {
  const quote = (id: string, payTo: string) => insertQuote(db, id, payTo);
  const payment = (id: string, quoteId: string, key: string, state: string, extra: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id, quote_id: quoteId, state, uncertain: 0, mode: "dev_gasless", payer: "0xf3e19c6f5fae9897ec46439f919392dac13abda4", order_id: null,
      idempotency_key: key, request_hash: `rh-${id}`, source_network: "eip155:43113", attempts: 0, next_check_at: "2026-10-05T10:00:05.000Z",
      created_at: "2026-10-05T10:00:00.000Z", updated_at: "2026-10-05T10:00:05.000Z", version: 3, ...extra,
    };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO crosschain_payments (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(Object.values(row) as never[]));
    db.prepare("INSERT INTO payment_events (payment_id, from_state, to_state, note, data_json, at) VALUES (?, NULL, 'AWAITING_BURN', 'created', NULL, '2026-10-05T10:00:00.000Z')").run(id);
    db.prepare("INSERT INTO payment_events (payment_id, from_state, to_state, note, data_json, at) VALUES (?, 'AWAITING_BURN', ?, 'moved', '{\"k\":1}', '2026-10-05T10:00:05.000Z')").run(id, state);
  };
  quote("route_quote_a", "GAAA");
  quote("route_quote_b", "GBBB");
  quote("route_quote_c", "GCCC");
  quote("route_quote_d", "GDDD");
  payment("payment_attempt_1", "route_quote_a", "idem-legacy-1", "AWAITING_BURN", { mode: "external", burn_auth_json: null });
  payment("payment_attempt_2", "route_quote_b", "idem-legacy-2", "BURN_SUBMITTED", { burn_tx_hash: "0xaa".padEnd(66, "a"), burn_submission_id: "relayer-tx-1", burn_requested_at: "2026-10-05T10:00:01.000Z" });
  payment("payment_attempt_3", "route_quote_c", "idem-legacy-3", "ATTESTED", {
    burn_tx_hash: "0xbb".padEnd(66, "b"), burn_block: "59205042", cctp_nonce: `0x${"7e".repeat(32)}`, message: "0xdead", attestation: "0xbeef", fee_executed_atomic: "0",
  });
  payment("payment_attempt_4", "route_quote_d", "idem-legacy-4", "SETTLED", {
    burn_tx_hash: "0xcc".padEnd(66, "c"), burn_block: "59205043", cctp_nonce: `0x${"8f".repeat(32)}`, mint_submitter: "relayer", mint_tx_hash: "b6a9dfd9", fee_executed_atomic: "0", uncertain: 0, version: 9,
  });
  db.prepare("INSERT INTO payment_receipts (id, payment_id, order_id, evidence_json, created_at) VALUES ('payment_receipt_1', 'payment_attempt_4', NULL, '{\"schema\":\"tilcai-crosschain-payment-receipt-v1\"}', '2026-10-05T10:01:00.000Z')").run();
}

const TABLES = ["route_quotes", "crosschain_payments", "payment_events", "payment_receipts"] as const;
const dump = (db: DatabaseSync, withoutTenant: boolean): Record<string, Row[]> =>
  Object.fromEntries(
    TABLES.map((t) => [
      t,
      // node:sqlite rows have a null prototype: copy them into plain objects so both sides compare alike.
      (db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Row[]).map((r) => {
        const plain: Row = { ...r };
        if (withoutTenant) delete plain.tenant_id;
        return plain;
      }),
    ]),
  );

test("a phase-1 database migrates without losing or altering a single payment, event or receipt", () => {
  const db = phase1Db();
  seedPhase1(db);
  const before = dump(db, false);
  assert.deepEqual(before.crosschain_payments.map((p) => p.state), ["AWAITING_BURN", "BURN_SUBMITTED", "ATTESTED", "SETTLED"]);

  migrate(db);

  const after = dump(db, true);
  for (const t of TABLES) assert.deepEqual(after[t], before[t], `${t}: every row identical, only tenant_id is new`);
  assert.equal(after.payment_receipts.length, 1, "the receipt is still there");
  assert.deepEqual((db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Row[]).map((r) => r.id), AFTER);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "no dangling reference");
  assert.equal((db.prepare("PRAGMA integrity_check").get() as Row).integrity_check, "ok");
});

test("after migrating, every existing quote and payment belongs to the legacy tenant", () => {
  const db = phase1Db();
  seedPhase1(db);
  migrate(db);
  for (const t of ["route_quotes", "crosschain_payments"]) {
    const owners = db.prepare(`SELECT DISTINCT tenant_id FROM ${t}`).all() as Row[];
    assert.deepEqual(owners.map((o) => o.tenant_id), [LEGACY_TENANT_ID], t);
  }
  const legacy = db.prepare("SELECT * FROM tenants WHERE id = ?").get(LEGACY_TENANT_ID) as Row;
  assert.equal(legacy.name, "legacy");
  assert.equal(legacy.status, "ACTIVE");
  assert.match(String(legacy.created_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("the phase-1 code keeps working on the migrated database: same payments, same idempotency keys, same receipt", async () => {
  const db = phase1Db();
  seedPhase1(db);
  migrate(db);
  const repo = new SqliteCrosschainRepository(db);
  const settled = repo.getPayment("payment_attempt_4" as never)!;
  assert.equal(settled.state, "SETTLED");
  assert.equal(settled.tenantId, LEGACY_TENANT_ID);
  assert.equal(settled.mintTxHash, "b6a9dfd9");
  assert.equal(repo.getByIdempotencyKey("idem-legacy-4")?.id, "payment_attempt_4", "a replay of a key sent before tenants existed still finds its payment");
  assert.equal(repo.getByIdempotencyKey("idem-legacy-4")?.idempotencyKey, "idem-legacy-4");
  assert.equal(repo.getByIdempotencyKey("idem-legacy-4", "tenant_other" as never), undefined, "and another tenant does not");
  assert.equal(repo.getQuote("route_quote_d" as never)?.tenantId, LEGACY_TENANT_ID);
  assert.deepEqual(repo.events("payment_attempt_3" as never).map((e) => e.to), ["AWAITING_BURN", "ATTESTED"]);
  assert.ok(repo.getReceipt("payment_attempt_4" as never));
  const due = repo.listDue("2026-10-06T00:00:00.000Z", 10).map((p) => p.id).sort();
  assert.deepEqual(due, ["payment_attempt_2", "payment_attempt_3"], "the reconciliation worker still finds the payments in flight");
});

test("migrating again does nothing", () => {
  const db = phase1Db();
  seedPhase1(db);
  migrate(db);
  const once = dump(db, false);
  const tenants = db.prepare("SELECT count(*) AS n FROM tenants").get() as Row;
  migrate(db);
  migrate(db);
  assert.deepEqual(dump(db, false), once);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM tenants").get(), tenants);
  assert.equal((db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as Row).n, AFTER.length);
});

test("a migration that fails leaves the phase-1 database untouched", () => {
  const db = phase1Db();
  seedPhase1(db);
  const before = dump(db, false);
  db.exec("CREATE TABLE smart_accounts (id TEXT)"); // something in the way, found halfway through the migration
  assert.throws(() => migrate(db), /already exists/);
  assert.deepEqual(dump(db, false), before, "payments, events and receipts exactly as they were");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => r.name);
  assert.ok(!tables.includes("tenants") && !tables.includes("tenant_api_keys"), "no table of the failed migration survives");
  const cols = (db.prepare("PRAGMA table_info(crosschain_payments)").all() as Row[]).map((r) => r.name);
  assert.ok(!cols.includes("tenant_id"), "and payments did not get half a column");
  assert.deepEqual((db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Row[]).map((r) => r.id), BEFORE, "so it can be retried once the problem is fixed");
});

test("starting the app on a phase-1 file migrates it and keeps its data", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "tilcai.db");
    const old = phase1Db(path);
    seedPhase1(old);
    const before = dump(old, false);
    old.close();

    const db = openDatabase(path); // what every process does at startup
    assert.deepEqual(dump(db, true), before);
    assert.equal((await new SqliteTenantRegistry(db).get(LEGACY_TENANT_ID))?.status, "ACTIVE");
    db.close();
  } finally {
    cleanup();
  }
});

test("a payment created after the migration without a tenant belongs to the legacy tenant", () => {
  const db = phase1Db();
  seedPhase1(db);
  migrate(db);
  insertQuote(db, "route_quote_e", "GEEE"); // a quote written after the migration, still without a tenant
  db.prepare(
    `INSERT INTO crosschain_payments (id, quote_id, state, uncertain, mode, idempotency_key, request_hash, source_network, attempts, next_check_at, created_at, updated_at, version)
     VALUES ('payment_attempt_new', 'route_quote_e', 'AWAITING_BURN', 0, 'external', 'idem-new-1', 'rh', 'eip155:43113', 0, 'x', 'x', 'x', 0)`,
  ).run();
  assert.equal((db.prepare("SELECT tenant_id FROM crosschain_payments WHERE id = 'payment_attempt_new'").get() as Row).tenant_id, LEGACY_TENANT_ID);
  assert.equal((db.prepare("SELECT tenant_id FROM route_quotes WHERE id = 'route_quote_e'").get() as Row).tenant_id, LEGACY_TENANT_ID);
});

test("several processes starting at once on a phase-1 file migrate it once and none fails", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "tilcai.db");
    const old = phase1Db(path);
    seedPhase1(old);
    const before = dump(old, false);
    old.close();

    // The API and the worker (or the tenant CLI next to the server) can open the same file at the same instant.
    const child = join(import.meta.dirname, "..", "support", "open-db.ts");
    const outs = await Promise.all(Array.from({ length: 6 }, () => run(process.execPath, ["--import", "tsx", "--no-warnings", child, path], { encoding: "utf8" })));
    for (const o of outs) assert.equal(o.stdout.trim(), AFTER.join(","));

    const db = openDatabase(path);
    assert.deepEqual(dump(db, true), before, "no payment lost or changed by the race");
    assert.equal((db.prepare("SELECT count(*) AS n FROM tenants WHERE id = ?").get(LEGACY_TENANT_ID) as Row).n, 1, "one legacy tenant, not one per process");
    db.close();
  } finally {
    cleanup();
  }
});

test("a process that listed the pending migrations before another one applied them neither fails nor applies them twice", () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "tilcai.db");
    const old = phase1Db(path);
    seedPhase1(old);
    const before = dump(old, false);
    old.close();

    const open = () => {
      const c = new DatabaseSync(path);
      c.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      return c;
    };
    const a = open();
    const b = open();
    // Process B reads which migrations are pending; right then, process A applies them (the interleaving that real
    // processes only hit by bad luck). B then goes on with a list that is no longer true.
    let raced = false;
    const stale = new Proxy(b, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const st = target.prepare(sql);
            if (raced || !sql.startsWith("SELECT id FROM schema_migrations")) return st;
            return new Proxy(st, {
              get(s, p) {
                if (p === "all") {
                  return (...args: unknown[]) => {
                    const rows = (s as any).all(...args);
                    raced = true;
                    migrate(a);
                    return rows;
                  };
                }
                const v = (s as any)[p];
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          };
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as DatabaseSync;

    migrate(stale);
    assert.ok(raced, "the interleaving happened");
    assert.deepEqual(dump(b, true), before, "no payment lost or changed");
    assert.deepEqual((b.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Row[]).map((r) => r.id), AFTER);
    assert.equal((b.prepare("SELECT count(*) AS n FROM tenants WHERE id = ?").get(LEGACY_TENANT_ID) as Row).n, 1);
    a.close();
    b.close();
  } finally {
    cleanup();
  }
});
