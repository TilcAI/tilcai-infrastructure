import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toFunctionSelector, toHex } from "viem";
import { loadEnv } from "../../src/config/env.ts";
import { networks } from "../../src/config/networks.ts";
import { DomainError } from "../../src/shared/errors.ts";
import { disbursementIdBytes32, ViemVault } from "../../src/modules/vault/adapters/evm.ts";
import { BUYER, decodeDisburse, RELAYER, VAULT, vaultHarness } from "../support/vault-fakes.ts";

const request = { to: BUYER, amount: "10.5", reference: "purchase:1", idempotencyKey: "key-vault-0001" };

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.contract.code === code);
}

test("payout: relayer submits, the vault's event confirms it", async () => {
  const h = vaultHarness();
  const r = await h.svc.create(request);
  assert.equal(r.replayed, false);
  assert.equal(r.disbursement.state, "SUBMITTED");
  assert.equal(r.disbursement.amountAtomic, 10_500_000n);
  assert.equal(h.submitter.submits[0]!.to, VAULT);

  const d = await h.drive(r.disbursement.id);
  assert.equal(d.state, "CONFIRMED");
  assert.equal(d.uncertain, false);
  assert.equal(h.vault.balance, 989_500_000n);
  assert.equal(await h.vault.paidAmount(disbursementIdBytes32(d.id)), 10_500_000n);
  const v = h.svc.view(d.id);
  assert.equal(v.amount, "10.5 USDC");
  assert.equal(v.links.tx, `https://testnet.snowtrace.io/tx/${d.txHash}`);
  assert.deepEqual(v.events.map((e) => e.to), ["REQUESTED", "SUBMITTED", "CONFIRMED"]);
});

test("idempotency: same key replays, other conditions conflict, one payout per reference", async () => {
  const h = vaultHarness();
  const first = await h.svc.create(request);
  const again = await h.svc.create(request);
  assert.equal(again.replayed, true);
  assert.equal(again.disbursement.id, first.disbursement.id);
  assert.equal(h.submitter.submits.length, 1);
  await rejects(h.svc.create({ ...request, amount: "11" }), "IDEMPOTENCY_CONFLICT");
  await rejects(h.svc.create({ ...request, idempotencyKey: "key-vault-0002" }), "DUPLICATE");
  await h.drive(first.disbursement.id);
  // Still one payout for the reference once it is paid.
  await rejects(h.svc.create({ ...request, idempotencyKey: "key-vault-0003" }), "DUPLICATE");
  assert.equal(h.vault.balance, 989_500_000n);
});

test("input is validated before anything is stored", async () => {
  const h = vaultHarness();
  await rejects(h.svc.create({ ...request, to: "0x123" }), "INVALID_INPUT");
  await rejects(h.svc.create({ ...request, to: `0x${"00".repeat(20)}` }), "INVALID_INPUT");
  await rejects(h.svc.create({ ...request, to: VAULT }), "INVALID_INPUT");
  await rejects(h.svc.create({ ...request, amount: "0" }), "INVALID_INPUT");
  await rejects(h.svc.create({ ...request, amount: "1.0000001" }), "INVALID_INPUT");
  await rejects(h.svc.create({ ...request, amount: "-1" }), "INVALID_INPUT");
  await rejects(h.svc.create({ ...request, reference: "has spaces" }), "INVALID_INPUT");
  await rejects(h.svc.create({ ...request, idempotencyKey: "short" }), "INVALID_INPUT");
  assert.equal(h.submitter.submits.length, 0);
  assert.equal(h.repo.getByIdempotencyKey(request.idempotencyKey), undefined);
});

test("preflight refuses what the vault could not pay now", async () => {
  const h = vaultHarness();
  h.vault.paused = true;
  await rejects(h.svc.create(request), "PAUSED");
  h.vault.paused = false;
  await rejects(h.svc.create({ ...request, amount: "100.000001" }), "PAYMENT_LIMIT");
  h.vault.spentToday = 495_000_000n;
  await rejects(h.svc.create(request), "PAYMENT_LIMIT");
  h.vault.spentToday = 0n;
  h.vault.balance = 10_499_999n;
  await rejects(h.svc.create(request), "BUDGET");
  h.vault.balance = 1_000_000_000n;
  h.vault.operator = "0x00000000000000000000000000000000000000ee";
  await rejects(h.svc.create(request), "SERVICE_UNAVAILABLE");
  assert.equal(h.submitter.submits.length, 0);
  assert.equal(h.repo.getByIdempotencyKey(request.idempotencyKey), undefined);
});

test("preflight counts payouts already promised", async () => {
  const h = vaultHarness();
  h.vault.balance = 15_000_000n;
  h.submitter.autoMine = false;
  const first = await h.svc.create({ ...request, amount: "10" });
  assert.equal((await h.svc.status()).pendingAtomic, 10_000_000n);
  await rejects(h.svc.create({ to: BUYER, amount: "10", reference: "purchase:2", idempotencyKey: "key-vault-0002" }), "BUDGET");
  h.submitter.mine(first.disbursement.submissionId!);
  await h.drive(first.disbursement.id);
  assert.equal((await h.svc.status()).pendingAtomic, 0n);
  h.submitter.autoMine = true;
  const second = await h.svc.create({ to: BUYER, amount: "5", reference: "purchase:2", idempotencyKey: "key-vault-0002" });
  assert.equal((await h.drive(second.disbursement.id)).state, "CONFIRMED");
  assert.equal(h.vault.balance, 0n);
});

test("relayer rejection: nothing sent, retried with backoff", async () => {
  const h = vaultHarness();
  h.submitter.failNextSubmit = "rejected";
  const r = await h.svc.create(request);
  assert.equal(r.disbursement.state, "REQUESTED");
  assert.equal(r.disbursement.attempts, 1);
  assert.equal(r.disbursement.uncertain, false);
  assert.match(r.disbursement.lastError!, /^DISBURSE_SUBMIT_REJECTED/);
  assert.ok(Date.parse(r.disbursement.nextCheckAt) > h.clock.t);
  assert.equal(await h.svc.processDue(), 0); // not due yet
  const d = await h.drive(r.disbursement.id);
  assert.equal(d.state, "CONFIRMED");
  assert.equal(h.submitter.submits.length, 1);
});

test("relayer call without an answer that did land: found on-chain, paid once", async () => {
  const h = vaultHarness();
  h.submitter.failNextSubmit = "lost";
  const r = await h.svc.create(request);
  assert.equal(r.disbursement.state, "REQUESTED");
  assert.equal(r.disbursement.uncertain, true);
  assert.ok(r.disbursement.requestedAt);
  const d = await h.drive(r.disbursement.id);
  assert.equal(d.state, "CONFIRMED");
  assert.equal(d.uncertain, false);
  assert.match(d.txHash!, /^0x[0-9a-f]{64}$/);
  assert.equal(h.submitter.submits.length, 1); // never sent again
  assert.equal(h.vault.balance, 989_500_000n);
});

test("relayer call without an answer that did not land: waits the guard, then sends again", async () => {
  const h = vaultHarness({ maxAttempts: 1 });
  h.submitter.failNextSubmit = "ambiguous";
  const r = await h.svc.create(request);
  assert.equal(r.disbursement.uncertain, true);
  // Inside the guard window a second transaction is never sent.
  h.clock.advance(5_000);
  const waiting = await h.svc.step(h.svc.mustGet(r.disbursement.id));
  assert.equal(waiting.state, "REQUESTED");
  assert.equal(h.submitter.submits.length, 0);
  h.clock.advance(60_000);
  const d = await h.drive(r.disbursement.id);
  assert.equal(d.state, "CONFIRMED"); // uncertain payouts are never given up, whatever maxAttempts says
  assert.equal(h.submitter.submits.length, 1);
});

test("a reverted payout goes back to the queue and pays once the vault can", async () => {
  const h = vaultHarness();
  h.submitter.autoMine = false;
  const r = await h.svc.create(request);
  h.vault.balance = 0n; // drained between the preflight and the block
  h.submitter.mine(r.disbursement.submissionId!);
  let d = await h.svc.step(h.svc.mustGet(r.disbursement.id));
  assert.equal(d.state, "REQUESTED");
  assert.match(d.lastError!, /^DISBURSE_REVERTED/);
  h.clock.advance(60_000);
  d = await h.svc.step(h.svc.mustGet(d.id));
  assert.equal(d.state, "REQUESTED");
  assert.equal(d.lastError, "DISBURSE_WOULD_REVERT:InsufficientBalance");
  assert.equal(h.submitter.submits.length, 1); // a payout that would revert is not sent

  h.vault.balance = 50_000_000n;
  h.submitter.autoMine = true;
  d = await h.drive(d.id);
  assert.equal(d.state, "CONFIRMED");
  assert.equal(h.vault.balance, 39_500_000n);
});

test("relayer reports the transaction failed: retried, paid once", async () => {
  const h = vaultHarness();
  h.submitter.autoMine = false;
  const r = await h.svc.create(request);
  h.submitter.statuses.set(r.disbursement.submissionId!, { state: "failed", reason: "expired:" });
  h.submitter.autoMine = true;
  const d = await h.drive(r.disbursement.id);
  assert.equal(d.state, "CONFIRMED");
  assert.equal(h.submitter.submits.length, 2);
  assert.equal(h.vault.balance, 989_500_000n);
  assert.deepEqual(h.svc.view(d.id).events.map((e) => e.to), ["REQUESTED", "SUBMITTED", "REQUESTED", "SUBMITTED", "CONFIRMED"]);
});

test("gives up only after every attempt provably paid nothing; the reference can be paid again", async () => {
  const h = vaultHarness({ maxAttempts: 3 });
  h.submitter.autoMine = false;
  const r = await h.svc.create(request);
  h.vault.paused = true; // paused after the request was accepted
  h.submitter.mine(r.disbursement.submissionId!);
  const d = await h.drive(r.disbursement.id, 20);
  assert.equal(d.state, "FAILED");
  assert.equal(d.failureCode, "DISBURSE_NOT_EXECUTED");
  assert.equal(d.lastError, "DISBURSE_WOULD_REVERT:EnforcedPause");
  assert.equal(h.vault.balance, 1_000_000_000n);
  assert.equal(await h.svc.processDue(), 0);

  h.vault.paused = false;
  h.submitter.autoMine = true;
  const retry = await h.svc.create({ ...request, idempotencyKey: "key-vault-retry" });
  assert.notEqual(retry.disbursement.id, d.id);
  assert.equal((await h.drive(retry.disbursement.id)).state, "CONFIRMED");
  assert.equal(h.vault.balance, 989_500_000n);
});

test("a mined transaction without the expected event is never reported as paid", async () => {
  const h = vaultHarness();
  h.submitter.autoMine = false;
  const r = await h.svc.create(request);
  const hash = `0x${"ab".repeat(32)}` as const;
  h.vault.txs.set(hash, { kind: "mined", blockNumber: 1001n, confirmations: 3n, disbursed: [{ disbursementId: disbursementIdBytes32(r.disbursement.id), to: BUYER, amount: 1n }] });
  h.submitter.statuses.set(r.disbursement.submissionId!, { state: "confirmed", txHash: hash });
  const d = await h.svc.step(h.svc.mustGet(r.disbursement.id));
  assert.equal(d.state, "SUBMITTED");
  assert.equal(d.uncertain, true);
  assert.equal(d.lastError, "DISBURSED_EVENT_MISMATCH");
});

test("paid on-chain but the event is out of reach: confirmed without a hash", async () => {
  const h = vaultHarness();
  h.submitter.failNextSubmit = "lost";
  h.vault.eventsVisible = false;
  const r = await h.svc.create(request);
  const d = await h.drive(r.disbursement.id);
  assert.equal(d.state, "CONFIRMED");
  assert.equal(d.txHash, null);
  assert.equal(h.svc.view(d.id).links.tx, null);
});

test("worker pass advances what is due and leaves settled payouts alone", async () => {
  const h = vaultHarness();
  const a = await h.svc.create(request);
  const b = await h.svc.create({ to: BUYER, amount: "1", idempotencyKey: "key-vault-0002" });
  assert.equal(await h.svc.processDue(), 2);
  assert.equal(h.svc.mustGet(a.disbursement.id).state, "CONFIRMED");
  assert.equal(h.svc.mustGet(b.disbursement.id).state, "CONFIRMED");
  assert.equal(await h.svc.processDue(), 0);
  await rejects(Promise.resolve().then(() => h.svc.mustGet("vault_disbursement_missing")), "NOT_FOUND");
  await rejects(Promise.resolve().then(() => h.svc.mustGet("payment_attempt_x")), "INVALID_INPUT");
});

test("status tells whether the relayer is the vault's operator", async () => {
  const h = vaultHarness();
  const s = await h.svc.status();
  assert.equal(s.relayer, RELAYER);
  assert.equal(s.operatorIsRelayer, true);
  h.submitter.account = "0x00000000000000000000000000000000000000ee";
  assert.equal((await h.svc.status()).operatorIsRelayer, false);
});

test("calldata: disburse(bytes32 id, address to, uint256 amount) with the id hashed like the contract expects", () => {
  const net = networks(loadEnv({})).avalancheFuji;
  const id32 = disbursementIdBytes32("vault_disbursement_abc");
  assert.equal(id32, keccak256(toHex("vault_disbursement_abc")));
  const data = new ViemVault(net, VAULT).encodeDisburse(id32, BUYER, 10_500_000n);
  assert.equal(data.slice(0, 10), toFunctionSelector("disburse(bytes32,address,uint256)"));
  assert.deepEqual(decodeDisburse(data).map((x) => String(x).toLowerCase()), [id32, BUYER, "10500000"]);
});
