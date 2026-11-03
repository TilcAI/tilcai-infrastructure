import type { DatabaseSync } from "node:sqlite";
import type { Attempt, Collection, CollectionState, ProviderId } from "./domain.ts";

export interface CollectionRepository {
  insert(c: Collection): void;
  get(id: string): Collection | undefined;
  byReference(tenantId: string, reference: string): Collection | undefined;
  byProviderRef(provider: ProviderId, providerRef: string): Collection | undefined;
  save(c: Collection): void;
  /** Pending collections not looked at since `beforeIso`, oldest check first. */
  due(beforeIso: string, limit: number): Collection[];
  list(tenantId: string, limit: number, status?: CollectionState): Collection[];
}

export class SqliteCollectionRepository implements CollectionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(c: Collection): void {
    this.db
      .prepare(
        `INSERT INTO qr_collections (id, tenant_id, reference, provider, provider_ref, provider_reference, amount_cents, currency, description,
          single_use, modify_amount, status, status_message, expires_at, image_base64, attempts_json, paid_amount_cents, paid_at, payer_name,
          payer_bank, payer_account, bank_reference, created_at, updated_at, checked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(...values(c));
  }

  get(id: string): Collection | undefined {
    return map(this.db.prepare("SELECT * FROM qr_collections WHERE id = ?").get(id));
  }

  byReference(tenantId: string, reference: string): Collection | undefined {
    return map(this.db.prepare("SELECT * FROM qr_collections WHERE tenant_id = ? AND reference = ?").get(tenantId, reference));
  }

  byProviderRef(provider: ProviderId, providerRef: string): Collection | undefined {
    return map(this.db.prepare("SELECT * FROM qr_collections WHERE provider = ? AND provider_ref = ?").get(provider, providerRef));
  }

  save(c: Collection): void {
    this.db
      .prepare(
        `UPDATE qr_collections SET status = ?, status_message = ?, expires_at = ?, attempts_json = ?, paid_amount_cents = ?, paid_at = ?,
           payer_name = ?, payer_bank = ?, payer_account = ?, bank_reference = ?, updated_at = ?, checked_at = ? WHERE id = ?`,
      )
      .run(c.status, c.statusMessage, c.expiresAt, JSON.stringify(c.attempts), c.paidAmountCents, c.paidAt, c.payerName, c.payerBank, c.payerAccount, c.bankReference, c.updatedAt, c.checkedAt, c.id);
  }

  due(beforeIso: string, limit: number): Collection[] {
    const rows = this.db
      .prepare("SELECT * FROM qr_collections WHERE status = 'PENDING' AND (checked_at IS NULL OR checked_at < ?) ORDER BY COALESCE(checked_at, created_at) LIMIT ?")
      .all(beforeIso, limit);
    return rows.map((r) => map(r)!);
  }

  list(tenantId: string, limit: number, status?: CollectionState): Collection[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM qr_collections WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?").all(tenantId, status, limit)
      : this.db.prepare("SELECT * FROM qr_collections WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?").all(tenantId, limit);
    return rows.map((r) => map(r)!);
  }
}

function values(c: Collection) {
  return [
    c.id, c.tenantId, c.reference, c.provider, c.providerRef, c.providerReference, c.amountCents, c.currency, c.description,
    c.singleUse ? 1 : 0, c.modifyAmount ? 1 : 0, c.status, c.statusMessage, c.expiresAt, c.imageBase64, JSON.stringify(c.attempts),
    c.paidAmountCents, c.paidAt, c.payerName, c.payerBank, c.payerAccount, c.bankReference, c.createdAt, c.updatedAt, c.checkedAt,
  ] as const;
}

function map(row: unknown): Collection | undefined {
  if (!row) return undefined;
  const r = row as Record<string, any>;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    reference: r.reference,
    provider: r.provider,
    providerRef: r.provider_ref,
    providerReference: r.provider_reference,
    amountCents: Number(r.amount_cents),
    currency: r.currency,
    description: r.description,
    singleUse: r.single_use === 1,
    modifyAmount: r.modify_amount === 1,
    status: r.status,
    statusMessage: r.status_message,
    expiresAt: r.expires_at,
    imageBase64: r.image_base64,
    attempts: JSON.parse(r.attempts_json) as Attempt[],
    paidAmountCents: r.paid_amount_cents === null ? null : Number(r.paid_amount_cents),
    paidAt: r.paid_at,
    payerName: r.payer_name,
    payerBank: r.payer_bank,
    payerAccount: r.payer_account,
    bankReference: r.bank_reference,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    checkedAt: r.checked_at,
  };
}
