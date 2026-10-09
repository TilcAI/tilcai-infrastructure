import { createHash } from "node:crypto";
import type { EvmNetwork } from "../../config/networks.ts";
import { atomicToDecimal, decimalToAtomic } from "../../shared/amount.ts";
import { iso, type Clock } from "../../shared/clock.ts";
import { DomainError } from "../../shared/errors.ts";
import { sameHex, type Hex } from "../../shared/hex.ts";
import { newVaultDisbursementId, parseVaultDisbursementId } from "../../shared/ids.ts";
import type { Logger } from "../../shared/log.ts";
import { SubmissionRejected } from "../crosschain/ports.ts";
import type { EventSink } from "../monitor/domain.ts";
import { disbursementIdBytes32 } from "./adapters/evm.ts";
import { canMove, isTerminal, type DisbursementState, type VaultDisbursement } from "./domain.ts";
import type { VaultPort, VaultStatus, VaultSubmitter } from "./ports.ts";
import { ConcurrentUpdateError, type VaultRepository } from "./repository.ts";

export interface VaultDeps {
  repo: VaultRepository;
  vault: VaultPort;
  /** Sends `disburse` from the relayer's account, which must be the vault's operator. */
  submitter: VaultSubmitter;
  network: EvmNetwork;
  clock: Clock;
  log: Logger;
  /** Where state changes and refusals are announced for the dashboard. */
  events?: EventSink;
  options: {
    pollMs: number;
    minConfirmations: number;
    /** Proven failures after which an unpaid payout is given up (FAILED). */
    maxAttempts?: number;
    /** Wait this long after a relayer request before sending a possibly in-flight one again. */
    resubmitGuardMs?: number;
  };
}

const MAX_BACKOFF_MS = 10 * 60_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Pays purchases out of the TilcaiVault: the relayer sends `disburse(id, to, amount)` and pays
 * the gas, the buyer receives USDC.
 *
 * Safety rules:
 *  - the vault pays a disbursement id at most once, so a payout is retried freely and a
 *    duplicated or late relayer transaction can only revert;
 *  - the on-chain record, not the relayer's answer, decides whether an id was paid;
 *  - a payout is only marked FAILED when every attempt provably paid nothing. One relayer
 *    call without an answer makes it `uncertain`, and it is then reconciled until it settles.
 */
export class VaultDisbursementService {
  constructor(private readonly d: VaultDeps) {}

  /** The vault as it is on-chain, plus what TilcAI has promised and not paid yet. */
  async status(): Promise<VaultStatus & { relayer: Hex; operatorIsRelayer: boolean; pendingAtomic: bigint }> {
    const [status, relayer] = await Promise.all([this.d.vault.status(), this.d.submitter.sender()]);
    return {
      ...status,
      relayer,
      operatorIsRelayer: sameHex(status.operator, relayer),
      pendingAtomic: this.d.repo.pendingAtomic(this.d.vault.address()),
    };
  }

  async create(input: { to: string; amount: string; reference?: string; idempotencyKey: string }): Promise<{ disbursement: VaultDisbursement; replayed: boolean }> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) throw new DomainError("INVALID_INPUT", "bad idempotency key");
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.to) || sameHex(input.to, ZERO_ADDRESS) || sameHex(input.to, this.d.vault.address())) {
      throw new DomainError("INVALID_INPUT", "to must be an EVM address other than the vault");
    }
    if (input.reference !== undefined && !/^[A-Za-z0-9._:-]{1,160}$/.test(input.reference)) {
      throw new DomainError("INVALID_INPUT", "bad reference");
    }
    let amount: bigint;
    try {
      amount = decimalToAtomic(input.amount, this.d.network.usdc.decimals);
    } catch {
      throw new DomainError("INVALID_INPUT", "amount must be a decimal with at most 6 decimals");
    }
    if (amount <= 0n) throw new DomainError("INVALID_INPUT", "amount must be positive");
    const to = input.to.toLowerCase() as Hex;
    const requestHash = sha256(JSON.stringify(["vault-disbursement-v1", to, amount.toString(), input.reference ?? null]));

    const existing = this.d.repo.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT");
      return { disbursement: existing, replayed: true };
    }
    if (input.reference && this.d.repo.getByReference(this.d.vault.address(), input.reference)) {
      throw new DomainError("DUPLICATE", "reference already has a disbursement");
    }

    // Refuse what the vault could not pay right now, so the caller gets a clear answer
    // instead of a payout that keeps reverting.
    const [status, head] = await Promise.all([this.status(), this.d.vault.blockNumber()]).catch((e: unknown) => {
      throw new DomainError("SERVICE_UNAVAILABLE", `vault or relayer unreachable: ${errText(e)}`);
    });
    // A payout the vault cannot take is announced: nobody finds out from a caller that keeps retrying.
    const refuse = (code: "SERVICE_UNAVAILABLE" | "PAUSED" | "PAYMENT_LIMIT" | "BUDGET", detail: string): never => {
      const usdc = (atomic: bigint) => atomicToDecimal(atomic, this.d.network.usdc.decimals);
      this.d.events?.emit({
        type: "vault.disbursement.rejected",
        severity: code === "PAYMENT_LIMIT" ? "warning" : "error",
        subject: input.reference ?? null,
        summary: `Desembolso de ${usdc(amount)} USDC rechazado (${code}): ${detail}`,
        data: {
          code,
          detail,
          to,
          amount: usdc(amount),
          reference: input.reference ?? null,
          vault: status.address,
          balance: usdc(status.balanceAtomic),
          pending: usdc(status.pendingAtomic),
          availableToday: usdc(status.availableTodayAtomic),
          maxPerDisbursement: usdc(status.maxPerDisbursementAtomic),
        },
      });
      throw new DomainError(code, detail);
    };
    if (!status.operatorIsRelayer) refuse("SERVICE_UNAVAILABLE", "the relayer is not the vault operator");
    if (status.paused) refuse("PAUSED", "vault is paused");
    if (amount > status.maxPerDisbursementAtomic) refuse("PAYMENT_LIMIT", "amount above the vault's limit per disbursement");
    // Payouts already promised count against both the daily limit and the balance.
    if (amount + status.pendingAtomic > status.availableTodayAtomic) refuse("PAYMENT_LIMIT", "amount above what the vault can still pay today");
    if (amount + status.pendingAtomic > status.balanceAtomic) refuse("BUDGET", "vault has insufficient USDC");

    const now = iso(this.d.clock.now());
    const disbursement: VaultDisbursement = {
      id: newVaultDisbursementId(),
      state: "REQUESTED",
      uncertain: false,
      network: this.d.network.id,
      vault: this.d.vault.address(),
      to,
      amountAtomic: amount,
      reference: input.reference ?? null,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      submissionId: null,
      requestedAt: null,
      fromBlock: head,
      txHash: null,
      blockNumber: null,
      attempts: 0,
      nextCheckAt: now,
      lastError: null,
      failureCode: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    try {
      this.d.repo.insert(disbursement, { disbursementId: disbursement.id, from: null, to: "REQUESTED", note: "created", at: now });
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        if (this.d.repo.getByIdempotencyKey(input.idempotencyKey)) return this.create(input); // lost a race on the same key → replay path
        throw new DomainError("DUPLICATE", "reference already has a disbursement");
      }
      throw e;
    }
    this.announce(disbursement, null, "created");
    // Sent right away: the caller does not wait for the worker's next pass.
    try {
      return { disbursement: await this.submit(disbursement), replayed: false };
    } catch (e) {
      this.d.log.warn("first disburse attempt failed; the worker will retry", { disbursementId: disbursement.id, error: errText(e) });
      return { disbursement: this.d.repo.get(disbursement.id) ?? disbursement, replayed: false };
    }
  }

  // ── Reconciliation (worker) ───────────────────────────────────────────────

  async processDue(limit = 20): Promise<number> {
    const due = this.d.repo.listDue(iso(this.d.clock.now()), limit);
    for (const d of due) {
      try {
        await this.step(d);
      } catch (e) {
        if (e instanceof ConcurrentUpdateError) continue;
        this.d.log.error("disbursement step failed", { disbursementId: d.id, state: d.state, error: errText(e) });
        this.reschedule(d, { error: errText(e), backoff: true });
      }
    }
    return due.length;
  }

  /** Runs one reconciliation step (used by the worker and the admin endpoint). */
  async step(d: VaultDisbursement): Promise<VaultDisbursement> {
    if (d.state === "REQUESTED") return this.stepRequested(d);
    if (d.state === "SUBMITTED") return this.stepSubmitted(d);
    return d;
  }

  private async stepRequested(d: VaultDisbursement): Promise<VaultDisbursement> {
    if ((await this.d.vault.paidAmount(disbursementIdBytes32(d.id))) > 0n) return this.confirmFromChain(d, "id already paid on-chain");
    const guard = this.d.options.resubmitGuardMs ?? 60_000;
    if (d.requestedAt && this.d.clock.now().getTime() - Date.parse(d.requestedAt) < guard) {
      return this.reschedule(d, {}); // a previous request may still land; give it time
    }
    return this.submit(d);
  }

  private async submit(d: VaultDisbursement): Promise<VaultDisbursement> {
    const id32 = disbursementIdBytes32(d.id);
    const sim = await this.d.vault.simulate(await this.d.submitter.sender(), id32, d.to, d.amountAtomic);
    if (!sim.ok) {
      if (sim.reason === "AlreadyDisbursed") return this.confirmFromChain(d, "id already paid on-chain");
      return this.retryLater(d, `DISBURSE_WOULD_REVERT:${sim.reason}`);
    }
    // Recorded before the call: a crash leaves evidence that a submission may be in flight.
    let cur = this.patch(d, { requestedAt: iso(this.d.clock.now()) });
    try {
      const sub = await this.d.submitter.submit(this.d.vault.address(), this.d.vault.encodeDisburse(id32, d.to, d.amountAtomic));
      return this.move(cur, "SUBMITTED", "disburse submitted via relayer", { submissionId: sub.submissionId, lastError: null });
    } catch (e) {
      cur = this.d.repo.get(cur.id) ?? cur;
      if (e instanceof SubmissionRejected) return this.retryLater(this.patch(cur, { requestedAt: null }), `DISBURSE_SUBMIT_REJECTED:${errText(e)}`);
      // No answer (timeout, 5xx): the relayer may hold a transaction TilcAI never saw.
      return this.reschedule(cur, { error: `DISBURSE_SUBMIT_FAILED:${errText(e)}`, uncertain: true, backoff: true, countAttempt: true });
    }
  }

  private async stepSubmitted(d: VaultDisbursement): Promise<VaultDisbursement> {
    const id32 = disbursementIdBytes32(d.id);
    const st = await this.d.submitter.status(d.submissionId!);
    if (st.state === "pending") {
      const age = this.d.clock.now().getTime() - Date.parse(d.requestedAt ?? d.updatedAt);
      if (age > 5 * 60_000 && (await this.d.vault.paidAmount(id32)) > 0n) return this.confirmFromChain(d, "paid while the submission was pending");
      return this.reschedule(d, {});
    }
    if (st.state === "failed") return this.afterFailedSubmission(d, `DISBURSE_RELAYER_FAILED:${st.reason}`);

    const r = await this.d.vault.inspect(st.txHash);
    if (r.kind === "not_found") return this.reschedule(d, {});
    if (r.kind === "reverted") return this.afterFailedSubmission(d, `DISBURSE_REVERTED:${st.txHash}`);
    if (r.confirmations < BigInt(this.d.options.minConfirmations)) return this.reschedule(d, {});
    const ev = r.disbursed.find((e) => sameHex(e.disbursementId, id32));
    if (!ev || !sameHex(ev.to, d.to) || ev.amount !== d.amountAtomic) {
      // Mined without the expected payout: never report it as paid.
      return this.reschedule(d, { error: "DISBURSED_EVENT_MISMATCH", uncertain: true, backoff: true });
    }
    return this.move(d, "CONFIRMED", "Disbursed event verified", { txHash: st.txHash.toLowerCase() as Hex, blockNumber: r.blockNumber, lastError: null });
  }

  /** The submission did not pay. If nobody else paid the id either, it goes back to the queue. */
  private async afterFailedSubmission(d: VaultDisbursement, error: string): Promise<VaultDisbursement> {
    if ((await this.d.vault.paidAmount(disbursementIdBytes32(d.id))) > 0n) return this.confirmFromChain(d, "paid by another submission");
    const attempts = d.attempts + 1;
    return this.move(d, "REQUESTED", "submission failed; will retry", {
      submissionId: null,
      requestedAt: null,
      attempts,
      lastError: error,
      nextCheckAt: iso(new Date(this.d.clock.now().getTime() + this.backoffMs(attempts))),
    });
  }

  /** The vault says the id is paid: take the transaction from its event. */
  private async confirmFromChain(d: VaultDisbursement, note: string): Promise<VaultDisbursement> {
    const found = await this.d.vault.findDisbursed(disbursementIdBytes32(d.id), d.fromBlock);
    if (found && (!sameHex(found.to, d.to) || found.amount !== d.amountAtomic)) {
      return this.reschedule(d, { error: "DISBURSED_EVENT_MISMATCH", uncertain: true, backoff: true });
    }
    return this.move(d, "CONFIRMED", note, {
      txHash: found ? (found.txHash.toLowerCase() as Hex) : d.txHash,
      blockNumber: found?.blockNumber ?? d.blockNumber,
      lastError: null,
    });
  }

  /** An attempt that provably paid nothing. Gives up after `maxAttempts` of them. */
  private retryLater(d: VaultDisbursement, error: string): VaultDisbursement {
    const attempts = d.attempts + 1;
    if (attempts >= (this.d.options.maxAttempts ?? 10) && !d.uncertain && d.state === "REQUESTED") {
      return this.move(d, "FAILED", "gave up: no attempt could pay", { attempts, lastError: error, failureCode: "DISBURSE_NOT_EXECUTED" });
    }
    return this.reschedule(d, { error, backoff: true, countAttempt: true });
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  view(id: string) {
    const d = this.mustGet(id);
    return {
      disbursement: d,
      amount: `${atomicToDecimal(d.amountAtomic, this.d.network.usdc.decimals)} USDC`,
      links: { tx: d.txHash ? `${this.d.network.explorer}/tx/${d.txHash}` : null },
      events: this.d.repo.events(d.id),
    };
  }

  mustGet(id: string): VaultDisbursement {
    let parsed;
    try {
      parsed = parseVaultDisbursementId(id);
    } catch {
      throw new DomainError("INVALID_INPUT", "invalid disbursement id");
    }
    const d = this.d.repo.get(parsed);
    if (!d) throw new DomainError("NOT_FOUND");
    return d;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private move(d: VaultDisbursement, to: DisbursementState, note: string, patch: Partial<VaultDisbursement> = {}): VaultDisbursement {
    if (!canMove(d.state, to)) throw new DomainError("INVALID_STATE_TRANSITION", `${d.state} → ${to}`);
    const now = iso(this.d.clock.now());
    const next: VaultDisbursement = {
      ...d,
      nextCheckAt: now,
      ...patch,
      state: to,
      uncertain: isTerminal(to) ? false : d.uncertain,
      updatedAt: now,
    };
    const saved = this.d.repo.update(next, d.version, {
      disbursementId: d.id,
      from: d.state,
      to,
      note,
      ...(patch.failureCode || patch.lastError ? { data: { failureCode: patch.failureCode, error: patch.lastError } } : {}),
      at: now,
    });
    this.d.log.info("disbursement transition", { disbursementId: d.id, from: d.state, to, note });
    this.announce(saved, d.state, note);
    return saved;
  }

  /** Tells the dashboard that a payout was created (`from` = null) or changed state. */
  private announce(d: VaultDisbursement, from: DisbursementState | null, note: string): void {
    this.d.events?.emit({
      type: "vault.disbursement.transition",
      severity: d.state === "FAILED" ? "error" : "info",
      subject: d.id,
      summary: `Desembolso de ${atomicToDecimal(d.amountAtomic, this.d.network.usdc.decimals)} USDC ${from ?? "nuevo"} → ${d.state}: ${note}`,
      data: {
        disbursementId: d.id,
        from,
        to: d.state,
        note,
        recipient: d.to,
        amount: atomicToDecimal(d.amountAtomic, this.d.network.usdc.decimals),
        reference: d.reference,
        submissionId: d.submissionId,
        txHash: d.txHash,
        explorer: d.txHash ? `${this.d.network.explorer}/tx/${d.txHash}` : null,
        attempts: d.attempts,
        failureCode: d.failureCode,
        lastError: d.lastError,
      },
    });
  }

  private patch(d: VaultDisbursement, patch: Partial<VaultDisbursement>): VaultDisbursement {
    return this.d.repo.update({ ...d, ...patch, updatedAt: iso(this.d.clock.now()) }, d.version);
  }

  private reschedule(d: VaultDisbursement, o: { error?: string | null; uncertain?: boolean; backoff?: boolean; countAttempt?: boolean }): VaultDisbursement {
    const fresh = this.d.repo.get(d.id) ?? d;
    const attempts = o.countAttempt ? fresh.attempts + 1 : fresh.attempts;
    const delay = o.backoff ? this.backoffMs(Math.max(attempts, 1)) : this.d.options.pollMs;
    const becameUncertain = Boolean(o.uncertain) && !fresh.uncertain;
    const next = {
      ...fresh,
      attempts,
      uncertain: fresh.uncertain || Boolean(o.uncertain),
      lastError: o.error === undefined ? fresh.lastError : o.error,
      nextCheckAt: iso(new Date(this.d.clock.now().getTime() + delay)),
      // updatedAt tracks state changes only, so "time in state" stays meaningful.
      updatedAt: fresh.updatedAt,
    };
    if (becameUncertain) {
      this.d.log.warn("disbursement flagged uncertain", { disbursementId: d.id, state: d.state, error: o.error });
      this.d.events?.emit({
        type: "vault.disbursement.uncertain",
        severity: "warning",
        subject: d.id,
        summary: `Desembolso incierto en ${fresh.state}: ${o.error ?? "sin detalle"}`,
        data: { disbursementId: d.id, state: fresh.state, error: o.error ?? null, attempts },
      });
      return this.d.repo.update(next, fresh.version, {
        disbursementId: d.id,
        from: fresh.state,
        to: fresh.state,
        note: "flagged uncertain; reconciliation continues",
        data: { error: o.error },
        at: iso(this.d.clock.now()),
      });
    }
    return this.d.repo.update(next, fresh.version);
  }

  private backoffMs(attempts: number): number {
    return Math.min(this.d.options.pollMs * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS);
  }
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
