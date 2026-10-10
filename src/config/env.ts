import "dotenv/config";
import { z } from "zod";

/** Process configuration. Validated once at startup; secrets are never logged. */
const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

const flag = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");
const optionalUrl = z.string().url().or(z.literal("")).default("");
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).or(z.literal("")).default("");
const stellarContract = z.string().regex(/^C[A-Z2-7]{55}$/).or(z.literal("")).default("");
const stellarAccount = z.string().regex(/^G[A-Z2-7]{55}$/).or(z.literal("")).default("");

const schema = z.object({
  TILCAI_ENV: z.enum(["testnet", "mainnet"]).default("testnet"),
  /** Second, explicit switch: a mainnet process is read-only (quotes, status) until this is true. */
  MAINNET_TRANSACTIONS_ENABLED: flag,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Service-to-service bearer keys for the HTTP API (phase 1). */
  TILCAI_API_KEYS: csv,
  /** Deliberately separate credentials: testnet keys are never accepted by a mainnet process. */
  TILCAI_API_KEYS_MAINNET: csv,

  DATABASE_PATH: z.string().default("./data/tilcai.db"),
  DATABASE_PATH_MAINNET: z.string().default(""),

  // OpenZeppelin Relayer (same host in production → localhost).
  RELAYER_URL: z.string().url().default("http://localhost:8080"),
  RELAYER_API_KEY: z.string().default(""),
  RELAYER_STELLAR_ID: z.string().default("stellar-example"),
  /** OZ Relayer id that submits the gasless Fuji burn (TilcaiCctpRouter.payWithAuthorization). */
  RELAYER_FUJI_ID: z.string().default("avalanche-fuji-relayer"),
  RELAYER_URL_MAINNET: optionalUrl,
  RELAYER_API_KEY_MAINNET: z.string().default(""),
  RELAYER_AVALANCHE_MAINNET_ID: z.string().default(""),
  RELAYER_STELLAR_MAINNET_ID: z.string().default(""),
  /** Deployed TilcaiCctpRouter on Avalanche Fuji (enables gasless modes). */
  CCTP_ROUTER_FUJI: evmAddress,
  /**
   * Fase SCA: deployed TilcaiAccountFactory on Avalanche Fuji (enables /v1/accounts) and
   * TilcaiCctpRouterV2 (enables `mode: "account"` payments). `npm run sca -- deploy` prints both.
   */
  ACCOUNT_FACTORY_FUJI: evmAddress,
  CCTP_ROUTER_V2_FUJI: evmAddress,
  /**
   * Deployed TilcaiVault on Avalanche Fuji (enables /v1/vault). Its operator must be the
   * RELAYER_FUJI_ID account, which sends the payouts.
   */
  VAULT_FUJI: evmAddress,
  /**
   * Fase SCA on Stellar: deployed `tilcai_account_factory` (enables /v1/accounts on stellar:testnet)
   * and `tilcai_vault` (enables /v1/vault?network=stellar:testnet). `contracts/soroban/deploy-testnet.sh`
   * prints both. The vault's operator must be the RELAYER_STELLAR_ID account.
   */
  ACCOUNT_FACTORY_STELLAR: stellarContract,
  VAULT_STELLAR: stellarContract,
  RELAYER_X402_PLUGIN_ID: z.string().default("x402"),

  // Mainnet contracts have no defaults on purpose: each address is supplied explicitly once its
  // deployment is verified. Only the gasless router is required; each of the others turns a feature on.
  CCTP_ROUTER_AVALANCHE_MAINNET: evmAddress,
  CCTP_ROUTER_V2_AVALANCHE_MAINNET: evmAddress,
  ACCOUNT_FACTORY_AVALANCHE_MAINNET: evmAddress,
  VAULT_AVALANCHE_MAINNET: evmAddress,
  /** Must be filled only after the ERC-4337 v0.9 deployment bytecode is verified on C-Chain. */
  ERC4337_ENTRYPOINT_AVALANCHE_MAINNET: evmAddress,
  ACCOUNT_FACTORY_STELLAR_MAINNET: stellarContract,
  VAULT_STELLAR_MAINNET: stellarContract,
  RELAYER_X402_PLUGIN_ID_MAINNET: z.string().default(""),

  /** Who submits `CctpForwarder.mint_and_forward` on Stellar. */
  STELLAR_MINT_SUBMITTER: z.enum(["relayer", "local"]).default("relayer"),
  /** Only for STELLAR_MINT_SUBMITTER=local: an operator account that pays XLM fees. */
  STELLAR_OPERATOR_SECRET: z.string().default(""),
  /** Any existing G… account used as source for read-only Soroban simulations. */
  STELLAR_SIMULATION_SOURCE: z.string().default(""),
  STELLAR_SIMULATION_SOURCE_MAINNET: stellarAccount,

  RPC_AVALANCHE_FUJI: z.string().url().default("https://api.avax-test.network/ext/bc/C/rpc"),
  RPC_STELLAR_TESTNET: z.string().url().default("https://soroban-testnet.stellar.org"),
  HORIZON_STELLAR_TESTNET: z.string().url().default("https://horizon-testnet.stellar.org"),
  IRIS_API_URL: z.string().url().default("https://iris-api-sandbox.circle.com"),
  RPC_AVALANCHE_MAINNET: optionalUrl,
  RPC_STELLAR_MAINNET: optionalUrl,
  HORIZON_STELLAR_MAINNET: optionalUrl,
  /** Official Circle CCTP production API host. Kept separate from the sandbox host. */
  IRIS_API_URL_MAINNET: z.string().url().default("https://iris-api.circle.com"),

  /**
   * Testnet-only developer payer. When set, `mode: "dev_signer"` lets the backend
   * sign the source burn itself. This is custody of a test key: never in mainnet.
   */
  DEV_EVM_PAYER_PRIVATE_KEY: z.string().default(""),

  // ── Monitoring: events and resources for the dashboard in tilcai-web ───────
  /** Ingest endpoint of tilcai-web (…/api/monitor/events). Empty = events stay in this database. */
  MONITOR_WEB_URL: optionalUrl,
  /** Shared with tilcai-web (MONITOR_INGEST_SECRET): signs every delivery (HMAC-SHA256). */
  MONITOR_WEB_SECRET: z.string().default(""),
  MONITOR_WEB_URL_MAINNET: optionalUrl,
  MONITOR_WEB_SECRET_MAINNET: z.string().default(""),
  /** How often a `resources.snapshot` event is taken. */
  MONITOR_RESOURCES_INTERVAL_MS: z.coerce.number().int().min(5000).default(30_000),
  MONITOR_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  /**
   * The relayer's WEBHOOK_SIGNING_KEY: authenticates POST /v1/webhooks/relayer. Empty = only
   * unsigned notifications from loopback are accepted.
   */
  RELAYER_WEBHOOK_SIGNING_KEY: z.string().default(""),
  RELAYER_WEBHOOK_SIGNING_KEY_MAINNET: z.string().default(""),

  // ── QR Simple mock (Vendis "QR Dinámico para Pagos" API v1.3) ──────────────
  /** Serves the mock under /mock/vendis. It moves no money: testnet and demos only. */
  QR_MOCK_ENABLED: flag,
  /** Credentials accepted by POST /mock/vendis/api/v1/login. */
  QR_MOCK_EMAIL: z.string().default(""),
  QR_MOCK_PASSWORD: z.string().default(""),
  /** Where the payment notification goes: the caller's …/api/v1/devices/simple-qr/callback. */
  QR_MOCK_CALLBACK_URL: optionalUrl,
  /** Base of `qr_url` as the caller sees this API. Empty = http://API_HOST:API_PORT. */
  QR_MOCK_PUBLIC_URL: optionalUrl,
  /** Opens the "Simular depósito" page to browsers that are not on this host (?key=…). */
  QR_MOCK_SIMULATOR_KEY: z.string().default(""),

  WORKER_POLL_MS: z.coerce.number().int().min(500).default(4000),
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(900),
  /** Avalanche finalizes in ~1 block; Iris still decides when to attest. */
  EVM_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(1),
  EVM_MIN_CONFIRMATIONS_MAINNET: z.coerce.number().int().min(1).default(1),
});

export type Env = z.infer<typeof schema>;

const checked = schema.superRefine((env, ctx) => {
  const need = (ok: boolean, path: keyof Env, message: string) => {
    if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
  };
  need(!env.MONITOR_WEB_URL || env.MONITOR_WEB_SECRET.length >= 16, "MONITOR_WEB_SECRET", "16+ characters with MONITOR_WEB_URL");
  need(!env.MONITOR_WEB_URL_MAINNET || env.MONITOR_WEB_SECRET_MAINNET.length >= 16, "MONITOR_WEB_SECRET_MAINNET", "16+ characters with MONITOR_WEB_URL_MAINNET");
  need(!env.QR_MOCK_ENABLED || Boolean(env.QR_MOCK_EMAIL), "QR_MOCK_EMAIL", "required with QR_MOCK_ENABLED");
  need(!env.QR_MOCK_ENABLED || env.QR_MOCK_PASSWORD.length >= 8, "QR_MOCK_PASSWORD", "8+ characters with QR_MOCK_ENABLED");
  if (env.TILCAI_ENV === "mainnet") {
    // What a mainnet process cannot run without: its own state, a relayer for each chain, the
    // gasless router and production endpoints.
    const required: Array<[keyof Env, string]> = [
      ["DATABASE_PATH_MAINNET", env.DATABASE_PATH_MAINNET],
      ["RELAYER_URL_MAINNET", env.RELAYER_URL_MAINNET],
      ["RELAYER_API_KEY_MAINNET", env.RELAYER_API_KEY_MAINNET],
      ["RELAYER_AVALANCHE_MAINNET_ID", env.RELAYER_AVALANCHE_MAINNET_ID],
      ["RELAYER_STELLAR_MAINNET_ID", env.RELAYER_STELLAR_MAINNET_ID],
      ["CCTP_ROUTER_AVALANCHE_MAINNET", env.CCTP_ROUTER_AVALANCHE_MAINNET],
      ["STELLAR_SIMULATION_SOURCE_MAINNET", env.STELLAR_SIMULATION_SOURCE_MAINNET],
      ["RPC_AVALANCHE_MAINNET", env.RPC_AVALANCHE_MAINNET],
      ["RPC_STELLAR_MAINNET", env.RPC_STELLAR_MAINNET],
      ["HORIZON_STELLAR_MAINNET", env.HORIZON_STELLAR_MAINNET],
    ];
    for (const [path, value] of required) need(Boolean(value), path, "required in mainnet");
    // Everything else is a feature that stays off until its contract is deployed and verified:
    // smart accounts (factory, router v2, EntryPoint), the vaults, x402 and the relayer webhooks.
    need(!env.ACCOUNT_FACTORY_AVALANCHE_MAINNET || Boolean(env.ERC4337_ENTRYPOINT_AVALANCHE_MAINNET), "ERC4337_ENTRYPOINT_AVALANCHE_MAINNET", "required with ACCOUNT_FACTORY_AVALANCHE_MAINNET");
    need(!env.CCTP_ROUTER_V2_AVALANCHE_MAINNET || Boolean(env.ACCOUNT_FACTORY_AVALANCHE_MAINNET), "ACCOUNT_FACTORY_AVALANCHE_MAINNET", "required with CCTP_ROUTER_V2_AVALANCHE_MAINNET");
    need(env.TILCAI_API_KEYS_MAINNET.length > 0, "TILCAI_API_KEYS_MAINNET", "at least one key is required in mainnet");
    need(env.DATABASE_PATH_MAINNET !== env.DATABASE_PATH, "DATABASE_PATH_MAINNET", "must be separate from testnet");
    // One OpenZeppelin Relayer may serve both environments (same URL and key): what keeps them
    // apart is the relayer id, which selects the network and the account that signs.
    need(env.RELAYER_AVALANCHE_MAINNET_ID !== env.RELAYER_FUJI_ID, "RELAYER_AVALANCHE_MAINNET_ID", "must be separate from testnet");
    need(env.RELAYER_STELLAR_MAINNET_ID !== env.RELAYER_STELLAR_ID, "RELAYER_STELLAR_MAINNET_ID", "must be separate from testnet");
    need(env.RELAYER_AVALANCHE_MAINNET_ID !== env.RELAYER_STELLAR_MAINNET_ID, "RELAYER_STELLAR_MAINNET_ID", "must not be the Avalanche relayer");
    need(!env.TILCAI_API_KEYS_MAINNET.some((key) => env.TILCAI_API_KEYS.includes(key)), "TILCAI_API_KEYS_MAINNET", "must not reuse testnet keys");
    need(!env.MONITOR_WEB_SECRET || env.MONITOR_WEB_SECRET_MAINNET !== env.MONITOR_WEB_SECRET, "MONITOR_WEB_SECRET_MAINNET", "must not reuse the testnet secret");
    need(!env.RELAYER_WEBHOOK_SIGNING_KEY || env.RELAYER_WEBHOOK_SIGNING_KEY_MAINNET !== env.RELAYER_WEBHOOK_SIGNING_KEY, "RELAYER_WEBHOOK_SIGNING_KEY_MAINNET", "must not reuse the testnet key");
    need(env.RPC_AVALANCHE_MAINNET !== env.RPC_AVALANCHE_FUJI, "RPC_AVALANCHE_MAINNET", "must be separate from testnet");
    need(env.RPC_STELLAR_MAINNET !== env.RPC_STELLAR_TESTNET, "RPC_STELLAR_MAINNET", "must be separate from testnet");
    need(env.HORIZON_STELLAR_MAINNET !== env.HORIZON_STELLAR_TESTNET, "HORIZON_STELLAR_MAINNET", "must be separate from testnet");
    const distinctAddress = (mainnet: string, testnet: string, path: keyof Env) => need(!mainnet || !testnet || mainnet.toLowerCase() !== testnet.toLowerCase(), path, "must not reuse the testnet address");
    distinctAddress(env.CCTP_ROUTER_AVALANCHE_MAINNET, env.CCTP_ROUTER_FUJI, "CCTP_ROUTER_AVALANCHE_MAINNET");
    distinctAddress(env.CCTP_ROUTER_V2_AVALANCHE_MAINNET, env.CCTP_ROUTER_V2_FUJI, "CCTP_ROUTER_V2_AVALANCHE_MAINNET");
    distinctAddress(env.ACCOUNT_FACTORY_AVALANCHE_MAINNET, env.ACCOUNT_FACTORY_FUJI, "ACCOUNT_FACTORY_AVALANCHE_MAINNET");
    distinctAddress(env.VAULT_AVALANCHE_MAINNET, env.VAULT_FUJI, "VAULT_AVALANCHE_MAINNET");
    distinctAddress(env.ACCOUNT_FACTORY_STELLAR_MAINNET, env.ACCOUNT_FACTORY_STELLAR, "ACCOUNT_FACTORY_STELLAR_MAINNET");
    distinctAddress(env.VAULT_STELLAR_MAINNET, env.VAULT_STELLAR, "VAULT_STELLAR_MAINNET");
    const evmContracts = [env.CCTP_ROUTER_AVALANCHE_MAINNET, env.CCTP_ROUTER_V2_AVALANCHE_MAINNET, env.ACCOUNT_FACTORY_AVALANCHE_MAINNET, env.VAULT_AVALANCHE_MAINNET].filter(Boolean).map((value) => value.toLowerCase());
    need(new Set(evmContracts).size === evmContracts.length, "CCTP_ROUTER_AVALANCHE_MAINNET", "mainnet EVM contract addresses must be distinct");
    need(!env.ACCOUNT_FACTORY_STELLAR_MAINNET || env.ACCOUNT_FACTORY_STELLAR_MAINNET !== env.VAULT_STELLAR_MAINNET, "ACCOUNT_FACTORY_STELLAR_MAINNET", "mainnet Stellar contract addresses must be distinct");
    need(!env.DEV_EVM_PAYER_PRIVATE_KEY, "DEV_EVM_PAYER_PRIVATE_KEY", "forbidden in mainnet");
    need(!env.STELLAR_OPERATOR_SECRET, "STELLAR_OPERATOR_SECRET", "local signing is forbidden in mainnet");
    need(env.STELLAR_MINT_SUBMITTER === "relayer", "STELLAR_MINT_SUBMITTER", "must be relayer in mainnet");
    need(!env.QR_MOCK_ENABLED, "QR_MOCK_ENABLED", "forbidden in mainnet");
    for (const key of ["RPC_AVALANCHE_MAINNET", "RPC_STELLAR_MAINNET", "HORIZON_STELLAR_MAINNET", "IRIS_API_URL_MAINNET"] as const) {
      need(!/(test|fuji|sandbox)/i.test(env[key]), key, "must not point to a test network");
    }
  }
});

/** Values selected for the process environment. Consumers never choose testnet/mainnet piecemeal. */
export function activeConfig(env: Env) {
  if (env.TILCAI_ENV === "mainnet") {
    return {
      databasePath: env.DATABASE_PATH_MAINNET,
      apiKeys: env.TILCAI_API_KEYS_MAINNET,
      relayerUrl: env.RELAYER_URL_MAINNET,
      relayerApiKey: env.RELAYER_API_KEY_MAINNET,
      evmRelayerId: env.RELAYER_AVALANCHE_MAINNET_ID,
      stellarRelayerId: env.RELAYER_STELLAR_MAINNET_ID,
      x402PluginId: env.RELAYER_X402_PLUGIN_ID_MAINNET,
      stellarSimulationSource: env.STELLAR_SIMULATION_SOURCE_MAINNET,
      irisApiUrl: env.IRIS_API_URL_MAINNET,
      evmMinConfirmations: env.EVM_MIN_CONFIRMATIONS_MAINNET,
      transactionsEnabled: env.MAINNET_TRANSACTIONS_ENABLED,
      monitorWebUrl: env.MONITOR_WEB_URL_MAINNET,
      monitorWebSecret: env.MONITOR_WEB_SECRET_MAINNET,
      relayerWebhookSigningKey: env.RELAYER_WEBHOOK_SIGNING_KEY_MAINNET,
    };
  }
  return {
    databasePath: env.DATABASE_PATH,
    apiKeys: env.TILCAI_API_KEYS,
    relayerUrl: env.RELAYER_URL,
    relayerApiKey: env.RELAYER_API_KEY,
    evmRelayerId: env.RELAYER_FUJI_ID,
    stellarRelayerId: env.RELAYER_STELLAR_ID,
    x402PluginId: env.RELAYER_X402_PLUGIN_ID,
    stellarSimulationSource: env.STELLAR_SIMULATION_SOURCE,
    irisApiUrl: env.IRIS_API_URL,
    evmMinConfirmations: env.EVM_MIN_CONFIRMATIONS,
    transactionsEnabled: true,
    monitorWebUrl: env.MONITOR_WEB_URL,
    monitorWebSecret: env.MONITOR_WEB_SECRET,
    relayerWebhookSigningKey: env.RELAYER_WEBHOOK_SIGNING_KEY,
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = checked.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return parsed.data;
}
