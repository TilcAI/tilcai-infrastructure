/**
 * Checks the OpenZeppelin Relayer that TilcAI depends on: liveness, auth,
 * x402 plugin `/supported`, configured relayers and the Stellar relayer account.
 *   npm run relayer:check
 */
import { loadEnv } from "../../config/env.ts";
import { networks } from "../../config/networks.ts";
import { RelayerClient } from "../../modules/relayer/client.ts";
import { SorobanStellarCctp } from "../../modules/crosschain/adapters/stellar.ts";

const env = loadEnv();
const nets = networks(env);
const r = new RelayerClient(env.RELAYER_URL, env.RELAYER_API_KEY);
const line = (ok: boolean, label: string, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -> ${detail}` : ""}`);

console.log(`Relayer ${env.RELAYER_URL}`);
const up = await r.health();
line(up, "GET /api/v1/health");
if (!up) process.exit(1);
if (!env.RELAYER_API_KEY) {
  console.log("RELAYER_API_KEY not set: stopping after the unauthenticated checks.");
  process.exit(1);
}
const sup = await r.x402(env.RELAYER_X402_PLUGIN_ID, "/supported").catch((e) => ({ status: 0, body: String(e) }));
const kind = sup.body?.kinds?.find((k: any) => k.network === "stellar:testnet");
line(sup.status === 200 && Boolean(kind), "x402 /supported advertises stellar:testnet", JSON.stringify(kind ?? sup.body).slice(0, 160));
const relayers = await r.listRelayers().catch((e) => (console.log(String(e)), []));
line(relayers.length > 0, "GET /api/v1/relayers", relayers.map((x) => `${x.id}(${x.network_type}:${x.network}${x.paused ? ",paused" : ""})`).join(" "));
const mainnet = relayers.filter((x) => !/test|sepolia|fuji|devnet/i.test(x.network));
line(mainnet.length === 0, "no mainnet relayers enabled", mainnet.map((x) => x.id).join(",") || "none");
const st = relayers.find((x) => x.id === env.RELAYER_STELLAR_ID);
line(Boolean(st), `stellar relayer '${env.RELAYER_STELLAR_ID}' exists`);
if (st) {
  const full = await r.getRelayer(st.id);
  const address = String(full.address ?? "");
  const acct = await new SorobanStellarCctp(nets.stellarTestnet).accountStatus(address);
  const bal = await r.getBalance(st.id).catch(() => null);
  line(acct.exists, "stellar relayer account exists on testnet", `${address} balance=${bal ? `${bal.balance} ${bal.unit}` : "?"}`);
}
