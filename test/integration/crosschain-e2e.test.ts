// Real Avalanche Fuji → Stellar Testnet USDC payment. Moves TESTNET funds.
// Requires DEV_EVM_PAYER_PRIVATE_KEY (Fuji USDC + AVAX), XPAY_PAY_TO (G… with USDC trustline)
// and a configured mint submitter (RELAYER_API_KEY or STELLAR_OPERATOR_SECRET).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAppContext } from "../../src/app-context.ts";

const payTo = process.env.XPAY_PAY_TO ?? "";
const skip = process.env.DEV_EVM_PAYER_PRIVATE_KEY && payTo ? false : "DEV_EVM_PAYER_PRIVATE_KEY / XPAY_PAY_TO not set";

test("dev signer pays a Stellar merchant in USDC from Avalanche Fuji", { skip, timeout: 15 * 60_000 }, async () => {
  const ctx = createAppContext("e2e");
  const svc = ctx.crosschain;
  const q = await svc.quote({ sourceNetwork: "eip155:43113", destinationNetwork: "stellar:testnet", amount: process.env.XPAY_AMOUNT ?? "0.1", payTo });
  assert.equal(q.preflight.payToTrustline, true, "payTo needs a USDC trustline");
  const r = await svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: randomUUID() });
  let p = r.payment;
  const deadline = Date.now() + 14 * 60_000;
  while (p.state !== "SETTLED" && p.state !== "FAILED" && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 4000));
    p = await svc.step(svc.mustGet(p.id));
  }
  const v = svc.view(p.id);
  console.log(JSON.stringify({ state: p.state, links: v.links, receipt: v.receipt }, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
  assert.equal(p.state, "SETTLED");
  ctx.db.close();
});
