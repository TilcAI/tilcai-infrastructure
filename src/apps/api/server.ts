import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../app-context.ts";
import { DomainError } from "../../shared/errors.ts";
import { atomicToDecimal } from "../../shared/amount.ts";
import type { CrosschainPayment, RouteQuote } from "../../modules/crosschain/domain.ts";
import { PAYMENT_MODES, paymentStateOf } from "../../modules/crosschain/domain.ts";
import { challengeBase64Url, encodeWebAuthnSignature, fromBase64Url, PasskeyFormatError } from "../../modules/accounts/evm/passkey.ts";
import { LEGACY_TENANT_ID, TENANT_SCOPES, type TenantId, type TenantScope } from "../../modules/tenants/ports.ts";
import type { Hex } from "../../shared/hex.ts";
import { registerAccountRoutes } from "./accounts-routes.ts";
import type { VaultDisbursement } from "../../modules/vault/domain.ts";
import type { VaultDisbursementService } from "../../modules/vault/service.ts";
import { Throttle } from "../../modules/monitor/service.ts";
import { QR_MOCK_PREFIX, registerQrMock } from "../../modules/qrsimple/routes.ts";
import { systemClock } from "../../shared/clock.ts";
import { bearerOf, isLoopback } from "./auth.ts";
import { registerMonitorRoutes, RELAYER_WEBHOOK_PATH } from "./monitor-routes.ts";

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
  mode: z.enum(PAYMENT_MODES),
  payer: z.string().max(42).optional(),
  orderId: z.string().max(160).optional(),
});
const BurnBody = z.strictObject({ txHash: z.string().max(66) });
const AuthorizationBody = z.strictObject({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });
/** `account` mode: the account's finished ERC-1271 signature, or the passkey assertion as the browser returned it (base64url). */
const AccountAuthorizationBody = z.union([
  z.strictObject({ signature: z.string().regex(/^0x([0-9a-fA-F]{2}){65,4096}$/) }),
  z.strictObject({
    webauthn: z.strictObject({
      authenticatorData: z.string().min(1).max(2048),
      clientDataJSON: z.string().min(1).max(4096),
      signature: z.string().min(1).max(256),
    }),
  }),
]);

/** Who is calling, once the bearer key was matched to a tenant. */
interface Caller {
  tenantId: TenantId;
  scopes: readonly TenantScope[];
}

/**
 * What a route asks of its caller. The vault, the event log and the relayer's status are TilcAI's
 * own: only the operator's keys (TILCAI_API_KEYS, the legacy tenant) reach them.
 */
function requirementOf(method: string, path: string): { scope: TenantScope; operator: boolean } {
  if (path === "/v1/accounts" || path.startsWith("/v1/accounts/")) return { scope: method === "GET" || method === "HEAD" ? "accounts:read" : "accounts:write", operator: false };
  const operator = ["/v1/vault", "/v1/monitor", "/v1/relayer"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  return { scope: "payments", operator };
}
const VAULT_NETWORKS = ["eip155:43113", "stellar:testnet"] as const;
const DisbursementBody = z.strictObject({
  /** Which network's vault pays. Without it: the one vault configured, Fuji's when both are. */
  network: z.enum(VAULT_NETWORKS).optional(),
  to: z.string().max(69),
  amount: z.string().max(40),
  reference: z.string().max(160).optional(),
});

export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({
    logger: { level: ctx.env.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers['idempotency-key']"] },
    bodyLimit: 64 * 1024,
    // An open event stream must not keep the process from shutting down.
    forceCloseConnections: true,
  });

  const keys = ctx.env.TILCAI_API_KEYS;
  const callers = new WeakMap<FastifyRequest, Caller>();
  if (keys.length === 0) app.log.warn("TILCAI_API_KEYS empty: API only reachable unauthenticated on loopback");

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?", 1)[0]!;
    // These authenticate on their own: the relayer signs its webhooks and the QR mock speaks
    // Vendis's API, with Vendis's tokens.
    if (path === "/health" || path === RELAYER_WEBHOOK_PATH || path === QR_MOCK_PREFIX || path.startsWith(`${QR_MOCK_PREFIX}/`)) return;
    const presented = bearerOf(req.headers.authorization);
    const known = presented ? await ctx.tenants.authenticate(presented) : undefined;
    let caller: Caller | undefined = known ? { tenantId: known.tenant.id, scopes: known.scopes } : undefined;
    // Development: without operator keys, this host is the operator.
    if (!caller && keys.length === 0 && isLoopback(req.ip)) caller = { tenantId: LEGACY_TENANT_ID, scopes: TENANT_SCOPES };
    if (!caller) return send(reply, 401, { error: new DomainError("UNAUTHENTICATED").contract });
    const need = requirementOf(req.method, path);
    if ((need.operator && caller.tenantId !== LEGACY_TENANT_ID) || !caller.scopes.includes(need.scope)) {
      return send(reply, 403, { error: new DomainError("FORBIDDEN").contract });
    }
    callers.set(req, caller);
  });
  const tenantOf = (req: FastifyRequest): TenantId => {
    const caller = callers.get(req);
    if (!caller) throw new DomainError("UNAUTHENTICATED");
    return caller.tenantId;
  };

  // A failing dependency shows on the dashboard once a minute, not once per request.
  const rejections = new Throttle(systemClock);
  const announceFailure = (req: FastifyRequest, status: number, code: string, detail?: string) => {
    const route = `${req.method} ${req.routeOptions?.url ?? req.url.split("?", 1)[0]}`;
    const pass = rejections.pass(`${route} ${code}`);
    if (!pass) return;
    ctx.monitor.emit({
      type: "api.request_rejected",
      severity: "error",
      subject: route,
      summary: `API ${route} → ${status} ${code}${detail ? `: ${detail}` : ""}`,
      data: { route, status, code, detail: detail ?? null, repeatedSinceLast: pass.suppressed },
    });
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      req.log.info({ code: err.contract.code, detail: err.detail }, "domain error");
      if (err.httpStatus >= 500) announceFailure(req, err.httpStatus, err.contract.code, err.detail);
      return send(reply, err.httpStatus, { error: err.contract, ...(err.detail && err.httpStatus < 500 ? { detail: err.detail } : {}) });
    }
    if (err instanceof PasskeyFormatError) return send(reply, 400, { error: new DomainError("INVALID_INPUT").contract, detail: err.message });
    if (err instanceof z.ZodError) {
      return send(reply, 400, { error: new DomainError("INVALID_INPUT").contract, detail: err.issues.map((i) => i.path.join(".") || i.message).join("; ").slice(0, 300) });
    }
    if ((err as { statusCode?: number }).statusCode === 400 || (err as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return send(reply, 400, { error: new DomainError("INVALID_INPUT").contract });
    }
    req.log.error({ err }, "unhandled error");
    announceFailure(req, 500, "INTERNAL_ERROR");
    return send(reply, 500, { error: new DomainError("INTERNAL_ERROR").contract });
  });

  app.get("/health", async (_req, reply) => {
    const relayer = await ctx.relayer.health();
    return send(reply, 200, {
      ok: true,
      env: ctx.env.TILCAI_ENV,
      relayer: relayer ? "up" : "down",
      vault: ctx.vault ? "on" : "off",
      vaultStellar: ctx.vaults["stellar:testnet"] ? "on" : "off",
      accounts: ctx.accountService ? "on" : "off",
      qrMock: ctx.qrMock ? "on" : "off",
      monitor: ctx.forwarder ? "push" : "local",
    });
  });

  registerMonitorRoutes(app, ctx);
  if (ctx.qrMock) {
    registerQrMock(app, { mock: ctx.qrMock, apiKeys: keys, simulatorKey: ctx.env.QR_MOCK_SIMULATOR_KEY, callbackUrl: ctx.env.QR_MOCK_CALLBACK_URL });
  }

  registerAccountRoutes(app, ctx, { tenantOf, idemKey, send });

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
    const q = await ctx.crosschain.quote({ ...body, tenantId: tenantOf(req) });
    return send(reply, 201, { quote: publicQuote(q) });
  });

  app.get<{ Params: { id: string } }>("/v1/crosschain/quotes/:id", async (req, reply) =>
    send(reply, 200, { quote: publicQuote(ctx.crosschain.getQuote(req.params.id, tenantOf(req))) }),
  );

  app.post("/v1/crosschain/payments", async (req, reply) => {
    const body = PaymentBody.parse(req.body);
    const idempotencyKey = idemKey(req);
    const r = await ctx.crosschain.createPayment({ ...body, idempotencyKey, tenantId: tenantOf(req) });
    const awaitingSignature = r.payment.state === "AWAITING_BURN" && !r.payment.burnAuthorization;
    return send(reply, r.replayed ? 200 : 201, {
      payment: publicPayment(r.payment),
      // Exact calls for the payer's wallet, in order. TilcAI never asks for the payer's key.
      unsignedCalls: r.calls,
      // Gasless: sign this typed data (eth_signTypedData_v4) and POST the signature; the relayer pays the gas.
      ...(r.authorization
        ? {
            authorization: {
              router: r.authorization.router,
              nonce: r.authorization.nonce,
              validBefore: r.authorization.validBefore,
              typedData: r.authorization.typedData,
              // Smart account: the owner's passkey signs `challenge`, which wraps typedData and names the account (ERC-7739).
              ...(r.authorization.account
                ? {
                    account: {
                      challenge: r.authorization.account.challenge,
                      challengeBase64Url: challengeBase64Url(r.authorization.account.challenge),
                      appDomainSeparator: r.authorization.account.contents.appDomainSeparator,
                      contentsHash: r.authorization.account.contents.contentsHash,
                      contentsType: r.authorization.account.contents.contentsType,
                    },
                  }
                : {}),
            },
          }
        : {}),
      next: r.payment.mode === "account" && awaitingSignature
        ? `ask the owner's passkey for navigator.credentials.get({ challenge: authorization.account.challenge, userVerification: "required" }), then POST /v1/crosschain/payments/${r.payment.id}/authorization {"webauthn": {authenticatorData, clientDataJSON, signature}} (base64url)`
        : r.payment.mode === "gasless" && awaitingSignature
        ? `sign authorization.typedData with eth_signTypedData_v4, then POST /v1/crosschain/payments/${r.payment.id}/authorization {"signature": "0x…"}`
        : r.payment.mode === "external" && r.payment.state === "AWAITING_BURN"
        ? `sign and broadcast the calls, then POST /v1/crosschain/payments/${r.payment.id}/burn {"txHash": "<burn tx>"}`
        : "poll GET /v1/crosschain/payments/:id",
    });
  });

  app.get<{ Params: { id: string } }>("/v1/crosschain/payments/:id", async (req, reply) => {
    const v = ctx.crosschain.view(req.params.id, tenantOf(req));
    return send(reply, 200, { ...v, payment: publicPayment(v.payment), quote: publicQuote(v.quote) });
  });

  app.post<{ Params: { id: string } }>("/v1/crosschain/payments/:id/authorization", async (req, reply) => {
    const tenantId = tenantOf(req);
    if (ctx.crosschain.mustGet(req.params.id, tenantId).mode === "account") {
      const body = AccountAuthorizationBody.parse(req.body);
      const signed =
        "signature" in body
          ? { signature: body.signature as Hex }
          : {
              passkeySignature: encodeWebAuthnSignature({
                authenticatorData: fromBase64Url(body.webauthn.authenticatorData, "authenticatorData"),
                clientDataJSON: fromBase64Url(body.webauthn.clientDataJSON, "clientDataJSON"),
                signature: fromBase64Url(body.webauthn.signature, "signature"),
              }),
            };
      return send(reply, 200, { payment: publicPayment(await ctx.crosschain.submitAccountAuthorization(req.params.id, signed, tenantId)) });
    }
    const { signature } = AuthorizationBody.parse(req.body);
    const v = parseInt(signature.slice(130, 132), 16);
    const p = await ctx.crosschain.submitAuthorization(
      req.params.id,
      { v: v < 27 ? v + 27 : v, r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}` },
      tenantId,
    );
    return send(reply, 200, { payment: publicPayment(p) });
  });

  app.post<{ Params: { id: string } }>("/v1/crosschain/payments/:id/burn", async (req, reply) => {
    const { txHash } = BurnBody.parse(req.body);
    return send(reply, 200, { payment: publicPayment(ctx.crosschain.attachBurn(req.params.id, txHash, tenantOf(req))) });
  });

  /** Runs one reconciliation step now (the worker does the same on its own cadence). */
  app.post<{ Params: { id: string } }>("/v1/crosschain/payments/:id/reconcile", async (req, reply) => {
    const p = await ctx.crosschain.step(ctx.crosschain.mustGet(req.params.id, tenantOf(req)));
    return send(reply, 200, { payment: publicPayment(p) });
  });

  // ── Vault: payouts of purchases settled off-chain ─────────────────────────

  /** The vault service of a network; without `network`, Fuji's (the original one) or the only one configured. */
  const vaultOf = (network?: string): VaultDisbursementService => {
    const found = network ? ctx.vaults[network as (typeof VAULT_NETWORKS)[number]] : (ctx.vault ?? Object.values(ctx.vaults)[0]);
    if (found) return found;
    if (network && !(VAULT_NETWORKS as readonly string[]).includes(network)) throw new DomainError("INVALID_INPUT", `unknown network ${network}`);
    const hint = network === "stellar:testnet" ? "VAULT_STELLAR" : "VAULT_FUJI";
    throw new DomainError("SERVICE_UNAVAILABLE", `vault not configured (${hint})`);
  };
  /** The service that owns a payout, found by its id through the shared repository. */
  const vaultOfDisbursement = (id: string): { service: VaultDisbursementService; disbursement: VaultDisbursement } => {
    const any = vaultOf();
    const disbursement = any.mustGet(id);
    return { service: vaultOf(disbursement.network), disbursement };
  };
  const usdcOf = (network: string) => {
    const net = ctx.nets.byId(network);
    return { decimals: net?.usdc.decimals ?? 6, asset: net?.family === "stellar" ? (net as { usdc: { sac: string } }).usdc.sac : (net as { usdc: { address: string } } | undefined)?.usdc.address, explorer: net?.explorer };
  };
  const publicDisbursement = (d: VaultDisbursement) => ({
    id: d.id,
    state: d.state,
    uncertain: d.uncertain,
    network: d.network,
    vault: d.vault,
    to: d.to,
    asset: "USDC",
    amountAtomic: d.amountAtomic,
    amount: atomicToDecimal(d.amountAtomic, usdcOf(d.network).decimals),
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
  const txLink = (d: VaultDisbursement) => ({ tx: d.txHash ? `${usdcOf(d.network).explorer}/tx/${d.txHash}` : null });

  app.get("/v1/vault", async (req, reply) => {
    const network = z.object({ network: z.enum(VAULT_NETWORKS).optional() }).parse(req.query).network;
    const service = vaultOf(network);
    const s = await service.status();
    const net = network ?? (ctx.vault ? "eip155:43113" : (Object.keys(ctx.vaults)[0] as string));
    const { decimals, asset, explorer } = usdcOf(net);
    const usdc = (atomic: bigint) => atomicToDecimal(atomic, decimals);
    return send(reply, 200, {
      vault: {
        network: net,
        address: s.address,
        asset,
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
        explorer: `${explorer}/${net === "stellar:testnet" ? "contract" : "address"}/${s.address}`,
      },
    });
  });

  app.post("/v1/vault/disbursements", async (req, reply) => {
    const { network, ...body } = DisbursementBody.parse(req.body);
    const r = await vaultOf(network).create({ ...body, idempotencyKey: idemKey(req) });
    return send(reply, r.replayed ? 200 : 201, { disbursement: publicDisbursement(r.disbursement), links: txLink(r.disbursement) });
  });

  app.get<{ Params: { id: string } }>("/v1/vault/disbursements/:id", async (req, reply) => {
    const { service } = vaultOfDisbursement(req.params.id);
    const v = service.view(req.params.id);
    return send(reply, 200, { disbursement: publicDisbursement(v.disbursement), links: v.links, events: v.events });
  });

  /** Runs one reconciliation step now (the worker does the same on its own cadence). */
  app.post<{ Params: { id: string } }>("/v1/vault/disbursements/:id/reconcile", async (req, reply) => {
    const { service, disbursement } = vaultOfDisbursement(req.params.id);
    const d = await service.step(disbursement);
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
