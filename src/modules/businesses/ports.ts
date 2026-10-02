// Phase 1–2 · owner: Jhamil. Provider identity, operators and versioned payout destinations (report §12.10).
import type { BusinessId, PrincipalId } from "tilcai-core/src/contracts.ts";

export interface PayoutDestination {
  /** CAIP-2 network + exact asset contract; "USDC" alone is never an asset id (§14.4). */
  network: "stellar:testnet" | "stellar:mainnet";
  assetId: string;
  payTo: string;
  version: number;
  activatedAt: string;
}

export interface BusinessProfile {
  id: BusinessId;
  ownerPrincipalId: PrincipalId;
  legalName: string;
  origin: string; // verified domain
  /** Offer-signing keys trusted through onboarding (independent trust root, §15.3). */
  offerKeys: ReadonlyArray<{ keyId: string; alg: "ed25519"; publicKey: string; revokedAt?: string }>;
  payout: PayoutDestination;
  capabilities: ReadonlyArray<"get_availability" | "hold_resource" | "confirm_order" | "cancel_order">;
}

export interface BusinessRepository {
  get(id: BusinessId): Promise<BusinessProfile | undefined>;
  list(cursor?: string, pageSize?: number): Promise<{ items: BusinessProfile[]; nextCursor?: string }>;
  /** Strong-auth admin action; previous approvals are never reused for a new destination. */
  rotatePayout(id: BusinessId, next: Omit<PayoutDestination, "version" | "activatedAt">): Promise<PayoutDestination>;
}
