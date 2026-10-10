/**
 * Active Avalanche → Stellar USDC payment, end to end, in-process.
 *
 *   npm run xpay -- --amount 0.5 --to G…                  # dev signer (DEV_EVM_PAYER_PRIVATE_KEY) burns, pays AVAX
 *   npm run xpay -- --amount 0.5 --to G… --gasless        # dev key signs EIP-3009; the OZ Relayer pays all gas
 *   npm run xpay -- --amount 0.5 --to G… --payer 0x…      # external wallet: prints the unsigned calls
 *   npm run xpay -- --payment payment_attempt_… --burn 0x…  # attach an external burn and follow it
 *   npm run xpay -- --payment payment_attempt_…             # follow until SETTLED/FAILED
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { createAppContext } from "../../app-context.ts";

const { values: a } = parseArgs({
  options: {
    amount: { type: "string" },
    to: { type: "string" },
    payer: { type: "string" },
    order: { type: "string" },
    gasless: { type: "boolean", default: false },
    payment: { type: "string" },
    burn: { type: "string" },
    timeout: { type: "string", default: "900" },
  },
});

const ctx = createAppContext("xpay");
const svc = ctx.crosschain;
const out = (o: unknown) => console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

let paymentId = a.payment;
if (!paymentId) {
  if (!a.amount || !a.to) throw new Error("--amount and --to are required (or --payment to follow one)");
  const q = await svc.quote({ sourceNetwork: ctx.nets.avalanche.id, destinationNetwork: ctx.nets.stellar.id, amount: a.amount, payTo: a.to });
  console.log(`quote ${q.id}: burn ${q.burnAmountAtomic} (6 dec) on ${ctx.nets.avalanche.name} → ${q.destinationAmountAtomic} (7 dec) on ${ctx.nets.stellar.name} to ${q.payTo}`);
  console.log(`preflight ${JSON.stringify(q.preflight)}`);
  const mode = a.gasless ? (a.payer ? "gasless" : "dev_gasless") : a.payer ? "external" : "dev_signer";
  const r = await svc.createPayment({ quoteId: q.id, mode, ...(a.payer ? { payer: a.payer } : {}), ...(a.order ? { orderId: a.order } : {}), idempotencyKey: randomUUID() });
  paymentId = r.payment.id;
  console.log(`payment ${paymentId} → ${r.payment.state}`);
  if (mode === "gasless") {
    console.log("Sign this typed data (eth_signTypedData_v4) and POST it to /v1/crosschain/payments/:id/authorization:");
    out(r.authorization?.typedData);
    ctx.db.close();
    process.exit(0);
  }
  if (mode === "external") {
    console.log("Sign and broadcast these calls from the payer wallet, then run with --payment and --burn:");
    out(r.calls);
    ctx.db.close();
    process.exit(0);
  }
}
if (a.burn) svc.attachBurn(paymentId, a.burn);

const deadline = Date.now() + Number(a.timeout) * 1000;
let last = "";
for (;;) {
  const p = await svc.step(svc.mustGet(paymentId));
  const tag = `${p.state}${p.uncertain ? " (uncertain)" : ""}${p.lastError ? ` · ${p.lastError}` : ""}`;
  if (tag !== last) console.log(`[${new Date().toISOString().slice(11, 19)}] ${tag}`);
  last = tag;
  if (p.state === "SETTLED" || p.state === "FAILED") break;
  if (Date.now() > deadline) {
    console.log("timeout: the worker will keep reconciling this payment");
    break;
  }
  const wait = Math.max(1000, Date.parse(p.nextCheckAt) - Date.now());
  await new Promise((r) => setTimeout(r, Math.min(wait, 15_000)));
}
const v = svc.view(paymentId);
out({ state: v.payment.state, paymentState: v.paymentState, links: v.links, amounts: v.amounts, receipt: v.receipt });
ctx.db.close();
