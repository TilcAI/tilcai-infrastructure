// Phase 2 (per-purchase approval) · Phase 3 (delegated mandates) · owner: Jose + Omar (report §12.4–12.6, §16.4).
import type { ApprovalBinding, Intent } from "tilcai-core/src/authority.ts";
import type { IntentId, MandateId } from "tilcai-core/src/contracts.ts";

export interface AuthorizationProvider {
  /** Creates a PENDING approval request bound to the intent commitment and exact financial action hash. */
  requestApproval(intent: Intent, actionHash: string): Promise<{ requestId: string; expiresAt: string }>;
  /** Trusted store only: an agent can never supply an approval. */
  getApproval(intentId: IntentId): Promise<ApprovalBinding | undefined>;
  revokeMandate(mandateId: MandateId, by: string): Promise<void>;
}
