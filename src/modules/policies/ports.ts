// Phase 2 · owner: Omar. Deterministic evaluation; ALLOW is never authorization to transfer (report §13).
import type { DecisionOutcome, ErrorCode } from "tilcai-core/contracts";
import type { Intent, Mandate } from "tilcai-core/experimental/authority";

export interface PolicyDecision {
  outcome: DecisionOutcome;
  reason: ErrorCode | "POLICY_OK";
  policyVersion: number;
}

export interface PolicyEngine {
  /** Pure: same inputs, same output. Budget availability comes from a fresh BudgetStore read. */
  evaluate(intent: Intent, mandate: Mandate | null, availableAtomic: bigint, now: Date): PolicyDecision;
}
