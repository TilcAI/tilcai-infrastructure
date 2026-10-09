import type { DatabaseSync } from "node:sqlite";
import { tx } from "../../db/sqlite.ts";
import type { VaultDisbursementId } from "../../shared/ids.ts";
import type { DisbursementEvent, DisbursementState, VaultDisbursement } from "./domain.ts";

export class ConcurrentUpdateError extends Error {
  constructor() {
    super("Disbursement was modified concurrently.");
  }
}

export interface VaultRepository {
  insert(d: VaultDisbursement, ev: DisbursementEvent): void;
  get(id: VaultDisbursementId): VaultDisbursement | undefined;
  getByIdempotencyKey(key: string): VaultDisbursement | undefined;
  /** The payout of a reference that has not failed, if there is one. */
  getByReference(vault: string, reference: string): VaultDisbursement | undefined;
  /** Optimistic update: fails if `expectedVersion` is stale. Appends the event atomically. */
  update(d: VaultDisbursement, expectedVersion: number, ev?: DisbursementEvent): VaultDisbursement;
  /** Payouts to reconcile now; with `network`, only that network's (each network has its own service). */
  listDue(nowIso: string, limit: number, network?: string): VaultDisbursement[];
  /** USDC already promised to payouts that have not finished. */
  pendingAtomic(vault: string): bigint;
  events(id: VaultDisbursementId): DisbursementEvent[];
}

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(v as string));
const str = (v: bigint | null): string | null => (v === null ? null : v.toString());
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export class SqliteVaultRepository implements VaultRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(d: VaultDisbursement, ev: DisbursementEvent): void {
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO vault_disbursements (id, state, uncertain, network, vault, to_address, amount_atomic, reference,
            idempotency_key, request_hash, from_block, attempts, next_check_at, created_at, updated_at, version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .run(
          d.id, d.state, d.uncertain ? 1 : 0, d.network, d.vault.toLowerCase(), d.to, d.amountAtomic.toString(), d.reference,
          d.idempotencyKey, d.requestHash, d.fromBlock.toString(), d.attempts, d.nextCheckAt, d.createdAt, d.updatedAt,
        );
      this.appendEvent(ev);
    });
  }

  get(id: VaultDisbursementId): VaultDisbursement | undefined {
    const r = this.db.prepare("SELECT * FROM vault_disbursements WHERE id = ?").get(id);
    return r ? this.toDisbursement(r as Record<string, any>) : undefined;
  }

  getByIdempotencyKey(key: string): VaultDisbursement | undefined {
    const r = this.db.prepare("SELECT * FROM vault_disbursements WHERE idempotency_key = ?").get(key);
    return r ? this.toDisbursement(r as Record<string, any>) : undefined;
  }

  getByReference(vault: string, reference: string): VaultDisbursement | undefined {
    const r = this.db
      .prepare("SELECT * FROM vault_disbursements WHERE vault = ? AND reference = ? AND state <> 'FAILED'")
      .get(vault.toLowerCase(), reference);
    return r ? this.toDisbursement(r as Record<string, any>) : undefined;
  }

  update(d: VaultDisbursement, expectedVersion: number, ev?: DisbursementEvent): VaultDisbursement {
    const next = { ...d, version: expectedVersion + 1 };
    tx(this.db, () => {
      const res = this.db
        .prepare(
          `UPDATE vault_disbursements SET state=?, uncertain=?, submission_id=?, requested_at=?, tx_hash=?, block_number=?,
            attempts=?, next_check_at=?, last_error=?, failure_code=?, updated_at=?, version=?
           WHERE id=? AND version=?`,
        )
        .run(
          next.state, next.uncertain ? 1 : 0, next.submissionId, next.requestedAt, next.txHash, str(next.blockNumber),
          next.attempts, next.nextCheckAt, next.lastError, next.failureCode, next.updatedAt, next.version, next.id, expectedVersion,
        );
      if (Number(res.changes) !== 1) throw new ConcurrentUpdateError();
      if (ev) this.appendEvent(ev);
    });
    return next;
  }

  listDue(nowIso: string, limit: number, network?: string): VaultDisbursement[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM vault_disbursements
         WHERE state IN ('REQUESTED','SUBMITTED') AND next_check_at <= ?${network ? " AND network = ?" : ""}
         ORDER BY next_check_at LIMIT ?`,
      )
      .all(...(network ? [nowIso, network, limit] : [nowIso, limit]));
    return rows.map((r) => this.toDisbursement(r as Record<string, any>));
  }

  pendingAtomic(vault: string): bigint {
    const rows = this.db
      .prepare("SELECT amount_atomic FROM vault_disbursements WHERE vault = ? AND state IN ('REQUESTED','SUBMITTED')")
      .all(vault.toLowerCase()) as Array<{ amount_atomic: string }>;
    return rows.reduce((sum, r) => sum + BigInt(r.amount_atomic), 0n);
  }

  events(id: VaultDisbursementId): DisbursementEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM vault_disbursement_events WHERE disbursement_id = ? ORDER BY seq")
      .all(id) as Array<Record<string, any>>;
    return rows.map((r) => ({
      disbursementId: r.disbursement_id,
      from: r.from_state,
      to: r.to_state,
      note: r.note,
      ...(r.data_json ? { data: JSON.parse(r.data_json) } : {}),
      at: r.at,
    }));
  }

  private appendEvent(ev: DisbursementEvent): void {
    this.db
      .prepare("INSERT INTO vault_disbursement_events (disbursement_id, from_state, to_state, note, data_json, at) VALUES (?,?,?,?,?,?)")
      .run(ev.disbursementId, ev.from, ev.to, ev.note, ev.data ? json(ev.data) : null, ev.at);
  }

  private toDisbursement(r: Record<string, any>): VaultDisbursement {
    return {
      id: r.id,
      state: r.state as DisbursementState,
      uncertain: r.uncertain === 1,
      network: r.network,
      vault: r.vault,
      to: r.to_address,
      amountAtomic: BigInt(r.amount_atomic),
      reference: r.reference,
      idempotencyKey: r.idempotency_key,
      requestHash: r.request_hash,
      submissionId: r.submission_id,
      requestedAt: r.requested_at,
      fromBlock: BigInt(r.from_block),
      txHash: r.tx_hash,
      blockNumber: big(r.block_number),
      attempts: r.attempts,
      nextCheckAt: r.next_check_at,
      lastError: r.last_error,
      failureCode: r.failure_code,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      version: r.version,
    };
  }
}
