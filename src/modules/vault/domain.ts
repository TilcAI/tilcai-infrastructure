import type { VaultDisbursementId } from "../../shared/ids.ts";
import type { NetworkId } from "../../config/networks.ts";

/**
 * Payout of a purchase that was paid off-chain (bank transfer, QR): the TilcaiVault sends
 * USDC to the buyer's wallet and the OpenZeppelin Relayer pays the gas.
 *
 * The vault records every disbursement id on-chain and refuses to pay one twice, so the
 * payout is retried freely: a duplicated or late relayer transaction can only revert.
 */
export const DISBURSEMENT_STATES = [
  "REQUESTED", // accepted; not (or no longer) in the relayer's hands
  "SUBMITTED", // the relayer has the transaction
  "CONFIRMED", // mined and the vault's Disbursed event matches the request
  "FAILED", // proven not paid, and no submission can still land
] as const;
export type DisbursementState = (typeof DISBURSEMENT_STATES)[number];

const NEXT: Record<DisbursementState, readonly DisbursementState[]> = {
  // REQUESTED → CONFIRMED when the id is already paid on-chain (a submission whose id was lost).
  REQUESTED: ["SUBMITTED", "CONFIRMED", "FAILED"],
  // Back to REQUESTED only when the submission failed and the id is still unpaid.
  SUBMITTED: ["CONFIRMED", "REQUESTED"],
  CONFIRMED: [],
  FAILED: [],
};

export function canMove(from: DisbursementState, to: DisbursementState): boolean {
  return NEXT[from].includes(to);
}

export const isTerminal = (s: DisbursementState): boolean => s === "CONFIRMED" || s === "FAILED";

export interface VaultDisbursement {
  id: VaultDisbursementId;
  state: DisbursementState;
  /** A relayer call ended without an answer: a transaction may exist that TilcAI cannot see. */
  uncertain: boolean;
  network: NetworkId;
  vault: string;
  to: string;
  amountAtomic: bigint;
  /** The caller's own id for what is being paid (an order, a purchase). One payout per reference. */
  reference: string | null;
  idempotencyKey: string;
  requestHash: string;
  /** Relayer transaction id and when it was asked for (persisted before calling the relayer). */
  submissionId: string | null;
  requestedAt: string | null;
  /** Chain head when the payout was created: where the search for its event starts. */
  fromBlock: bigint;
  txHash: string | null;
  blockNumber: bigint | null;
  attempts: number;
  nextCheckAt: string;
  lastError: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface DisbursementEvent {
  disbursementId: VaultDisbursementId;
  from: DisbursementState | null;
  to: DisbursementState;
  note: string;
  data?: Record<string, unknown>;
  at: string;
}
