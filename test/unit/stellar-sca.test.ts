import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { loadEnv } from "../../src/config/env.ts";
import { networks } from "../../src/config/networks.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import type { OwnerCredential } from "../../src/modules/accounts/ports.ts";
import { SqliteSmartAccountRepository } from "../../src/modules/accounts/repository.ts";
import { AccountService, accountSalt } from "../../src/modules/accounts/service.ts";
import { StellarSmartAccountProvider } from "../../src/modules/accounts/stellar/provider.ts";
import { SubmissionRejected } from "../../src/modules/crosschain/ports.ts";
import type { ScValJson } from "../../src/modules/relayer/client.ts";
import { SimulationError, type SimulatedCall, type SorobanView } from "../../src/modules/stellar/soroban.ts";
import { i128, type StellarInvoker, type StellarSubmissionStatus } from "../../src/modules/stellar/relayer-submitter.ts";
import { SorobanVault, StellarVaultSubmitter } from "../../src/modules/vault/adapters/stellar.ts";
import { disbursementIdBytes32 } from "../../src/modules/vault/disbursement-id.ts";
import { SqliteTenantRegistry } from "../../src/modules/tenants/registry.ts";
import { DomainError } from "../../src/shared/errors.ts";
import type { Hex } from "../../src/shared/hex.ts";
import { silentLogger } from "../../src/shared/log.ts";
import { TestClock } from "../support/sca.ts";

const net = networks(loadEnv({})).stellarTestnet;
const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const FACTORY = contract(1);
const VAULT = contract(2);
const RELAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const BUYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();

const ED_OWNER: OwnerCredential = { kind: "ed25519", publicKey: `0x${"ab".repeat(32)}` };
const PASSKEY_OWNER: OwnerCredential = { kind: "webauthn-p256", publicKey: `0x04${"11".repeat(64)}`, credentialId: "cred-1", rpId: "optus.example" };

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.contract.code === code);
}

/** The node as far as these adapters read it. Each test says what it answers. */
class FakeNode implements SorobanView {
  calls: Array<{ contract: string; method: string; args: xdr.ScVal[]; source?: string | undefined }> = [];
  answers = new Map<string, unknown>();
  auth: SimulatedCall["auth"] = [];
  failWith: SimulationError | Error | null = null;
  code = new Set<string>();
  ledger = 1000;
  transactions = new Map<string, Awaited<ReturnType<SorobanView["getTransaction"]>>>();
  events: Awaited<ReturnType<SorobanView["getEvents"]>>["events"] = [];
  eventsFail = false;

  async simulate(contractId: string, method: string, args: xdr.ScVal[], source?: string): Promise<SimulatedCall> {
    this.calls.push({ contract: contractId, method, args, source });
    if (this.failWith) throw this.failWith;
    if (!this.answers.has(method)) throw new Error(`no answer for ${method}`);
    return { value: this.answers.get(method), auth: this.auth };
  }
  async read(contractId: string, method: string, args: xdr.ScVal[] = []) {
    return (await this.simulate(contractId, method, args)).value;
  }
  async contractExists(address: string) {
    return this.code.has(address);
  }
  async latestLedger() {
    return this.ledger;
  }
  async getTransaction(hash: string) {
    return this.transactions.get(hash) ?? ({ status: "NOT_FOUND" } as never);
  }
  async getEvents() {
    if (this.eventsFail) throw new Error("startLedger must be within the ledger range");
    return { events: this.events, cursor: "", latestLedger: this.ledger } as never;
  }
}

class FakeInvoker implements StellarInvoker {
  readonly name = "relayer";
  sent: Array<{ contract: string; fn: string; args: ScValJson[]; auth: string }> = [];
  statuses = new Map<string, StellarSubmissionStatus>();
  reject = false;
  async sender() {
    return RELAYER;
  }
  async invoke(contractId: string, fn: string, args: ScValJson[], auth: "none" | "source_account" = "none") {
    if (this.reject) throw new SubmissionRejected("relayer 400");
    this.sent.push({ contract: contractId, fn, args, auth });
    const id = `stellar-${this.sent.length}`;
    this.statuses.set(id, { state: "pending" });
    return { submissionId: id };
  }
  async status(id: string) {
    return this.statuses.get(id) ?? { state: "pending" as const };
  }
}

const salt = `0x${"5a".repeat(32)}` as Hex;
const ACCOUNT_ADDRESS = contract(7);

function provider(node = new FakeNode(), invoker: FakeInvoker | null = new FakeInvoker()) {
  node.answers.set("address_ed25519", ACCOUNT_ADDRESS);
  node.answers.set("address_webauthn", ACCOUNT_ADDRESS);
  node.answers.set("account_wasm_hash", Buffer.alloc(32, 0xcd));
  return { node, invoker, provider: new StellarSmartAccountProvider(net, FACTORY, invoker, undefined, node) };
}

// ── Accounts ────────────────────────────────────────────────────────────────────────────────────────

test("stellar account: the address comes from the factory, by kind of owner, with the key and the salt", async () => {
  const { node, provider: p } = provider();
  assert.equal(await p.addressFor(ED_OWNER, salt), ACCOUNT_ADDRESS);
  assert.equal(await p.addressFor(PASSKEY_OWNER, salt), ACCOUNT_ADDRESS);

  const [ed, pk] = node.calls;
  assert.deepEqual([ed!.contract, ed!.method], [FACTORY, "address_ed25519"]);
  assert.equal(Buffer.from(scValToNative(ed!.args[0]!) as Uint8Array).toString("hex"), "ab".repeat(32));
  assert.equal(Buffer.from(scValToNative(ed!.args[1]!) as Uint8Array).toString("hex"), "5a".repeat(32));
  assert.equal(pk!.method, "address_webauthn");
  // The verifier takes the P-256 point; the credential id is not part of the signer.
  assert.equal(Buffer.from(scValToNative(pk!.args[0]!) as Uint8Array).length, 65);
});

test("stellar account: the relayer calls the factory and pays; the code ref is the account wasm hash", async () => {
  const { invoker, provider: p } = provider();
  const sent = await p.deploy(ED_OWNER, salt);
  assert.deepEqual(sent, { address: ACCOUNT_ADDRESS, submissionId: "stellar-1" });
  assert.deepEqual(invoker!.sent, [
    { contract: FACTORY, fn: "create_ed25519", args: [{ bytes: "ab".repeat(32) }, { bytes: "5a".repeat(32) }], auth: "none" },
  ]);
  await p.deploy(PASSKEY_OWNER, salt);
  assert.equal(invoker!.sent[1]!.fn, "create_webauthn");
  assert.equal(await p.codeRef(), "cd".repeat(32));
  assert.deepEqual(await p.deployStatus("stellar-1"), { state: "pending" });
});

test("stellar account: owners the chain could not check are refused before anything is sent", async () => {
  const { invoker, provider: p } = provider();
  await assert.rejects(p.addressFor({ kind: "ed25519", publicKey: "0x1234" }, salt), TypeError);
  await assert.rejects(p.addressFor({ ...PASSKEY_OWNER, publicKey: `0x02${"11".repeat(32)}` } as OwnerCredential, salt), TypeError);
  await assert.rejects(p.deploy({ kind: "secp256k1", address: `0x${"ab".repeat(20)}` }, salt), TypeError);
  assert.equal(invoker!.sent.length, 0);
  await assert.rejects(provider(new FakeNode(), null).provider.deploy(ED_OWNER, salt), /no Stellar relayer/);
});

test("stellar account: deployed means the contract instance is live on the ledger", async () => {
  const { node, provider: p } = provider();
  assert.equal(await p.isDeployed(ACCOUNT_ADDRESS), false);
  node.code.add(ACCOUNT_ADDRESS);
  assert.equal(await p.isDeployed(ACCOUNT_ADDRESS), true);
});

test("stellar account: the service issues it, deploys it through the relayer and activates it on evidence", async () => {
  const clock = new TestClock();
  const db = openDatabase(":memory:");
  const tenants = new SqliteTenantRegistry(db, clock);
  const repo = new SqliteSmartAccountRepository(db, clock);
  const { node, invoker, provider: p } = provider();
  const svc = new AccountService({ repo, providers: { "stellar:testnet": p }, clock, log: silentLogger, options: { pollMs: 1000 } });
  const tenant = await tenants.createTenant({ name: "Optus" });
  assert.deepEqual(svc.networks(), ["stellar:testnet"]);

  // Upper-case hex is the same key: it is stored and sent in its canonical form.
  const owner: OwnerCredential = { kind: "ed25519", publicKey: `0x${"AB".repeat(32)}` };
  const { account } = await svc.create({ tenantId: tenant.id, network: "stellar:testnet", externalRef: "user-1", owner, idempotencyKey: "idem-0001" });
  assert.equal(account.address, ACCOUNT_ADDRESS);
  assert.equal(account.state, "DEPLOYING");
  assert.equal(account.codeRef, "cd".repeat(32));
  assert.deepEqual(account.owner, ED_OWNER);
  assert.equal(account.salt, accountSalt(tenant.id, "user-1"));
  assert.equal(invoker!.sent.length, 1);

  // Confirmed by the relayer but no code yet: not ACTIVE. With code: ACTIVE, whoever deployed it.
  invoker!.statuses.set(account.deploySubmissionId!, { state: "confirmed", txHash: "ab".repeat(32) });
  clock.advance(2000);
  await svc.processDue();
  assert.equal((await repo.get(account.id))!.state, "DEPLOYING");
  node.code.add(ACCOUNT_ADDRESS);
  clock.advance(2000);
  await svc.processDue();
  const active = (await repo.get(account.id))!;
  assert.equal(active.state, "ACTIVE");
  assert.equal(active.deployTxHash, "ab".repeat(32));
  assert.equal(invoker!.sent.length, 1, "deployed once");
  assert.equal((await svc.activeByAddress(tenant.id, "stellar:testnet", ACCOUNT_ADDRESS))?.id, account.id);

  // An EVM-only passkey flow does not leak in: a secp256k1 owner is refused as invalid input.
  await rejects(svc.create({ tenantId: tenant.id, network: "stellar:testnet", externalRef: "user-2", owner: { kind: "secp256k1", address: `0x${"ab".repeat(20)}` }, idempotencyKey: "idem-0002" }), "INVALID_INPUT");
});

// ── Vault ───────────────────────────────────────────────────────────────────────────────────────────

const id32 = disbursementIdBytes32("vdisb_test");
const vault = (node = new FakeNode()) => ({ node, vault: new SorobanVault(net, VAULT, undefined, node) });

test("stellar vault: status reads the contract and the USDC balance it holds", async () => {
  const { node, vault: v } = vault();
  for (const [k, val] of Object.entries({ owner: contract(3), operator: RELAYER, paused: false, max_per_disbursement: 100_0000000n, daily_limit: 500_0000000n, available_today: 480_0000000n, balance: 12_3400000n })) {
    node.answers.set(k, val);
  }
  const s = await v.status();
  assert.deepEqual(s, {
    address: VAULT,
    owner: contract(3),
    operator: RELAYER,
    paused: false,
    balanceAtomic: 12_3400000n,
    maxPerDisbursementAtomic: 100_0000000n,
    dailyLimitAtomic: 500_0000000n,
    availableTodayAtomic: 480_0000000n,
  });
  const balance = node.calls.find((c) => c.method === "balance")!;
  assert.equal(balance.contract, net.usdc.sac, "the balance is the USDC asset contract's, of the vault's address");
});

test("stellar vault: recipients are Stellar accounts or contracts, never the vault, a muxed or an EVM address", () => {
  const { vault: v } = vault();
  assert.equal(v.parseRecipient(BUYER), BUYER);
  assert.equal(v.parseRecipient(contract(5)), contract(5));
  for (const bad of [VAULT, `0x${"ab".repeat(20)}`, "G123", StrKey.encodeMed25519PublicKey(Buffer.concat([Buffer.alloc(8, 1), Buffer.alloc(32, 2)])).toString()]) {
    assert.throws(() => v.parseRecipient(bad), TypeError, bad);
  }
});

test("stellar vault: a payout the contract would refuse is reported with the EVM vault's name for it", async () => {
  const { node, vault: v } = vault();
  const refuse = (code: number, extra = "") => {
    node.failWith = new SimulationError("disburse", `HostError: Error(Contract, #${code})${extra}`);
  };
  const sim = () => v.simulate(RELAYER, id32, BUYER, 1_0000000n);

  node.answers.set("disburse", null);
  assert.deepEqual(await sim(), { ok: true });
  assert.equal(node.calls.at(-1)!.source, RELAYER, "simulated as the operator would send it");

  for (const [code, name] of [[3, "AlreadyDisbursed"], [4, "AboveDisbursementLimit"], [5, "AboveDailyLimit"], [6, "InsufficientBalance"], [7, "EnforcedPause"]] as const) {
    refuse(code);
    assert.deepEqual(await sim(), { ok: false, reason: name });
  }

  // The same number raised by another contract (the USDC token) is not the vault's error.
  refuse(3, `\n  contract:${net.usdc.sac} topics:[error]`);
  assert.deepEqual(await sim(), { ok: false, reason: "HostError: Error(Contract, #3)" });
  // What the USDC contract itself refuses says why a recipient cannot be paid.
  refuse(13);
  assert.deepEqual(await sim(), { ok: false, reason: "RecipientHasNoTrustline" });
  // A transport failure proves nothing: it is thrown, not reported as a refusal.
  node.failWith = new Error("fetch failed");
  await assert.rejects(sim(), /fetch failed/);
  node.failWith = new SimulationError("disburse", "RPC says: something odd");
  await assert.rejects(sim(), SimulationError);
});

test("stellar vault: if the operator is not the one asked to authorize, the sender is not the operator", async () => {
  const { node, vault: v } = vault();
  node.answers.set("disburse", null);
  node.auth = [{ kind: "address", address: RELAYER }];
  assert.deepEqual(await v.simulate(BUYER, id32, BUYER, 1n), { ok: false, reason: "NotOperator" });
  node.auth = [{ kind: "source_account" }];
  assert.deepEqual(await v.simulate(RELAYER, id32, BUYER, 1n), { ok: true });
});

test("stellar vault: paid is what the vault's own record says; the tx comes from its event when the node still has it", async () => {
  const { node, vault: v } = vault();
  node.answers.set("disbursed_amount", 0n);
  assert.equal(await v.paidAmount(id32), 0n);
  node.answers.set("payout", null);
  assert.equal(await v.findDisbursed(id32, 900n), null);

  node.answers.set("payout", { to: BUYER, amount: 5_0000000n });
  node.events = [{ txHash: "ee".repeat(32), ledger: 950 } as never];
  assert.deepEqual(await v.findDisbursed(id32, 900n), { txHash: "ee".repeat(32), blockNumber: 950n, to: BUYER, amount: 5_0000000n });
  // Out of what the node keeps: still proven paid, without a transaction.
  node.eventsFail = true;
  assert.deepEqual(await v.findDisbursed(id32, 900n), { txHash: null, blockNumber: null, to: BUYER, amount: 5_0000000n });
});

test("stellar vault: the chain position is the ledger and a transaction the node does not know is not found", async () => {
  const { node, vault: v } = vault();
  node.ledger = 4242;
  assert.equal(await v.blockNumber(), 4242n);
  assert.deepEqual(await v.inspect("aa".repeat(32)), { kind: "not_found" });
  node.transactions.set("bb".repeat(32), { status: "FAILED", ledger: 4000 } as never);
  assert.deepEqual(await v.inspect("bb".repeat(32)), { kind: "reverted", blockNumber: 4000n });
});

test("stellar vault: the relayer sends disburse(id, to, amount) authorized by its own account", async () => {
  const invoker = new FakeInvoker();
  const { vault: v } = vault();
  const submitter = new StellarVaultSubmitter(invoker);
  assert.equal(await submitter.sender(), RELAYER);

  const sent = await submitter.submit(VAULT, v.encodeDisburse(id32, BUYER, 10_5000000n));
  assert.equal(sent.submissionId, "stellar-1");
  assert.deepEqual(invoker.sent, [
    {
      contract: VAULT,
      fn: "disburse",
      args: [{ bytes: id32.slice(2) }, { address: BUYER }, { i128: { hi: "0", lo: "105000000" } }],
      auth: "source_account",
    },
  ]);
  assert.deepEqual(await submitter.status("stellar-1"), { state: "pending" });
});

test("stellar vault: i128 splits like Soroban does, high word signed", () => {
  assert.deepEqual(i128(0n), { i128: { hi: "0", lo: "0" } });
  assert.deepEqual(i128(2n ** 64n + 5n), { i128: { hi: "1", lo: "5" } });
  assert.deepEqual(i128(-1n), { i128: { hi: "-1", lo: "18446744073709551615" } });
});

// ── One repository, one service per network ─────────────────────────────────────────────────────────

test("vault repository: each network's service reconciles only its own payouts and counts only its own vault", async () => {
  const { SqliteVaultRepository } = await import("../../src/modules/vault/repository.ts");
  const repo = new SqliteVaultRepository(openDatabase(":memory:"));
  const now = "2026-10-09T12:00:00.000Z";
  const base = {
    state: "REQUESTED" as const,
    uncertain: false,
    amountAtomic: 5n,
    reference: null,
    requestHash: "h",
    submissionId: null,
    requestedAt: null,
    fromBlock: 1n,
    txHash: null,
    blockNumber: null,
    attempts: 0,
    nextCheckAt: now,
    lastError: null,
    failureCode: null,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
  const fuji = { ...base, id: "vdisb_fuji" as never, network: "eip155:43113" as const, vault: `0x${"fa".repeat(20)}`, to: `0x${"b1".repeat(20)}`, idempotencyKey: "key-fuji-0001" };
  const stellar = { ...base, id: "vdisb_stellar" as never, network: "stellar:testnet" as const, vault: VAULT, to: BUYER, idempotencyKey: "key-stellar-0001", reference: "purchase:1" };
  for (const d of [fuji, stellar]) repo.insert(d, { disbursementId: d.id, from: null, to: "REQUESTED", note: "created", at: now });

  assert.deepEqual(repo.listDue(now, 10, "stellar:testnet").map((d) => d.id), ["vdisb_stellar"]);
  assert.deepEqual(repo.listDue(now, 10, "eip155:43113").map((d) => d.id), ["vdisb_fuji"]);
  assert.equal(repo.listDue(now, 10).length, 2);
  assert.equal(repo.pendingAtomic(VAULT), 5n);
  // Stellar contract ids are upper case strkeys: found by the exact id they were stored with.
  assert.equal(repo.getByReference(VAULT, "purchase:1")?.id, "vdisb_stellar");
  assert.equal(repo.get("vdisb_stellar" as never)?.to, BUYER, "recipients are stored as given: strkeys are case sensitive");
});
