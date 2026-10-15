import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { activeConfig, loadEnv, type Env } from "./config/env.ts";
import { networks, type EvmNetwork, type NetworkId, type NetworkRegistry } from "./config/networks.ts";
import type { Hex } from "./shared/hex.ts";
import { openDatabase } from "./db/sqlite.ts";
import { systemClock } from "./shared/clock.ts";
import { createLogger, type Logger } from "./shared/log.ts";
import { ViemEvmCctp } from "./modules/crosschain/adapters/evm.ts";
import { RelayerEvmSubmitter } from "./modules/crosschain/adapters/evm-relayer.ts";
import { LocalKeyMintSubmitter, RelayerMintSubmitter, SorobanStellarCctp } from "./modules/crosschain/adapters/stellar.ts";
import { IrisClient } from "./modules/crosschain/cctp/iris.ts";
import type { MintSubmitter } from "./modules/crosschain/ports.ts";
import { SqliteCrosschainRepository } from "./modules/crosschain/repository.ts";
import { CrosschainPaymentService, type SourceLeg } from "./modules/crosschain/service.ts";
import { sqliteCorrelate } from "./modules/monitor/correlate.ts";
import { WebForwarder } from "./modules/monitor/forwarder.ts";
import type { Correlate } from "./modules/monitor/relayer-webhook.ts";
import { SqliteMonitorRepository } from "./modules/monitor/repository.ts";
import { ResourceMonitor } from "./modules/monitor/resources.ts";
import { MonitorService } from "./modules/monitor/service.ts";
import { SqliteCollectionRepository } from "./modules/qrcollect/repository.ts";
import { QrCollectionService } from "./modules/qrcollect/service.ts";
import type { QrProvider } from "./modules/qrcollect/domain.ts";
import { AtcProvider, deriveWebhookSecret } from "./modules/qrcollect/providers/atc.ts";
import { BanecoProvider } from "./modules/qrcollect/providers/baneco.ts";
import { MockProvider } from "./modules/qrcollect/providers/mock.ts";
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
  /** Payouts from the active Avalanche vault (the other networks' are in `vaults`). */
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
  /** QR collection gateway: the mock when QR_MOCK_ENABLED, else the real providers with fallback. Null with none. */
  qrCollect: QrCollectionService | null;
  /** The secret ATC echoes in its webhook header (and the header's name). */
  qrWebhook: { header: string; secret: string };
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

  const canSubmit = Boolean(runtime.relayerApiKey && runtime.transactionsEnabled);
  const evmSubmitters: Record<string, RelayerEvmSubmitter | null> = {};
  for (const n of nets.evm) {
    const relayerId = runtime.evmRelayers[n.id];
    evmSubmitters[n.id] = canSubmit && relayerId ? new RelayerEvmSubmitter(relayer, relayerId) : null;
  }
  const evmSubmitter = evmSubmitters[nets.avalanche.id] ?? null;
  // The keys of TILCAI_API_KEYS belong to the legacy tenant (scope `payments`): Optipagos and optus-agentBE keep working.
  // SQLite runs this to completion before the call returns, so the keys are in place when the context is.
  const tenants = new SqliteTenantRegistry(db, systemClock);
  tenants
    .syncLegacyKeys(runtime.apiKeys)
    .then((r) => log.info("legacy tenant keys synced", r))
    .catch((e) => log.error("could not sync TILCAI_API_KEYS with the legacy tenant", { error: e instanceof Error ? e.message : String(e) }));

  const accounts = new SqliteSmartAccountRepository(db, systemClock);
  const stellarSubmitter = runtime.relayerApiKey && runtime.transactionsEnabled ? new RelayerStellarSubmitter(relayer, runtime.stellarRelayerId, nets.stellar) : null;
  const stellarAccountProvider = nets.stellar.accountFactory
    ? new StellarSmartAccountProvider(nets.stellar, nets.stellar.accountFactory, stellarSubmitter, runtime.stellarSimulationSource || undefined)
    : null;
  const providers: Partial<Record<AccountDeployer["network"], AccountDeployer>> = {};
  const evmAccountProviders: Record<string, EvmSmartAccountProvider> = {};
  for (const n of nets.evm) {
    if (!n.accountFactory) continue;
    const provider = new EvmSmartAccountProvider(n, n.accountFactory, evmSubmitters[n.id] ?? null);
    evmAccountProviders[n.id] = provider;
    providers[provider.network] = provider;
    if (!evmSubmitters[n.id]) log.warn("EVM account factory is set but its relayer is not; accounts are issued but never deployed", { network: n.id });
  }
  if (stellarAccountProvider) providers[stellarAccountProvider.network] = stellarAccountProvider;
  const accountService =
    Object.keys(providers).length > 0
      ? new AccountService({ repo: accounts, providers, clock: systemClock, log, events: monitor, options: { pollMs: env.WORKER_POLL_MS, transactionsEnabled: runtime.transactionsEnabled } })
      : null;
  if (stellarAccountProvider && !stellarSubmitter) log.warn("active Stellar account factory is set but its relayer is not; accounts are issued but never deployed");

  /** What a payment that starts on `n` needs: the burn adapter, that network's relayer and its smart accounts. */
  const sourceLeg = (n: EvmNetwork): SourceLeg => {
    const submitter = evmSubmitters[n.id];
    const provider = evmAccountProviders[n.id];
    return {
      network: n,
      evm: new ViemEvmCctp(n, env.DEV_EVM_PAYER_PRIVATE_KEY || undefined),
      ...(submitter && (n.cctpRouter || n.cctpRouterV2) ? { evmSubmitter: submitter } : {}),
      ...(accountService && provider
        ? {
            accounts: {
              isActiveAccount: async (tenantId: string, address: string) => Boolean(await accountService.activeByAddress(tenantId as TenantId, provider.network, address)),
              isValidSignature: (account: Hex, hash: Hex, signature: Hex) => provider.isValidSignature(account, hash, signature),
            },
          }
        : {}),
    };
  };
  const [primaryLeg, ...otherLegs] = [nets.avalanche, ...nets.evm.filter((n) => n.id !== nets.avalanche.id)].map(sourceLeg);

  const crosschain = new CrosschainPaymentService({
    repo: new SqliteCrosschainRepository(db),
    evm: primaryLeg!.evm,
    stellar: new SorobanStellarCctp(nets.stellar, runtime.stellarSimulationSource || undefined),
    iris: new IrisClient(runtime.irisApiUrl),
    submitters,
    activeSubmitter: env.STELLAR_MINT_SUBMITTER,
    ...(primaryLeg!.evmSubmitter ? { evmSubmitter: primaryLeg!.evmSubmitter } : {}),
    ...(primaryLeg!.accounts ? { accounts: primaryLeg!.accounts } : {}),
    source: nets.avalanche,
    ...(otherLegs.length > 0 ? { extraSources: otherLegs } : {}),
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

  // One vault service per network over the same repository: each reconciles only the payouts of its own vault.
  const vaults: AppContext["vaults"] = {};
  for (const n of nets.evm) {
    const submitter = evmSubmitters[n.id];
    if (n.vault && !submitter) log.warn("EVM vault is set but its relayer is not; payouts are disabled", { network: n.id });
    if (!n.vault || !submitter) continue;
    vaults[n.id] = new VaultDisbursementService({
      repo: new SqliteVaultRepository(db),
      vault: new ViemVault(n, n.vault),
      submitter,
      network: n,
      clock: systemClock,
      log,
      events: monitor,
      options: { pollMs: env.WORKER_POLL_MS, minConfirmations: runtime.evmMinConfirmations },
    });
  }
  const vault = vaults[nets.avalanche.id] ?? null;
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
  if (stellarVault) vaults[nets.stellar.id] = stellarVault;

  const resources = new ResourceMonitor({
    role,
    db,
    databasePath: runtime.databasePath,
    relayer,
    relayerAuthenticated: Boolean(runtime.relayerApiKey),
    relayerIds: [...nets.evm.map((n) => runtime.evmRelayers[n.id]).filter((id): id is string => Boolean(id)), runtime.stellarRelayerId],
    nativeUnits: Object.fromEntries(nets.evm.flatMap((n) => (runtime.evmRelayers[n.id] ? [[runtime.evmRelayers[n.id]!, n.nativeSymbol]] : []))),
    vault,
    usdcDecimals: nets.avalanche.usdc.decimals,
    primaryVaultNetwork: nets.avalanche.id,
    otherVaults: [
      ...nets.evm.filter((n) => n.id !== nets.avalanche.id && vaults[n.id]).map((n) => ({ network: n.id, service: vaults[n.id]!, usdcDecimals: n.usdc.decimals })),
      ...(stellarVault ? [{ network: nets.stellar.id, service: stellarVault, usdcDecimals: nets.stellar.usdc.decimals }] : []),
    ],
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
          payload: qrMockPayload(env),
        },
      })
    : null;
  if (qrMock && !env.QR_MOCK_CALLBACK_URL) log.warn("QR mock without QR_MOCK_CALLBACK_URL: payments are only visible by polling the QR status");

  const timeoutMs = env.QR_PROVIDER_TIMEOUT_MS;
  const webhookUrl = env.ATC_WEBHOOK_URL || (env.QR_PUBLIC_URL ? `${env.QR_PUBLIC_URL.replace(/\/+$/, "")}/v1/qr/webhooks/atc` : "");
  const qrWebhook = { header: "x-tilcai-webhook", secret: env.ATC_WEBHOOK_SECRET || deriveWebhookSecret(env.ATC_CLIENT_SECRET || "tilcai") };
  const atc = {
    baseUrl: env.ATC_BASE_URL,
    clientId: env.ATC_CLIENT_ID,
    clientSecret: env.ATC_CLIENT_SECRET,
    establishmentId: env.ATC_ESTABLISHMENT_ID,
    establishmentName: env.ATC_ESTABLISHMENT_NAME,
    // ATC requires a webhook on every QR; without a public URL the confirmation comes only by polling.
    webhookUrl: webhookUrl || "https://tilcai.invalid/v1/qr/webhooks/atc",
    webhookHeader: qrWebhook.header,
    webhookSecret: qrWebhook.secret,
    timeoutMs,
  };
  const realProviders: Record<string, QrProvider> = {
    baneco: new BanecoProvider({
      baseUrl: env.BANECO_BASE_URL,
      user: env.BANECO_USER,
      password: env.BANECO_PASSWORD,
      encryptionKey: env.BANECO_ENCRIPTION_KEY,
      paymentAccount: env.BANECO_PAYMENT_ACCOUNT,
      branchCode: env.BANECO_BRANCH_CODE,
      timeoutMs,
    }),
    "atc-simple": new AtcProvider("simple", atc),
    "atc-mld": new AtcProvider("mld", atc),
  };
  // The mock replaces the real providers; without it, QR_PROVIDERS gives the order (principal first).
  const qrProviders: QrProvider[] = qrMock
    ? [new MockProvider(qrMock, { email: env.QR_MOCK_EMAIL, password: env.QR_MOCK_PASSWORD })]
    : env.QR_PROVIDERS.map((id) => realProviders[id]!);
  const qrCollect =
    qrProviders.some((p) => p.configured())
      ? new QrCollectionService({
          repo: new SqliteCollectionRepository(db),
          providers: qrProviders,
          mode: qrMock ? "mock" : "live",
          clock: systemClock,
          log,
          events: monitor,
          options: { breakerThreshold: env.QR_PROVIDER_BREAKER_THRESHOLD, breakerCooldownMs: env.QR_PROVIDER_COOLDOWN_SECONDS * 1000 },
        })
      : null;
  if (!qrMock && qrCollect && !webhookUrl) log.warn("QR_PUBLIC_URL / ATC_WEBHOOK_URL not set: ATC payments are only seen by polling verify");
  return {
    env, runtime, nets, db, log, relayer, crosschain, vault, vaults, role, monitor, resources, forwarder, correlate: sqliteCorrelate(db), qrMock, qrCollect, qrWebhook, tenants,
    accounts,
    accountService,
    delegations: new SqliteDelegationRepository(db),
  };
}

/** The fixed content of the mock's QRs: QR_MOCK_PAYLOAD, else its file, else none (random). */
function qrMockPayload(env: Env): string {
  if (env.QR_MOCK_PAYLOAD) return env.QR_MOCK_PAYLOAD.trim();
  const file = env.QR_MOCK_PAYLOAD_FILE || (env.DATABASE_PATH === ":memory:" ? "" : join(dirname(env.DATABASE_PATH), "qr-mock-payload.txt"));
  return file && existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}
