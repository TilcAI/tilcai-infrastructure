/**
 * Preconditions of the SCA phase (smart contract accounts on Stellar and EVM), checked against
 * the real networks, the Relayer and the local toolchain. Read-only: it sends no transaction.
 *   npm run sca:preflight
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { createPublicClient, http, toFunctionSelector } from "viem";
import { activeConfig, loadEnv } from "../../config/env.ts";
import { networks } from "../../config/networks.ts";
import { viemChain } from "../../modules/crosschain/adapters/evm.ts";
import { RelayerClient } from "../../modules/relayer/client.ts";

const env = loadEnv();
const active = activeConfig(env);
const nets = networks(env);
const fuji = nets.avalanche;
const stellar = nets.stellar;
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

let failures = 0;
const line = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -> ${detail}` : ""}`);
};
const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await run();
  } catch (e) {
    line(false, label, String((e as Error).message ?? e).split("\n")[0]!.slice(0, 160));
    return undefined;
  }
};

// ── EVM: what an account with a passkey owner and ERC-1271 payments needs ──
console.log(`\n${fuji.name} (${fuji.id})`);
const evm = createPublicClient({ chain: viemChain(fuji), transport: http(fuji.rpc, { timeout: 20_000 }) });
const hasCode = async (address: `0x${string}`) => ((await evm.getCode({ address })) ?? "0x") !== "0x";

const chainId = await attempt("RPC reachable", () => evm.getChainId());
if (chainId !== undefined) {
  line(chainId === fuji.chainId, "RPC reachable", `chainId ${chainId}`);
  line(await hasCode(fuji.erc4337.entryPoint), `EntryPoint v${fuji.erc4337.version} deployed`, fuji.erc4337.entryPoint);

  // RIP-7212 input: hash ‖ r ‖ s ‖ x ‖ y (a valid Wycheproof vector). A live precompile returns 1.
  const p256Vector = `0x${[
    "bb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023",
    "2ba3a8be6b94d5ec80a6d9d1190a436effe50d85a1eee859b8cc6af9bd5c2e18",
    "4cd60b855d442f5b3c7b11eb6c4e0ae7525fe710fab9aa7c77a67f79e6fadd76",
    "2927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838",
    "c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e",
  ].join("")}` as const;
  const p256 = await evm.call({ to: fuji.p256Precompile, data: p256Vector }).catch(() => ({ data: undefined }));
  line(p256.data !== undefined && BigInt(p256.data) === 1n, "P-256 precompile verifies a valid signature", fuji.p256Precompile);

  // FiatTokenProxy keeps its implementation in the ZeppelinOS slot. A contract account can only
  // pay with EIP-3009 if the token has the `bytes signature` overload, which checks ERC-1271.
  const slot = await evm.getStorageAt({ address: fuji.usdc.address, slot: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3" });
  const implementation = `0x${(slot ?? "0x").slice(-40)}` as const;
  const usdcCode = (await evm.getCode({ address: implementation })) ?? "0x";
  const selector = toFunctionSelector("receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)");
  line(usdcCode.includes(selector.slice(2)), "USDC accepts EIP-3009 with a contract (ERC-1271) signature", `implementation ${implementation}`);

  if (fuji.cctpRouter) line(await hasCode(fuji.cctpRouter), "TilcaiCctpRouter deployed", fuji.cctpRouter);
  else line(false, "TilcaiCctpRouter configured", "CCTP_ROUTER_FUJI is empty");
}

// ── Stellar: the contracts an issued account interacts with ──
console.log(`\n${stellar.name} (${stellar.id})`);
const soroban = new rpc.Server(stellar.rpc);
const network = await attempt("Soroban RPC reachable", () => soroban.getNetwork());
if (network) {
  line(network.passphrase === stellar.passphrase, "Soroban RPC reachable", `protocol ${network.protocolVersion}`);
  const instance = xdr.ScVal.scvLedgerKeyContractInstance();
  for (const [label, contract] of [["USDC SAC", stellar.usdc.sac], ["CctpForwarder", stellar.cctpV2.cctpForwarder]] as const) {
    const found = await soroban.getContractData(contract, instance).then(() => true, () => false);
    line(found, `${label} exists`, contract);
  }
}

// ── Relayer: it deploys the accounts and pays every fee ──
console.log(`\nRelayer ${active.relayerUrl}`);
const relayer = new RelayerClient(active.relayerUrl, active.relayerApiKey);
const up = await relayer.health();
line(up, "GET /api/v1/health");
if (!active.relayerApiKey) line(false, "active relayer API key set");
if (up && active.relayerApiKey) {
  const relayers = (await attempt("GET /api/v1/relayers", () => relayer.listRelayers())) ?? [];
  for (const id of [active.stellarRelayerId, active.evmRelayerId]) {
    const found = relayers.find((x) => x.id === id);
    const balance = found ? await relayer.getBalance(id).catch(() => null) : null;
    line(Boolean(found) && !found!.paused, `relayer '${id}' enabled`, balance ? `balance ${balance.balance} ${balance.unit}` : found ? "balance ?" : "not found");
  }
}

// ── Local toolchain and build outputs ──
console.log("\nToolchain");
const run = (bin: string, args: string[]) => {
  try {
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};
const firstLine = (s: string | undefined) => s?.split("\n")[0] ?? "not found";
/** A local prerequisite: on failure the detail is the command that fixes it. */
const need = (ok: boolean, label: string, fix: string) => line(ok, label, ok ? "" : fix);
const stellarCli = run("stellar", ["--version"]);
line(Boolean(stellarCli), "stellar CLI", firstLine(stellarCli));
need(Boolean(run("rustup", ["target", "list", "--installed"])?.split("\n").includes("wasm32v1-none")), "rust target wasm32v1-none", "rustup target add wasm32v1-none");
const forge = run("forge", ["--version"]) ?? run(`${homedir()}/.foundry/bin/forge`, ["--version"]);
line(Boolean(forge), "forge", firstLine(forge));
need(existsSync(repo("contracts/soroban/target/wasm32v1-none/release/tilcai_account.wasm")), "Soroban contracts built", "cd contracts/soroban && stellar contract build");
need(existsSync(repo("contracts/evm/lib/openzeppelin-contracts/package.json")), "EVM dependencies installed", "see contracts/evm/README.md");

console.log(failures === 0 ? "\nReady for M0." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
