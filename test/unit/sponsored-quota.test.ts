import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/db/sqlite.ts";
import { SqliteCrosschainRepository } from "../../src/modules/crosschain/repository.ts";
import { SqliteTenantRegistry } from "../../src/modules/tenants/registry.ts";
import type { TenantId } from "../../src/modules/tenants/ports.ts";
import { harness, MERCHANT, PAYER, SIGNER } from "../support/fakes.ts";
import { tempDir } from "../support/sca.ts";

// N-14: one unit of the tenant's sponsored-operation quota per payment whose burn the Relayer sends, taken BEFORE the Relayer is called.

const base = { sourceNetwork: "eip155:43113", destinationNetwork: "stellar:testnet", amount: "1.25", payTo: MERCHANT };

async function setup(quota: number, db?: DatabaseSync) {
  const h = db ? harness(db) : harness();
  h.evm.dev = SIGNER.address;
  const tenants = new SqliteTenantRegistry(h.db, h.clock);
  const a = await tenants.createTenant({ name: "A", quota: { sponsoredOpsPerDay: quota } });
  const b = await tenants.createTenant({ name: "B", quota: { sponsoredOpsPerDay: quota } });
  /** A dev_gasless payment: signed by the dev key and handed to the Relayer at once. */
  const pay = async (svc: typeof h.svc, tenantId: TenantId, key: string, mode: "dev_gasless" | "external" = "dev_gasless", quoteId?: string) => {
    const q = quoteId ? svc.getQuote(quoteId, tenantId) : await svc.quote({ ...base, tenantId });
    h.evm.lastBurn = { amount: q.burnAmountAtomic, maxFee: q.maxFeeAtomic, target: q.target, finality: q.finality };
    return svc.createPayment({ quoteId: q.id, mode, ...(mode === "external" ? { payer: PAYER } : {}), idempotencyKey: key, tenantId });
  };
  /** The worker, tenant-blind like the real one: steps due payments until they stop moving. */
  const drive = async (id: string, steps = 3) => {
    for (let i = 0; i < steps; i++) {
      const p = h.repo.getPayment(id as never)!;
      if (p.state === "SETTLED" || p.state === "FAILED") break;
      h.clock.advance(Math.max(0, Date.parse(p.nextCheckAt) - h.clock.t) + 1);
      await h.svc.step(h.repo.getPayment(id as never)!);
    }
    return h.repo.getPayment(id as never)!;
  };
  const used = (tenantId: TenantId) => (h.db.prepare("SELECT count FROM tenant_usage WHERE tenant_id = ? AND kind = 'operation'").get(tenantId) as any)?.count ?? 0;
  const hold = (paymentId: string) => (h.db.prepare("SELECT state FROM sponsored_holds WHERE payment_id = ?").get(paymentId) as any)?.state;
  return { h, a, b, pay, drive, used, hold };
}

test("N-14: with quota 1 two requests on two connections send one burn; the other is refused before the Relayer", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "q.sqlite");
    const { h, a, pay, used } = await setup(1, openDatabase(path));
    const dbB = openDatabase(path);
    const svcB = h.build(new SqliteCrosschainRepository(dbB));
    const [r1, r2] = await Promise.all([pay(h.svc, a.id, "key-n14-race-1"), pay(svcB, a.id, "key-n14-race-2")]);
    assert.equal(h.evmSubmitter.submits.length, 1, "exactly one burn reached the Relayer");
    assert.equal(used(a.id), 1);
    const refused = [r1, r2].filter((r) => r.payment.burnSubmissionId === null);
    assert.equal(refused.length, 1);
    assert.equal(h.repo.getPayment(refused[0]!.payment.id)!.lastError, "SPONSORED_QUOTA_EXHAUSTED");
    // The worker keeps asking, still without sending anything above the quota.
    h.clock.advance(60_000);
    await h.svc.processDue();
    assert.equal(h.evmSubmitter.submits.length, 1);
    dbB.close();
  } finally {
    cleanup();
  }
});

test("N-14: replay of the key and worker retries of the same payment consume one unit", async () => {
  const { h, a, pay, drive, used, hold } = await setup(5);
  const r = await pay(h.svc, a.id, "key-n14-replay");
  assert.equal(used(a.id), 1);
  assert.equal(hold(r.payment.id), "HELD");
  const again = await pay(h.svc, a.id, "key-n14-replay", "dev_gasless", r.payment.quoteId);
  assert.equal(again.replayed, true);
  assert.equal(used(a.id), 1);
  // The relayer reports the transaction failed: the worker sends the same authorization again, on the same hold.
  h.evmSubmitter.statuses.set(r.payment.burnSubmissionId!, { state: "failed", reason: "dropped" });
  h.clock.advance(61_000);
  await h.svc.step(h.repo.getPayment(r.payment.id)!);
  assert.equal(h.evmSubmitter.submits.length, 2);
  assert.equal(used(a.id), 1, "a retry is not a second operation");
  // Once the burn is mined the unit is spent for good.
  await drive(r.payment.id);
  assert.equal(hold(r.payment.id), "CONSUMED");
  assert.equal(used(a.id), 1);
});

test("N-14: external mode consumes no sponsorship, even with quota 0", async () => {
  const { h, a, pay, used } = await setup(0);
  const r = await pay(h.svc, a.id, "key-n14-external", "external");
  assert.equal(r.payment.state, "AWAITING_BURN");
  assert.equal(used(a.id), 0);
  assert.equal((h.db.prepare("SELECT count(*) n FROM sponsored_holds").get() as any).n, 0);
});

test("N-14: a refusal before sending gives the unit back; the retry takes it again once", async () => {
  const { h, a, pay, drive, used, hold } = await setup(1);
  h.evmSubmitter.failNextSubmit = "rejected";
  const r = await pay(h.svc, a.id, "key-n14-refused");
  assert.equal(h.evmSubmitter.submits.length, 0);
  assert.equal(used(a.id), 0);
  assert.equal(hold(r.payment.id), "RELEASED");
  await drive(r.payment.id);
  assert.equal(h.evmSubmitter.submits.length, 1);
  assert.equal(used(a.id), 1);
  assert.equal(hold(r.payment.id), "CONSUMED");
});

test("N-14: an ambiguous send (timeout, 408) keeps the hold, survives a restart and never charges or sends twice", async () => {
  const { dir, cleanup } = tempDir();
  try {
    for (const kind of ["ambiguous", "timeout408"] as const) {
      const path = join(dir, `${kind}.sqlite`);
      const { h, a, pay, used, hold } = await setup(1, openDatabase(path));
      h.evmSubmitter.failNextSubmit = kind;
      const r = await pay(h.svc, a.id, `key-n14-${kind}`);
      const id = r.payment.id;
      assert.equal(hold(id), "HELD", `${kind}: the Relayer may have it, so the unit stays reserved`);
      assert.equal(used(a.id), 1);
      assert.equal(h.repo.getPayment(id as never)!.burnSubmissionId, null);

      // Another payment cannot take the unit while this one is unresolved.
      const other = await pay(h.svc, a.id, `key-n14-${kind}-2`);
      assert.equal(other.payment.burnSubmissionId, null);
      assert.equal(h.evmSubmitter.submits.length, 0);

      // Inside the guard the worker does not send again; after a restart and the guard it sends once, on the same hold.
      h.clock.advance(10_000);
      await h.svc.processDue();
      assert.equal(h.evmSubmitter.submits.length, 0, `${kind}: guard respected`);
      h.db.close();
      const db = openDatabase(path);
      const svc = h.build(new SqliteCrosschainRepository(db));
      h.clock.advance(61_000);
      await svc.step(new SqliteCrosschainRepository(db).getPayment(id as never)!);
      assert.equal(h.evmSubmitter.submits.length, 1);
      assert.equal((db.prepare("SELECT count FROM tenant_usage WHERE tenant_id = ? AND kind = 'operation'").get(a.id) as any).count, 1, "no double charge");
      assert.equal((db.prepare("SELECT state FROM sponsored_holds WHERE payment_id = ?").get(id) as any).state, "HELD");
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("N-14: an authorization that expires unused releases its unit", async () => {
  const { h, a, pay, drive, used, hold } = await setup(1);
  h.evmSubmitter.failNextSubmit = "ambiguous";
  const r = await pay(h.svc, a.id, "key-n14-expire");
  assert.equal(used(a.id), 1);
  h.clock.advance(11 * 60_000);
  const p = await drive(r.payment.id);
  assert.equal(p.state, "FAILED");
  assert.equal(hold(r.payment.id), "RELEASED");
  assert.equal(used(a.id), 0);
});

test("N-14: tenant A running out does not affect tenant B", async () => {
  const { h, a, b, pay, used } = await setup(1);
  await pay(h.svc, a.id, "key-n14-a1");
  const refusedA = await pay(h.svc, a.id, "key-n14-a2");
  assert.equal(refusedA.payment.burnSubmissionId, null);
  const okB = await pay(h.svc, b.id, "key-n14-b1");
  assert.ok(okB.payment.burnSubmissionId, "B still has its own unit");
  assert.deepEqual([used(a.id), used(b.id)], [1, 1]);
  assert.equal(h.evmSubmitter.submits.length, 2);
});
