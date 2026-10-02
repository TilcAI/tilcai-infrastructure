// Phase 1 (crosschain CCTP rail, implemented in ../crosschain) · Phase 2 (x402 Stellar exact rail) · owner: Saul.
import type { PaymentAttemptId, PaymentState } from "tilcai-core/src/contracts.ts";

/**
 * One interface for every way TilcAI can pay a quote:
 *  - "x402-stellar-exact": signed Soroban auth entry → OZ Relayer x402 facilitator /verify + /settle
 *  - "cctp-v2": burn on an EVM source chain → Circle attestation → CctpForwarder mint on Stellar
 * The orchestrator only sees attempt ids and shared PaymentState.
 */
export interface PaymentRail {
  readonly kind: "x402-stellar-exact" | "cctp-v2";
  prepare(input: { orderId: string; amountAtomic: bigint; payTo: string; assetId: string; network: string; idempotencyKey: string }): Promise<{ attemptId: PaymentAttemptId; toSign: unknown }>;
  submit(attemptId: PaymentAttemptId, signed: unknown): Promise<PaymentState>;
  reconcile(attemptId: PaymentAttemptId): Promise<PaymentState>;
}
