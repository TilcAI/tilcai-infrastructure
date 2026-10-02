// Phase 2 · owner: team. Decision, payment and fulfillment evidence stay separate (report §16.1, §17.4).
import type { ReceiptReference } from "tilcai-core/src/contracts.ts";

export interface ReceiptStore {
  put(ref: ReceiptReference, evidence: unknown): Promise<void>;
  listByOrder(orderId: string): Promise<Array<{ ref: ReceiptReference; evidence: unknown; createdAt: string }>>;
}
