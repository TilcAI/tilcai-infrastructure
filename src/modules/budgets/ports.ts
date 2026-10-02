// Phase 2–3 · owner: Jhamil. Atomic holds on a shared root budget (report §13.3–13.5).
import type { BudgetReservationId, BudgetState, OrderId } from "tilcai-core/src/contracts.ts";

export interface BudgetStore {
  /** Atomic: fails if limit − (consumed + held) < amount. Never based on a stale read. */
  hold(budgetRef: string, orderId: OrderId, amountAtomic: bigint, expiresAt: string): Promise<BudgetReservationId>;
  consume(id: BudgetReservationId, paymentReceiptId: string): Promise<void>;
  /** Only when payment is NOT_ATTEMPTED/FAILED with no authority in flight (core `budgetResolution`). */
  release(id: BudgetReservationId, reason: string): Promise<void>;
  status(budgetRef: string): Promise<{ limitAtomic: bigint; heldAtomic: bigint; consumedAtomic: bigint; state?: BudgetState }>;
}
