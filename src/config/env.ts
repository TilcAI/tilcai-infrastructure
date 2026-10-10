import "dotenv/config";
import { z } from "zod";

/**
 * Process configuration. Validated once at startup; secrets are never logged.
 * Only testnet is enabled in this phase: mainnet values are rejected on purpose.
 */
const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

const flag = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");
const optionalUrl = z.string().url().or(z.literal("")).default("");

const schema = z.object({
  TILCAI_ENV: z.literal("testnet").default("testnet"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Service-to-service bearer keys for the HTTP API (phase 1). */
  TILCAI_API_KEYS: csv,

  DATABASE_PATH: z.string().default("./data/tilcai.db"),

  // OpenZeppelin Relayer (same host in production → localhost).
  RELAYER_URL: z.string().url().default("http://localhost:8080"),
  RELAYER_API_KEY: z.string().default(""),
  RELAYER_STELLAR_ID: z.string().default("stellar-example"),
  /** OZ Relayer id that submits the gasless Fuji burn (TilcaiCctpRouter.payWithAuthorization). */
  RELAYER_FUJI_ID: z.string().default("avalanche-fuji-relayer"),
  /** Deployed TilcaiCctpRouter on Avalanche Fuji (enables gasless modes). */
  CCTP_ROUTER_FUJI: z.string().regex(/^0x[0-9a-fA-F]{40}$/).or(z.literal("")).default(""),
  /**
   * Fase SCA: deployed TilcaiAccountFactory on Avalanche Fuji (enables /v1/accounts) and
   * TilcaiCctpRouterV2 (enables `mode: "account"` payments). `npm run sca -- deploy` prints both.
   */
  ACCOUNT_FACTORY_FUJI: z.string().regex(/^0x[0-9a-fA-F]{40}$/).or(z.literal("")).default(""),
  CCTP_ROUTER_V2_FUJI: z.string().regex(/^0x[0-9a-fA-F]{40}$/).or(z.literal("")).default(""),
  /**
   * Deployed TilcaiVault on Avalanche Fuji (enables /v1/vault). Its operator must be the
   * RELAYER_FUJI_ID account, which sends the payouts.
   */
  VAULT_FUJI: z.string().regex(/^0x[0-9a-fA-F]{40}$/).or(z.literal("")).default(""),
  /**
   * Fase SCA on Stellar: deployed `tilcai_account_factory` (enables /v1/accounts on stellar:testnet)
   * and `tilcai_vault` (enables /v1/vault?network=stellar:testnet). `contracts/soroban/deploy-testnet.sh`
   * prints both. The vault's operator must be the RELAYER_STELLAR_ID account.
   */
  ACCOUNT_FACTORY_STELLAR: z.string().regex(/^C[A-Z2-7]{55}$/).or(z.literal("")).default(""),
  VAULT_STELLAR: z.string().regex(/^C[A-Z2-7]{55}$/).or(z.literal("")).default(""),
  RELAYER_X402_PLUGIN_ID: z.string().default("x402"),

  /** Who submits `CctpForwarder.mint_and_forward` on Stellar. */
  STELLAR_MINT_SUBMITTER: z.enum(["relayer", "local"]).default("relayer"),
  /** Only for STELLAR_MINT_SUBMITTER=local: an operator account that pays XLM fees. */
  STELLAR_OPERATOR_SECRET: z.string().default(""),
  /** Any existing G… account used as source for read-only Soroban simulations. */
  STELLAR_SIMULATION_SOURCE: z.string().default(""),

  RPC_AVALANCHE_FUJI: z.string().url().default("https://api.avax-test.network/ext/bc/C/rpc"),
  RPC_STELLAR_TESTNET: z.string().url().default("https://soroban-testnet.stellar.org"),
  HORIZON_STELLAR_TESTNET: z.string().url().default("https://horizon-testnet.stellar.org"),
  IRIS_API_URL: z.string().url().default("https://iris-api-sandbox.circle.com"),

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
  /** How often a `resources.snapshot` event is taken. */
  MONITOR_RESOURCES_INTERVAL_MS: z.coerce.number().int().min(5000).default(30_000),
  MONITOR_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  /**
   * The relayer's WEBHOOK_SIGNING_KEY: authenticates POST /v1/webhooks/relayer. Empty = only
   * unsigned notifications from loopback are accepted.
   */
  RELAYER_WEBHOOK_SIGNING_KEY: z.string().default(""),

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
});

export type Env = z.infer<typeof schema>;

const checked = schema.superRefine((env, ctx) => {
  const need = (ok: boolean, path: keyof Env, message: string) => {
    if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
  };
  need(!env.MONITOR_WEB_URL || env.MONITOR_WEB_SECRET.length >= 16, "MONITOR_WEB_SECRET", "16+ characters with MONITOR_WEB_URL");
  need(!env.QR_MOCK_ENABLED || Boolean(env.QR_MOCK_EMAIL), "QR_MOCK_EMAIL", "required with QR_MOCK_ENABLED");
  need(!env.QR_MOCK_ENABLED || env.QR_MOCK_PASSWORD.length >= 8, "QR_MOCK_PASSWORD", "8+ characters with QR_MOCK_ENABLED");
});

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = checked.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return parsed.data;
}
