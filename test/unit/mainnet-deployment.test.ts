import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, type Hex } from "viem";
import { AVALANCHE_MAINNET, STELLAR_MAINNET } from "../../src/config/networks.ts";
import { assertPreparationOnlyEnv, buildEvmDeploymentPlan, checkEvmProtocolCode, checkStellarProtocolContracts, type EvmArtifact } from "../../src/mainnet/deployment.ts";

const bytecode = "0x60006000" as Hex;
const artifact = (abi: EvmArtifact["abi"]): EvmArtifact => ({ abi, bytecode: { object: bytecode } });
const artifacts = {
  TilcaiCctpRouter: artifact(parseAbi(["constructor(address usdc_, address tokenMessenger_)"])),
  TilcaiCctpRouterV2: artifact(parseAbi(["constructor(address usdc_, address tokenMessenger_)"])),
  TilcaiAccountFactory: artifact(parseAbi(["constructor()"])),
  TilcaiVault: artifact(parseAbi(["constructor(address usdc_, address owner_, address operator_, uint256 max_, uint256 daily_)"])),
};

test("Avalanche dry-run builds four unsigned Mainnet deployments with explicit roles", () => {
  const plan = buildEvmDeploymentPlan({
    deployer: `0x${"11".repeat(20)}`,
    owner: `0x${"22".repeat(20)}`,
    operator: `0x${"33".repeat(20)}`,
    maxPerDisbursement: "100",
    dailyLimit: "1000",
    deployerNonce: 7n,
  }, artifacts);
  assert.deepEqual(plan.map((x) => x.contract), ["TilcaiCctpRouter", "TilcaiCctpRouterV2", "TilcaiAccountFactory", "TilcaiVault"]);
  assert.equal(plan[0]!.constructorArguments[0], AVALANCHE_MAINNET.usdc);
  assert.equal(plan[0]!.constructorArguments[1], AVALANCHE_MAINNET.tokenMessengerV2);
  assert.equal(plan[3]!.constructorArguments[0], AVALANCHE_MAINNET.usdc);
  assert.equal(new Set(plan.map((x) => x.expectedAddress)).size, 4);
  assert.ok(plan.every((x) => x.initCodeHash.startsWith("0x") && x.initCode.length >= bytecode.length));
  assert.ok(plan.filter((x) => x.constructorArguments.length > 0).every((x) => x.initCode.length > bytecode.length));
});

test("Avalanche plan rejects unsafe ownership and invalid limits", () => {
  const same = `0x${"11".repeat(20)}`;
  assert.throws(() => buildEvmDeploymentPlan({ deployer: same, owner: same, operator: `0x${"33".repeat(20)}`, maxPerDisbursement: "1", dailyLimit: "2" }, artifacts), /deployer and final vault owner/);
  assert.throws(() => buildEvmDeploymentPlan({ deployer: same, owner: `0x${"22".repeat(20)}`, operator: `0x${"33".repeat(20)}`, maxPerDisbursement: "3", dailyLimit: "2" }, artifacts), /0 < max <= daily/);
});

test("preparation environment rejects transaction switches and private material", () => {
  assert.doesNotThrow(() => assertPreparationOnlyEnv({ MAINNET_TRANSACTIONS_ENABLED: "false" }));
  assert.throws(() => assertPreparationOnlyEnv({ MAINNET_TRANSACTIONS_ENABLED: "true" }), /must remain false/);
  assert.throws(() => assertPreparationOnlyEnv({ PRIVATE_KEY: "never" }), /PRIVATE_KEY is forbidden/);
});

test("read-only protocol checks distinguish PASS and FAIL with mocked readers", async () => {
  const evm = await checkEvmProtocolCode(async (address) => address === AVALANCHE_MAINNET.messageTransmitterV2 ? "0x" : "0x6000");
  assert.deepEqual(evm.map((x) => x.state), ["PASS", "PASS", "FAIL"]);
  const stellar = await checkStellarProtocolContracts(async (address) => address !== STELLAR_MAINNET.cctpForwarder);
  assert.deepEqual(stellar.map((x) => x.state), ["PASS", "PASS", "PASS", "FAIL"]);
});
