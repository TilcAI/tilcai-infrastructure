import { activeConfig, type Env } from "../../config/env.ts";
import { networks, type EvmNetwork } from "../../config/networks.ts";

/** The testnet networks the deployment and operation CLIs can act on. */
const CLI_NETWORKS = {
  fuji: { pick: (n: ReturnType<typeof networks>) => n.avalancheFuji, suffix: "FUJI", relayerKey: "RELAYER_FUJI_ID" },
  "monad-testnet": { pick: (n: ReturnType<typeof networks>) => n.monadTestnet, suffix: "MONAD_TESTNET", relayerKey: "RELAYER_MONAD_TESTNET_ID" },
} as const;

export type CliNetworkName = keyof typeof CLI_NETWORKS;

export interface CliEvmNetwork {
  name: CliNetworkName;
  net: EvmNetwork;
  /** OZ Relayer id of this network. */
  relayerId: string;
  /** Environment variable that holds the address of a deployed piece: `VAULT_FUJI`, `VAULT_MONAD_TESTNET`… */
  variable(piece: "ACCOUNT_FACTORY" | "CCTP_ROUTER" | "CCTP_ROUTER_V2" | "VAULT"): string;
}

/**
 * Picks the EVM network a CLI works on: `--network fuji|monad-testnet` (removed from argv so each
 * CLI's own argument parser never sees it), else `TILCAI_CLI_NETWORK`, else Avalanche Fuji.
 */
export function selectCliNetwork(env: Env, argv: string[] = process.argv): CliEvmNetwork {
  let requested = process.env.TILCAI_CLI_NETWORK || "fuji";
  const at = argv.findIndex((x) => x === "--network" || x.startsWith("--network="));
  if (at >= 0) {
    const inline = argv[at]!.startsWith("--network=");
    requested = inline ? argv[at]!.slice("--network=".length) : (argv[at + 1] ?? "");
    argv.splice(at, inline ? 1 : 2);
  }
  if (!(requested in CLI_NETWORKS)) throw new Error(`--network must be one of ${Object.keys(CLI_NETWORKS).join(", ")} (got "${requested}")`);
  const name = requested as CliNetworkName;
  const entry = CLI_NETWORKS[name];
  return {
    name,
    net: entry.pick(networks(env)),
    relayerId: env[entry.relayerKey],
    variable: (piece) => `${piece}_${entry.suffix}`,
  };
}

export { activeConfig };
