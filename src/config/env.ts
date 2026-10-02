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

  WORKER_POLL_MS: z.coerce.number().int().min(500).default(4000),
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(900),
  /** Avalanche finalizes in ~1 block; Iris still decides when to attest. */
  EVM_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(1),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return parsed.data;
}
