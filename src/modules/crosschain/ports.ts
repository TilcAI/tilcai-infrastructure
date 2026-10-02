import type { Hex } from "../../shared/hex.ts";
import type { Finality } from "./domain.ts";
import type { MintTarget } from "./cctp/encoding.ts";

export interface UnsignedEvmCall {
  chainId: number;
  to: Hex;
  data: Hex;
  value: "0";
  description: string;
}

export interface DepositForBurnEvent {
  burnToken: Hex;
  amount: bigint;
  depositor: Hex;
  mintRecipient: Hex;
  destinationDomain: number;
  destinationTokenMessenger: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: Hex;
}

export interface RouterPaymentEvent {
  paymentId: Hex;
  payer: Hex;
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Hex;
  hookDataHash: Hex;
}

export type BurnInspection =
  | { kind: "not_found" }
  | { kind: "reverted"; blockNumber: bigint }
  | { kind: "mined"; blockNumber: bigint; confirmations: bigint; to: Hex | null; burns: DepositForBurnEvent[]; routerPayments: RouterPaymentEvent[] };

export interface EvmCctpPort {
  buildBurnCalls(p: {
    payer: Hex;
    amount: bigint;
    maxFee: bigint;
    destinationDomain: number;
    target: MintTarget;
    finality: Finality;
  }): Promise<{
    calls: UnsignedEvmCall[];
    usdcBalance: bigint;
    allowance: bigint;
  }>;
  /** Testnet developer key only. Returns the burn tx hash once mined. */
  devSignerAddress(): Hex | null;
  sendWithDevSigner(calls: UnsignedEvmCall[], onBurnHash: (hash: Hex) => void): Promise<Hex>;
  inspectBurn(txHash: Hex): Promise<BurnInspection>;
  /** Deployed TilcaiCctpRouter, or null when gasless modes are not available. */
  routerAddress(): Hex | null;
  /** EIP-3009 `authorizationState`: true once the payer's authorization has been consumed on-chain. */
  authorizationUsed(payer: Hex, nonce: Hex): Promise<boolean>;
  /** Testnet developer key signs the typed data (dev_gasless). */
  devSignTypedData(typed: Record<string, unknown>): Promise<Hex>;
}

export interface StellarAccountStatus {
  exists: boolean;
  trustline: boolean;
  authorized: boolean;
  usdcBalanceAtomic: bigint;
}

export interface StellarCctpPort {
  accountStatus(account: string): Promise<StellarAccountStatus>;
  isNonceUsed(nonce: Hex): Promise<boolean>;
  transactionStatus(hash: string): Promise<"SUCCESS" | "FAILED" | "NOT_FOUND">;
}

export type SubmissionStatus =
  | { state: "pending" }
  | { state: "confirmed"; txHash: string }
  | { state: "failed"; txHash?: string; reason: string };

/** Thrown when the submitter proves nothing was sent (4xx, failed simulation): no in-flight guard needed. */
export class SubmissionRejected extends Error {}

export interface MintSubmitter {
  readonly name: string;
  submit(message: Hex, attestation: Hex): Promise<{ submissionId: string; txHash?: string }>;
  status(submissionId: string): Promise<SubmissionStatus>;
}

export type EvmSubmissionStatus =
  | { state: "pending" }
  | { state: "confirmed"; txHash: Hex }
  | { state: "failed"; reason: string };

/** Sends a transaction from the relayer's own account (the payer never pays gas). */
export interface EvmTxSubmitter {
  readonly name: string;
  submit(to: Hex, data: Hex): Promise<{ submissionId: string }>;
  status(submissionId: string): Promise<EvmSubmissionStatus>;
}
