/**
 * QR Simple mock: the bank QR a Bolivian payment gateway issues, as TilcAI's callers see it.
 *
 * It follows the API of Vendis, "QR Dinámico para Pagos" v1.3 (login, generate, status and
 * the payment callback), so a client written against this mock talks to the real service by
 * changing its base URL and credentials. No bank is involved and no money moves: a payment
 * happens when someone presses "Simular depósito".
 */
export const QR_STATUSES = ["Pendiente", "Pagado", "Anulado", "Fallido"] as const;
/** Pendiente: not paid yet · Pagado: paid · Anulado: voided or expired unpaid · Fallido: could not be created. */
export type QrStatus = (typeof QR_STATUSES)[number];

export interface QrCode {
  qrId: number;
  tokenId: number;
  deviceId: string;
  amountCents: number;
  /** The payer may type another amount in the bank app. */
  modifyAmount: boolean;
  /** Accepts more than one payment. */
  multiUse: boolean;
  /** The "glosa": "SN<device serial> <description sent by the caller>". */
  description: string;
  /** What the QR encodes. Opaque, like the real one. */
  payload: string;
  status: QrStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export type CallbackState = "PENDING" | "DELIVERED" | "FAILED" | "SKIPPED";

export interface QrPayment {
  id: number;
  qrId: number;
  amountCents: number;
  payerName: string;
  payerBank: string;
  paidAt: string;
  callbackState: CallbackState;
  callbackAttempts: number;
  callbackNextAt: string | null;
  callbackLastError: string | null;
  callbackDeliveredAt: string | null;
}

/** Body of the callback and item of `payments` in the status answer. */
export interface VendisPayment {
  payment_date: string;
  payment_amount: string;
  qr_id: number;
  payment_name: string;
  payment_bank: string;
}

/** An answer the mock gives in Vendis's own shape instead of TilcAI's error envelope. */
export class QrMockError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.message ?? status));
  }
}

/**
 * Vendis dates are "Y-m-d H:i:s" without a zone. The service is Bolivian, so the mock reads
 * and writes them in Bolivia time (UTC−4 all year).
 */
const BOLIVIA_OFFSET_MS = -4 * 3_600_000;

export function parseVendisDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const utc = Date.UTC(y, mo - 1, d, h, mi, s) - BOLIVIA_OFFSET_MS;
  const date = new Date(utc);
  // Rejects 2026-02-31 and friends, which Date.UTC would silently roll over.
  return formatVendisDate(date) === `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` ? date : null;
}

export function formatVendisDate(date: Date): string {
  return new Date(date.getTime() + BOLIVIA_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

const MAX_AMOUNT_CENTS = 1_000_000_00;

/** 34, "34.5", 34.50 → 3450. Null when it is not an amount in bolivianos with at most 2 decimals. */
export function amountToCents(value: unknown): number | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents <= MAX_AMOUNT_CENTS ? cents : null;
}

/** 3450 → "34.50". */
export const centsToAmount = (cents: number): string => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
