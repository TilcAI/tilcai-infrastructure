/** Offline child process for the relayer:check CLI tests. No HTTP or chain clients. */
import { RelayerHttpError } from "../../src/modules/relayer/client.ts";
import { runRelayerCheck, type RelayerCheckDeps } from "../../src/apps/cli/relayer-check-run.ts";

const scenario = process.argv[2] ?? "success";
const secret = "fake-api-key-never-print-this";
const mainnet = scenario === "mainnet_optional_plugin";
const stellarNetwork = mainnet
  ? { id: "stellar:pubnet" as const, name: "Stellar Public Network", relayerNetwork: "mainnet" }
  : { id: "stellar:testnet" as const, name: "Stellar Testnet", relayerNetwork: "testnet" };
const stellar = { id: "stellar-example", name: "Stellar", network: stellarNetwork.relayerNetwork, network_type: "stellar", paused: false };

const client: RelayerCheckDeps["client"] = {
  async health() { return scenario !== "health_failed" && scenario !== "combined"; },
  async x402() {
    if (scenario === "key_missing" || mainnet) throw new Error("unexpected x402 call");
    if (scenario === "transport") throw new Error(secret);
    if (scenario === "http_auth_x402") throw new RelayerHttpError(401, secret);
    if (scenario === "http_500") return { status: 500, body: { token: secret } };
    if (scenario === "supported_invalid" || scenario === "combined") return { status: 200, body: { kinds: secret } };
    if (scenario === "supported_partial_invalid") return { status: 200, body: { kinds: [{ network: stellarNetwork.id, scheme: "exact" }, { token: secret }] } };
    if (scenario === "supported_missing") return { status: 200, body: { kinds: [] } };
    return { status: 200, body: { kinds: [{ network: stellarNetwork.id, scheme: "exact" }] } };
  },
  async listRelayers() {
    if (scenario === "key_missing") throw new Error("unexpected list call");
    if (scenario === "http_auth_list") throw new RelayerHttpError(401, secret);
    if (scenario === "transport") throw new Error(secret);
    if (scenario === "invalid_list") return { token: secret } as never;
    if (scenario === "list_empty") return [];
    if (scenario === "wrong_id") return [{ ...stellar, id: "another-relayer" }];
    if (scenario === "wrong_network" || scenario === "combined") return [{ ...stellar, network: "mainnet" }];
    if (scenario === "wrong_type") return [{ ...stellar, network_type: "evm" }];
    if (scenario === "paused") return [{ ...stellar, paused: true }];
    if (scenario === "disallowed") return [stellar, { ...stellar, id: "unexpected-mainnet", network: "mainnet" }];
    return [stellar];
  },
  async getRelayer() {
    if (scenario === "http_auth_detail") throw new RelayerHttpError(401, secret);
    if (scenario === "invalid_detail") return { address: { token: secret } };
    return { address: "GFAKESTELLARACCOUNT" };
  },
  async getBalance() {
    if (scenario === "http_auth_balance") throw new RelayerHttpError(401, secret);
    return { balance: "10", unit: "XLM" };
  },
};

process.exitCode = await runRelayerCheck({
  client,
  environment: mainnet ? "mainnet" : "testnet",
  apiKeySet: scenario !== "key_missing",
  x402PluginId: mainnet || scenario === "plugin_missing" ? "" : "x402",
  stellarRelayerId: stellar.id,
  stellarNetwork,
  accountStatus: async () => {
    if (scenario === "health_failed" || scenario === "combined" || scenario === "wrong_network") throw new Error("unexpected account call");
    if (scenario === "account_transport") throw new Error(secret);
    return { exists: scenario !== "account_missing" };
  },
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
});
