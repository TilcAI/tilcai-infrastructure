import { RelayerHttpError, type RelayerClient } from "../../modules/relayer/client.ts";
import type { StellarNetwork } from "../../config/networks.ts";

type Listed = Awaited<ReturnType<RelayerClient["listRelayers"]>>;

export interface RelayerCheckDeps {
  client: Pick<RelayerClient, "health" | "x402" | "listRelayers" | "getRelayer" | "getBalance">;
  environment: "testnet" | "mainnet";
  apiKeySet: boolean;
  x402PluginId: string;
  stellarRelayerId: string;
  stellarNetwork: Pick<StellarNetwork, "id" | "name" | "relayerNetwork">;
  accountStatus: (address: string) => Promise<{ exists: boolean }>;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validList = (value: unknown): value is Listed => Array.isArray(value) && value.every((item) =>
  record(item) && typeof item.id === "string" && typeof item.network === "string" &&
  typeof item.network_type === "string" && typeof item.paused === "boolean");
const failure = (error: unknown) => error instanceof RelayerHttpError ? `HTTP ${error.status}` : "request failed";

/** Return the process exit code; never print raw responses or exception messages. */
export async function runRelayerCheck(deps: RelayerCheckDeps): Promise<number> {
  let failures = 0;
  const line = (ok: boolean, label: string, detail = "") => {
    if (!ok) failures++;
    deps.stdout(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -> ${detail}` : ""}`);
  };
  const finish = () => {
    if (failures) deps.stderr(`relayer:check: ${failures} check(s) failed`);
    return failures ? 1 : 0;
  };

  deps.stdout("Relayer check");
  const up = await deps.client.health().catch(() => false);
  line(up, "GET /api/v1/health");
  line(deps.apiKeySet, "relayer API key configured");
  if (!deps.apiKeySet) {
    deps.stdout("Authenticated checks skipped: relayer API key is absent.");
    return finish();
  }

  if (!deps.x402PluginId && deps.environment === "mainnet") {
    deps.stdout("SKIP  x402 /supported: plugin is not configured in mainnet");
  } else if (!deps.x402PluginId) {
    line(false, "x402 /supported", "plugin id is absent");
  } else {
    try {
      const supported = await deps.client.x402(deps.x402PluginId, "/supported");
      const kinds = record(supported.body) ? supported.body.kinds : undefined;
      if (supported.status !== 200) line(false, "x402 /supported", `HTTP ${supported.status}`);
      else if (!Array.isArray(kinds) || !kinds.every((kind) => record(kind) && typeof kind.network === "string" && typeof kind.scheme === "string")) {
        line(false, "x402 /supported", "invalid response");
      } else line(kinds.some((kind) => kind.network === deps.stellarNetwork.id && kind.scheme === "exact"),
        `x402 /supported advertises ${deps.stellarNetwork.id}`, "scheme exact");
    } catch (error) {
      line(false, "x402 /supported", failure(error));
    }
  }

  let relayers: Listed | undefined;
  try {
    const listed: unknown = await deps.client.listRelayers();
    if (!validList(listed)) line(false, "GET /api/v1/relayers", "invalid response");
    else {
      relayers = listed;
      line(listed.length > 0, "GET /api/v1/relayers", `${listed.length} relayer(s)`);
    }
  } catch (error) {
    line(false, "GET /api/v1/relayers", failure(error));
  }
  if (!relayers) {
    deps.stdout("Stellar relayer checks skipped: relayer list is unavailable.");
    return finish();
  }

  if (deps.environment === "testnet") {
    const mainnet = relayers.filter((item) => !/test|sepolia|fuji|devnet/i.test(item.network));
    line(mainnet.length === 0, "no mainnet relayers enabled", `${mainnet.length} disallowed relayer(s)`);
  }

  const stellar = relayers.find((item) => item.id === deps.stellarRelayerId);
  line(Boolean(stellar), "configured Stellar relayer exists");
  if (!stellar) return finish();
  const typeOk = stellar.network_type === "stellar";
  const networkOk = stellar.network === deps.stellarNetwork.relayerNetwork;
  const enabled = !stellar.paused;
  line(typeOk, "Stellar relayer type", "expected stellar");
  line(networkOk, "Stellar relayer network", `expected ${deps.stellarNetwork.relayerNetwork}`);
  line(enabled, "Stellar relayer enabled");

  let address = "";
  try {
    const full: unknown = await deps.client.getRelayer(stellar.id);
    address = record(full) && typeof full.address === "string" ? full.address : "";
    line(Boolean(address), "Stellar relayer address", address ? "present" : "invalid response");
  } catch (error) {
    line(false, "Stellar relayer address", failure(error));
  }
  try {
    const balance: unknown = await deps.client.getBalance(stellar.id);
    const valid = record(balance) && (typeof balance.balance === "number" || typeof balance.balance === "string") && typeof balance.unit === "string";
    line(valid, "Stellar relayer balance", valid ? "available" : "invalid response");
  } catch (error) {
    line(false, "Stellar relayer balance", failure(error));
  }
  if (!up || !typeOk || !networkOk || !enabled || !address) {
    deps.stdout("Stellar account check skipped: relayer health, network or address failed.");
    return finish();
  }
  try {
    const account = await deps.accountStatus(address);
    line(record(account) && account.exists === true, `Stellar relayer account exists on ${deps.stellarNetwork.name}`);
  } catch {
    line(false, `Stellar relayer account exists on ${deps.stellarNetwork.name}`, "request failed");
  }
  return finish();
}
