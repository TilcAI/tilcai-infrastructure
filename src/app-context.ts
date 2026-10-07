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
import { ViemVault } from "./modules/vault/adapters/evm.ts";
import { SqliteVaultRepository } from "./modules/vault/repository.ts";
import { VaultDisbursementService } from "./modules/vault/service.ts";

/** Composition root: the only place that knows concrete adapters. */
export interface AppContext {
  env: Env;
  nets: NetworkRegistry;
  db: DatabaseSync;
  log: Logger;
  relayer: RelayerClient;
  crosschain: CrosschainPaymentService;
  /** Payouts from the TilcaiVault. Null until VAULT_FUJI and the relayer key are configured. */
  vault: VaultDisbursementService | null;
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

  const evmSubmitter = env.RELAYER_API_KEY ? new RelayerEvmSubmitter(relayer, env.RELAYER_FUJI_ID) : null;

  const crosschain = new CrosschainPaymentService({
    repo: new SqliteCrosschainRepository(db),
    evm: new ViemEvmCctp(nets.avalancheFuji, env.DEV_EVM_PAYER_PRIVATE_KEY || undefined),
    stellar: new SorobanStellarCctp(nets.stellarTestnet, env.STELLAR_SIMULATION_SOURCE || undefined),
    iris: new IrisClient(env.IRIS_API_URL),
    submitters,
    activeSubmitter: env.STELLAR_MINT_SUBMITTER,
    ...(evmSubmitter && nets.avalancheFuji.cctpRouter ? { evmSubmitter } : {}),
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

  const vault =
    evmSubmitter && nets.avalancheFuji.vault
      ? new VaultDisbursementService({
          repo: new SqliteVaultRepository(db),
          vault: new ViemVault(nets.avalancheFuji, nets.avalancheFuji.vault),
          submitter: evmSubmitter,
          network: nets.avalancheFuji,
          clock: systemClock,
          log,
          options: { pollMs: env.WORKER_POLL_MS, minConfirmations: env.EVM_MIN_CONFIRMATIONS },
        })
      : null;
  if (nets.avalancheFuji.vault && !vault) log.warn("VAULT_FUJI is set but RELAYER_API_KEY is not; vault payouts are disabled");
  return { env, nets, db, log, relayer, crosschain, vault };
}
