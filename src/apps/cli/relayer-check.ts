/**
 * Checks the OpenZeppelin Relayer that TilcAI depends on: liveness, auth,
 * x402 plugin `/supported`, configured relayers and the Stellar relayer account.
 *   npm run relayer:check
 */
import { activeConfig, loadEnv } from "../../config/env.ts";
import { networks } from "../../config/networks.ts";
import { RelayerClient } from "../../modules/relayer/client.ts";
import { SorobanStellarCctp } from "../../modules/crosschain/adapters/stellar.ts";

const env = loadEnv();
const active = activeConfig(env);
const nets = networks(env);
const r = new RelayerClient(active.relayerUrl, active.relayerApiKey);
const line = (ok: boolean, label: string, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -> ${detail}` : ""}`);

console.log(`Relayer ${active.relayerUrl}`);
const up = await r.health();
line(up, "GET /api/v1/health");
if (!up) process.exit(1);
if (!active.relayerApiKey) {
  console.log("RELAYER_API_KEY not set: stopping after the unauthenticated checks.");
  process.exit(1);
}
const sup = await r.x402(active.x402PluginId, "/supported").catch((e) => ({ status: 0, body: String(e) }));
const kind = sup.body?.kinds?.find((k: any) => k.network === nets.stellar.id);
line(sup.status === 200 && Boolean(kind), `x402 /supported advertises ${nets.stellar.id}`, JSON.stringify(kind ?? sup.body).slice(0, 160));
const relayers = await r.listRelayers().catch((e) => (console.log(String(e)), []));
line(relayers.length > 0, "GET /api/v1/relayers", relayers.map((x) => `${x.id}(${x.network_type}:${x.network}${x.paused ? ",paused" : ""})`).join(" "));
if (env.TILCAI_ENV === "testnet") {
  const mainnet = relayers.filter((x) => !/test|sepolia|fuji|devnet/i.test(x.network));
  line(mainnet.length === 0, "no mainnet relayers enabled", mainnet.map((x) => x.id).join(",") || "none");
}
const st = relayers.find((x) => x.id === active.stellarRelayerId);
line(Boolean(st), `stellar relayer '${active.stellarRelayerId}' exists`);
if (st) {
  const full = await r.getRelayer(st.id);
  const address = String(full.address ?? "");
  const acct = await new SorobanStellarCctp(nets.stellar).accountStatus(address);
  const bal = await r.getBalance(st.id).catch(() => null);
  line(acct.exists, `stellar relayer account exists on ${nets.stellar.name}`, `${address} balance=${bal ? `${bal.balance} ${bal.unit}` : "?"}`);
}
