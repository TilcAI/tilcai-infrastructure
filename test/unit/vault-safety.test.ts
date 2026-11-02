import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/sqlite.ts";
import { SqliteVaultRepository } from "../../src/modules/vault/repository.ts";
import { VaultDisbursementService } from "../../src/modules/vault/service.ts";
import { networks } from "../../src/config/networks.ts";
import { loadEnv } from "../../src/config/env.ts";
import { silentLogger } from "../../src/shared/log.ts";
import { FakeClock } from "../support/fakes.ts";
import { BUYER, FakeVault, FakeVaultSubmitter, vaultHarness } from "../support/vault-fakes.ts";
import { disbursementIdBytes32 } from "../../src/modules/vault/disbursement-id.ts";

const request = { to: BUYER, amount: "10", idempotencyKey: "concurrent-vault-01" };
const network = networks(loadEnv({})).avalancheFuji;

for (const capacity of ["balance", "daily"] as const) for (const sameKey of [false, true]) test(`two SQLite connections (${capacity}): ${sameKey ? "same key replays" : "only one reservation fits"}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-reserve-"));
  const file = join(dir, "db.sqlite");
  const dbs = [openDatabase(file), openDatabase(file)];
  try {
    const vault = new FakeVault();
    if (capacity === "balance") vault.balance = 10_000_000n;
    else vault.dailyLimit = 10_000_000n;
    const submitter = new FakeVaultSubmitter(vault);
    submitter.autoMine = false;
    const clock = new FakeClock();
    const services = dbs.map(db => new VaultDisbursementService({ repo: new SqliteVaultRepository(db), vault, submitter, network, clock, log: silentLogger, options: { pollMs: 1, minConfirmations: 1 } }));
    // Both read the same external capacity before either can reserve it locally.
    const original = vault.status.bind(vault);
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    vault.status = async () => {
      const snapshot = await original();
      if (++reads === 2) release();
      await barrier;
      return snapshot;
    };
    const results = await Promise.allSettled(services.map((svc, i) => svc.create({ ...request, idempotencyKey: sameKey ? request.idempotencyKey : `${request.idempotencyKey}-${i}` })));
    assert.equal(results.filter(r => r.status === "fulfilled").length, sameKey ? 2 : 1);
    if (sameKey) {
      const values = results.map(r => { assert.equal(r.status, "fulfilled"); return r.value; });
      assert.equal(values[0]!.disbursement.id, values[1]!.disbursement.id);
      assert.equal(values.filter(v => v.replayed).length, 1);
    } else {
      const failed = results.find(r => r.status === "rejected");
      assert.equal(failed?.status === "rejected" && failed.reason.contract.code, capacity === "balance" ? "BUDGET" : "PAYMENT_LIMIT");
    }
    assert.equal(submitter.submits.length, 1);
    const reopened = openDatabase(file);
    try { assert.equal(new SqliteVaultRepository(reopened).pendingAtomic(vault.address()), 10_000_000n); }
    finally { reopened.close(); }
  } finally { dbs.forEach(db => db.close()); rmSync(dir, { recursive: true, force: true }); }
});

for (const change of ["receiver", "amount", "rpc", "no-hash"] as const) test(`recovery evidence: ${change}`, async () => {
  const h = vaultHarness();
  h.submitter.failNextSubmit = "lost";
  const created = await h.svc.create(request);
  const paid = h.vault.paid.get(disbursementIdBytes32(created.disbursement.id))!;
  const original = h.vault.findDisbursed.bind(h.vault);
  if (change === "receiver") paid.to = `0x${"12".repeat(20)}`;
  if (change === "amount") paid.amount += 1n;
  if (change === "rpc") h.vault.findDisbursed = async () => { throw new Error("RPC down"); };
  if (change === "no-hash") h.vault.findDisbursed = async () => ({ ...paid, txHash: null, blockNumber: null }) as any;
  const d = await h.drive(created.disbursement.id);
  assert.equal(d.state, change === "no-hash" ? "CONFIRMED" : "REQUESTED");
  assert.equal(d.uncertain, change !== "no-hash");
  assert.equal(h.submitter.submits.length, 1);
  if (change === "rpc") {
    h.vault.findDisbursed = original;
    assert.equal((await h.drive(d.id)).state, "CONFIRMED");
  }
});

test("capacity snapshot crossing UTC day or aging out never inserts", async () => {
  for (const crossing of [false, true]) {
    const h = vaultHarness();
    if (crossing) h.clock.advance(86_400_000 - (h.clock.t % 86_400_000) - 1);
    const original = h.vault.status.bind(h.vault);
    h.vault.status = async () => { const s = await original(); h.clock.advance(crossing ? 2 : 30_001); return s; };
    await assert.rejects(h.svc.create(request), (e: any) => e.contract.code === "SERVICE_UNAVAILABLE");
    assert.equal(h.repo.getByIdempotencyKey(request.idempotencyKey), undefined);
    assert.equal(h.submitter.submits.length, 0);
  }
});

test("failed insert rolls back payout and event atomically", async () => {
  const db = openDatabase(":memory:");
  const h = vaultHarness();
  const d = (await h.svc.create(request)).disbursement;
  const repo = new SqliteVaultRepository(db);
  try {
    db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON vault_disbursement_events BEGIN SELECT RAISE(ABORT, 'injected'); END");
    assert.throws(() => repo.insert(d, { disbursementId: d.id, from: null, to: "REQUESTED", at: d.createdAt, note: "test" }, () => {}), /injected/);
    assert.equal(repo.get(d.id), undefined);
    assert.equal(repo.pendingAtomic(d.vault), 0n);
  } finally { db.close(); }
});
