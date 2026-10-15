import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TenantId } from "../tenants/ports.ts";
import { centsToAmount } from "../qrsimple/domain.ts";
import { CollectionError, type Attempt, type Collection } from "./domain.ts";
import { AtcProvider } from "./providers/atc.ts";
import type { QrCollectionService } from "./service.ts";
import type { QrSimpleMock } from "../qrsimple/service.ts";

export const QR_WEBHOOK_PREFIX = "/v1/qr/webhooks/";

const safeEqual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const CreateBody = z.strictObject({
  /** Decimal bolivianos, at most 2 decimals: "10.50". */
  amount: z.union([z.string().max(20), z.number()]),
  description: z.string().max(200),
  /** The caller's order id: asking twice with the same one returns the same QR. */
  reference: z.string().min(1).max(100).optional(),
  expires_in_seconds: z.number().int().optional(),
  single_use: z.boolean().optional(),
  modify_amount: z.boolean().optional(),
  /** Diagnostics: skip the fallback and use exactly this provider. */
  provider: z.enum(["baneco", "atc-simple", "atc-mld", "mock"]).optional(),
});

const SimulateBody = z.strictObject({ amount: z.union([z.string().max(20), z.number()]).optional(), payer_name: z.string().max(80).optional(), payer_bank: z.string().max(80).optional() });

export function collectionJson(c: Collection, o: { withImage: boolean }) {
  return {
    id: c.id,
    reference: c.reference,
    status: c.status,
    status_message: c.statusMessage,
    provider: c.provider,
    provider_ref: c.providerRef,
    amount: centsToAmount(c.amountCents),
    currency: c.currency,
    description: c.description,
    single_use: c.singleUse,
    modify_amount: c.modifyAmount,
    expires_at: c.expiresAt,
    ...(o.withImage ? { qr_image: c.imageBase64 } : {}),
    payment:
      c.status === "PAID"
        ? { amount: centsToAmount(c.paidAmountCents ?? c.amountCents), paid_at: c.paidAt, payer_name: c.payerName, payer_bank: c.payerBank, payer_account: c.payerAccount, bank_reference: c.bankReference }
        : null,
    attempts: c.attempts,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

/**
 * QR collection gateway over HTTP.
 *
 *   POST /v1/qr                       issue a QR (principal provider, then the fallbacks)
 *   GET  /v1/qr/:id                   state, refreshed from the issuing provider
 *   GET  /v1/qr                       latest QRs of the tenant
 *   POST /v1/qr/:id/cancel            cancel where the provider supports it (Baneco)
 *   GET  /v1/qr/providers             order, configuration and breaker state (operator)
 *   POST /v1/qr/:id/simulate-payment  mock mode only: pay it as a bank app would (operator)
 *   POST /v1/qr/webhooks/atc          ATC's payment confirmation (header secret)
 *   POST /v1/qr/webhooks/baneco       Banco Económico's notifyPaymentQR (?key=secret)
 *
 * The first routes use the TilcAI API keys; the webhooks authenticate with their own secret and are
 * only a hint: the payment is confirmed by asking the provider that issued the QR.
 */
export function registerQrCollectRoutes(
  app: FastifyInstance,
  o: {
    service: QrCollectionService;
    tenantOf: (req: FastifyRequest) => TenantId;
    webhook: { header: string; secret: string };
    mock: QrSimpleMock | null;
    send: (reply: FastifyReply, status: number, body: unknown) => FastifyReply;
  },
): void {
  const { service, send } = o;
  const fail = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof CollectionError)) throw e;
    const status = { NOT_FOUND: 404, INVALID_INPUT: 400, NO_PROVIDER: 503, ALL_PROVIDERS_FAILED: 502, UNSUPPORTED: 409, PROVIDER_ERROR: 502 }[e.code];
    return send(reply, status, { error: { code: e.code, message: e.message }, ...(e.attempts.length ? { attempts: e.attempts satisfies Attempt[] } : {}) });
  };

  app.post("/v1/qr", async (req, reply) => {
    const b = CreateBody.parse(req.body);
    try {
      const c = await service.create({
        tenantId: o.tenantOf(req),
        amount: b.amount,
        description: b.description,
        ...(b.reference ? { reference: b.reference } : {}),
        ...(b.expires_in_seconds !== undefined ? { expiresInSeconds: b.expires_in_seconds } : {}),
        ...(b.single_use !== undefined ? { singleUse: b.single_use } : {}),
        ...(b.modify_amount !== undefined ? { modifyAmount: b.modify_amount } : {}),
        ...(b.provider ? { provider: b.provider } : {}),
      });
      return send(reply, 201, collectionJson(c, { withImage: true }));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get("/v1/qr", async (req, reply) => {
    const limit = Number((req.query as { limit?: unknown }).limit ?? 50);
    return send(reply, 200, { collections: service.list(o.tenantOf(req), Number.isFinite(limit) ? limit : 50).map((c) => collectionJson(c, { withImage: false })) });
  });

  app.get("/v1/qr/providers", async (_req, reply) => send(reply, 200, { mode: service.mode, providers: service.providers() }));

  app.get<{ Params: { id: string } }>("/v1/qr/:id", async (req, reply) => {
    try {
      const withImage = (req.query as { image?: unknown }).image === "true";
      return send(reply, 200, collectionJson(await service.get(o.tenantOf(req), req.params.id), { withImage }));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/qr/:id/cancel", async (req, reply) => {
    try {
      return send(reply, 200, collectionJson(await service.cancel(o.tenantOf(req), req.params.id), { withImage: false }));
    } catch (e) {
      return fail(reply, e);
    }
  });

  if (o.mock) {
    app.post<{ Params: { id: string } }>("/v1/qr/:id/simulate-payment", async (req, reply) => {
      try {
        const c = service.find(o.tenantOf(req), req.params.id);
        if (c.provider !== "mock") throw new CollectionError("UNSUPPORTED", "only mock QRs can be paid by simulation");
        const b = SimulateBody.parse(req.body ?? {});
        await o.mock!.simulateDeposit({ qrId: c.providerRef, amount: b.amount, payerName: b.payer_name, payerBank: b.payer_bank });
        return send(reply, 200, collectionJson(await service.refresh(c), { withImage: false }));
      } catch (e) {
        return fail(reply, e);
      }
    });
  }

  // ── Provider webhooks ─────────────────────────────────────────────────────
  app.post(`${QR_WEBHOOK_PREFIX}atc`, async (req, reply) => {
    const presented = req.headers[o.webhook.header];
    if (typeof presented !== "string" || !safeEqual(presented, o.webhook.secret)) return send(reply, 401, { error: { code: "UNAUTHENTICATED" } });
    const ref = AtcProvider.webhookReference(req.body);
    if (!ref) return send(reply, 200, { received: true, matched: false });
    // Both ATC providers share the confirmation URL: the reference belongs to whichever issued it.
    const hit = (await service.onNotification("atc-simple", ref)) ?? (await service.onNotification("atc-mld", ref));
    return send(reply, 200, { received: true, matched: Boolean(hit) });
  });

  app.post(`${QR_WEBHOOK_PREFIX}baneco`, async (req, reply) => {
    const key = (req.query as { key?: unknown }).key;
    if (typeof key !== "string" || !safeEqual(key, o.webhook.secret)) return send(reply, 401, { responseCode: 1, message: "No autorizado" });
    const payment = (req.body as { payment?: { qrId?: unknown } } | null)?.payment;
    const ref = typeof payment?.qrId === "string" ? payment.qrId : null;
    if (ref) await service.onNotification("baneco", ref);
    // The bank's contract: responseCode 0 acknowledges.
    return send(reply, 200, { responseCode: 0, message: "" });
  });
}
