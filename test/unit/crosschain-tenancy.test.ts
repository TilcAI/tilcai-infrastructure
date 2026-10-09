import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../src/shared/errors.ts";
import type { Hex } from "../../src/shared/hex.ts";
import { LEGACY_TENANT_ID } from "../../src/modules/tenants/ports.ts";
import { SqliteTenantRegistry } from "../../src/modules/tenants/registry.ts";
import { harness, MERCHANT, PAYER } from "../support/fakes.ts";

const NONCE = `0x${"7e".repeat(32)}` as Hex;
const quoteInput = { sourceNetwork: "eip155:43113", destinationNetwork: "stellar:testnet", amount: "1.25", payTo: MERCHANT };

async function rejects(p: Promise<unknown> | (() => unknown), code: string) {
  await assert.rejects(async () => (typeof p === "function" ? p() : p), (e: unknown) => e instanceof DomainError && e.contract.code === code);
}

async function twoTenants() {
  const h = harness();
  const reg = new SqliteTenantRegistry(h.db, h.clock);
  const a = await reg.createTenant({ name: "Optus" });
  const b = await reg.createTenant({ name: "Other" });
  return { h, a: a.id, b: b.id };
}

/** The worker side: it works on the payment row itself, not on a request, so it needs no tenant. */
async function drive(h: ReturnType<typeof harness>, id: string) {
  for (let i = 0; i < 12; i++) {
    const p = h.repo.getPayment(id as never)!;
    if (p.state === "SETTLED" || p.state === "FAILED") return p;
    h.clock.advance(Math.max(0, Date.parse(p.nextCheckAt) - h.clock.t) + 1);
    await h.svc.step(h.repo.getPayment(id as never)!);
  }
  return h.repo.getPayment(id as never)!;
}

test("a quote belongs to the tenant that asked for it", async () => {
  const { h, a, b } = await twoTenants();
  const q = await h.svc.quote({ ...quoteInput, tenantId: a });
  assert.equal(q.tenantId, a);
  assert.equal(h.svc.getQuote(q.id, a).id, q.id);
  await rejects(() => h.svc.getQuote(q.id, b), "NOT_FOUND");
  await rejects(() => h.svc.getQuote(q.id), "NOT_FOUND"); // no tenant means the legacy tenant, and it is not the owner
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-steal-1", tenantId: b }), "NOT_FOUND");
  assert.equal(h.repo.getByIdempotencyKey("key-steal-1", b), undefined, "the refused request left nothing behind");
  const legacyQuote = await h.svc.quote(quoteInput);
  assert.equal(legacyQuote.tenantId, LEGACY_TENANT_ID, "without a tenant, a quote is the legacy tenant's, as before");
  await rejects(() => h.svc.getQuote(legacyQuote.id, a), "NOT_FOUND");
});

test("a payment of one tenant cannot be seen, reported on or authorised by another tenant, nor by the legacy one", async () => {
  const { h, a, b } = await twoTenants();
  const q = await h.svc.quote({ ...quoteInput, tenantId: a });
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-owner-1", tenantId: a });
  const id = r.payment.id;
  assert.equal(r.payment.tenantId, a);
  assert.equal(h.svc.view(id, a).payment.id, id);

  for (const intruder of [b, LEGACY_TENANT_ID, undefined]) {
    await rejects(() => h.svc.view(id, intruder as never), "NOT_FOUND");
    await rejects(() => h.svc.mustGet(id, intruder as never), "NOT_FOUND");
    await rejects(() => h.svc.attachBurn(id, `0x${"ab".repeat(32)}`, intruder as never), "NOT_FOUND");
    await rejects(h.svc.submitAuthorization(id, { v: 27, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` }, intruder as never), "NOT_FOUND");
  }
  assert.equal(h.repo.getPayment(id)!.state, "AWAITING_BURN", "none of that changed the payment");
  const same = h.svc.attachBurn(id, `0x${"ab".repeat(32)}`, a);
  assert.equal(same.state, "BURN_SUBMITTED", "its owner can");
  // The same answer for "not yours" and "does not exist", so ids cannot be probed.
  await rejects(() => h.svc.view("payment_attempt_00000000-0000-0000-0000-000000000000", b), "NOT_FOUND");
});

test("idempotency keys are per tenant: two tenants can use the same key and never meet", async () => {
  const { h, a, b } = await twoTenants();
  const qa = await h.svc.quote({ ...quoteInput, tenantId: a });
  const qb = await h.svc.quote({ ...quoteInput, tenantId: b });
  const KEY = "order-1001-retry";
  const pa = await h.svc.createPayment({ quoteId: qa.id, mode: "external", payer: PAYER, idempotencyKey: KEY, tenantId: a });
  const pb = await h.svc.createPayment({ quoteId: qb.id, mode: "external", payer: PAYER, idempotencyKey: KEY, tenantId: b });
  assert.notEqual(pa.payment.id, pb.payment.id, "same key, different tenants, different payments");
  assert.equal(pa.replayed, false);
  assert.equal(pb.replayed, false);

  const again = await h.svc.createPayment({ quoteId: qa.id, mode: "external", payer: PAYER, idempotencyKey: KEY, tenantId: a });
  assert.equal(again.replayed, true);
  assert.equal(again.payment.id, pa.payment.id, "a replay by the same tenant finds its own payment");
  assert.equal(again.payment.idempotencyKey, KEY, "the key is returned as the client sent it");
  const againB = await h.svc.createPayment({ quoteId: qb.id, mode: "external", payer: PAYER, idempotencyKey: KEY, tenantId: b });
  assert.equal(againB.payment.id, pb.payment.id);

  const other = await h.svc.quote({ ...quoteInput, amount: "2", tenantId: a });
  await rejects(h.svc.createPayment({ quoteId: other.id, mode: "external", payer: PAYER, idempotencyKey: KEY, tenantId: a }), "IDEMPOTENCY_CONFLICT");

  const stored = (h.db.prepare("SELECT tenant_id, idempotency_key FROM crosschain_payments ORDER BY created_at, id").all() as Array<{ tenant_id: string; idempotency_key: string }>).map((r) => ({ ...r }));
  assert.deepEqual(stored.map((r) => r.idempotency_key).sort(), [`${a}:${KEY}`, `${b}:${KEY}`].sort(), "tenant keys are stored namespaced");
});

test("the legacy tenant's keys are stored as sent, so replays from before tenants still work", async () => {
  const { h } = await twoTenants();
  const q = await h.svc.quote(quoteInput);
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "legacy-key-1" });
  assert.equal(r.payment.tenantId, LEGACY_TENANT_ID);
  assert.equal((h.db.prepare("SELECT idempotency_key FROM crosschain_payments WHERE id = ?").get(r.payment.id) as any).idempotency_key, "legacy-key-1");
  const replay = await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "legacy-key-1" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.payment.id, r.payment.id);
});

test("a tenant's payment goes all the way to SETTLED with its receipt, and stays invisible to the others", async () => {
  const { h, a, b } = await twoTenants();
  const q = await h.svc.quote({ ...quoteInput, tenantId: a });
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "dev_signer", idempotencyKey: "key-e2e-1", orderId: "order_optus_1", tenantId: a });
  h.attest(r.payment.burnTxHash!, NONCE);
  const done = await drive(h, r.payment.id);
  assert.equal(done.state, "SETTLED");
  assert.equal(done.tenantId, a, "the tenant never changes along the way");
  const v = h.svc.view(done.id, a);
  assert.ok(v.receipt, "the receipt exists");
  assert.equal((v.receipt!.evidence as any).orderId, "order_optus_1");
  await rejects(() => h.svc.view(done.id, b), "NOT_FOUND");
  assert.equal(h.svc.mustGet(done.id, a).tenantId, a);
});

test("one quote, one payment still holds across tenants: nobody else can spend it, and its owner only once", async () => {
  const { h, a, b } = await twoTenants();
  const q = await h.svc.quote({ ...quoteInput, tenantId: a });
  await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-first-01", tenantId: a });
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-second-1", tenantId: a }), "DUPLICATE");
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-third-01", tenantId: b }), "NOT_FOUND");
});

test("a payment's tenant cannot be rewritten, not even from the database", async () => {
  const { h, a, b } = await twoTenants();
  const q = await h.svc.quote({ ...quoteInput, tenantId: a });
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "external", payer: PAYER, idempotencyKey: "key-immut-01", tenantId: a });
  assert.throws(() => h.db.prepare("UPDATE crosschain_payments SET tenant_id = ? WHERE id = ?").run(b, r.payment.id), /immutable/);
  assert.throws(() => h.db.prepare("UPDATE route_quotes SET tenant_id = ? WHERE id = ?").run(b, q.id), /immutable/);
  assert.equal(h.repo.getPayment(r.payment.id)!.tenantId, a);
});
