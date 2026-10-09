import type { TenantId, QuotaKind } from "../tenants/ports.ts";
import type { AccountState, DelegationState } from "./ports.ts";

/**
 * Account: DEPLOYING → ACTIVE | FAILED (fase SCA §7.2). A repeated deployment is not an error: if the
 * address already has code the account goes to ACTIVE. FAILED only with evidence, and it is final.
 */
const ACCOUNT_NEXT: Record<AccountState, readonly AccountState[]> = {
  DEPLOYING: ["ACTIVE", "FAILED"],
  ACTIVE: [],
  FAILED: [],
};

/**
 * Delegation:
 *   AWAITING_OWNER → SUBMITTED (owner signed, sent through the relayer) | FAILED (expired or cancelled before signing)
 *   SUBMITTED      → ACTIVE (confirmed on-chain) | FAILED
 *   ACTIVE         → REVOKING (owner signed the revocation)
 *   REVOKING       → REVOKED | ACTIVE (the revocation failed on-chain, so the rule still binds)
 * REVOKED and FAILED are final.
 */
const DELEGATION_NEXT: Record<DelegationState, readonly DelegationState[]> = {
  AWAITING_OWNER: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["ACTIVE", "FAILED"],
  ACTIVE: ["REVOKING"],
  REVOKING: ["REVOKED", "ACTIVE"],
  REVOKED: [],
  FAILED: [],
};

export const canMoveAccount = (from: AccountState, to: AccountState): boolean => ACCOUNT_NEXT[from].includes(to);
export const canMoveDelegation = (from: DelegationState, to: DelegationState): boolean => DELEGATION_NEXT[from].includes(to);

/** A unique guarantee was hit. `reason` says which one. */
export class AccountConflictError extends Error {
  constructor(readonly reason: "ADDRESS" | "EXTERNAL_REF" | "IDEMPOTENCY_KEY" | "ONCHAIN_REF") {
    super(`account conflict: ${reason}`);
  }
}

/** The row changed since it was read (optimistic lock). Re-read and retry. */
export class StaleVersionError extends Error {
  constructor() {
    super("The record was modified concurrently.");
  }
}

export class IllegalTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`illegal transition ${from} → ${to}`);
  }
}

/** A change of state must come with the event that explains it. */
export class MissingEventError extends Error {
  constructor() {
    super("A change of state must be stored with its event.");
  }
}

/** Tenant, network, address and external reference are fixed when the account is created. */
export class IdentityChangeError extends Error {
  constructor(readonly field: string) {
    super(`${field} cannot change`);
  }
}

export class AccountNotFoundError extends Error {
  constructor() {
    super("account not found");
  }
}

/** The tenant has no quota left (or is suspended). Nothing was stored or counted. */
export class QuotaExceededError extends Error {
  constructor(readonly tenantId: TenantId, readonly kind: QuotaKind) {
    super(`quota exhausted for ${tenantId}: ${kind}`);
  }
}
