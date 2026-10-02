// Phase 2 (trust root) · Phase 4 (ERC-8004) · owner: Omar + Jhamil (report §15).
import type { BusinessId } from "tilcai-core/src/contracts.ts";

export interface IdentityResolver {
  /** Key trusted by an independent root (onboarding/registry), never the key embedded in the offer. */
  offerKey(businessId: BusinessId, keyId: string): Promise<{ publicKey: string; revoked: boolean } | undefined>;
  verifyOffer(offer: { keyId: string; signature: string; canonical: Uint8Array; businessId: BusinessId }): Promise<boolean>;
}

/**
 * ERC-8004 (Draft) resolver over an EVM registry (Identity / Reputation / Validation).
 * Read-only for buyers; registration/feedback writes go through the EVM relayer.
 * It never moves funds and is not a Soroban contract (report §15.2).
 */
export interface Erc8004Resolver {
  resolveAgent(registry: string, agentId: bigint): Promise<{ owner: string; agentURI: string; card?: unknown } | undefined>;
  linkProof(registry: string, agentId: bigint): Promise<{ domainVerified: boolean; stellarPayTo?: string }>;
  feedbackSummary(registry: string, agentId: bigint, tag?: string): Promise<{ count: number; average?: number }>;
}
