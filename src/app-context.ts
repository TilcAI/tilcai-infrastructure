import type { DatabaseSync } from "node:sqlite";
import { loadEnv, type Env } from "./config/env.ts";
import { networks, type NetworkRegistry } from "./config/networks.ts";
import { openDatabase } from "./db/sqlite.ts";
import { systemClock } from "./shared/clock.ts";
import { createLogger, type Logger } from "./shared/log.ts";
import { ViemEvmCctp } from "./modules/crosschain/adapters/evm.ts";
import { RelayerEvmSubmitter } from "./modules/crosschain/adapters/evm-relayer.ts";
import { LocalKeyMintSubmitter, RelayerMintSubmitter, SorobanStellarCctp } from "./modules/crosschain/adapters/stellar.ts";
import { IrisClient } from "./modules/crosschain/cctp/iris.ts";
import type { MintSubmitter } from "./modules/crosschain/ports.ts";
import { SqliteCrosschainRepository } from "./modules/crosschain/repository.ts";
import { CrosschainPaymentService } from "./modules/crosschain/service.ts";
import { RelayerClient } from "./modules/relayer/client.ts";
import type { DelegationRepository, SmartAccountRepository } from "./modules/accounts/ports.ts";
import { SqliteDelegationRepository, SqliteSmartAccountRepository } from "./modules/accounts/repository.ts";
import type { TenantAdmin, TenantRegistry } from "./modules/tenants/ports.ts";
import { SqliteTenantRegistry } from "./modules/tenants/registry.ts";

/** Composition root: the only place that knows concrete adapters. */
export interface AppContext {
  env: Env;
  nets: NetworkRegistry;
  db: DatabaseSync;
  log: Logger;
  relayer: RelayerClient;
  crosschain: CrosschainPaymentService;
  /** Fase SCA M1. Authentication and the HTTP API consume these (M1, Omar); the CLI uses `TenantAdmin`. */
  tenants: TenantRegistry & TenantAdmin;
  accounts: SmartAccountRepository;
  delegations: DelegationRepository;
}

export function createAppContext(name: string, env: Env = loadEnv()): AppContext {
  const log = createLogger(name, env.LOG_LEVEL);
  const nets = networks(env);
  const db = openDatabase(env.DATABASE_PATH);
  const relayer = new RelayerClient(env.RELAYER_URL, env.RELAYER_API_KEY);

  const submitters: Record<string, MintSubmitter> = {};
  if (env.RELAYER_API_KEY) submitters.relayer = new RelayerMintSubmitter(relayer, env.RELAYER_STELLAR_ID, nets.stellarTestnet);
  if (env.STELLAR_OPERATOR_SECRET) submitters.local = new LocalKeyMintSubmitter(nets.stellarTestnet, env.STELLAR_OPERATOR_SECRET);
  if (!submitters[env.STELLAR_MINT_SUBMITTER]) {
    log.warn("mint submitter not configured; payments will wait at ATTESTED", { submitter: env.STELLAR_MINT_SUBMITTER });
  }

  // The keys of TILCAI_API_KEYS belong to the legacy tenant (scope `payments`): Optipagos and optus-agentBE keep working.
  // SQLite runs this to completion before the call returns, so the keys are in place when the context is.
  const tenants = new SqliteTenantRegistry(db, systemClock);
  tenants
    .syncLegacyKeys(env.TILCAI_API_KEYS)
    .then((r) => log.info("legacy tenant keys synced", r))
    .catch((e) => log.error("could not sync TILCAI_API_KEYS with the legacy tenant", { error: e instanceof Error ? e.message : String(e) }));

  const crosschain = new CrosschainPaymentService({
    repo: new SqliteCrosschainRepository(db),
    evm: new ViemEvmCctp(nets.avalancheFuji, env.DEV_EVM_PAYER_PRIVATE_KEY || undefined),
    stellar: new SorobanStellarCctp(nets.stellarTestnet, env.STELLAR_SIMULATION_SOURCE || undefined),
    iris: new IrisClient(env.IRIS_API_URL),
    submitters,
    activeSubmitter: env.STELLAR_MINT_SUBMITTER,
    ...(env.RELAYER_API_KEY && nets.avalancheFuji.cctpRouter ? { evmSubmitter: new RelayerEvmSubmitter(relayer, env.RELAYER_FUJI_ID) } : {}),
    source: nets.avalancheFuji,
    destination: nets.stellarTestnet,
    clock: systemClock,
    log,
    options: {
      quoteTtlSeconds: env.QUOTE_TTL_SECONDS,
      pollMs: env.WORKER_POLL_MS,
      minConfirmations: env.EVM_MIN_CONFIRMATIONS,
    },
  });
  return {
    env, nets, db, log, relayer, crosschain, tenants,
    accounts: new SqliteSmartAccountRepository(db, systemClock),
    delegations: new SqliteDelegationRepository(db),
  };
}
