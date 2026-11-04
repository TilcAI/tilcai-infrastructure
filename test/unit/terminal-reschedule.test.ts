import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/db/sqlite.ts";
import type { Hex } from "../../src/shared/hex.ts";
import { SqliteCrosschainRepository } from "../../src/modules/crosschain/repository.ts";
import { SqliteVaultRepository } from "../../src/modules/vault/repository.ts";
import { harness, MERCHANT } from "../support/fakes.ts";
import { BUYER, vaultHarness } from "../support/vault-fakes.ts";
import { tempDir } from "../support/sca.ts";

// N-10: a reschedule that arrives after another actor finished the record must not touch it.
// Two SQLite connections to one file: A reads the record and calls the provider; B finishes it meanwhile; A then reschedules.

const NONCE = `0x${"7e".repeat(32)}` as Hex;
const tick = () => new Promise((r) => setImmediate(r));

/** Every row of the record, byte for byte (row + events [+ receipt]). */
const snapshot = (db: DatabaseSync, queries: string[], id: string) => JSON.stringify(queries.map((sql) => db.prepare(sql).all(id)));
const CROSSCHAIN_ROWS = [
  "SELECT * FROM crosschain_payments WHERE id = ?",
  "SELECT * FROM payment_events WHERE payment_id = ? ORDER BY seq",
  "SELECT * FROM payment_receipts WHERE payment_id = ?",
];
const VAULT_ROWS = [
  "SELECT * FROM vault_disbursements WHERE id = ?",
  "SELECT * FROM vault_disbursement_events WHERE disbursement_id = ? ORDER BY seq",
];

/** The first `status` call answers what it saw BEFORE the gate opens: the provider call A already made. */
function gateStatus(target: { status: (id: string) => Promise<any> }, failWith?: Error) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let armed = true;
  const orig = target.status.bind(target);
  target.status = async (id: string) => {
    const seen = await orig(id);
    if (armed) {
      armed = false; // only A's call waits
      await gate;
      if (failWith) throw failWith; // synthetic provider failure, after B finished
    }
    return seen;
  };
  return open;
}

async function crosschainSetup(path: string) {
  const dbA = openDatabase(path);
  const h = harness(dbA);
  h.submitter.autoConfirm = false;
  const q = await h.svc.quote({ sourceNetwork: "eip155:43113", destinationNetwork: "stellar:testnet", amount: "1.25", payTo: MERCHANT });
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: "key-n10-cross" });
  h.attest(r.payment.burnTxHash!, NONCE);
  const p = await h.drive(r.payment.id, 6);
  assert.equal(p.state, "MINT_SUBMITTED");
  const dbB = openDatabase(path);
  const svcB = h.build(new SqliteCrosschainRepository(dbB));
  /** B confirms the mint on the fake chain and settles the payment through its own connection. */
  const settleViaB = async () => {
    const hash = `${"b".repeat(63)}1`;
    h.stellar.txs.set(hash, "SUCCESS");
    h.stellar.usedNonces.add(NONCE);
    h.submitter.statuses.set(p.mintSubmissionId!, { state: "confirmed", txHash: hash });
    h.clock.advance(5_000);
    assert.equal((await svcB.step(svcB.mustGet(p.id))).state, "SETTLED");
  };
  return { h, p, dbA, dbB, settleViaB };
}

test("N-10 crosschain: a late reschedule (pending answer or provider error) leaves a settled payment untouched", async () => {
  const { dir, cleanup } = tempDir();
  try {
    for (const mode of ["pending", "provider-error"] as const) {
      const path = join(dir, `${mode}.sqlite`);
      const { h, p, dbA, dbB, settleViaB } = await crosschainSetup(path);
      const stale = h.svc.mustGet(p.id);
      h.clock.advance(5_000);
      const open = gateStatus(h.submitter, mode === "provider-error" ? new Error("rpc timeout") : undefined);
      const a = mode === "pending" ? h.svc.step(stale) : h.svc.processDue();
      await tick();
      await settleViaB();
      const before = snapshot(dbA, CROSSCHAIN_ROWS, p.id);
      const emitted = h.events.length;
      open();
      await a;
      assert.equal(snapshot(dbA, CROSSCHAIN_ROWS, p.id), before, `${mode}: row, events and receipt byte for byte`);
      assert.equal(h.events.length, emitted, `${mode}: no uncertainty announcement`);
      assert.equal(h.submitter.submits.length, 1, "no new emission");

      // Restart: reopen the file and try again with the stale copy, with the most aggressive options.
      dbA.close();
      dbB.close();
      const db = openDatabase(path);
      const svc = h.build(new SqliteCrosschainRepository(db));
      (svc as any).reschedule(stale, { uncertain: true, error: "LATE", backoff: true, countAttempt: true });
      assert.equal(snapshot(db, CROSSCHAIN_ROWS, p.id), before, `${mode}: reopened terminal stays closed`);
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("N-10 crosschain: an active payment still retries — attempts +1 once, uncertainty announced once", async () => {
  const h = harness();
  h.submitter.autoConfirm = false;
  const q = await h.svc.quote({ sourceNetwork: "eip155:43113", destinationNetwork: "stellar:testnet", amount: "1.25", payTo: MERCHANT });
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: "key-n10-active" });
  h.attest(r.payment.burnTxHash!, NONCE);
  const p = await h.drive(r.payment.id, 6);
  assert.equal(p.state, "MINT_SUBMITTED");
  const next = (h.svc as any).reschedule(p, { uncertain: true, error: "E", backoff: true, countAttempt: true });
  assert.equal(next.attempts, p.attempts + 1);
  assert.equal(next.uncertain, true);
  assert.equal(next.lastError, "E");
  assert.equal(h.repo.events(p.id).filter((e) => e.note.startsWith("flagged uncertain")).length, 1);
  assert.equal(h.events.filter((e) => e.type === "crosschain.payment.uncertain").length, 1);
});

test("N-10 vault: a late reschedule leaves a confirmed payout untouched, also after reopening", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "v.sqlite");
    const dbA = openDatabase(path);
    const h = vaultHarness({}, dbA);
    h.submitter.autoMine = false;
    const r = await h.svc.create({ to: BUYER, amount: "10.5", reference: "purchase:n10", idempotencyKey: "key-vault-n10" });
    const id = r.disbursement.id;
    const stale = h.svc.mustGet(id);
    assert.equal(stale.state, "SUBMITTED");
    const dbB = openDatabase(path);
    const svcB = h.build(new SqliteVaultRepository(dbB));
    h.clock.advance(5_000);
    const open = gateStatus(h.submitter);
    const a = h.svc.step(stale);
    await tick();
    h.submitter.mine(stale.submissionId!);
    assert.equal((await svcB.step(svcB.mustGet(id))).state, "CONFIRMED");
    const before = snapshot(dbA, VAULT_ROWS, id);
    const emitted = h.events.length;
    open();
    await a;
    assert.equal(snapshot(dbA, VAULT_ROWS, id), before, "row and events byte for byte");
    assert.equal(h.events.length, emitted, "no uncertainty announcement");
    assert.equal(h.submitter.submits.length, 1, "no new emission");

    dbA.close();
    dbB.close();
    const db = openDatabase(path);
    const svc = h.build(new SqliteVaultRepository(db));
    (svc as any).reschedule(stale, { uncertain: true, error: "LATE", backoff: true, countAttempt: true });
    assert.equal(snapshot(db, VAULT_ROWS, id), before, "reopened terminal stays closed");
    db.close();
  } finally {
    cleanup();
  }
});

test("N-10 vault: an active payout still retries — attempts +1 once, uncertainty announced once", async () => {
  const h = vaultHarness();
  h.submitter.autoMine = false;
  const r = await h.svc.create({ to: BUYER, amount: "10.5", reference: "purchase:n10b", idempotencyKey: "key-vault-n10b" });
  const d = h.svc.mustGet(r.disbursement.id);
  const next = (h.svc as any).reschedule(d, { uncertain: true, error: "E", backoff: true, countAttempt: true });
  assert.equal(next.attempts, d.attempts + 1);
  assert.equal(next.uncertain, true);
  assert.equal(h.repo.events(d.id).filter((e) => e.note.startsWith("flagged uncertain")).length, 1);
  assert.equal(h.events.filter((e) => e.type === "vault.disbursement.uncertain").length, 1);
});
