import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "../../app-context.ts";
import { DomainError } from "../../shared/errors.ts";
import { checkReadiness, READINESS_MODES, type ExpectedRelayer, type Readiness, type ReadinessDeps, type ReadinessMode, type WorkerState } from "../../modules/readiness/service.ts";

export const READY_PATH = "/ready";
/** Answers are reused this long: the route is public and each one asks the relayer. */
const CACHE_MS = 5000;

const send = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).type("application/json; charset=utf-8").send(JSON.stringify(body));

/** Every relayer this process sends through: one per active EVM source network, and Stellar's. */
export function expectedRelayers(ctx: AppContext): ExpectedRelayer[] {
  return [
    ...ctx.nets.evm.map((n) => ({ for: n.id, id: ctx.runtime.evmRelayers[n.id] ?? "", network: n.relayerNetwork, networkType: "evm" as const })),
    { for: ctx.nets.stellar.id, id: ctx.runtime.stellarRelayerId, network: ctx.nets.stellar.relayerNetwork, networkType: "stellar" },
  ];
}

/**
 *   GET /ready                      200 ready / 503 not, for the mode this process runs in
 *   GET /ready?mode=transactional   the same checks a transactional process needs, asked of a read-only one:
 *                                   what to run before MAINNET_TRANSACTIONS_ENABLED=true
 * Public like `/health`, which stays the liveness probe.
 */
export function registerReadinessRoutes(app: FastifyInstance, ctx: AppContext, worker?: () => WorkerState): void {
  const deps: ReadinessDeps = {
    db: ctx.db,
    relayer: ctx.relayer,
    relayerApiKeySet: Boolean(ctx.runtime.relayerApiKey),
    relayers: expectedRelayers(ctx),
    mintSubmitter: { kind: ctx.env.STELLAR_MINT_SUBMITTER, localKeySet: Boolean(ctx.env.STELLAR_OPERATOR_SECRET) },
    ...(worker ? { worker } : {}),
    workerMaxSilenceMs: Math.max(10 * ctx.env.WORKER_POLL_MS, 120_000),
  };
  const current: ReadinessMode = ctx.runtime.transactionsEnabled ? "transactional" : "read-only";
  const cache = new Map<ReadinessMode, { at: number; answer: Promise<Readiness> }>();

  app.get<{ Querystring: { mode?: string } }>(READY_PATH, async (req, reply) => {
    const asked = req.query.mode;
    if (asked !== undefined && !READINESS_MODES.includes(asked as ReadinessMode)) {
      return send(reply, 400, { error: new DomainError("INVALID_INPUT").contract, detail: `mode must be one of ${READINESS_MODES.join(", ")}` });
    }
    const mode = (asked as ReadinessMode | undefined) ?? current;
    let hit = cache.get(mode);
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      hit = { at: Date.now(), answer: checkReadiness(deps, mode) };
      cache.set(mode, hit);
    }
    const r = await hit.answer;
    return send(reply, r.ready ? 200 : 503, { ...r, env: ctx.env.TILCAI_ENV, transactionsEnabled: ctx.runtime.transactionsEnabled });
  });
}
