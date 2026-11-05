/** Read-only checks for the configured OpenZeppelin Relayer. */
import { activeConfig, loadEnv } from "../../config/env.ts";
import { networks } from "../../config/networks.ts";
import { RelayerClient } from "../../modules/relayer/client.ts";
import { SorobanStellarCctp } from "../../modules/crosschain/adapters/stellar.ts";
import { runRelayerCheck } from "./relayer-check-run.ts";

async function main(): Promise<void> {
  const env = loadEnv();
  const active = activeConfig(env);
  const nets = networks(env);
  const client = new RelayerClient(active.relayerUrl, active.relayerApiKey);
  process.exitCode = await runRelayerCheck({
    client,
    environment: env.TILCAI_ENV,
    apiKeySet: Boolean(active.relayerApiKey),
    x402PluginId: active.x402PluginId,
    stellarRelayerId: active.stellarRelayerId,
    stellarNetwork: nets.stellar,
    accountStatus: (address) => new SorobanStellarCctp(nets.stellar).accountStatus(address),
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  });
}

await main().catch(() => {
  console.error("relayer:check failed: invalid configuration or unexpected error");
  process.exitCode = 1;
});
