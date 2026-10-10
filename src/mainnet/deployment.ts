import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { encodeDeployData, getAddress, getContractAddress, keccak256, parseUnits, type Abi, type Hex } from "viem";
import { AVALANCHE_MAINNET, STELLAR_MAINNET } from "../config/networks.ts";

export type CheckState = "PASS" | "FAIL" | "PENDING";
export interface PreflightCheck { state: CheckState; area: string; name: string; detail: string }

export const check = (state: CheckState, area: string, name: string, detail: string): PreflightCheck => ({ state, area, name, detail });

export interface EvmArtifact {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode?: { object?: Hex; immutableReferences?: Record<string, Array<{ start: number; length: number }>> };
}

export interface EvmDeploymentInput {
  deployer: string;
  owner: string;
  operator: string;
  maxPerDisbursement: string;
  dailyLimit: string;
  /** Pending nonce read from C-Chain. Required to predict addresses without broadcasting. */
  deployerNonce?: bigint;
}

export interface EvmDeploymentStep {
  order: number;
  contract: "TilcaiCctpRouter" | "TilcaiCctpRouterV2" | "TilcaiAccountFactory" | "TilcaiVault";
  constructorArguments: readonly unknown[];
  initCode: Hex;
  initCodeHash: Hex;
  expectedRuntimeBytecodeHash?: Hex;
  expectedAddress?: Hex;
}

export const EVM_ARTIFACT_PATHS = {
  TilcaiCctpRouter: "contracts/evm/out/TilcaiCctpRouter.sol/TilcaiCctpRouter.json",
  TilcaiCctpRouterV2: "contracts/evm/out/TilcaiCctpRouterV2.sol/TilcaiCctpRouterV2.json",
  TilcaiAccountFactory: "contracts/evm/out/TilcaiAccountFactory.sol/TilcaiAccountFactory.json",
  TilcaiVault: "contracts/evm/out/TilcaiVault.sol/TilcaiVault.json",
} as const;

export function readEvmArtifact(path: string): EvmArtifact {
  const artifact = JSON.parse(readFileSync(path, "utf8")) as EvmArtifact;
  if (!Array.isArray(artifact.abi) || !artifact.bytecode?.object?.startsWith("0x") || artifact.bytecode.object === "0x") {
    throw new Error(`invalid or empty Foundry artifact: ${path}`);
  }
  return artifact;
}

/** Builds unsigned init code only. It has no wallet/client and therefore cannot broadcast. */
export function buildEvmDeploymentPlan(input: EvmDeploymentInput, artifacts: Record<keyof typeof EVM_ARTIFACT_PATHS, EvmArtifact>): EvmDeploymentStep[] {
  const deployer = getAddress(input.deployer);
  const owner = getAddress(input.owner);
  const operator = getAddress(input.operator);
  if (deployer === owner) throw new Error("deployer and final vault owner must be different");
  if (owner === operator) throw new Error("vault owner and operator must be different");
  const max = parseUnits(input.maxPerDisbursement, 6);
  const daily = parseUnits(input.dailyLimit, 6);
  if (max <= 0n || daily <= 0n || max > daily) throw new Error("vault limits must satisfy 0 < max <= daily");

  const specs: Array<[EvmDeploymentStep["contract"], readonly unknown[]]> = [
    ["TilcaiCctpRouter", [AVALANCHE_MAINNET.usdc, AVALANCHE_MAINNET.tokenMessengerV2]],
    ["TilcaiCctpRouterV2", [AVALANCHE_MAINNET.usdc, AVALANCHE_MAINNET.tokenMessengerV2]],
    ["TilcaiAccountFactory", []],
    ["TilcaiVault", [AVALANCHE_MAINNET.usdc, owner, operator, max, daily]],
  ];
  return specs.map(([contract, args], index) => {
    const artifact = artifacts[contract];
    const initCode = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: args as never });
    const nonce = input.deployerNonce === undefined ? undefined : input.deployerNonce + BigInt(index);
    return {
      order: index + 1,
      contract,
      constructorArguments: args,
      initCode,
      initCodeHash: keccak256(initCode),
      ...(artifact.deployedBytecode?.object && artifact.deployedBytecode.object !== "0x" ? { expectedRuntimeBytecodeHash: keccak256(artifact.deployedBytecode.object) } : {}),
      ...(nonce === undefined ? {} : { expectedAddress: getContractAddress({ from: deployer, nonce }) }),
    };
  });
}

/**
 * Compares deployed code with the compiled artifact. The compiler leaves zeros where the
 * constructor writes the `immutable` values, so those bytes are skipped: a plain hash of the
 * two never matches for a contract that has immutables.
 */
export function runtimeMatchesArtifact(deployed: Hex | undefined, artifact: EvmArtifact): { ok: boolean; detail: string } {
  const expected = artifact.deployedBytecode?.object;
  if (!expected || expected === "0x") return { ok: false, detail: "the artifact has no runtime bytecode" };
  if (!deployed || deployed === "0x") return { ok: false, detail: "no code at the address" };
  const a = deployed.slice(2).toLowerCase();
  const b = expected.slice(2).toLowerCase();
  if (a.length !== b.length) return { ok: false, detail: `runtime is ${a.length / 2} bytes, the artifact ${b.length / 2}` };
  const skipped = new Set<number>();
  for (const ref of Object.values(artifact.deployedBytecode?.immutableReferences ?? {}).flat()) {
    for (let i = ref.start; i < ref.start + ref.length; i++) skipped.add(i);
  }
  let differing = 0;
  for (let i = 0; i < b.length / 2; i++) if (!skipped.has(i) && a.slice(2 * i, 2 * i + 2) !== b.slice(2 * i, 2 * i + 2)) differing++;
  return differing === 0
    ? { ok: true, detail: `${b.length / 2} bytes match the artifact (${skipped.size} immutable bytes skipped)` }
    : { ok: false, detail: `${differing} bytes differ from the artifact outside its immutables` };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Refuses values that could accidentally turn a preparation command into a production signer. */
export function assertPreparationOnlyEnv(source: NodeJS.ProcessEnv): void {
  if (source.MAINNET_TRANSACTIONS_ENABLED && source.MAINNET_TRANSACTIONS_ENABLED !== "false" && source.MAINNET_TRANSACTIONS_ENABLED !== "0") {
    throw new Error("MAINNET_TRANSACTIONS_ENABLED must remain false during preparation");
  }
  for (const name of ["DEV_EVM_PAYER_PRIVATE_KEY", "STELLAR_OPERATOR_SECRET", "PRIVATE_KEY", "MNEMONIC"]) {
    if (source[name]) throw new Error(`${name} is forbidden in Mainnet preparation commands`);
  }
}

/** Injectable read-only checks: unit tests use mocks; the CLI supplies RPC readers. */
export async function checkEvmProtocolCode(readCode: (address: Hex) => Promise<Hex | undefined>): Promise<PreflightCheck[]> {
  const targets = [["USDC", AVALANCHE_MAINNET.usdc], ["TokenMessengerV2", AVALANCHE_MAINNET.tokenMessengerV2], ["MessageTransmitterV2", AVALANCHE_MAINNET.messageTransmitterV2]] as const;
  return Promise.all(targets.map(async ([name, address]) => {
    const code = await readCode(address);
    return check(code && code !== "0x" ? "PASS" : "FAIL", "avalanche", `${name} deployed`, address);
  }));
}

export async function checkStellarProtocolContracts(exists: (address: string) => Promise<boolean>): Promise<PreflightCheck[]> {
  const targets = [["USDC SAC", STELLAR_MAINNET.usdcSac], ["TokenMessengerMinter", STELLAR_MAINNET.tokenMessengerMinter], ["MessageTransmitter", STELLAR_MAINNET.messageTransmitter], ["CctpForwarder", STELLAR_MAINNET.cctpForwarder]] as const;
  return Promise.all(targets.map(async ([name, address]) => check(await exists(address) ? "PASS" : "FAIL", "stellar", `${name} exists`, address)));
}
