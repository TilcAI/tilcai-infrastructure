import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition } from "tilcai-core/src/contracts.ts";
import { DomainError } from "../../src/shared/errors.ts";
import type { Hex } from "../../src/shared/hex.ts";
import { paymentStateOf } from "../../src/modules/crosschain/domain.ts";
import { harness, MERCHANT, PAYER } from "../support/fakes.ts";

const NONCE = `0x${"7e".repeat(32)}` as Hex;
const quoteInput = { sourceNetwork: "eip155:43113", destinationNetwork: "stellar:testnet", amount: "1.25", payTo: MERCHANT };

async function rejects(p: Promise<unknown> | (() => unknown), code: string) {
  await assert.rejects(async () => (typeof p === "function" ? p() : p), (e: unknown) => e instanceof DomainError && e.contract.code === code);
}

/** Every recorded transition must respect the shared tilcai-shared-v1 payment graph. */
function assertSharedGraph(h: ReturnType<typeof harness>, id: string) {
  const evs = h.repo.events(id as never);
  let prev = paymentStateOf("AWAITING_BURN", false);
  let uncertain = false;
  for (const e of evs.slice(1)) {
    if (e.note.startsWith("flagged uncertain")) uncertain = true;
    if (e.to === "SETTLED" || e.to === "FAILED") uncertain = false;
    const next = paymentStateOf(e.to, uncertain);
    assert.ok(prev === next || canTransition("payment", prev, next), `${prev} → ${next}`);
    prev = next;
  }
}

test("quote: exact amounts, forwarder target, preflight", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  assert.equal(q.burnAmountAtomic, 1_250_000n);
  assert.equal(q.destinationAmountAtomic, 12_500_000n);
  assert.equal(q.maxFeeAtomic, 0n);
  assert.equal(q.finality, 2000);
  assert.deepEqual(q.preflight, { payToExists: true, payToTrustline: true, payToAuthorized: true });
  await rejects(h.svc.quote({ ...quoteInput, amount: "1.0000001" }), "INVALID_INPUT");
  await rejects(h.svc.quote({ ...quoteInput, amount: "0" }), "INVALID_INPUT");
  await rejects(h.svc.quote({ ...quoteInput, payTo: "GBAD" }), "INVALID_INPUT");
  await rejects(h.svc.quote({ ...quoteInput, sourceNetwork: "eip155:1" }), "NETWORK_OR_ASSET");
});

test("dev signer happy path: burn → attest → relayer mint → SETTLED with one receipt", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: "key-happy-1", orderId: "order_demo" });
  assert.equal(r.payment.state, "BURN_SUBMITTED");
  h.attest(r.payment.burnTxHash!, NONCE);
  const p = await h.drive(r.payment.id);
  assert.equal(p.state, "SETTLED");
  assert.equal(p.cctpNonce, NONCE);
  assert.equal(h.submitter.submits.length, 1);
  const v = h.svc.view(p.id);
  assert.equal(v.paymentState, "SETTLED");
  const ev = v.receipt!.evidence as any;
  assert.equal(ev.destination.receivedAtomic, "12500000");
  assert.equal(ev.destination.payTo, MERCHANT);
  assert.equal(ev.orderId, "order_demo");
  assert.deepEqual(v.events.map((e) => e.to), ["AWAITING_BURN", "BURN_SUBMITTED", "BURN_CONFIRMED", "ATTESTED", "MINT_SUBMITTED", "SETTLED"]);
  assertSharedGraph(h, p.id);
});

test("external wallet: unsigned calls, idempotent replay, conflict, burn attach once", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  const a = await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-ext-1" });
  assert.equal(a.payment.state, "AWAITING_BURN");
  assert.equal(a.payment.mode, "external");
  assert.equal(a.calls.length, 2);
  const again = await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-ext-1" });
  assert.equal(again.replayed, true);
  assert.equal(again.payment.id, a.payment.id);
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "external", payer: `0x${"2".repeat(40)}`, idempotencyKey: "key-ext-1" }), "IDEMPOTENCY_CONFLICT");
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-ext-2" }), "DUPLICATE");

  const hash = `0x${"c1".repeat(32)}` as Hex;
  h.evm.burns.set(hash, h.evm.minedBurn(h.evm.depositEvent()));
  h.svc.attachBurn(a.payment.id, hash);
  assert.equal(h.svc.attachBurn(a.payment.id, hash).state, "BURN_SUBMITTED", "same hash is idempotent");
  assert.throws(() => h.svc.attachBurn(a.payment.id, `0x${"c2".repeat(32)}`), (e: unknown) => (e as DomainError).contract.code === "INVALID_STATE_TRANSITION");

  // The same burn cannot back a second payment.
  const q2 = await h.svc.quote(quoteInput);
  const b = await h.svc.createPayment({ quoteId: q2.id, mode: "external", payer: PAYER, idempotencyKey: "key-ext-3" });
  assert.throws(() => h.svc.attachBurn(b.payment.id, hash), (e: unknown) => (e as DomainError).contract.code === "DUPLICATE");

  h.attest(hash, NONCE);
  assert.equal((await h.drive(a.payment.id)).state, "SETTLED");
});

test("burn that does not match the quote fails without minting", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  const a = await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-mismatch" });
  const hash = `0x${"d1".repeat(32)}` as Hex;
  h.evm.burns.set(hash, h.evm.minedBurn(h.evm.depositEvent({ amount: 1n, hookData: "0x00" })));
  h.svc.attachBurn(a.payment.id, hash);
  const p = await h.drive(a.payment.id);
  assert.equal(p.state, "FAILED");
  assert.equal(p.failureCode, "BURN_MISMATCH");
  assert.match(p.lastError!, /amount/);
  assert.match(p.lastError!, /hookData/);
  assert.equal(h.submitter.submits.length, 0);
  assertSharedGraph(h, p.id);
});

test("reverted burn fails; unknown burn becomes UNCERTAIN, never FAILED", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  const a = await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-revert" });
  const hash = `0x${"e1".repeat(32)}` as Hex;
  h.evm.burns.set(hash, { kind: "reverted", blockNumber: 9n });
  h.svc.attachBurn(a.payment.id, hash);
  assert.equal((await h.drive(a.payment.id)).failureCode, "BURN_REVERTED");

  const q2 = await h.svc.quote(quoteInput);
  const b = await h.svc.createPayment({ quoteId: q2.id, mode: "external", payer: PAYER, idempotencyKey: "key-ghost" });
  h.svc.attachBurn(b.payment.id, `0x${"e2".repeat(32)}`);
  h.clock.advance(31 * 60_000);
  const p = await h.svc.step(h.svc.mustGet(b.payment.id));
  assert.equal(p.state, "BURN_SUBMITTED");
  assert.equal(p.uncertain, true);
  assert.equal(h.svc.view(p.id).paymentState, "UNCERTAIN");
});

test("attested message that disagrees with the quote is never minted", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: "key-badatt" });
  h.attest(r.payment.burnTxHash!, NONCE, { destinationDomain: 6 });
  const p = await h.drive(r.payment.id, 4);
  assert.equal(p.state, "BURN_CONFIRMED");
  assert.equal(p.uncertain, true);
  assert.match(p.lastError!, /ATTESTATION_MISMATCH/);
  assert.equal(h.submitter.submits.length, 0);
});

test("rejected mint submit is retried with backoff, then settles once", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: "key-outage" });
  h.attest(r.payment.burnTxHash!, NONCE);
  h.submitter.failNextSubmit = "rejected";
  await h.svc.step(h.svc.mustGet(r.payment.id)); // → BURN_CONFIRMED
  await h.svc.step(h.svc.mustGet(r.payment.id)); // → ATTESTED
  const failed = await h.svc.step(h.svc.mustGet(r.payment.id)); // submit throws
  assert.equal(failed.state, "ATTESTED");
  assert.equal(failed.attempts, 1);
  assert.match(failed.lastError!, /MINT_SUBMIT_FAILED/);
  assert.equal(failed.mintRequestedAt, null, "nothing was sent: no in-flight guard");
  const p = await h.drive(r.payment.id);
  assert.equal(p.state, "SETTLED");
  assert.equal(h.submitter.submits.length, 1);
});

test("ambiguous mint submit (timeout) waits out the in-flight guard before re-submitting", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: "key-timeout" });
  h.attest(r.payment.burnTxHash!, NONCE);
  h.submitter.failNextSubmit = "ambiguous";
  let p = await h.svc.step(h.svc.mustGet(r.payment.id));
  p = await h.svc.step(p);
  p = await h.svc.step(p);
  assert.equal(p.state, "ATTESTED");
  assert.ok(p.mintRequestedAt, "request may be in flight");
  h.clock.advance(5_000);
  p = await h.svc.step(h.svc.mustGet(p.id));
  assert.equal(h.submitter.submits.length, 0, "inside guard window");
  h.clock.advance(60_000);
  p = await h.drive(p.id);
  assert.equal(p.state, "SETTLED");
  assert.equal(h.submitter.submits.length, 1);
});

test("nonce already used (earlier submission landed) settles without a new mint", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: "key-used" });
  h.attest(r.payment.burnTxHash!, NONCE);
  h.stellar.usedNonces.add(NONCE);
  const p = await h.drive(r.payment.id);
  assert.equal(p.state, "SETTLED");
  assert.equal(h.submitter.submits.length, 0);
  assert.ok(h.svc.view(p.id).receipt);
});

test("failed mint with unused nonce goes back to ATTESTED and is re-submitted", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: "key-remint" });
  h.attest(r.payment.burnTxHash!, NONCE);
  h.submitter.autoConfirm = false;
  let p = r.payment;
  for (let i = 0; i < 3; i++) p = await h.svc.step(h.svc.mustGet(p.id));
  assert.equal(p.state, "MINT_SUBMITTED");
  h.submitter.statuses.set("tx-1", { state: "failed", reason: "simulation failed" });
  p = await h.svc.step(h.svc.mustGet(p.id));
  assert.equal(p.state, "ATTESTED");
  h.submitter.autoConfirm = true;
  p = await h.drive(p.id);
  assert.equal(p.state, "SETTLED");
  assert.equal(h.submitter.submits.length, 2);
  assertSharedGraph(h, p.id);
});

test("crash after mint request: guard waits, then nonce check avoids a duplicate", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: "key-crash" });
  h.attest(r.payment.burnTxHash!, NONCE);
  let p = await h.svc.step(h.svc.mustGet(r.payment.id));
  p = await h.svc.step(p);
  assert.equal(p.state, "ATTESTED");
  // Simulate: request recorded, call reached the relayer, process died before persisting MINT_SUBMITTED.
  p = h.repo.update({ ...p, mintRequestedAt: h.clock.now().toISOString() }, p.version);
  p = await h.svc.step(p);
  assert.equal(h.submitter.submits.length, 0, "guard window: no immediate re-submit");
  h.stellar.usedNonces.add(NONCE); // the lost submission landed
  h.clock.advance(61_000);
  p = await h.svc.step(h.svc.mustGet(p.id));
  assert.equal(p.state, "SETTLED");
  assert.equal(h.submitter.submits.length, 0);
});

test("expired quote, recipient without trustline and disabled dev signer are refused", async () => {
  const h = harness();
  const q = await h.svc.quote(quoteInput);
  h.clock.advance(601_000);
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-expired" }), "QUOTE_EXPIRED");

  const q2 = await h.svc.quote(quoteInput);
  h.stellar.accounts.set(MERCHANT, { exists: true, trustline: false, authorized: false, usdcBalanceAtomic: 0n });
  await rejects(h.svc.createPayment({ quoteId: q2.id, mode: "external", payer: PAYER, idempotencyKey: "key-trust" }), "RECIPIENT");

  h.stellar.accounts.delete(MERCHANT);
  h.evm.dev = null;
  await rejects(h.svc.createPayment({ quoteId: q2.id, mode: "dev_signer", idempotencyKey: "key-nodev" }), "FORBIDDEN");
  await rejects(h.svc.createPayment({ quoteId: q2.id, mode: "external", payer: "0x12", idempotencyKey: "key-badpayer" }), "INVALID_INPUT");
});

// ── Gasless source leg: payer signs EIP-3009, the OZ Relayer pays the gas ───────────────────────

import { SIGNER, OTHER_SIGNER, ROUTER } from "../support/fakes.ts";
import { authorizationNonce, paymentIdBytes32, routeOf } from "../../src/modules/crosschain/router.ts";
import { parseSignature, recoverTypedDataAddress } from "viem";

async function gaslessSetup(mode: "dev_gasless" | "gasless", key: string) {
  const h = harness();
  h.evm.dev = SIGNER.address;
  const q = await h.svc.quote(quoteInput);
  h.evm.lastBurn = { amount: q.burnAmountAtomic, maxFee: q.maxFeeAtomic, target: q.target, finality: q.finality };
  const r = await h.svc.createPayment({ quoteId: q.id, mode, ...(mode === "gasless" ? { payer: SIGNER.address } : {}), idempotencyKey: key });
  return { h, q, r };
}

const splitSig = (signature: Hex) => {
  const s = parseSignature(signature);
  return { v: Number(s.v ?? BigInt(27 + (s.yParity ?? 0))), r: s.r, s: s.s };
};

test("dev_gasless: payer pays no gas; relayer sends the burn and the mint; ends SETTLED", async () => {
  const { h, r } = await gaslessSetup("dev_gasless", "key-gasless-1");
  assert.equal(r.payment.state, "AWAITING_BURN");
  assert.ok(r.payment.burnSubmissionId, "relayer accepted the burn");
  assert.equal(h.evmSubmitter.submits.length, 1);
  assert.equal(h.evmSubmitter.submits[0]!.to.toLowerCase(), ROUTER.toLowerCase());
  assert.equal(h.evm.counter, 0, "backend never broadcast a burn itself");
  let p = await h.svc.step(h.svc.mustGet(r.payment.id));
  assert.equal(p.state, "BURN_SUBMITTED");
  h.attest(p.burnTxHash!, NONCE, {}, true);
  p = await h.drive(p.id);
  assert.equal(p.state, "SETTLED");
  assert.equal(h.submitter.submits.length, 1);
  const ev = h.svc.view(p.id).receipt!.evidence as any;
  assert.equal(ev.source.payer.toLowerCase(), SIGNER.address.toLowerCase());
  assertSharedGraph(h, p.id);
});

test("gasless external payer: typed data, signature checked off-chain, replay safe", async () => {
  const { h, r } = await gaslessSetup("gasless", "key-gasless-2");
  const auth = r.authorization!;
  assert.equal(r.calls.length, 0);
  assert.equal(auth.router, ROUTER);
  // The nonce commits to payment, amount and the full CCTP route.
  const q = h.svc.getQuote(r.payment.quoteId);
  assert.equal(auth.nonce, authorizationNonce(paymentIdBytes32(r.payment.id), q.burnAmountAtomic, routeOf(27, q.target, q.maxFeeAtomic, q.finality)));
  const again = await h.svc.createPayment({ quoteId: q.id, mode: "gasless", payer: SIGNER.address, idempotencyKey: "key-gasless-2" });
  assert.equal(again.authorization!.nonce, auth.nonce);
  assert.equal(again.authorization!.validBefore, auth.validBefore);

  const bad = splitSig(await OTHER_SIGNER.signTypedData(auth.typedData as never));
  await rejects(h.svc.submitAuthorization(r.payment.id, bad), "APPROVAL_INVALID");
  assert.equal(h.evmSubmitter.submits.length, 0, "a forged signature never reaches the relayer");

  const good = splitSig(await SIGNER.signTypedData(auth.typedData as never));
  const p = await h.svc.submitAuthorization(r.payment.id, good);
  assert.ok(p.burnSubmissionId);
  assert.equal((await h.svc.submitAuthorization(r.payment.id, good)).burnSubmissionId, p.burnSubmissionId, "same signature is idempotent");
  assert.equal(h.evmSubmitter.submits.length, 1);
  await rejects(h.svc.submitAuthorization(r.payment.id, splitSig(await SIGNER.signTypedData({ ...auth.typedData, message: { ...auth.typedData.message, validBefore: 1n } } as never))), "INVALID_STATE_TRANSITION");

  // The signature the relayer submits recovers to the payer for exactly this message.
  const sig = `0x${good.r.slice(2)}${good.s.slice(2)}${good.v.toString(16)}` as Hex;
  assert.equal(await recoverTypedDataAddress({ ...auth.typedData, signature: sig } as never), SIGNER.address);
});

test("gasless: relayer rejection is retried while the authorization is valid, then FAILED after expiry", async () => {
  const { h, r } = await gaslessSetup("gasless", "key-gasless-3");
  const sig = splitSig(await SIGNER.signTypedData(r.authorization!.typedData as never));
  h.evmSubmitter.failNextSubmit = "rejected";
  let p = await h.svc.submitAuthorization(r.payment.id, sig);
  assert.equal(p.burnSubmissionId, null);
  assert.match(p.lastError!, /BURN_SUBMIT_FAILED/);
  p = await h.drive(p.id, 3);
  assert.ok(p.burnSubmissionId || p.state === "BURN_SUBMITTED", "resubmitted with the same signed authorization");
  assert.equal(h.evmSubmitter.submits.length, 1);

  // Second payment: relayer never lands it and the authorization expires unused.
  const q2 = await h.svc.quote(quoteInput);
  const r2 = await h.svc.createPayment({ quoteId: q2.id, mode: "gasless", payer: SIGNER.address, idempotencyKey: "key-gasless-4" });
  h.evmSubmitter.autoConfirm = false;
  await h.svc.submitAuthorization(r2.payment.id, splitSig(await SIGNER.signTypedData(r2.authorization!.typedData as never)));
  h.evmSubmitter.statuses.set("evm-2", { state: "failed", reason: "expired" });
  h.clock.advance(11 * 60_000);
  const failed = await h.drive(r2.payment.id, 4);
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.failureCode, "BURN_NOT_EXECUTED");
});

test("gasless: router event for another payer fails the burn; authorization consumed without a hash is UNCERTAIN", async () => {
  const { h, r } = await gaslessSetup("dev_gasless", "key-gasless-5");
  h.evmSubmitter.statuses.clear();
  const data = h.evmSubmitter.submits[0]!.data;
  h.evmSubmitter.land(r.payment.burnSubmissionId!, data, { payer: OTHER_SIGNER.address });
  const p = await h.drive(r.payment.id);
  assert.equal(p.state, "FAILED");
  assert.equal(p.failureCode, "BURN_MISMATCH");
  assert.match(p.lastError!, /payer/);

  const g = await gaslessSetup("gasless", "key-gasless-6");
  await g.h.svc.submitAuthorization(g.r.payment.id, splitSig(await SIGNER.signTypedData(g.r.authorization!.typedData as never)));
  g.h.evmSubmitter.statuses.set("evm-1", { state: "failed", reason: "dropped" });
  g.h.evm.authUsed.add(g.r.authorization!.nonce.toLowerCase());
  const u = await g.h.svc.step(g.h.svc.mustGet(g.r.payment.id));
  assert.equal(u.uncertain, true);
  assert.match(u.lastError!, /AUTHORIZATION_USED_HASH_UNKNOWN/);
});

test("gasless modes are refused when the router is not configured", async () => {
  const h = harness();
  h.evm.routerAddr = null;
  const q = await h.svc.quote(quoteInput);
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "gasless", payer: PAYER, idempotencyKey: "key-nogasless" }), "SERVICE_UNAVAILABLE");
});
