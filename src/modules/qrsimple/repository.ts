import type { DatabaseSync } from "node:sqlite";
import { tx } from "../../db/sqlite.ts";
import type { CallbackState, QrCode, QrPayment, QrStatus } from "./domain.ts";

export interface QrToken {
  id: number;
  name: string;
  createdAt: string;
  expiresAt: string;
}

export interface QrMockRepository {
  createToken(name: string, createdAt: string, expiresAt: string): QrToken;
  token(id: number): QrToken | undefined;
  insertCode(code: QrCode): void;
  code(qrId: number): QrCode | undefined;
  /** Unpaid and still valid, newest first. */
  pending(nowIso: string, limit: number): QrCode[];
  payments(qrId: number): QrPayment[];
  /** Records a payment and marks the QR paid, atomically. */
  pay(qrId: number, p: Omit<QrPayment, "id" | "qrId">, nowIso: string): QrPayment;
  dueCallbacks(nowIso: string, limit: number): QrPayment[];
  /**
   * Reserves a due notification for one sender until `leaseIso`. False = someone else took it
   * (or it is no longer pending), so it must not be sent from here.
   */
  claimCallback(paymentId: number, attempts: number, leaseIso: string): boolean;
  saveCallback(paymentId: number, patch: Pick<QrPayment, "callbackState" | "callbackAttempts" | "callbackNextAt" | "callbackLastError" | "callbackDeliveredAt">): void;
  /** Voids the QRs that ran out of time unpaid and returns them. */
  expire(nowIso: string): QrCode[];
}

export class SqliteQrMockRepository implements QrMockRepository {
  constructor(private readonly db: DatabaseSync) {}

  createToken(name: string, createdAt: string, expiresAt: string): QrToken {
    const res = this.db.prepare("INSERT INTO qr_mock_tokens (name, created_at, expires_at) VALUES (?,?,?)").run(name, createdAt, expiresAt);
    return { id: Number(res.lastInsertRowid), name, createdAt, expiresAt };
  }

  token(id: number): QrToken | undefined {
    const r = this.db.prepare("SELECT * FROM qr_mock_tokens WHERE id = ?").get(id) as Record<string, any> | undefined;
    return r ? { id: Number(r.id), name: r.name, createdAt: r.created_at, expiresAt: r.expires_at } : undefined;
  }

  insertCode(c: QrCode): void {
    this.db
      .prepare(
        `INSERT INTO qr_mock_codes (qr_id, token_id, device_id, amount_cents, modify_amount, is_multi_use, description, payload,
          status, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(c.qrId, c.tokenId, c.deviceId, c.amountCents, c.modifyAmount ? 1 : 0, c.multiUse ? 1 : 0, c.description, c.payload, c.status, c.expiresAt, c.createdAt, c.updatedAt);
  }

  code(qrId: number): QrCode | undefined {
    const r = this.db.prepare("SELECT * FROM qr_mock_codes WHERE qr_id = ?").get(qrId);
    return r ? toCode(r) : undefined;
  }

  pending(nowIso: string, limit: number): QrCode[] {
    return this.db
      .prepare("SELECT * FROM qr_mock_codes WHERE status = 'Pendiente' AND expires_at > ? ORDER BY created_at DESC, qr_id DESC LIMIT ?")
      .all(nowIso, limit)
      .map(toCode);
  }

  payments(qrId: number): QrPayment[] {
    return this.db.prepare("SELECT * FROM qr_mock_payments WHERE qr_id = ? ORDER BY id").all(qrId).map(toPayment);
  }

  pay(qrId: number, p: Omit<QrPayment, "id" | "qrId">, nowIso: string): QrPayment {
    return tx(this.db, () => {
      const res = this.db
        .prepare(
          `INSERT INTO qr_mock_payments (qr_id, amount_cents, payer_name, payer_bank, paid_at, callback_state, callback_attempts,
            callback_next_at, callback_last_error, callback_delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(qrId, p.amountCents, p.payerName, p.payerBank, p.paidAt, p.callbackState, p.callbackAttempts, p.callbackNextAt, p.callbackLastError, p.callbackDeliveredAt);
      this.db.prepare("UPDATE qr_mock_codes SET status = 'Pagado', updated_at = ? WHERE qr_id = ?").run(nowIso, qrId);
      return { ...p, id: Number(res.lastInsertRowid), qrId };
    });
  }

  dueCallbacks(nowIso: string, limit: number): QrPayment[] {
    return this.db
      .prepare("SELECT * FROM qr_mock_payments WHERE callback_state = 'PENDING' AND callback_next_at <= ? ORDER BY callback_next_at LIMIT ?")
      .all(nowIso, limit)
      .map(toPayment);
  }

  claimCallback(paymentId: number, attempts: number, leaseIso: string): boolean {
    const res = this.db
      .prepare("UPDATE qr_mock_payments SET callback_next_at = ? WHERE id = ? AND callback_state = 'PENDING' AND callback_attempts = ?")
      .run(leaseIso, paymentId, attempts);
    return Number(res.changes) === 1;
  }

  saveCallback(paymentId: number, patch: Pick<QrPayment, "callbackState" | "callbackAttempts" | "callbackNextAt" | "callbackLastError" | "callbackDeliveredAt">): void {
    this.db
      .prepare("UPDATE qr_mock_payments SET callback_state=?, callback_attempts=?, callback_next_at=?, callback_last_error=?, callback_delivered_at=? WHERE id=?")
      .run(patch.callbackState, patch.callbackAttempts, patch.callbackNextAt, patch.callbackLastError, patch.callbackDeliveredAt, paymentId);
  }

  expire(nowIso: string): QrCode[] {
    return tx(this.db, () => {
      const due = this.db.prepare("SELECT * FROM qr_mock_codes WHERE status = 'Pendiente' AND expires_at <= ?").all(nowIso).map(toCode);
      for (const c of due) this.db.prepare("UPDATE qr_mock_codes SET status = 'Anulado', updated_at = ? WHERE qr_id = ?").run(nowIso, c.qrId);
      return due.map((c) => ({ ...c, status: "Anulado" as QrStatus, updatedAt: nowIso }));
    });
  }
}

function toCode(r: unknown): QrCode {
  const row = r as Record<string, any>;
  return {
    qrId: Number(row.qr_id),
    tokenId: Number(row.token_id),
    deviceId: row.device_id,
    amountCents: Number(row.amount_cents),
    modifyAmount: row.modify_amount === 1,
    multiUse: row.is_multi_use === 1,
    description: row.description,
    payload: row.payload,
    status: row.status as QrStatus,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPayment(r: unknown): QrPayment {
  const row = r as Record<string, any>;
  return {
    id: Number(row.id),
    qrId: Number(row.qr_id),
    amountCents: Number(row.amount_cents),
    payerName: row.payer_name,
    payerBank: row.payer_bank,
    paidAt: row.paid_at,
    callbackState: row.callback_state as CallbackState,
    callbackAttempts: Number(row.callback_attempts),
    callbackNextAt: row.callback_next_at,
    callbackLastError: row.callback_last_error,
    callbackDeliveredAt: row.callback_delivered_at,
  };
}
