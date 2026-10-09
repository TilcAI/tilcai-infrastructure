import type { Hex } from "../../shared/hex.ts";
import type { EvmTxSubmitter } from "../crosschain/ports.ts";

export interface VaultStatus {
  address: Hex;
  owner: Hex;
  operator: Hex;
  paused: boolean;
  balanceAtomic: bigint;
  maxPerDisbursementAtomic: bigint;
  dailyLimitAtomic: bigint;
  availableTodayAtomic: bigint;
}

export interface DisbursedEvent {
  disbursementId: Hex;
  to: Hex;
  amount: bigint;
}

export type DisbursementInspection =
  | { kind: "not_found" }
  | { kind: "reverted"; blockNumber: bigint }
  | { kind: "mined"; blockNumber: bigint; confirmations: bigint; disbursed: DisbursedEvent[] };

/** Reads of the TilcaiVault contract. Never signs: payouts go out through the submitter. */
export interface VaultPort {
  address(): Hex;
  status(): Promise<VaultStatus>;
  blockNumber(): Promise<bigint>;
  /** `disbursedAmount(id)`: non-zero once the id has been paid. */
  paidAmount(id32: Hex): Promise<bigint>;
  encodeDisburse(id32: Hex, to: Hex, amount: bigint): Hex;
  /** eth_call from the sender: says why the payout would revert, before any gas is spent. */
  simulate(sender: Hex, id32: Hex, to: Hex, amount: bigint): Promise<{ ok: true } | { ok: false; reason: string }>;
  inspect(txHash: Hex): Promise<DisbursementInspection>;
  /** Looks for the Disbursed event of an id from `fromBlock` on (bounded range). */
  findDisbursed(id32: Hex, fromBlock: bigint): Promise<{ txHash: Hex; blockNumber: bigint; to: Hex; amount: bigint } | null>;
}

/** The relayer account that sends the payouts. It must be the vault's operator. */
export interface VaultSubmitter extends EvmTxSubmitter {
  sender(): Promise<Hex>;
}
