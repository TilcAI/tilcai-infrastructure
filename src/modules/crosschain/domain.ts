import { canTransition, type PaymentAttemptId, type PaymentState } from "tilcai-core/src/contracts.ts";
import type { Hex } from "../../shared/hex.ts";
import type { RouteQuoteId } from "../../shared/ids.ts";
import type { TenantId } from "../tenants/ports.ts";
import type { MintTarget } from "./cctp/encoding.ts";

/**
 * Crosschain USDC payment (CCTP V2): burn on the source chain, Circle attests,
 * the CctpForwarder mints on Stellar and forwards atomically to `payTo`.
 *
 * Detailed states are internal; the shared `PaymentState` (tilcai-shared-v1)
 * is derived and every derived change is checked against the shared graph.
 */
export const CROSSCHAIN_STATES = [
  "AWAITING_BURN", // prepared; unsigned burn calls issued to the payer
  "BURN_SUBMITTED", // source tx hash known (persisted before anything else)
  "BURN_CONFIRMED", // receipt + DepositForBurn event verified against the quote
  "ATTESTED", // Circle attestation obtained and raw message verified
  "MINT_SUBMITTED", // mint_and_forward handed to a submitter (relayer/local)
  "SETTLED", // destination tx confirmed and CCTP nonce marked used
  "FAILED", // proven not to pay this route (reverted or mismatching burn)
] as const;
export type CrosschainState = (typeof CROSSCHAIN_STATES)[number];

const NEXT: Record<CrosschainState, readonly CrosschainState[]> = {
  // FAILED only when a signed gasless authorization expired unused (shared graph: PREPARED → FAILED).
  AWAITING_BURN: ["BURN_SUBMITTED", "FAILED"],
  BURN_SUBMITTED: ["BURN_CONFIRMED", "FAILED"],
  BURN_CONFIRMED: ["ATTESTED"],
  // ATTESTED → SETTLED when the nonce is already used (an earlier submission landed).
  ATTESTED: ["MINT_SUBMITTED", "SETTLED"],
  // Back to ATTESTED only when the submission failed AND the nonce is still unused:
  // CCTP's nonce makes the mint idempotent, so retrying it can never pay twice.
  MINT_SUBMITTED: ["SETTLED", "ATTESTED"],
  SETTLED: [],
  FAILED: [],
};

export function canMove(from: CrosschainState, to: CrosschainState): boolean {
  return NEXT[from].includes(to);
}

/** Shared payment state. `uncertain` is sticky until a terminal state (shared graph has no UNCERTAIN → SENT). */
export function paymentStateOf(state: CrosschainState, uncertain: boolean): PaymentState {
  if (state === "SETTLED") return "SETTLED";
  if (state === "FAILED") return "FAILED";
  if (state === "AWAITING_BURN") return "PREPARED";
  return uncertain ? "UNCERTAIN" : "SENT";
}

export function assertSharedTransition(from: PaymentState, to: PaymentState): void {
  if (from !== to && !canTransition("payment", from, to)) {
    throw new Error(`Shared payment transition ${from} → ${to} is not allowed.`);
  }
}

/**
 * external      payer broadcasts approve + burn from their wallet (pays AVAX)
 * dev_signer    backend signs and broadcasts the burn with a testnet key (pays AVAX)
 * gasless       payer signs EIP-3009 typed data; the OZ Relayer submits it through TilcaiCctpRouter
 * dev_gasless   same as gasless, signed by the testnet developer key
 * account       the payer is a smart account issued by TilcAI: its owner signs the same EIP-3009
 *               message with the passkey (ERC-1271) and the relayer submits it through TilcaiCctpRouterV2
 */
export type PaymentMode = "external" | "dev_signer" | "gasless" | "dev_gasless" | "account";
export const PAYMENT_MODES = ["external", "dev_signer", "gasless", "dev_gasless", "account"] as const satisfies readonly PaymentMode[];
export const isGaslessMode = (m: PaymentMode): boolean => m === "gasless" || m === "dev_gasless" || m === "account";
export type Finality = 1000 | 2000;

export interface Preflight {
  payToExists: boolean;
  payToTrustline: boolean;
  payToAuthorized: boolean;
}

export interface RouteQuote {
  id: RouteQuoteId;
  /** Who asked for it. Calls made on behalf of another tenant see it as not found. */
  tenantId: TenantId;
  sourceNetwork: "eip155:43113";
  destinationNetwork: "stellar:testnet";
  sourceDomain: number;
  destinationDomain: number;
  payTo: string;
  /** What the merchant must receive, in destination precision (7 decimals). */
  destinationAmountAtomic: bigint;
  /** What is burned on the source chain (6 decimals) = canonical amount + maxFee. */
  burnAmountAtomic: bigint;
  maxFeeAtomic: bigint;
  feeBpsHundredths: bigint;
  finality: Finality;
  burnToken: Hex;
  target: MintTarget;
  preflight: Preflight;
  createdAt: string;
  expiresAt: string;
}

export interface StoredAuthorization {
  validAfter: string;
  validBefore: string;
  v: number;
  r: Hex;
  s: Hex;
  /** `account` mode: the account's whole ERC-1271 signature (v, r and s are then zero). */
  signature?: Hex;
}

export interface CrosschainPayment {
  id: PaymentAttemptId;
  /** Owner of the payment; always the owner of its quote. Never changes. */
  tenantId: TenantId;
  quoteId: RouteQuoteId;
  state: CrosschainState;
  uncertain: boolean;
  mode: PaymentMode;
  payer: Hex | null;
  orderId: string | null;
  idempotencyKey: string;
  requestHash: string;
  /** Gasless: signed EIP-3009 authorization (persisted before the relayer sees it) and relayer tx id. */
  burnAuthorization: StoredAuthorization | null;
  burnSubmissionId: string | null;
  burnRequestedAt: string | null;
  burnTxHash: Hex | null;
  burnBlock: bigint | null;
  cctpNonce: Hex | null;
  message: Hex | null;
  attestation: Hex | null;
  feeExecutedAtomic: bigint | null;
  mintSubmitter: string | null;
  mintSubmissionId: string | null;
  mintRequestedAt: string | null;
  mintTxHash: string | null;
  attempts: number;
  nextCheckAt: string;
  lastError: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PaymentEvent {
  paymentId: PaymentAttemptId;
  from: CrosschainState | null;
  to: CrosschainState;
  note: string;
  data?: Record<string, unknown>;
  at: string;
}
