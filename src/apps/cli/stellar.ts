/**
 * The Stellar side of the SCA phase from the command line (Stellar Testnet).
 *
 *   npm run stellar -- relayer                 # the relayer's account: the vault's operator and the tx source
 *   npm run stellar -- status                  # factory and vault as they are on-chain (ACCOUNT_FACTORY_STELLAR, VAULT_STELLAR)
 *   npm run stellar -- verify-account          # issues a throwaway account through the relayer and checks it
 *   npm run stellar -- verify-vault [--pay G… --amount 0.5]   # checks the vault's guards; with --pay, makes one real payout
 *
 * Contracts are deployed with `contracts/soroban/deploy-testnet.sh`; this reads and verifies them.
 */
import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import { loadEnv } from "../../config/env.ts";
import { networks } from "../../config/networks.ts";
import { atomicToDecimal, decimalToAtomic } from "../../shared/amount.ts";
import { bytesToHex, type Hex } from "../../shared/hex.ts";
import { StellarSmartAccountProvider } from "../../modules/accounts/stellar/provider.ts";
import { RelayerClient } from "../../modules/relayer/client.ts";
import { RelayerStellarSubmitter } from "../../modules/stellar/relayer-submitter.ts";
import { SorobanReader } from "../../modules/stellar/soroban.ts";
import { SorobanVault, StellarVaultSubmitter } from "../../modules/vault/adapters/stellar.ts";
import { disbursementIdBytes32 } from "../../modules/vault/disbursement-id.ts";

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { pay: { type: "string" }, amount: { type: "string", default: "0.1" } } });
const env = loadEnv();
if (env.TILCAI_ENV === "mainnet") throw new Error("Stellar deployment/operation CLI is disabled on mainnet in phase 1");
const net = networks(env).stellarTestnet;
const usdc = (atomic: bigint) => `${atomicToDecimal(atomic, net.usdc.decimals)} USDC`;
const link = (kind: "contract" | "account" | "tx", id: string) => `${net.explorer}/${kind}/${id}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const need = (value: string, name: string) => {
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const submitter = () => new RelayerStellarSubmitter(new RelayerClient(env.RELAYER_URL, need(env.RELAYER_API_KEY, "RELAYER_API_KEY")), env.RELAYER_STELLAR_ID, net);
const reader = new SorobanReader(net, env.STELLAR_SIMULATION_SOURCE || undefined);

async function relayer() {
  const account = await submitter().sender();
  const bal = await new RelayerClient(env.RELAYER_URL, env.RELAYER_API_KEY).getBalance(env.RELAYER_STELLAR_ID).catch(() => null);
  console.log(`relayer ${env.RELAYER_STELLAR_ID}  ${account}${bal ? `  balance ${bal.balance} ${bal.unit}` : ""}`);
  console.log(`  ${link("account", account)}`);
}

async function status() {
  console.log(`${net.name} (${net.id})`);
  const factory = net.accountFactory;
  if (!factory) console.log("  ACCOUNT_FACTORY_STELLAR   not set");
  else if (!(await reader.contractExists(factory))) console.log(`  ACCOUNT_FACTORY_STELLAR   ${factory}  NOT FOUND`);
  else {
    const hash = Buffer.from((await reader.read(factory, "account_wasm_hash")) as Uint8Array).toString("hex");
    console.log(`  factory                   ${factory}`);
    console.log(`  account wasm              ${hash}`);
    console.log(`  ed25519 verifier          ${await reader.read(factory, "ed25519_verifier")}`);
    console.log(`  webauthn verifier         ${await reader.read(factory, "webauthn_verifier")}`);
  }
  if (!net.vault) return console.log("  VAULT_STELLAR             not set");
  const s = await new SorobanVault(net, net.vault, env.STELLAR_SIMULATION_SOURCE || undefined).status();
  const relayerAddress = env.RELAYER_API_KEY ? await submitter().sender().catch(() => null) : null;
  console.log(`  vault                     ${s.address}`);
  console.log(`    ${link("contract", s.address)}`);
  console.log(`    balance                 ${usdc(s.balanceAtomic)}`);
  console.log(`    per disbursement        ${usdc(s.maxPerDisbursementAtomic)}`);
  console.log(`    per day                 ${usdc(s.dailyLimitAtomic)}  (left today: ${usdc(s.availableTodayAtomic)})`);
  console.log(`    paused                  ${s.paused}`);
  console.log(`    owner                   ${s.owner}`);
  console.log(`    operator                ${s.operator}${relayerAddress ? (relayerAddress === s.operator ? "  (the relayer)" : `  (NOT the relayer ${relayerAddress})`) : ""}`);
}

/** A throwaway Ed25519 owner: the account is issued the way a tenant's request would be. */
async function verifyAccount() {
  const factory = need(net.accountFactory ?? "", "ACCOUNT_FACTORY_STELLAR");
  const provider = new StellarSmartAccountProvider(net, factory, submitter(), env.STELLAR_SIMULATION_SOURCE || undefined);
  const keypair = Keypair.random();
  const owner = { kind: "ed25519" as const, publicKey: bytesToHex(keypair.rawPublicKey()) };
  const salt = bytesToHex(randomBytes(32));

  const address = await provider.addressFor(owner, salt);
  console.log(`Account ${address}  (known before deploying)`);
  if (await provider.isDeployed(address)) throw new Error("the address already has an account");
  const sent = await provider.deploy(owner, salt);
  if (sent.address !== address) throw new Error("the deployment address differs from the predicted one");
  console.log(`  submitted  relayer id ${sent.submissionId}`);
  let txHash = "";
  for (let i = 0; i < 40; i++) {
    const st = await provider.deployStatus(sent.submissionId);
    if (st.state === "failed") throw new Error(`deployment failed: ${st.reason}`);
    if (st.state === "confirmed") {
      txHash = st.txHash;
      break;
    }
    await sleep(3000);
  }
  if (!txHash) throw new Error("the relayer did not confirm the deployment in time");
  for (let i = 0; i < 20 && !(await provider.isDeployed(address)); i++) await sleep(2000);
  if (!(await provider.isDeployed(address))) throw new Error("confirmed, but the account has no code at the predicted address");
  console.log(`  deployed   ${link("tx", txHash)}`);
  console.log(`  contract   ${link("contract", address)}`);
  const signers = JSON.stringify(await provider.ownerRuleSigners(address), (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v));
  if (!signers.includes(Buffer.from(keypair.rawPublicKey()).toString("hex"))) throw new Error(`the owner rule does not hold the owner's key: ${signers}`);
  console.log("  owner rule holds only the owner's key");
  console.log("OK");
}

async function verifyVault() {
  const vaultId = need(net.vault ?? "", "VAULT_STELLAR");
  const vault = new SorobanVault(net, vaultId, env.STELLAR_SIMULATION_SOURCE || undefined);
  const invoker = submitter();
  const operator = await invoker.sender();
  const s = await vault.status();
  const check = (ok: boolean, what: string) => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exitCode = 1;
  };
  console.log(`Vault ${vaultId}: ${usdc(s.balanceAtomic)}`);
  check(s.operator === operator, "the relayer's account is the vault's operator");
  const probe = disbursementIdBytes32("vault_stellar_verification");
  const buyer = a.pay ?? Keypair.random().publicKey();
  check((await vault.simulate(s.owner, probe, buyer, 1n)).ok === false, "an account that is not the operator cannot disburse");
  const over = await vault.simulate(operator, probe, buyer, s.maxPerDisbursementAtomic + 1n);
  check(!over.ok && over.reason === "AboveDisbursementLimit", `above the cap (${usdc(s.maxPerDisbursementAtomic)}) the operator is refused`);
  check((await vault.paidAmount(probe)) === 0n, "an unused id is unpaid");

  if (!a.pay) return console.log("(pass --pay G… --amount N to make one real payout)");
  const amount = decimalToAtomic(a.amount!, net.usdc.decimals);
  const id = disbursementIdBytes32(`vault_stellar_verification_${createHash("sha256").update(randomBytes(8)).digest("hex").slice(0, 12)}`);
  const sim = await vault.simulate(operator, id, a.pay, amount);
  if (!sim.ok) throw new Error(`the payout would be refused: ${sim.reason}`);
  const sent = await new StellarVaultSubmitter(invoker).submit(vaultId, vault.encodeDisburse(id, a.pay, amount));
  console.log(`  submitted  relayer id ${sent.submissionId}`);
  let txHash = "";
  for (let i = 0; i < 40 && !txHash; i++) {
    const st = await invoker.status(sent.submissionId);
    if (st.state === "failed") throw new Error(`payout failed: ${st.reason}`);
    if (st.state === "confirmed") txHash = st.txHash;
    else await sleep(3000);
  }
  if (!txHash) throw new Error("the relayer did not confirm the payout in time");
  const r = await vault.inspect(txHash);
  check(r.kind === "mined", "the transaction is final");
  const ev = r.kind === "mined" ? r.disbursed.find((d) => d.disbursementId === id) : undefined;
  check(Boolean(ev) && ev!.to === a.pay && ev!.amount === amount, "its Disbursed event names the buyer and the amount");
  check((await vault.paidAmount(id)) === amount, "the vault records the id as paid");
  const again = await vault.simulate(operator, id, a.pay, amount);
  check(!again.ok && again.reason === "AlreadyDisbursed", "the same id cannot be paid twice");
  console.log(`  paid ${usdc(amount)} to ${a.pay}  ${link("tx", txHash)}`);
}

const commands: Record<string, () => Promise<void>> = { relayer, status, "verify-account": verifyAccount, "verify-vault": verifyVault };
const run = commands[positionals[0] ?? ""];
if (!run) {
  console.error("usage: npm run stellar -- relayer | status | verify-account | verify-vault [--pay G… --amount N]");
  process.exit(64);
}
await run();
