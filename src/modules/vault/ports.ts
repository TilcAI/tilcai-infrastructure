import type { Hex } from "../../shared/hex.ts";

/**
 * One vault per network, the same rules everywhere: an EVM `TilcaiVault` (Avalanche) and a Soroban
 * `tilcai_vault` (Stellar). Addresses, transaction hashes and the chain position are plain strings
 * here; each adapter knows its own format. `id32` is always the 32-byte disbursement id as hex.
 */
export interface VaultStatus {
  address: string;
  owner: string;
  operator: string;
  paused: boolean;
  balanceAtomic: bigint;
  maxPerDisbursementAtomic: bigint;
  dailyLimitAtomic: bigint;
  availableTodayAtomic: bigint;
}

export interface DisbursedEvent {
  disbursementId: Hex;
  to: string;
  amount: bigint;
}

/** `blockNumber` is the block (EVM) or the ledger (Stellar). */
export type DisbursementInspection =
  | { kind: "not_found" }
  | { kind: "reverted"; blockNumber: bigint }
  | { kind: "mined"; blockNumber: bigint; confirmations: bigint; disbursed: DisbursedEvent[] };

/** What the service needs to know about a network's vault. Never signs: payouts go out through the submitter. */
export interface VaultPort {
  address(): string;
  status(): Promise<VaultStatus>;
  /** Chain position (block or ledger) now: payouts are searched for from where they were created. */
  blockNumber(): Promise<bigint>;
  /** Amount paid for an id: non-zero once the id has been paid. */
  paidAmount(id32: Hex): Promise<bigint>;
  /** The call that pays `amount` to `to`, in the form the network's submitter takes. */
  encodeDisburse(id32: Hex, to: string, amount: bigint): string;
  /** The recipient as it is stored and compared. Throws `TypeError` (with a message for the caller) if it cannot be paid. */
  parseRecipient(to: string): string;
  /** Dry run as `sender`: says why the payout would fail, before any fee is spent. */
  simulate(sender: string, id32: Hex, to: string, amount: bigint): Promise<{ ok: true } | { ok: false; reason: string }>;
  inspect(txHash: string): Promise<DisbursementInspection>;
  /**
   * Looks for the Disbursed event of an id from `fromBlock` on (bounded range). `txHash` and
   * `blockNumber` are null when the id is paid but the event is out of what the node retains.
   */
  findDisbursed(id32: Hex, fromBlock: bigint): Promise<{ txHash: string | null; blockNumber: bigint | null; to: string; amount: bigint } | null>;
}

export type VaultSubmissionStatus = { state: "pending" } | { state: "confirmed"; txHash: string } | { state: "failed"; reason: string };

/** The relayer account that sends the payouts. It must be the vault's operator. */
export interface VaultSubmitter {
  readonly name: string;
  sender(): Promise<string>;
  /** Sends the call `VaultPort.encodeDisburse` produced to `vault`. */
  submit(vault: string, call: string): Promise<{ submissionId: string }>;
  status(submissionId: string): Promise<VaultSubmissionStatus>;
}

/** The part of a network the vault service reads. */
export interface VaultNetwork {
  id: "eip155:43113" | "stellar:testnet";
  explorer: string;
  usdc: { decimals: number };
}
