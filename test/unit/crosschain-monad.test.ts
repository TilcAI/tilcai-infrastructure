import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../../src/config/env.ts";
import { MONAD_TESTNET, networks } from "../../src/config/networks.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import { silentLogger } from "../../src/shared/log.ts";
import { DomainError } from "../../src/shared/errors.ts";
import type { Hex } from "../../src/shared/hex.ts";
import { SqliteCrosschainRepository } from "../../src/modules/crosschain/repository.ts";
import { CrosschainPaymentService } from "../../src/modules/crosschain/service.ts";
import { encodeMessageV2, FakeClock, FakeEvm, FakeEvmSubmitter, FakeIris, FakeStellar, FakeSubmitter, MERCHANT, PAYER, ROUTER, SIGNER } from "../support/fakes.ts";
import { bytesToHex, hexToBytes } from "../../src/shared/hex.ts";

const MONAD_ROUTER = `0x${"77".repeat(20)}` as Hex;
const NONCE = `0x${"5a".repeat(32)}` as Hex;
const env = loadEnv({ CCTP_ROUTER_MONAD_TESTNET: MONAD_ROUTER });
const nets = networks(env);

/** Fuji is the primary source (as in production); Monad Testnet is the extra one, with its own adapters. */
function monadHarness() {
  const clock = new FakeClock();
  const db = openDatabase(":memory:");
  const fujiEvm = new FakeEvm();
  const monadEvm = new FakeEvm();
  monadEvm.routerAddr = MONAD_ROUTER;
  fujiEvm.dev = SIGNER.address;
  monadEvm.dev = SIGNER.address;
  const fujiSubmitter = new FakeEvmSubmitter(fujiEvm);
  const monadSubmitter = new FakeEvmSubmitter(monadEvm);
  const stellar = new FakeStellar();
  const iris = new FakeIris();
  const mint = new FakeSubmitter(stellar, (m) => bytesToHex(hexToBytes(m).subarray(12, 44)));
  const svc = new CrosschainPaymentService({
    repo: new SqliteCrosschainRepository(db),
    evm: fujiEvm,
    evmSubmitter: fujiSubmitter,
    stellar,
    iris,
    submitters: { relayer: mint },
    activeSubmitter: "relayer",
    source: { ...nets.avalancheFuji, cctpRouter: ROUTER },
    extraSources: [{ network: nets.monadTestnet, evm: monadEvm, evmSubmitter: monadSubmitter }],
    destination: nets.stellarTestnet,
    clock,
    log: silentLogger,
    options: { quoteTtlSeconds: 600, pollMs: 1000, minConfirmations: 1 },
  });
  return { svc, clock, fujiEvm, monadEvm, fujiSubmitter, monadSubmitter, iris, mint, stellar };
}

const quoteInput = { sourceNetwork: "eip155:10143", destinationNetwork: "stellar:testnet", amount: "1.25", payTo: MERCHANT };

test("Monad Testnet is a registered EVM network with Circle's values, in the testnet environment", () => {
  const m = nets.monadTestnet;
  assert.equal(m.id, "eip155:10143");
  assert.equal(m.chainId, 10143);
  assert.equal(m.cctpDomain, 15);
  assert.equal(m.nativeSymbol, "MON");
  assert.equal(m.usdc.address, MONAD_TESTNET.usdc);
  assert.equal(m.usdc.eip712Name, "USDC", "the token's EIP-712 domain name is not Fuji's `USD Coin`");
  assert.equal(m.maxLogRange, 100);
  assert.equal(m.cctpRouter, MONAD_ROUTER);
  assert.deepEqual(nets.evm.map((n) => n.id), ["eip155:43113", "eip155:10143"]);
  assert.equal(nets.byId("eip155:10143"), m);
  assert.equal(nets.avalanche.id, "eip155:43113", "Avalanche stays the primary source");
});

test("a quote can start on Monad Testnet and carries its domain and USDC", async () => {
  const h = monadHarness();
  const q = await h.svc.quote(quoteInput);
  assert.equal(q.sourceNetwork, "eip155:10143");
  assert.equal(q.sourceDomain, 15);
  assert.equal(q.destinationDomain, 27);
  assert.equal(q.burnToken, MONAD_TESTNET.usdc);
  const fuji = await h.svc.quote({ ...quoteInput, sourceNetwork: "eip155:43113" });
  assert.equal(fuji.sourceDomain, 1, "the Fuji route is unchanged");
  await assert.rejects(h.svc.quote({ ...quoteInput, sourceNetwork: "eip155:84532" }), (e: unknown) => e instanceof DomainError && e.contract.code === "NETWORK_OR_ASSET");
});

test("external mode builds the burn calls with Monad's adapter, never Fuji's", async () => {
  const h = monadHarness();
  const q = await h.svc.quote(quoteInput);
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "monad-external-1" });
  assert.equal(r.calls.length, 2);
  assert.ok(h.monadEvm.lastBurn, "Monad's adapter built the calls");
  assert.equal(h.fujiEvm.lastBurn, null);
  const again = await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "monad-external-1" });
  assert.equal(again.replayed, true);
});

test("gasless: the typed data is Monad's (chain, token domain, router) and the burn goes through Monad's relayer", async () => {
  const h = monadHarness();
  const q = await h.svc.quote(quoteInput);
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_gasless", idempotencyKey: "monad-gasless-1" });
  const typed = r.authorization!.typedData;
  assert.equal(typed.domain.chainId, 10143);
  assert.equal(typed.domain.name, "USDC");
  assert.equal(typed.domain.version, "2");
  assert.equal(typed.domain.verifyingContract.toLowerCase(), MONAD_TESTNET.usdc.toLowerCase());
  assert.equal(r.authorization!.router, MONAD_ROUTER);
  assert.equal(typed.message.to.toLowerCase(), MONAD_ROUTER.toLowerCase());
  assert.equal(h.monadSubmitter.submits.length, 1);
  assert.equal(h.monadSubmitter.submits[0]!.to, MONAD_ROUTER);
  assert.equal(h.fujiSubmitter.submits.length, 0, "Fuji's relayer sent nothing");
  assert.equal(r.payment.payer, SIGNER.address);

  // The burn mined on Monad is verified against the quote and settles on Stellar.
  const mined = [...h.monadEvm.burns.entries()][0]!;
  const burn = mined[1];
  assert.equal(burn.kind, "mined");
  if (burn.kind !== "mined") return;
  // The shared fake relayer mines against Fuji's constants; re-point the burn at Monad's.
  burn.burns[0]!.burnToken = MONAD_TESTNET.usdc;
  burn.burns[0]!.depositor = MONAD_ROUTER;
  burn.to = MONAD_ROUTER;
  const message = encodeMessageV2({
    sourceDomain: 15,
    destinationDomain: 27,
    nonce: NONCE,
    destinationCaller: q.target.destinationCaller,
    burnToken: MONAD_TESTNET.usdc,
    mintRecipient: q.target.mintRecipient,
    amount: q.burnAmountAtomic,
    messageSender: MONAD_ROUTER,
    maxFee: q.maxFeeAtomic,
    feeExecuted: 0n,
    hookData: q.target.hookData,
  });
  h.iris.messages.set(mined[0].toLowerCase(), { kind: "complete", message: { message, attestation: `0x${"cd".repeat(65)}`, eventNonce: NONCE, cctpVersion: 2, status: "complete" } });
  let p = h.svc.mustGet(r.payment.id);
  for (let i = 0; i < 12 && p.state !== "SETTLED" && p.state !== "FAILED"; i++) {
    h.clock.advance(Math.max(0, Date.parse(p.nextCheckAt) - h.clock.t) + 1);
    p = await h.svc.step(h.svc.mustGet(r.payment.id));
  }
  assert.equal(p.state, "SETTLED", p.lastError ?? p.failureCode ?? "");
  const v = h.svc.view(r.payment.id);
  assert.match(v.links.burn!, /^https:\/\/testnet\.monadscan\.com\/tx\//);
  assert.equal((v.receipt!.evidence as { source: { network: string } }).source.network, "eip155:10143");
});

test("a network without its router or accounts refuses those modes by name, while Fuji keeps working", async () => {
  const h = monadHarness();
  h.monadEvm.routerAddr = null;
  const q = await h.svc.quote(quoteInput);
  await assert.rejects(
    h.svc.createPayment({ quoteId: q.id, mode: "dev_gasless", idempotencyKey: "monad-nogasless-1" }),
    (e: unknown) => e instanceof DomainError && e.contract.code === "SERVICE_UNAVAILABLE" && String(e.detail).includes("eip155:10143"),
  );
  await assert.rejects(
    h.svc.createPayment({ quoteId: q.id, mode: "account", payer: PAYER, idempotencyKey: "monad-noaccount-1" }),
    (e: unknown) => e instanceof DomainError && e.contract.code === "SERVICE_UNAVAILABLE",
  );
  const fuji = await h.svc.quote({ ...quoteInput, sourceNetwork: "eip155:43113" });
  const ok = await h.svc.createPayment({ quoteId: fuji.id, mode: "dev_gasless", idempotencyKey: "fuji-gasless-1" });
  assert.equal(ok.authorization!.router, ROUTER);
  assert.equal(h.fujiSubmitter.submits.length, 1);
});
