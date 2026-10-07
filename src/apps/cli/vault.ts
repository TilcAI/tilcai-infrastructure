/**
 * TilcaiVault from the command line (Avalanche Fuji).
 *
 *   npm run vault -- status                                      # the vault on-chain (VAULT_FUJI)
 *   npm run vault -- deploy [--owner 0x…] [--operator 0x…] [--max 100] [--daily 1000]
 *   npm run vault -- withdraw --to 0x… --amount 5                # owner takes USDC back out
 *
 * `deploy` and `withdraw` sign with DEV_EVM_PAYER_PRIVATE_KEY and pay their gas in AVAX. The
 * deployer is also the owner unless --owner says otherwise; the operator defaults to the
 * RELAYER_FUJI_ID account, which is the one that sends the payouts.
 * `deploy` reads the compiled contract: run `forge build` in contracts/evm first.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, getAddress, http, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv } from "../../config/env.ts";
import { networks } from "../../config/networks.ts";
import { atomicToDecimal, decimalToAtomic } from "../../shared/amount.ts";
import { sameHex, type Hex } from "../../shared/hex.ts";
import { viemChain } from "../../modules/crosschain/adapters/evm.ts";
import { RelayerClient } from "../../modules/relayer/client.ts";
import { VAULT_ABI, ViemVault } from "../../modules/vault/adapters/evm.ts";

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    owner: { type: "string" },
    operator: { type: "string" },
    max: { type: "string", default: "100" },
    daily: { type: "string", default: "1000" },
    to: { type: "string" },
    amount: { type: "string" },
  },
});

const env = loadEnv();
const net = networks(env).avalancheFuji;
const chain = viemChain(net);
const pub = createPublicClient({ chain, transport: http(net.rpc, { retryCount: 3 }) });
const usdc = (atomic: bigint) => `${atomicToDecimal(atomic, net.usdc.decimals)} USDC`;
const address = (value: string | undefined, name: string): Hex => {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be an EVM address`);
  return getAddress(value);
};

function signer() {
  const key = env.DEV_EVM_PAYER_PRIVATE_KEY;
  if (!key) throw new Error("DEV_EVM_PAYER_PRIVATE_KEY is not set");
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  return { account, wallet: createWalletClient({ chain, account, transport: http(net.rpc) }) };
}

async function relayerAddress(): Promise<Hex> {
  if (!env.RELAYER_API_KEY) throw new Error("RELAYER_API_KEY is not set: pass --operator");
  const relayer = await new RelayerClient(env.RELAYER_URL, env.RELAYER_API_KEY).getRelayer(env.RELAYER_FUJI_ID);
  return address(String(relayer.address ?? ""), `relayer ${env.RELAYER_FUJI_ID} address`);
}

async function status(vault: Hex) {
  const s = await new ViemVault(net, vault).status();
  const relayer = await relayerAddress().catch(() => null);
  console.log(`TilcaiVault ${s.address}  (${net.name})`);
  console.log(`  ${net.explorer}/address/${s.address}`);
  console.log(`  balance            ${usdc(s.balanceAtomic)}`);
  console.log(`  per disbursement   ${usdc(s.maxPerDisbursementAtomic)}`);
  console.log(`  per day            ${usdc(s.dailyLimitAtomic)}  (left today: ${usdc(s.availableTodayAtomic)})`);
  console.log(`  paused             ${s.paused}`);
  console.log(`  owner              ${s.owner}`);
  console.log(`  operator           ${s.operator}${relayer ? (sameHex(relayer, s.operator) ? "  (the relayer)" : `  (NOT the relayer ${relayer})`) : ""}`);
}

const command = positionals[0];
if (command === "status") {
  await status(address(net.vault, "VAULT_FUJI"));
} else if (command === "deploy") {
  const artifactUrl = new URL("../../../contracts/evm/out/TilcaiVault.sol/TilcaiVault.json", import.meta.url);
  let artifact: { abi: Abi; bytecode: { object: Hex } };
  try {
    artifact = JSON.parse(readFileSync(artifactUrl, "utf8"));
  } catch {
    throw new Error("Compiled contract not found: run `forge build` in contracts/evm");
  }
  const { account, wallet } = signer();
  const owner = a.owner ? address(a.owner, "--owner") : account.address;
  const operator = a.operator ? address(a.operator, "--operator") : await relayerAddress();
  const max = decimalToAtomic(a.max!, net.usdc.decimals);
  const daily = decimalToAtomic(a.daily!, net.usdc.decimals);
  console.log(`Deploying TilcaiVault on ${net.name} from ${account.address}`);
  console.log(`  owner ${owner} · operator ${operator} · ${usdc(max)} per disbursement · ${usdc(daily)} per day`);
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [net.usdc.address, owner, operator, max, daily] });
  console.log(`  tx ${net.explorer}/tx/${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deployment reverted: ${hash}`);
  console.log("");
  await status(receipt.contractAddress);
  console.log(`\nSet VAULT_FUJI=${receipt.contractAddress} and fund the vault by sending Fuji USDC (${net.usdc.address}) to that address.`);
} else if (command === "withdraw") {
  const vault = address(net.vault, "VAULT_FUJI");
  const { account, wallet } = signer();
  const to = address(a.to, "--to");
  if (!a.amount) throw new Error("--amount is required");
  const amount = decimalToAtomic(a.amount, net.usdc.decimals);
  const hash = await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "withdraw", args: [net.usdc.address, to, amount] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`withdraw reverted (is ${account.address} the owner?): ${hash}`);
  console.log(`Withdrew ${usdc(amount)} to ${to}: ${net.explorer}/tx/${hash}`);
  await status(vault);
} else {
  console.error("usage: npm run vault -- status | deploy [--owner --operator --max --daily] | withdraw --to 0x… --amount N");
  process.exit(64);
}
