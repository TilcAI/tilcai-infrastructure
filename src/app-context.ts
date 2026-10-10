import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { activeConfig, loadEnv, type Env } from "./config/env.ts";
import { networks, type NetworkId, type NetworkRegistry } from "./config/networks.ts";
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
import { sqliteCorrelate } from "./modules/monitor/correlate.ts";
import { WebForwarder } from "./modules/monitor/forwarder.ts";
import type { Correlate } from "./modules/monitor/relayer-webhook.ts";
import { SqliteMonitorRepository } from "./modules/monitor/repository.ts";
import { ResourceMonitor } from "./modules/monitor/resources.ts";
import { MonitorService } from "./modules/monitor/service.ts";
import { SqliteQrMockRepository } from "./modules/qrsimple/repository.ts";
import { QrSimpleMock } from "./modules/qrsimple/service.ts";
import { RelayerClient } from "./modules/relayer/client.ts";
import { ViemVault } from "./modules/vault/adapters/evm.ts";
import { SorobanVault, StellarVaultSubmitter } from "./modules/vault/adapters/stellar.ts";
import { SqliteVaultRepository } from "./modules/vault/repository.ts";
import { VaultDisbursementService } from "./modules/vault/service.ts";
import type { DelegationRepository, SmartAccountRepository } from "./modules/accounts/ports.ts";
import { EvmSmartAccountProvider } from "./modules/accounts/evm/provider.ts";
import { StellarSmartAccountProvider } from "./modules/accounts/stellar/provider.ts";
import { RelayerStellarSubmitter } from "./modules/stellar/relayer-submitter.ts";
import type { AccountDeployer } from "./modules/accounts/ports.ts";
import { SqliteDelegationRepository, SqliteSmartAccountRepository } from "./modules/accounts/repository.ts";
import { AccountService } from "./modules/accounts/service.ts";
import type { TenantAdmin, TenantId, TenantRegistry } from "./modules/tenants/ports.ts";
import { SqliteTenantRegistry } from "./modules/tenants/registry.ts";

/** Composition root: the only place that knows concrete adapters. */
export interface AppContext {
  env: Env;
  runtime: ReturnType<typeof activeConfig>;
  nets: NetworkRegistry;
  db: DatabaseSync;
  log: Logger;
  relayer: RelayerClient;
  crosschain: CrosschainPaymentService;
  /** Payouts from the active Avalanche vault. */
  vault: VaultDisbursementService | null;
  /** Every active network's vault service: the HTTP API and worker go through this. */
  vaults: Partial<Record<NetworkId, VaultDisbursementService>>;
  /** all | api | worker: which process this is. */
  role: string;
  /** The event log behind the dashboard in tilcai-web. */
  monitor: MonitorService;
  resources: ResourceMonitor;
  /** Pushes the event log to tilcai-web. Null until MONITOR_WEB_URL is configured. */
  forwarder: WebForwarder | null;
  /** Maps a relayer transaction to the payment or payout that sent it. */
  correlate: Correlate;
  /** QR Simple mock (Vendis API). Null unless QR_MOCK_ENABLED. */
  qrMock: QrSimpleMock | null;
  /** Fase SCA M1. Authentication and the HTTP API consume these (M1, Omar); the CLI uses `TenantAdmin`. */
  tenants: TenantRegistry & TenantAdmin;
  accounts: SmartAccountRepository;
  delegations: DelegationRepository;
  /** Issues smart accounts for tenants. Null until an active-network account factory is configured. */
  accountService: AccountService | null;
}

export function createAppContext(name: string, env: Env = loadEnv()): AppContext {
  const log = createLogger(name, env.LOG_LEVEL);
  const nets = networks(env);
  const runtime = activeConfig(env);
  const db = openDatabase(runtime.databasePath);
  const relayer = new RelayerClient(runtime.relayerUrl, runtime.relayerApiKey);
  const role = name === "tilcai" ? "all" : name;
  const monitorRepo = new SqliteMonitorRepository(db);
  const monitor = new MonitorService(monitorRepo, systemClock, log);

  const submitters: Record<string, MintSubmitter> = {};
  if (runtime.relayerApiKey && runtime.transactionsEnabled) submitters.relayer = new RelayerMintSubmitter(relayer, runtime.stellarRelayerId, nets.stellar);
  if (env.STELLAR_OPERATOR_SECRET) submitters.local = new LocalKeyMintSubmitter(nets.stellar, env.STELLAR_OPERATOR_SECRET);
  if (!submitters[env.STELLAR_MINT_SUBMITTER]) {
    log.warn("mint submitter not configured; payments will wait at ATTESTED", { submitter: env.STELLAR_MINT_SUBMITTER });
  }

  const evmSubmitter = runtime.relayerApiKey && runtime.transactionsEnabled ? new RelayerEvmSubmitter(relayer, runtime.evmRelayerId) : null;
  // The keys of TILCAI_API_KEYS belong to the legacy tenant (scope `payments`): Optipagos and optus-agentBE keep working.
  // SQLite runs this to completion before the call returns, so the keys are in place when the context is.
  const tenants = new SqliteTenantRegistry(db, systemClock);
  tenants
    .syncLegacyKeys(runtime.apiKeys)
    .then((r) => log.info("legacy tenant keys synced", r))
    .catch((e) => log.error("could not sync TILCAI_API_KEYS with the legacy tenant", { error: e instanceof Error ? e.message : String(e) }));

  const accounts = new SqliteSmartAccountRepository(db, systemClock);
  const accountProvider = nets.avalanche.accountFactory ? new EvmSmartAccountProvider(nets.avalanche, nets.avalanche.accountFactory, evmSubmitter) : null;
  const stellarSubmitter = runtime.relayerApiKey && runtime.transactionsEnabled ? new RelayerStellarSubmitter(relayer, runtime.stellarRelayerId, nets.stellar) : null;
  const stellarAccountProvider = nets.stellar.accountFactory
    ? new StellarSmartAccountProvider(nets.stellar, nets.stellar.accountFactory, stellarSubmitter, runtime.stellarSimulationSource || undefined)
    : null;
  const providers: Partial<Record<AccountDeployer["network"], AccountDeployer>> = {};
  if (accountProvider) providers[accountProvider.network] = accountProvider;
  if (stellarAccountProvider) providers[stellarAccountProvider.network] = stellarAccountProvider;
  const accountService =
    accountProvider || stellarAccountProvider
      ? new AccountService({ repo: accounts, providers, clock: systemClock, log, events: monitor, options: { pollMs: env.WORKER_POLL_MS, transactionsEnabled: runtime.transactionsEnabled } })
      : null;
  if (accountProvider && !evmSubmitter) log.warn("active EVM account factory is set but its relayer is not; accounts are issued but never deployed");
  if (stellarAccountProvider && !stellarSubmitter) log.warn("active Stellar account factory is set but its relayer is not; accounts are issued but never deployed");

  const crosschain = new CrosschainPaymentService({
    repo: new SqliteCrosschainRepository(db),
    evm: new ViemEvmCctp(nets.avalanche, env.DEV_EVM_PAYER_PRIVATE_KEY || undefined),
    stellar: new SorobanStellarCctp(nets.stellar, runtime.stellarSimulationSource || undefined),
    iris: new IrisClient(runtime.irisApiUrl),
    submitters,
    activeSubmitter: env.STELLAR_MINT_SUBMITTER,
    ...(evmSubmitter && (nets.avalanche.cctpRouter || nets.avalanche.cctpRouterV2) ? { evmSubmitter } : {}),
    ...(accountService && accountProvider
      ? {
          accounts: {
            isActiveAccount: async (tenantId, address) => Boolean(await accountService.activeByAddress(tenantId as TenantId, accountProvider.network, address)),
            isValidSignature: (account, hash, signature) => accountProvider.isValidSignature(account, hash, signature),
          },
        }
      : {}),
    source: nets.avalanche,
    destination: nets.stellar,
    clock: systemClock,
    log,
    events: monitor,
    transactionsEnabled: runtime.transactionsEnabled,
    options: {
      quoteTtlSeconds: env.QUOTE_TTL_SECONDS,
      pollMs: env.WORKER_POLL_MS,
      minConfirmations: runtime.evmMinConfirmations,
    },
  });

  const vault =
    evmSubmitter && nets.avalanche.vault
      ? new VaultDisbursementService({
          repo: new SqliteVaultRepository(db),
          vault: new ViemVault(nets.avalanche, nets.avalanche.vault),
          submitter: evmSubmitter,
          network: nets.avalanche,
          clock: systemClock,
          log,
          events: monitor,
          options: { pollMs: env.WORKER_POLL_MS, minConfirmations: runtime.evmMinConfirmations },
        })
      : null;
  if (nets.avalanche.vault && !vault) log.warn("active Avalanche vault is set but its relayer is not; payouts are disabled");

  // Same repository, one service per network: each reconciles only the payouts of its own vault.
  const stellarVault =
    stellarSubmitter && nets.stellar.vault
      ? new VaultDisbursementService({
          repo: new SqliteVaultRepository(db),
          vault: new SorobanVault(nets.stellar, nets.stellar.vault, runtime.stellarSimulationSource || undefined),
          submitter: new StellarVaultSubmitter(stellarSubmitter),
          network: nets.stellar,
          clock: systemClock,
          log,
          events: monitor,
          // A Stellar ledger closes in about 5 s and is final: one confirmation is enough.
          options: { pollMs: env.WORKER_POLL_MS, minConfirmations: 1 },
        })
      : null;
  if (nets.stellar.vault && !stellarVault) log.warn("active Stellar vault is set but its relayer is not; payouts are disabled");
  const vaults: AppContext["vaults"] = {};
  if (vault) vaults[nets.avalanche.id] = vault;
  if (stellarVault) vaults[nets.stellar.id] = stellarVault;

  const resources = new ResourceMonitor({
    role,
    db,
    databasePath: runtime.databasePath,
    relayer,
    relayerAuthenticated: Boolean(runtime.relayerApiKey),
    relayerIds: [runtime.evmRelayerId, runtime.stellarRelayerId],
    vault,
    usdcDecimals: nets.avalanche.usdc.decimals,
    primaryVaultNetwork: nets.avalanche.id,
    otherVaults: stellarVault ? [{ network: nets.stellar.id, service: stellarVault, usdcDecimals: nets.stellar.usdc.decimals }] : [],
    monitor: { head: () => monitorRepo.head(), sinks: () => monitorRepo.sinks() },
    now: systemClock.now,
  });
  const forwarder = runtime.monitorWebUrl
    ? new WebForwarder({
        repo: monitorRepo,
        url: runtime.monitorWebUrl,
        secret: runtime.monitorWebSecret,
        origin: { env: env.TILCAI_ENV, instance: hostname() },
        clock: systemClock,
        log,
      })
    : null;
  const qrMock = env.QR_MOCK_ENABLED
    ? new QrSimpleMock({
        repo: new SqliteQrMockRepository(db),
        clock: systemClock,
        log,
        events: monitor,
        config: {
          email: env.QR_MOCK_EMAIL,
          password: env.QR_MOCK_PASSWORD,
          publicUrl: env.QR_MOCK_PUBLIC_URL || `http://${env.API_HOST === "0.0.0.0" ? "127.0.0.1" : env.API_HOST}:${env.API_PORT}`,
          callbackUrl: env.QR_MOCK_CALLBACK_URL,
        },
      })
    : null;
  if (qrMock && !env.QR_MOCK_CALLBACK_URL) log.warn("QR mock without QR_MOCK_CALLBACK_URL: payments are only visible by polling the QR status");
  return {
    env, runtime, nets, db, log, relayer, crosschain, vault, vaults, role, monitor, resources, forwarder, correlate: sqliteCorrelate(db), qrMock, tenants,
    accounts,
    accountService,
    delegations: new SqliteDelegationRepository(db),
  };
}
