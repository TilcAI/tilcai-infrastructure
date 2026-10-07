import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../app-context.ts";
import { DomainError } from "../../shared/errors.ts";
import { atomicToDecimal } from "../../shared/amount.ts";
import type { CrosschainPayment, RouteQuote } from "../../modules/crosschain/domain.ts";
import { paymentStateOf } from "../../modules/crosschain/domain.ts";
import type { VaultDisbursement } from "../../modules/vault/domain.ts";
import type { VaultDisbursementService } from "../../modules/vault/service.ts";

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const send = (reply: FastifyReply, status: number, body: unknown) =>
  reply.code(status).type("application/json; charset=utf-8").send(json(body));

const QuoteBody = z.strictObject({
  sourceNetwork: z.literal("eip155:43113"),
  destinationNetwork: z.literal("stellar:testnet"),
  amount: z.string().max(40),
  payTo: z.string().max(69),
});
const PaymentBody = z.strictObject({
  quoteId: z.string().max(160),
  mode: z.enum(["external", "dev_signer", "gasless", "dev_gasless"]),
  payer: z.string().max(42).optional(),
  orderId: z.string().max(160).optional(),
});
const BurnBody = z.strictObject({ txHash: z.string().max(66) });
const AuthorizationBody = z.strictObject({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });
const DisbursementBody = z.strictObject({
  to: z.string().max(42),
  amount: z.string().max(40),
  reference: z.string().max(160).optional(),
});

export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({
    logger: { level: ctx.env.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers['idempotency-key']"] },
    bodyLimit: 64 * 1024,
  });

  const keys = ctx.env.TILCAI_API_KEYS.map((k) => Buffer.from(k));
  if (keys.length === 0) app.log.warn("TILCAI_API_KEYS empty: API only reachable unauthenticated on loopback");

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    if (keys.length === 0) {
      if (!isLoopback(req.ip)) return send(reply, 401, { error: new DomainError("UNAUTHENTICATED").contract });
      return;
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const ok = token !== undefined && keys.some((k) => k.length === Buffer.byteLength(token) && timingSafeEqual(k, Buffer.from(token)));
    if (!ok) return send(reply, 401, { error: new DomainError("UNAUTHENTICATED").contract });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      req.log.info({ code: err.contract.code, detail: err.detail }, "domain error");
      return send(reply, err.httpStatus, { error: err.contract, ...(err.detail && err.httpStatus < 500 ? { detail: err.detail } : {}) });
    }
    if (err instanceof z.ZodError) {
      return send(reply, 400, { error: new DomainError("INVALID_INPUT").contract, detail: err.issues.map((i) => i.path.join(".") || i.message).join("; ").slice(0, 300) });
    }
    if ((err as { statusCode?: number }).statusCode === 400 || (err as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return send(reply, 400, { error: new DomainError("INVALID_INPUT").contract });
    }
    req.log.error({ err }, "unhandled error");
    return send(reply, 500, { error: new DomainError("INTERNAL_ERROR").contract });
  });

  app.get("/health", async (_req, reply) => {
    const relayer = await ctx.relayer.health();
    return send(reply, 200, { ok: true, env: ctx.env.TILCAI_ENV, relayer: relayer ? "up" : "down", vault: ctx.vault ? "on" : "off" });
  });

  app.get("/v1/routes", async (_req, reply) =>
    send(reply, 200, {
      routes: [
        {
          protocol: "cctp-v2",
          source: { network: ctx.nets.avalancheFuji.id, asset: ctx.nets.avalancheFuji.usdc.address, domain: ctx.nets.avalancheFuji.cctpDomain },
          destination: { network: ctx.nets.stellarTestnet.id, asset: ctx.nets.stellarTestnet.usdc.sac, domain: ctx.nets.stellarTestnet.cctpDomain },
          finality: "standard",
          mintSubmitter: ctx.env.STELLAR_MINT_SUBMITTER,
        },
      ],
    }),
  );

  app.post("/v1/crosschain/quotes", async (req, reply) => {
    const body = QuoteBody.parse(req.body);
    const q = await ctx.crosschain.quote(body);
    return send(reply, 201, { quote: publicQuote(q) });
  });

  app.get<{ Params: { id: string } }>("/v1/crosschain/quotes/:id", async (req, reply) =>
    send(reply, 200, { quote: publicQuote(ctx.crosschain.getQuote(req.params.id)) }),
  );

  app.post("/v1/crosschain/payments", async (req, reply) => {
    const body = PaymentBody.parse(req.body);
    const idempotencyKey = idemKey(req);
    const r = await ctx.crosschain.createPayment({ ...body, idempotencyKey });
    return send(reply, r.replayed ? 200 : 201, {
      payment: publicPayment(r.payment),
      // Exact calls for the payer's wallet, in order. TilcAI never asks for the payer's key.
      unsignedCalls: r.calls,
      // Gasless: sign this typed data (eth_signTypedData_v4) and POST the signature; the relayer pays the gas.
      ...(r.authorization ? { authorization: { router: r.authorization.router, nonce: r.authorization.nonce, validBefore: r.authorization.validBefore, typedData: r.authorization.typedData } } : {}),
      next: r.payment.mode === "gasless" && r.payment.state === "AWAITING_BURN" && !r.payment.burnAuthorization
        ? `sign authorization.typedData with eth_signTypedData_v4, then POST /v1/crosschain/payments/${r.payment.id}/authorization {"signature": "0x…"}`
        : r.payment.mode === "external" && r.payment.state === "AWAITING_BURN"
        ? `sign and broadcast the calls, then POST /v1/crosschain/payments/${r.payment.id}/burn {"txHash": "<burn tx>"}`
        : "poll GET /v1/crosschain/payments/:id",
    });
  });

  app.get<{ Params: { id: string } }>("/v1/crosschain/payments/:id", async (req, reply) => {
    const v = ctx.crosschain.view(req.params.id);
    return send(reply, 200, { ...v, payment: publicPayment(v.payment), quote: publicQuote(v.quote) });
  });

  app.post<{ Params: { id: string } }>("/v1/crosschain/payments/:id/authorization", async (req, reply) => {
    const { signature } = AuthorizationBody.parse(req.body);
    const v = parseInt(signature.slice(130, 132), 16);
    const p = await ctx.crosschain.submitAuthorization(req.params.id, {
      v: v < 27 ? v + 27 : v,
      r: `0x${signature.slice(2, 66)}`,
      s: `0x${signature.slice(66, 130)}`,
    });
    return send(reply, 200, { payment: publicPayment(p) });
  });

  app.post<{ Params: { id: string } }>("/v1/crosschain/payments/:id/burn", async (req, reply) => {
    const { txHash } = BurnBody.parse(req.body);
    return send(reply, 200, { payment: publicPayment(ctx.crosschain.attachBurn(req.params.id, txHash)) });
  });

  /** Runs one reconciliation step now (the worker does the same on its own cadence). */
  app.post<{ Params: { id: string } }>("/v1/crosschain/payments/:id/reconcile", async (req, reply) => {
    const p = await ctx.crosschain.step(ctx.crosschain.mustGet(req.params.id));
    return send(reply, 200, { payment: publicPayment(p) });
  });

  // ── Vault: payouts of purchases settled off-chain ─────────────────────────

  const vault = (): VaultDisbursementService => {
    if (!ctx.vault) throw new DomainError("SERVICE_UNAVAILABLE", "vault not configured (VAULT_FUJI)");
    return ctx.vault;
  };
  const usdc = (atomic: bigint) => atomicToDecimal(atomic, ctx.nets.avalancheFuji.usdc.decimals);
  const publicDisbursement = (d: VaultDisbursement) => ({
    id: d.id,
    state: d.state,
    uncertain: d.uncertain,
    network: d.network,
    vault: d.vault,
    to: d.to,
    asset: "USDC",
    amountAtomic: d.amountAtomic,
    amount: usdc(d.amountAtomic),
    reference: d.reference,
    submissionId: d.submissionId,
    txHash: d.txHash,
    blockNumber: d.blockNumber,
    attempts: d.attempts,
    lastError: d.lastError,
    failureCode: d.failureCode,
    nextCheckAt: d.nextCheckAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  });
  const txLink = (d: VaultDisbursement) => ({ tx: d.txHash ? `${ctx.nets.avalancheFuji.explorer}/tx/${d.txHash}` : null });

  app.get("/v1/vault", async (_req, reply) => {
    const s = await vault().status();
    return send(reply, 200, {
      vault: {
        network: ctx.nets.avalancheFuji.id,
        address: s.address,
        asset: ctx.nets.avalancheFuji.usdc.address,
        owner: s.owner,
        operator: s.operator,
        relayer: s.relayer,
        operatorIsRelayer: s.operatorIsRelayer,
        paused: s.paused,
        balance: usdc(s.balanceAtomic),
        pending: usdc(s.pendingAtomic),
        maxPerDisbursement: usdc(s.maxPerDisbursementAtomic),
        dailyLimit: usdc(s.dailyLimitAtomic),
        availableToday: usdc(s.availableTodayAtomic),
        explorer: `${ctx.nets.avalancheFuji.explorer}/address/${s.address}`,
      },
    });
  });

  app.post("/v1/vault/disbursements", async (req, reply) => {
    const body = DisbursementBody.parse(req.body);
    const r = await vault().create({ ...body, idempotencyKey: idemKey(req) });
    return send(reply, r.replayed ? 200 : 201, { disbursement: publicDisbursement(r.disbursement), links: txLink(r.disbursement) });
  });

  app.get<{ Params: { id: string } }>("/v1/vault/disbursements/:id", async (req, reply) => {
    const v = vault().view(req.params.id);
    return send(reply, 200, { disbursement: publicDisbursement(v.disbursement), links: v.links, events: v.events });
  });

  /** Runs one reconciliation step now (the worker does the same on its own cadence). */
  app.post<{ Params: { id: string } }>("/v1/vault/disbursements/:id/reconcile", async (req, reply) => {
    const d = await vault().step(vault().mustGet(req.params.id));
    return send(reply, 200, { disbursement: publicDisbursement(d), links: txLink(d) });
  });

  app.get("/v1/relayer/status", async (_req, reply) => {
    const up = await ctx.relayer.health();
    if (!up || !ctx.env.RELAYER_API_KEY) return send(reply, 200, { up, authenticated: false });
    const [supported, stellar] = await Promise.allSettled([
      ctx.relayer.x402(ctx.env.RELAYER_X402_PLUGIN_ID, "/supported"),
      ctx.relayer.getRelayer(ctx.env.RELAYER_STELLAR_ID),
    ]);
    return send(reply, 200, {
      up,
      authenticated: true,
      x402: supported.status === "fulfilled" ? supported.value.body : { error: String(supported.reason) },
      stellarRelayer: stellar.status === "fulfilled" ? pick(stellar.value, ["id", "network", "paused", "address", "network_type"]) : { error: String(stellar.reason) },
    });
  });

  return app;
}

function idemKey(req: FastifyRequest): string {
  const k = req.headers["idempotency-key"];
  if (typeof k !== "string") throw new DomainError("INVALID_INPUT", "Idempotency-Key header required");
  return k;
}

function publicQuote(q: RouteQuote) {
  return {
    id: q.id,
    route: { protocol: "cctp-v2", source: q.sourceNetwork, destination: q.destinationNetwork, sourceDomain: q.sourceDomain, destinationDomain: q.destinationDomain },
    payTo: q.payTo,
    destination: { asset: "USDC", amountAtomic: q.destinationAmountAtomic, amount: atomicToDecimal(q.destinationAmountAtomic, 7), decimals: 7 },
    burn: { asset: q.burnToken, amountAtomic: q.burnAmountAtomic, amount: atomicToDecimal(q.burnAmountAtomic, 6), decimals: 6 },
    fees: { protocolBpsHundredths: q.feeBpsHundredths, maxFeeAtomic: q.maxFeeAtomic, destinationGas: "sponsored by TilcAI relayer" },
    finality: q.finality === 2000 ? "standard" : "fast",
    cctp: q.target,
    preflight: q.preflight,
    createdAt: q.createdAt,
    expiresAt: q.expiresAt,
  };
}

function publicPayment(p: CrosschainPayment) {
  return {
    id: p.id,
    quoteId: p.quoteId,
    orderId: p.orderId,
    mode: p.mode,
    state: p.state,
    paymentState: paymentStateOf(p.state, p.uncertain),
    uncertain: p.uncertain,
    payer: p.payer,
    burnSubmissionId: p.burnSubmissionId,
    burnTxHash: p.burnTxHash,
    burnBlock: p.burnBlock,
    cctpNonce: p.cctpNonce,
    feeExecutedAtomic: p.feeExecutedAtomic,
    mintSubmitter: p.mintSubmitter,
    mintTxHash: p.mintTxHash,
    attempts: p.attempts,
    lastError: p.lastError,
    failureCode: p.failureCode,
    nextCheckAt: p.nextCheckAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

const pick = (o: Record<string, unknown>, ks: string[]) => Object.fromEntries(ks.filter((k) => k in o).map((k) => [k, o[k]]));
const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
