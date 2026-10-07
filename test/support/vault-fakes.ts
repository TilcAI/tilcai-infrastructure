import { decodeFunctionData } from "viem";
import { loadEnv } from "../../src/config/env.ts";
import { networks } from "../../src/config/networks.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import { sameHex, type Hex } from "../../src/shared/hex.ts";
import { silentLogger } from "../../src/shared/log.ts";
import { SubmissionRejected, type EvmSubmissionStatus } from "../../src/modules/crosschain/ports.ts";
import { VAULT_ABI } from "../../src/modules/vault/adapters/evm.ts";
import { isTerminal } from "../../src/modules/vault/domain.ts";
import type { DisbursementInspection, VaultPort, VaultStatus, VaultSubmitter } from "../../src/modules/vault/ports.ts";
import { SqliteVaultRepository } from "../../src/modules/vault/repository.ts";
import { VaultDisbursementService } from "../../src/modules/vault/service.ts";
import { FakeClock } from "./fakes.ts";

const nets = networks(loadEnv({}));
export const VAULT: Hex = "0x00000000000000000000000000000000000000fa";
export const RELAYER: Hex = "0xcc0bbfaffb786c8bb1212c3555b8c6d0b195d6f5";
export const OWNER: Hex = "0x4b7e897e51305c3d6935671eaec6cb7874488f4f";
export const BUYER: Hex = "0x00000000000000000000000000000000000000b1";

/** The TilcaiVault's rules in memory: same checks, in the same order, as the contract. */
export class FakeVault implements VaultPort {
  operator: Hex = RELAYER;
  paused = false;
  balance = 1_000_000_000n;
  maxPerDisbursement = 100_000_000n;
  dailyLimit = 500_000_000n;
  spentToday = 0n;
  head = 1000n;
  paid = new Map<string, { to: Hex; amount: bigint; txHash: Hex; blockNumber: bigint }>();
  txs = new Map<string, DisbursementInspection>();
  /** False = the Disbursed event cannot be located (out of the searched range). */
  eventsVisible = true;
  private counter = 0;

  address() {
    return VAULT;
  }
  async blockNumber() {
    return this.head;
  }
  async status(): Promise<VaultStatus> {
    return {
      address: VAULT,
      owner: OWNER,
      operator: this.operator,
      paused: this.paused,
      balanceAtomic: this.balance,
      maxPerDisbursementAtomic: this.maxPerDisbursement,
      dailyLimitAtomic: this.dailyLimit,
      availableTodayAtomic: this.spentToday >= this.dailyLimit ? 0n : this.dailyLimit - this.spentToday,
    };
  }
  async paidAmount(id32: Hex) {
    return this.paid.get(id32)?.amount ?? 0n;
  }
  encodeDisburse(id32: Hex, to: Hex, amount: bigint) {
    return `0x${Buffer.from(JSON.stringify([id32, to, amount.toString()])).toString("hex")}` as Hex;
  }
  private revertReason(sender: Hex, id32: Hex, amount: bigint): string | null {
    if (this.paused) return "EnforcedPause";
    if (!sameHex(sender, this.operator)) return "NotOperator";
    if (this.paid.has(id32)) return "AlreadyDisbursed";
    if (amount > this.maxPerDisbursement) return "AboveDisbursementLimit";
    if (amount > this.dailyLimit - this.spentToday) return "AboveDailyLimit";
    if (amount > this.balance) return "InsufficientBalance";
    return null;
  }
  async simulate(sender: Hex, id32: Hex, _to: Hex, amount: bigint) {
    const reason = this.revertReason(sender, id32, amount);
    return reason ? ({ ok: false, reason } as const) : ({ ok: true } as const);
  }
  /** Mines a `disburse` sent by `sender`: pays or reverts, like the chain would. */
  execute(sender: Hex, data: Hex): Hex {
    const [id32, to, amount] = JSON.parse(Buffer.from(data.slice(2), "hex").toString()) as [Hex, Hex, string];
    const txHash = `0x${(++this.counter).toString(16).padStart(64, "d")}` as Hex;
    const blockNumber = ++this.head;
    if (this.revertReason(sender, id32, BigInt(amount))) {
      this.txs.set(txHash, { kind: "reverted", blockNumber });
      return txHash;
    }
    this.balance -= BigInt(amount);
    this.spentToday += BigInt(amount);
    this.paid.set(id32, { to, amount: BigInt(amount), txHash, blockNumber });
    this.txs.set(txHash, { kind: "mined", blockNumber, confirmations: 3n, disbursed: [{ disbursementId: id32, to, amount: BigInt(amount) }] });
    return txHash;
  }
  async inspect(txHash: Hex): Promise<DisbursementInspection> {
    return this.txs.get(txHash) ?? { kind: "not_found" };
  }
  async findDisbursed(id32: Hex) {
    const p = this.paid.get(id32);
    return p && this.eventsVisible ? { txHash: p.txHash, blockNumber: p.blockNumber, to: p.to, amount: p.amount } : null;
  }
}

/** The relayer's EVM account: takes `disburse` calls and (by default) mines them at once. */
export class FakeVaultSubmitter implements VaultSubmitter {
  readonly name = "relayer";
  account: Hex = RELAYER;
  submits: Array<{ to: Hex; data: Hex }> = [];
  statuses = new Map<string, EvmSubmissionStatus>();
  /** rejected: a 4xx, nothing sent. ambiguous: no answer, nothing sent. lost: no answer, but it was mined. */
  failNextSubmit: false | "rejected" | "ambiguous" | "lost" = false;
  autoMine = true;
  constructor(private readonly vault: FakeVault) {}
  async sender() {
    return this.account;
  }
  async submit(to: Hex, data: Hex) {
    const fail = this.failNextSubmit;
    this.failNextSubmit = false;
    if (fail === "rejected") throw new SubmissionRejected("relayer 400");
    if (fail === "ambiguous") throw new Error("relayer timeout");
    this.submits.push({ to, data });
    const id = `evm-${this.submits.length}`;
    if (fail === "lost") {
      this.vault.execute(this.account, data);
      throw new Error("relayer timeout");
    }
    if (this.autoMine) this.mine(id);
    else this.statuses.set(id, { state: "pending" });
    return { submissionId: id };
  }
  mine(id: string): Hex {
    const data = this.submits[Number(id.slice(4)) - 1]!.data;
    const txHash = this.vault.execute(this.account, data);
    this.statuses.set(id, { state: "confirmed", txHash });
    return txHash;
  }
  async status(id: string) {
    return this.statuses.get(id) ?? { state: "pending" as const };
  }
}

export function vaultHarness(options: { maxAttempts?: number } = {}) {
  const clock = new FakeClock();
  const repo = new SqliteVaultRepository(openDatabase(":memory:"));
  const vault = new FakeVault();
  const submitter = new FakeVaultSubmitter(vault);
  const svc = new VaultDisbursementService({
    repo,
    vault,
    submitter,
    network: { ...nets.avalancheFuji, vault: VAULT },
    clock,
    log: silentLogger,
    options: { pollMs: 1000, minConfirmations: 1, ...options },
  });
  /** Drives the worker until the payout settles (bounded). */
  const drive = async (id: string, steps = 12) => {
    for (let i = 0; i < steps; i++) {
      const d = svc.mustGet(id);
      if (isTerminal(d.state)) return d;
      clock.advance(Math.max(0, Date.parse(d.nextCheckAt) - clock.t) + 1);
      await svc.step(svc.mustGet(id));
    }
    return svc.mustGet(id);
  };
  return { clock, repo, vault, submitter, svc, drive };
}

/** Decodes real `disburse` calldata (used to check the production encoder). */
export const decodeDisburse = (data: Hex) => decodeFunctionData({ abi: VAULT_ABI, data }).args as readonly [Hex, Hex, bigint];
