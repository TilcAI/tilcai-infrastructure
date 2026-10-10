/** Read-only Mainnet readiness checks. No wallet, signer or transaction method is constructed. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { createPublicClient, http, type Hex } from "viem";
import { loadEnv } from "../../config/env.ts";
import { AVALANCHE_MAINNET, STELLAR_MAINNET } from "../../config/networks.ts";
import { assertPreparationOnlyEnv, check, EVM_ARTIFACT_PATHS, sha256File, type PreflightCheck } from "../../mainnet/deployment.ts";

const { values } = parseArgs({ options: { offline: { type: "boolean", default: false }, json: { type: "boolean", default: false } } });
assertPreparationOnlyEnv(process.env);
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const checks: PreflightCheck[] = [];
const add = (state: PreflightCheck["state"], area: string, name: string, detail: string) => checks.push(check(state, area, name, detail));
const pendingEnv = (name: string, area = "config") => {
  const value = process.env[name];
  add(value ? "PASS" : "PENDING", area, name, value ? "configured (value redacted)" : "not configured");
  return value;
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 240);
const unavailable = (e: unknown) => /HTTP request failed|fetch failed|timed? out|ENOTFOUND|ECONN|ETIMEDOUT|\b429\b|\b503\b/i.test(errorText(e));
const readFailure = (e: unknown) => unavailable(e)
  ? "endpoint unavailable or rate-limited; inspect its URL and credentials privately"
  : `unexpected read error (${e instanceof Error ? e.name : "unknown"}); inspect locally`;

add(process.env.MAINNET_TRANSACTIONS_ENABLED === "true" || process.env.MAINNET_TRANSACTIONS_ENABLED === "1" ? "FAIL" : "PASS", "safety", "transactions disabled", "MAINNET_TRANSACTIONS_ENABLED must be false");
for (const name of [
  "MAINNET_EVM_DEPLOYER", "MAINNET_EVM_VAULT_OWNER", "MAINNET_EVM_VAULT_OPERATOR",
  "MAINNET_STELLAR_DEPLOYER", "MAINNET_STELLAR_VAULT_OWNER", "MAINNET_STELLAR_VAULT_OPERATOR",
  "RELAYER_URL_MAINNET", "RELAYER_API_KEY_MAINNET", "RELAYER_AVALANCHE_MAINNET_ID", "RELAYER_STELLAR_MAINNET_ID",
  "RELAYER_X402_PLUGIN_ID_MAINNET", "RELAYER_WEBHOOK_SIGNING_KEY_MAINNET",
]) pendingEnv(name);
const runtimeRequired = [
  "TILCAI_API_KEYS_MAINNET", "DATABASE_PATH_MAINNET", "RELAYER_URL_MAINNET", "RELAYER_API_KEY_MAINNET",
  "RELAYER_AVALANCHE_MAINNET_ID", "RELAYER_STELLAR_MAINNET_ID", "RELAYER_X402_PLUGIN_ID_MAINNET",
  "RELAYER_WEBHOOK_SIGNING_KEY_MAINNET", "RPC_AVALANCHE_MAINNET", "RPC_STELLAR_MAINNET",
  "HORIZON_STELLAR_MAINNET", "STELLAR_SIMULATION_SOURCE_MAINNET",
  "CCTP_ROUTER_AVALANCHE_MAINNET", "CCTP_ROUTER_V2_AVALANCHE_MAINNET",
  "ACCOUNT_FACTORY_AVALANCHE_MAINNET", "VAULT_AVALANCHE_MAINNET",
  "ERC4337_ENTRYPOINT_AVALANCHE_MAINNET", "ACCOUNT_FACTORY_STELLAR_MAINNET", "VAULT_STELLAR_MAINNET",
] as const;
const missingRuntime = runtimeRequired.filter((name) => !process.env[name]);
if (missingRuntime.length) {
  add("PENDING", "config", "full Mainnet runtime validation", `missing ${missingRuntime.join(", ")}`);
} else {
  try {
    loadEnv({ ...process.env, TILCAI_ENV: "mainnet" });
    add("PASS", "config", "full Mainnet runtime validation", "schema accepted (values redacted)");
  } catch (e) {
    add("FAIL", "config", "full Mainnet runtime validation", errorText(e));
  }
}
if (process.env.MAINNET_EVM_DEPLOYER && process.env.MAINNET_EVM_VAULT_OWNER) {
  add(process.env.MAINNET_EVM_DEPLOYER.toLowerCase() !== process.env.MAINNET_EVM_VAULT_OWNER.toLowerCase() ? "PASS" : "FAIL", "config", "deployer is not final owner", "separate operational roles required");
}

for (const [name, path] of Object.entries(EVM_ARTIFACT_PATHS)) {
  const full = repo(path);
  add(existsSync(full) ? "PASS" : "PENDING", "artifacts", name, existsSync(full) ? `sha256 ${sha256File(full)}` : `missing ${path}`);
}
for (const name of ["tilcai_account", "tilcai_ed25519_verifier", "tilcai_webauthn_verifier", "tilcai_account_factory", "tilcai_vault"]) {
  const path = repo(`contracts/soroban/target/wasm32v1-none/release/${name}.wasm`);
  add(existsSync(path) ? "PASS" : "PENDING", "artifacts", `${name}.wasm`, existsSync(path) ? `sha256 ${sha256File(path)}` : "run a local stellar contract build");
}

const tool = (area: string, bin: string, args: string[], fallback?: string) => {
  try {
    const output = execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0]!;
    add("PASS", area, bin, output);
  } catch {
    if (fallback) return tool(area, fallback, args);
    add("PENDING", area, bin, "not available in this shell");
  }
};
tool("tools", "forge", ["--version"], `${homedir()}/.foundry/bin/forge`);
tool("tools", "stellar", ["--version"]);
tool("tools", "rustc", ["--version"]);

const relayerConfigPath = repo("deploy/relayer/config/config.mainnet.json");
if (!existsSync(relayerConfigPath)) add("FAIL", "relayer", "Mainnet config", "deploy/relayer/config/config.mainnet.json is missing");
else {
  try {
    const config = JSON.parse(readFileSync(relayerConfigPath, "utf8")) as { relayers?: Array<{ id: string; paused: boolean; signer_id: string }>; plugins?: Array<{ id: string; config?: { networks?: Array<{ network: string }> } }> };
    const ids = new Set((config.relayers ?? []).map((r) => r.id));
    const signers = new Set((config.relayers ?? []).map((r) => r.signer_id));
    const caip = new Set((config.plugins ?? []).flatMap((p) => p.config?.networks?.map((n) => n.network) ?? []));
    add(ids.has("avalanche-mainnet-relayer") && ids.has("stellar-mainnet-relayer") ? "PASS" : "FAIL", "relayer", "independent IDs", [...ids].join(", "));
    add(signers.size === 2 ? "PASS" : "FAIL", "relayer", "independent signers", `${signers.size} signer definitions referenced`);
    add((config.relayers ?? []).every((r) => r.paused) ? "PASS" : "FAIL", "relayer", "relayers paused", "phase 2 requires paused=true");
    add(caip.has(AVALANCHE_MAINNET.id) && caip.has(STELLAR_MAINNET.id) ? "PASS" : "FAIL", "relayer", "x402 CAIP-2 identifiers configured", [...caip].join(", "));
    add("PENDING", "relayer", "EVM receiver allowlist", "fill with verified TilcAI contract addresses after deployment; relayers remain paused meanwhile");
  } catch (e) {
    add("FAIL", "relayer", "Mainnet config parses", errorText(e));
  }
}

if (values.offline) {
  add("PENDING", "avalanche", "on-chain checks", "offline mode: RPC reads not attempted");
  add("PENDING", "stellar", "on-chain checks", "offline mode: RPC/Horizon reads not attempted");
} else {
  const evmRpc = process.env.RPC_AVALANCHE_MAINNET ?? "https://api.avax.network/ext/bc/C/rpc";
  const client = createPublicClient({
    chain: { id: AVALANCHE_MAINNET.chainId, name: "Avalanche C-Chain", nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 }, rpcUrls: { default: { http: [evmRpc] } } },
    transport: http(evmRpc, { timeout: 15_000, retryCount: 1 }),
  });
  try {
    const chainId = await client.getChainId();
    add(chainId === AVALANCHE_MAINNET.chainId ? "PASS" : "FAIL", "avalanche", "chain ID", String(chainId));
    for (const [name, address] of [["USDC", AVALANCHE_MAINNET.usdc], ["TokenMessengerV2", AVALANCHE_MAINNET.tokenMessengerV2], ["MessageTransmitterV2", AVALANCHE_MAINNET.messageTransmitterV2]] as const) {
      const code = await client.getCode({ address });
      add(code && code !== "0x" ? "PASS" : "FAIL", "avalanche", `${name} deployed`, address);
    }
    const entryPoint = process.env.ERC4337_ENTRYPOINT_AVALANCHE_MAINNET as Hex | undefined;
    if (!entryPoint) add("PENDING", "avalanche", "EntryPoint v0.9", "address not approved/configured");
    else {
      const code = await client.getCode({ address: entryPoint });
      add(code && code !== "0x" ? "PASS" : "FAIL", "avalanche", "EntryPoint v0.9 bytecode exists", entryPoint);
    }
    const vector = `0x${["bb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023", "2ba3a8be6b94d5ec80a6d9d1190a436effe50d85a1eee859b8cc6af9bd5c2e18", "4cd60b855d442f5b3c7b11eb6c4e0ae7525fe710fab9aa7c77a67f79e6fadd76", "2927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838", "c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e"].join("")}` as Hex;
    const p256 = await client.call({ to: AVALANCHE_MAINNET.p256Precompile, data: vector });
    add(p256.data !== undefined && BigInt(p256.data) === 1n ? "PASS" : "FAIL", "avalanche", "P-256 precompile", AVALANCHE_MAINNET.p256Precompile);
    add("PENDING", "avalanche", "USDC ERC-1271 authorization overload", "bytecode selector search cannot prove proxy behavior; requires a read-only fork simulation with the approved contract and signature");
  } catch (e) {
    add(unavailable(e) ? "PENDING" : "FAIL", "avalanche", "RPC read suite", readFailure(e));
  }

  const stellarRpc = process.env.RPC_STELLAR_MAINNET ?? "https://soroban-rpc.mainnet.stellar.gateway.fm";
  const horizon = (process.env.HORIZON_STELLAR_MAINNET ?? "https://horizon.stellar.org").replace(/\/$/, "");
  try {
    const server = new rpc.Server(stellarRpc);
    const network = await server.getNetwork();
    add(network.passphrase === STELLAR_MAINNET.passphrase ? "PASS" : "FAIL", "stellar", "network passphrase", network.passphrase);
    const instance = xdr.ScVal.scvLedgerKeyContractInstance();
    for (const [name, address] of [["USDC SAC", STELLAR_MAINNET.usdcSac], ["TokenMessengerMinter", STELLAR_MAINNET.tokenMessengerMinter], ["MessageTransmitter", STELLAR_MAINNET.messageTransmitter], ["CctpForwarder", STELLAR_MAINNET.cctpForwarder]] as const) {
      const found = await server.getContractData(address, instance).then(() => true, () => false);
      add(found ? "PASS" : "FAIL", "stellar", `${name} exists`, address);
    }
    const horizonResponse = await fetch(horizon, { signal: AbortSignal.timeout(15_000) });
    add(horizonResponse.ok ? "PASS" : "FAIL", "stellar", "Horizon reachable", `${horizon} HTTP ${horizonResponse.status}`);
    for (const name of ["MAINNET_STELLAR_DEPLOYER", "MAINNET_STELLAR_VAULT_OWNER", "MAINNET_STELLAR_VAULT_OPERATOR"]) {
      const account = process.env[name];
      if (!account) continue;
      const response = await fetch(`${horizon}/accounts/${encodeURIComponent(account)}`, { signal: AbortSignal.timeout(15_000) });
      add(response.ok ? "PASS" : "FAIL", "stellar", `${name} exists`, `HTTP ${response.status}`);
    }
    add("PENDING", "stellar", "Soroban resource fee/reserve/TTL budget", "requires deployment simulations with an approved public source account; no transaction built in this run");
  } catch (e) {
    add(unavailable(e) ? "PENDING" : "FAIL", "stellar", "RPC/Horizon read suite", readFailure(e));
  }

  const relayerUrl = process.env.RELAYER_URL_MAINNET?.replace(/\/$/, "");
  const relayerKey = process.env.RELAYER_API_KEY_MAINNET;
  const pluginId = process.env.RELAYER_X402_PLUGIN_ID_MAINNET;
  if (!relayerUrl || !relayerKey || !pluginId) {
    add("PENDING", "relayer", "x402 runtime /supported", "requires the isolated paused Mainnet Relayer URL, API key and plugin ID");
  } else {
    try {
      const response = await fetch(`${relayerUrl}/api/v1/plugins/${encodeURIComponent(pluginId)}/call/supported`, {
        headers: { Authorization: `Bearer ${relayerKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json() as { kinds?: Array<{ network?: string }> };
      const advertised = new Set(body.kinds?.map((kind) => kind.network) ?? []);
      add(response.ok && advertised.has(AVALANCHE_MAINNET.id) && advertised.has(STELLAR_MAINNET.id) ? "PASS" : "FAIL", "relayer", "x402 runtime /supported", `${response.status}: ${[...advertised].join(", ")}`);
    } catch (e) {
      add(unavailable(e) ? "PENDING" : "FAIL", "relayer", "x402 runtime /supported", readFailure(e));
    }
  }
}

const counts = { PASS: 0, FAIL: 0, PENDING: 0 };
for (const item of checks) counts[item.state]++;
if (values.json) console.log(JSON.stringify({ mode: values.offline ? "OFFLINE_READ_ONLY" : "ONLINE_READ_ONLY", counts, checks }, null, 2));
else {
  for (const item of checks) console.log(`${item.state.padEnd(7)} ${item.area.padEnd(10)} ${item.name} -> ${item.detail}`);
  console.log(`\nPASS ${counts.PASS} · FAIL ${counts.FAIL} · PENDING ${counts.PENDING}`);
}
process.exitCode = counts.FAIL > 0 ? 1 : counts.PENDING > 0 ? 2 : 0;
