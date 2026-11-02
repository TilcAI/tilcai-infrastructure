/**
 * QR collections: a bank QR that a customer pays from their banking app, issued by one of several
 * providers (Banco Económico, Red Enlace ATC QR Simple, ATC QR MLD) behind a single interface.
 *
 * Providers are tried in a configured order: the first is the principal, the rest are fallbacks that
 * take over when it fails. The mock (QR_MOCK_ENABLED) replaces the whole list and moves no money.
 */
export const COLLECTION_STATES = ["PENDING", "PAID", "CANCELLED", "EXPIRED", "ERROR"] as const;
export type CollectionState = (typeof COLLECTION_STATES)[number];

export type ProviderId = "baneco" | "atc-simple" | "atc-mld" | "mock";
export const REAL_PROVIDER_IDS = ["baneco", "atc-simple", "atc-mld"] as const;

/** What the gateway asks a provider to issue. Amounts are bolivianos in cents; never floats. */
export interface ProviderQrRequest {
  /** Numeric id (below 2^31: ATC parses it as an int) the provider echoes back as transaction / originator reference. */
  reference: string;
  amountCents: number;
  currency: "BOB";
  description: string;
  expiresAt: Date;
  singleUse: boolean;
  modifyAmount: boolean;
}

export interface ProviderQr {
  /** The provider's own id of the QR: what status and cancel are asked with. */
  providerRef: string;
  /** PNG, base64. */
  imageBase64: string;
  /** Effective expiry, when the provider says so (Baneco only takes a date). */
  expiresAt: Date | null;
}

export interface ProviderPayment {
  amountCents: number | null;
  paidAt: string | null;
  payerName: string | null;
  payerBank: string | null;
  payerAccount: string | null;
  bankReference: string | null;
}

export interface ProviderStatus {
  state: CollectionState;
  message: string | null;
  payment: ProviderPayment | null;
}

export interface QrProvider {
  readonly id: ProviderId;
  /** Human name for logs and the providers listing. */
  readonly label: string;
  /** Whether it can be asked at all (credentials present). Unconfigured providers are skipped. */
  configured(): boolean;
  generate(req: ProviderQrRequest): Promise<ProviderQr>;
  status(providerRef: string): Promise<ProviderStatus>;
  /** Absent when the provider has no cancel operation. */
  cancel?(providerRef: string): Promise<void>;
}

export type ProviderFailureKind = "network" | "timeout" | "auth" | "http" | "rejected" | "invalid-response" | "unsupported";

/** A provider could not do what was asked. Never carries credentials or tokens. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly kind: ProviderFailureKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export interface Collection {
  id: string;
  tenantId: string;
  /** The caller's own reference (their order number), if any. */
  reference: string | null;
  provider: ProviderId;
  providerRef: string;
  /** What the provider was given as transaction / originator reference. */
  providerReference: string;
  amountCents: number;
  currency: "BOB";
  description: string;
  singleUse: boolean;
  modifyAmount: boolean;
  status: CollectionState;
  statusMessage: string | null;
  expiresAt: string;
  imageBase64: string;
  attempts: Attempt[];
  paidAmountCents: number | null;
  paidAt: string | null;
  payerName: string | null;
  payerBank: string | null;
  payerAccount: string | null;
  bankReference: string | null;
  createdAt: string;
  updatedAt: string;
  checkedAt: string | null;
}

/** One provider tried while issuing a QR: how the fallback went. */
export interface Attempt {
  provider: ProviderId;
  ok: boolean;
  /** Absent when the provider was skipped (not configured, cooling down). */
  skipped?: "not-configured" | "cooling-down";
  kind?: ProviderFailureKind;
  error?: string;
  ms: number;
}

export class CollectionError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "NO_PROVIDER" | "ALL_PROVIDERS_FAILED" | "INVALID_INPUT" | "UNSUPPORTED" | "PROVIDER_ERROR",
    message: string,
    readonly attempts: Attempt[] = [],
  ) {
    super(message);
  }
}

/** Dates sent to Baneco (`dueDate`) are yyyy-MM-dd in Bolivia time (UTC−4, no DST). */
export function boliviaDate(d: Date): string {
  return new Date(d.getTime() - 4 * 3_600_000).toISOString().slice(0, 10);
}
/** The last second of that Bolivian day, as an instant. */
export function endOfBoliviaDay(ymd: string): Date {
  return new Date(Date.parse(`${ymd}T23:59:59.000Z`) + 4 * 3_600_000);
}
