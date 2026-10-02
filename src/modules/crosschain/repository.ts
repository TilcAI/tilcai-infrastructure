import type { DatabaseSync } from "node:sqlite";
import { tx } from "../../db/sqlite.ts";
import type { Hex } from "../../shared/hex.ts";
import type { RouteQuoteId } from "../../shared/ids.ts";
import type { PaymentAttemptId } from "tilcai-core/src/contracts.ts";
import type { CrosschainPayment, CrosschainState, PaymentEvent, RouteQuote } from "./domain.ts";

export class ConcurrentUpdateError extends Error {
  constructor() {
    super("Payment was modified concurrently.");
  }
}

export interface CrosschainRepository {
  insertQuote(q: RouteQuote): void;
  getQuote(id: RouteQuoteId): RouteQuote | undefined;
  insertPayment(p: CrosschainPayment, ev: PaymentEvent): void;
  getPayment(id: PaymentAttemptId): CrosschainPayment | undefined;
  getByIdempotencyKey(key: string): CrosschainPayment | undefined;
  findByBurnTx(sourceNetwork: string, hash: Hex): CrosschainPayment | undefined;
  /** Optimistic update: fails if `expectedVersion` is stale. Appends the event atomically. */
  update(p: CrosschainPayment, expectedVersion: number, ev?: PaymentEvent): CrosschainPayment;
  listDue(nowIso: string, limit: number): CrosschainPayment[];
  events(id: PaymentAttemptId): PaymentEvent[];
  insertReceipt(r: { id: string; paymentId: PaymentAttemptId; orderId: string | null; evidence: unknown; createdAt: string }): void;
  getReceipt(paymentId: PaymentAttemptId): { id: string; evidence: unknown; createdAt: string } | undefined;
}

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(v as string));
const str = (v: bigint | null): string | null => (v === null ? null : v.toString());
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export class SqliteCrosschainRepository implements CrosschainRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertQuote(q: RouteQuote): void {
    this.db
      .prepare(
        `INSERT INTO route_quotes (id, source_network, destination_network, source_domain, destination_domain, pay_to,
          destination_amount_atomic, burn_amount_atomic, max_fee_atomic, fee_bps_hundredths, finality, burn_token,
          mint_recipient, destination_caller, hook_data, preflight_json, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        q.id, q.sourceNetwork, q.destinationNetwork, q.sourceDomain, q.destinationDomain, q.payTo,
        q.destinationAmountAtomic.toString(), q.burnAmountAtomic.toString(), q.maxFeeAtomic.toString(),
        q.feeBpsHundredths.toString(), q.finality, q.burnToken, q.target.mintRecipient, q.target.destinationCaller,
        q.target.hookData, json(q.preflight), q.createdAt, q.expiresAt,
      );
  }

  getQuote(id: RouteQuoteId): RouteQuote | undefined {
    const r = this.db.prepare("SELECT * FROM route_quotes WHERE id = ?").get(id) as Record<string, any> | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      sourceNetwork: r.source_network,
      destinationNetwork: r.destination_network,
      sourceDomain: r.source_domain,
      destinationDomain: r.destination_domain,
      payTo: r.pay_to,
      destinationAmountAtomic: BigInt(r.destination_amount_atomic),
      burnAmountAtomic: BigInt(r.burn_amount_atomic),
      maxFeeAtomic: BigInt(r.max_fee_atomic),
      feeBpsHundredths: BigInt(r.fee_bps_hundredths),
      finality: r.finality,
      burnToken: r.burn_token,
      target: { mintRecipient: r.mint_recipient, destinationCaller: r.destination_caller, hookData: r.hook_data },
      preflight: JSON.parse(r.preflight_json),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    };
  }

  insertPayment(p: CrosschainPayment, ev: PaymentEvent): void {
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO crosschain_payments (id, quote_id, state, uncertain, mode, payer, order_id, idempotency_key,
            request_hash, source_network, attempts, next_check_at, created_at, updated_at, version)
           SELECT ?,?,?,?,?,?,?,?,?, q.source_network, 0, ?, ?, ?, 0 FROM route_quotes q WHERE q.id = ?`,
        )
        .run(
          p.id, p.quoteId, p.state, p.uncertain ? 1 : 0, p.mode, p.payer, p.orderId, p.idempotencyKey, p.requestHash,
          p.nextCheckAt, p.createdAt, p.updatedAt, p.quoteId,
        );
      this.appendEvent(ev);
    });
  }

  getPayment(id: PaymentAttemptId): CrosschainPayment | undefined {
    const r = this.db.prepare("SELECT * FROM crosschain_payments WHERE id = ?").get(id);
    return r ? this.toPayment(r as Record<string, any>) : undefined;
  }

  getByIdempotencyKey(key: string): CrosschainPayment | undefined {
    const r = this.db.prepare("SELECT * FROM crosschain_payments WHERE idempotency_key = ?").get(key);
    return r ? this.toPayment(r as Record<string, any>) : undefined;
  }

  findByBurnTx(sourceNetwork: string, hash: Hex): CrosschainPayment | undefined {
    const r = this.db
      .prepare("SELECT * FROM crosschain_payments WHERE source_network = ? AND lower(burn_tx_hash) = lower(?)")
      .get(sourceNetwork, hash);
    return r ? this.toPayment(r as Record<string, any>) : undefined;
  }

  update(p: CrosschainPayment, expectedVersion: number, ev?: PaymentEvent): CrosschainPayment {
    const next = { ...p, version: expectedVersion + 1 };
    tx(this.db, () => {
      const res = this.db
        .prepare(
          `UPDATE crosschain_payments SET state=?, uncertain=?, payer=?, burn_submission_id=?, burn_auth_json=?, burn_requested_at=?, burn_tx_hash=?, burn_block=?, cctp_nonce=?,
            message=?, attestation=?, fee_executed_atomic=?, mint_submitter=?, mint_submission_id=?, mint_requested_at=?,
            mint_tx_hash=?, attempts=?, next_check_at=?, last_error=?, failure_code=?, updated_at=?, version=?
           WHERE id=? AND version=?`,
        )
        .run(
          next.state, next.uncertain ? 1 : 0, next.payer, next.burnSubmissionId, next.burnAuthorization ? json(next.burnAuthorization) : null,
          next.burnRequestedAt, next.burnTxHash, str(next.burnBlock), next.cctpNonce,
          next.message, next.attestation, str(next.feeExecutedAtomic), next.mintSubmitter, next.mintSubmissionId,
          next.mintRequestedAt, next.mintTxHash, next.attempts, next.nextCheckAt, next.lastError, next.failureCode,
          next.updatedAt, next.version, next.id, expectedVersion,
        );
      if (Number(res.changes) !== 1) throw new ConcurrentUpdateError();
      if (ev) this.appendEvent(ev);
    });
    return next;
  }

  listDue(nowIso: string, limit: number): CrosschainPayment[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM crosschain_payments
         WHERE (state IN ('BURN_SUBMITTED','BURN_CONFIRMED','ATTESTED','MINT_SUBMITTED')
                OR (state = 'AWAITING_BURN' AND burn_auth_json IS NOT NULL)) AND next_check_at <= ?
         ORDER BY next_check_at LIMIT ?`,
      )
      .all(nowIso, limit);
    return rows.map((r) => this.toPayment(r as Record<string, any>));
  }

  events(id: PaymentAttemptId): PaymentEvent[] {
    const rows = this.db.prepare("SELECT * FROM payment_events WHERE payment_id = ? ORDER BY seq").all(id) as Array<Record<string, any>>;
    return rows.map((r) => ({
      paymentId: r.payment_id,
      from: r.from_state,
      to: r.to_state,
      note: r.note,
      ...(r.data_json ? { data: JSON.parse(r.data_json) } : {}),
      at: r.at,
    }));
  }

  insertReceipt(r: { id: string; paymentId: PaymentAttemptId; orderId: string | null; evidence: unknown; createdAt: string }): void {
    this.db
      .prepare("INSERT OR IGNORE INTO payment_receipts (id, payment_id, order_id, evidence_json, created_at) VALUES (?,?,?,?,?)")
      .run(r.id, r.paymentId, r.orderId, json(r.evidence), r.createdAt);
  }

  getReceipt(paymentId: PaymentAttemptId) {
    const r = this.db.prepare("SELECT * FROM payment_receipts WHERE payment_id = ?").get(paymentId) as Record<string, any> | undefined;
    return r ? { id: r.id as string, evidence: JSON.parse(r.evidence_json), createdAt: r.created_at as string } : undefined;
  }

  private appendEvent(ev: PaymentEvent): void {
    this.db
      .prepare("INSERT INTO payment_events (payment_id, from_state, to_state, note, data_json, at) VALUES (?,?,?,?,?,?)")
      .run(ev.paymentId, ev.from, ev.to, ev.note, ev.data ? json(ev.data) : null, ev.at);
  }

  private toPayment(r: Record<string, any>): CrosschainPayment {
    return {
      id: r.id,
      quoteId: r.quote_id,
      state: r.state as CrosschainState,
      uncertain: r.uncertain === 1,
      mode: r.mode,
      payer: r.payer,
      orderId: r.order_id,
      idempotencyKey: r.idempotency_key,
      requestHash: r.request_hash,
      burnAuthorization: r.burn_auth_json ? JSON.parse(r.burn_auth_json) : null,
      burnSubmissionId: r.burn_submission_id,
      burnRequestedAt: r.burn_requested_at,
      burnTxHash: r.burn_tx_hash,
      burnBlock: big(r.burn_block),
      cctpNonce: r.cctp_nonce,
      message: r.message,
      attestation: r.attestation,
      feeExecutedAtomic: big(r.fee_executed_atomic),
      mintSubmitter: r.mint_submitter,
      mintSubmissionId: r.mint_submission_id,
      mintRequestedAt: r.mint_requested_at,
      mintTxHash: r.mint_tx_hash,
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
