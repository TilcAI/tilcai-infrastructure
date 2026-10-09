import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { openDatabase } from "../../src/db/sqlite.ts";
import { SqliteDelegationRepository, SqliteSmartAccountRepository } from "../../src/modules/accounts/repository.ts";
import { LEGACY_TENANT_ID } from "../../src/modules/tenants/ports.ts";
import { SqliteTenantRegistry } from "../../src/modules/tenants/registry.ts";
import { accountEvent, newAccount, tempDir, TestClock, type RepoFixture } from "../support/sca.ts";
import { defineRepositoryContract } from "../support/repository-contract.ts";

const run = promisify(execFile);

function sqliteFixture(path = ":memory:") {
  const db = openDatabase(path);
  const clock = new TestClock();
  const fixture: RepoFixture = {
    tenants: new SqliteTenantRegistry(db, clock),
    accounts: new SqliteSmartAccountRepository(db, clock),
    delegations: new SqliteDelegationRepository(db),
    clock,
  };
  return { db, clock, fixture };
}

// The behaviour every engine must have (ADR-04). Phase 2 runs this same suite against Postgres.
defineRepositoryContract("sqlite", () => sqliteFixture().fixture);

// ── What only SQLite can show: the guarantees live in the database itself ─────────────────────────────

test("[sqlite] the log is insert-only: UPDATE and DELETE on account_events are refused by the database", async () => {
  const { db, clock, fixture } = sqliteFixture();
  const t = await fixture.tenants.createTenant({ name: "A" });
  const acc = newAccount(t.id, clock);
  await fixture.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "created", clock));
  assert.throws(() => db.exec("UPDATE account_events SET note = 'edited'"), /insert-only/);
  assert.throws(() => db.exec("DELETE FROM account_events"), /insert-only/);
  assert.equal((await fixture.accounts.events(acc.id))[0]!.note, "created");
});

test("[sqlite] identity cannot be changed even with raw SQL: tenant of an account, quote and payment", async () => {
  const { db, clock, fixture } = sqliteFixture();
  const a = await fixture.tenants.createTenant({ name: "A" });
  const b = await fixture.tenants.createTenant({ name: "B" });
  const acc = newAccount(a.id, clock);
  await fixture.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "c", clock));
  for (const col of ["tenant_id", "network", "address", "external_ref"]) {
    assert.throws(() => db.prepare(`UPDATE smart_accounts SET ${col} = ? WHERE id = ?`).run(col === "tenant_id" ? b.id : "other", acc.id), /immutable/, col);
  }
  db.prepare("UPDATE smart_accounts SET attempts = 5 WHERE id = ?").run(acc.id); // everything else may change
  db.exec(`INSERT INTO route_quotes (id, source_network, destination_network, source_domain, destination_domain, pay_to, destination_amount_atomic,
    burn_amount_atomic, max_fee_atomic, fee_bps_hundredths, finality, burn_token, mint_recipient, destination_caller, hook_data, preflight_json, created_at, expires_at)
    VALUES ('route_quote_1','eip155:43113','stellar:testnet',1,27,'G','1','1','0','0',2000,'0x','0x','0x','0x','{}','2026-10-08T00:00:00Z','2026-10-08T01:00:00Z')`);
  assert.equal((db.prepare("SELECT tenant_id FROM route_quotes").get() as any).tenant_id, LEGACY_TENANT_ID, "a row written without a tenant belongs to the legacy tenant");
  assert.throws(() => db.prepare("UPDATE route_quotes SET tenant_id = ?").run(b.id), /immutable/);
  assert.throws(() => db.prepare("UPDATE route_quotes SET tenant_id = 'tenant_nope'").run(), /immutable/);
});

test("[sqlite] a quote or payment cannot name a tenant that does not exist", () => {
  const { db } = sqliteFixture();
  assert.throws(
    () =>
      db.exec(`INSERT INTO route_quotes (id, tenant_id, source_network, destination_network, source_domain, destination_domain, pay_to, destination_amount_atomic,
        burn_amount_atomic, max_fee_atomic, fee_bps_hundredths, finality, burn_token, mint_recipient, destination_caller, hook_data, preflight_json, created_at, expires_at)
        VALUES ('route_quote_2','tenant_ghost','eip155:43113','stellar:testnet',1,27,'G','1','1','0','0',2000,'0x','0x','0x','0x','{}','2026-10-08T00:00:00Z','2026-10-08T01:00:00Z')`),
    /unknown tenant/,
  );
});

test("[sqlite] only the SHA-256 of a key is stored, never the key", async () => {
  const { db, fixture } = sqliteFixture();
  const t = await fixture.tenants.createTenant({ name: "A" });
  const { key, info } = await fixture.tenants.issueKey(t.id, { label: "backend", scopes: ["payments"] });
  const rows = db.prepare("SELECT * FROM tenant_api_keys WHERE id = ?").all(info.id) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  for (const value of Object.values(rows[0]!)) assert.ok(!String(value).includes(key), "no column holds the key");
  assert.equal(rows[0]!.key_hash, createHash("sha256").update(key).digest("hex"));
  assert.ok(key.startsWith("tilc_test_") && key.length > 40);
  assert.equal(info.hint, key.slice(0, 14), "only a short hint is kept to recognise it");
  const dump = JSON.stringify(db.prepare("SELECT * FROM tenant_api_keys").all());
  assert.ok(!dump.includes(key.slice(14)), "the secret part appears nowhere in the table");
});

test("[sqlite] the limit holds when two connections race for the last unit", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "race.db");
    const one = sqliteFixture(path);
    const two = sqliteFixture(path);
    const t = await one.fixture.tenants.createTenant({ name: "Racer", quota: { sponsoredOpsPerDay: 5 } });
    // Four units used, one left; twenty requests arrive at once from both connections.
    for (let i = 0; i < 4; i++) assert.equal(await one.fixture.tenants.consumeQuota(t.id, "operation"), true);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).fixture.tenants.consumeQuota(t.id, "operation")));
    assert.equal(results.filter(Boolean).length, 1, "exactly one request gets the last unit");
    assert.equal((await two.fixture.tenants.usage(t.id)).operations, 5, "and the counter stops at the limit");
    one.db.close();
    two.db.close();
  } finally {
    cleanup();
  }
});

test("[sqlite] the limit holds across separate processes, as with the API and the worker", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "procs.db");
    const { db, fixture } = sqliteFixture(path);
    const t = await fixture.tenants.createTenant({ name: "Multi", quota: { sponsoredOpsPerDay: 40 } });
    db.close();
    const worker = join(import.meta.dirname, "..", "support", "quota-worker.ts");
    // Four processes, 25 attempts each: 100 attempts for 40 units.
    const outs = await Promise.all(
      Array.from({ length: 4 }, () => run(process.execPath, ["--import", "tsx", "--no-warnings", worker, path, t.id, "25"], { encoding: "utf8" })),
    );
    const got = outs.map((o) => Number(o.stdout.trim()));
    assert.equal(got.reduce((a, b) => a + b, 0), 40, `processes got ${got.join("+")}`);
    // The children count on the real UTC day, so the check reads it with the real clock too.
    const check = openDatabase(path);
    assert.equal((await new SqliteTenantRegistry(check).usage(t.id)).operations, 40);
    check.close();
  } finally {
    cleanup();
  }
});

test("[sqlite] a database opened again keeps its tenants, keys and usage", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "persist.db");
    const first = sqliteFixture(path);
    const t = await first.fixture.tenants.createTenant({ name: "Keeps", quota: { accountsPerDay: 3 } });
    const { key } = await first.fixture.tenants.issueKey(t.id, { label: "k", scopes: ["accounts:read"] });
    await first.fixture.tenants.consumeQuota(t.id, "account");
    first.db.close();
    const second = sqliteFixture(path);
    assert.equal((await second.fixture.tenants.authenticate(key))?.tenant.id, t.id);
    assert.deepEqual(await second.fixture.tenants.usage(t.id), { accounts: 1, operations: 0 });
    second.db.close();
  } finally {
    cleanup();
  }
});
