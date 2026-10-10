/** Mainnet deployment preparation. This command never owns a signer and cannot broadcast. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertPreparationOnlyEnv, buildEvmDeploymentPlan, EVM_ARTIFACT_PATHS, readEvmArtifact, sha256File } from "../../mainnet/deployment.ts";
import { AVALANCHE_MAINNET } from "../../config/networks.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    deployer: { type: "string" },
    owner: { type: "string" },
    operator: { type: "string" },
    max: { type: "string", default: "100" },
    daily: { type: "string", default: "1000" },
    nonce: { type: "string" },
  },
});
const command = positionals[0] ?? "dry-run";
if (command === "deploy") throw new Error("Avalanche Mainnet deployment is deliberately blocked in phase 2; this CLI has no signer or broadcast path");
if (command !== "dry-run") throw new Error("usage: npm run mainnet:avalanche -- dry-run --deployer 0x… --owner 0x… --operator 0x… [--max 100 --daily 1000 --nonce N]");

assertPreparationOnlyEnv(process.env);
for (const [name, value] of [["--deployer", values.deployer], ["--owner", values.owner], ["--operator", values.operator]] as const) {
  if (!value) throw new Error(`${name} is required`);
}
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const entries = Object.entries(EVM_ARTIFACT_PATHS) as Array<[keyof typeof EVM_ARTIFACT_PATHS, string]>;
for (const [, path] of entries) if (!existsSync(repo(path))) throw new Error(`missing artifact ${path}; run a local forge build first`);
const artifacts = Object.fromEntries(entries.map(([name, path]) => [name, readEvmArtifact(repo(path))])) as Parameters<typeof buildEvmDeploymentPlan>[1];
const plan = buildEvmDeploymentPlan(
  {
    deployer: values.deployer!,
    owner: values.owner!,
    operator: values.operator!,
    maxPerDisbursement: values.max!,
    dailyLimit: values.daily!,
    ...(values.nonce === undefined ? {} : { deployerNonce: BigInt(values.nonce) }),
  },
  artifacts,
);

console.log(JSON.stringify({
  mode: "DRY_RUN_NO_BROADCAST",
  chainId: AVALANCHE_MAINNET.chainId,
  protocol: {
    usdc: AVALANCHE_MAINNET.usdc,
    tokenMessengerV2: AVALANCHE_MAINNET.tokenMessengerV2,
    messageTransmitterV2: AVALANCHE_MAINNET.messageTransmitterV2,
  },
  source: {
    TilcaiCctpRouter: {
      path: "contracts/evm/src/TilcaiCctpRouter.sol",
      sha256: sha256File(repo("contracts/evm/src/TilcaiCctpRouter.sol")),
      introducedBy: "6f0671c52f50577e5345cd825074eec101b77d12",
    },
  },
  deployments: plan.map((step) => ({
    order: step.order,
    contract: step.contract,
    constructorArguments: step.constructorArguments.map((value) => typeof value === "bigint" ? value.toString() : value),
    initCodeHash: step.initCodeHash,
    expectedRuntimeBytecodeHash: step.expectedRuntimeBytecodeHash ?? "PENDING: artifact has no deployedBytecode",
    initCodeBytes: (step.initCode.length - 2) / 2,
    expectedAddress: step.expectedAddress ?? "PENDING: provide --nonce read from chain",
  })),
  next: "review only; no transaction was signed or broadcast",
}, null, 2));
