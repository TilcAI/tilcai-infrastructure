// Phase 2 · owner: Jhamil. Signed quotes, orders and the business adapter (report §10, §16, §21.3).
import type { BusinessId, OrderId, QuoteId, ServiceId, CommerceState } from "tilcai-core/src/contracts.ts";

export interface SignedQuote {
  schema: "tilcai-quote-v1";
  quoteId: QuoteId;
  businessId: BusinessId;
  serviceId: ServiceId;
  quantity: number;
  amountAtomic: string;
  network: string;
  assetId: string;
  payTo: string;
  termsHash: string;
  expiresAt: string;
  /** Crosschain payment options the business accepts for this quote (e.g. CCTP from eip155:43113). */
  acceptedSources?: ReadonlyArray<{ network: string; assetId: string; protocol: "cctp-v2" }>;
  keyId: string;
  signature: string; // ed25519 over canonical JSON with domain separation
}

export interface Order {
  id: OrderId;
  quoteId: QuoteId;
  businessId: BusinessId;
  commerce: CommerceState;
  createdAt: string;
}

/** Implemented once per business integration; the business stays the source of truth. */
export interface MerchantAdapter {
  getService(serviceId: ServiceId): Promise<{ title: string; description: string; capabilities: string[] }>;
  getAvailability(serviceId: ServiceId, quantity: number): Promise<{ available: boolean; checkedAt: string }>;
  quote(serviceId: ServiceId, quantity: number, idempotencyKey: string): Promise<SignedQuote>;
  holdResource?(orderId: OrderId, ttlSeconds: number): Promise<{ holdId: string; expiresAt: string }>;
  confirmOrder(orderId: OrderId, paymentReceiptId: string): Promise<{ reference: string }>;
  cancelOrder?(orderId: OrderId): Promise<{ accepted: boolean }>;
  getFulfillment(orderId: OrderId): Promise<{ status: "PENDING" | "CONFIRMED" | "FAILED"; evidence?: string }>;
}
