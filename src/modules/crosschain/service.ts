import { createHash } from "node:crypto";
import { parseSignature, recoverTypedDataAddress } from "viem";
import type { PaymentAttemptId } from "tilcai-core/src/contracts.ts";
import type { EvmNetwork, StellarNetwork } from "../../config/networks.ts";
import { atomicToDecimal, decimalToAtomic, maxFeeForBps } from "../../shared/amount.ts";
import { iso, type Clock } from "../../shared/clock.ts";
import { DomainError } from "../../shared/errors.ts";
import { isHex32, type Hex } from "../../shared/hex.ts";
import { newId, newRouteQuoteId, parseRouteQuoteId } from "../../shared/ids.ts";
import type { Logger } from "../../shared/log.ts";
import type { EventSink } from "../monitor/domain.ts";
import { isValidStellarRecipient, stellarMintTarget } from "./cctp/encoding.ts";
import type { IrisPort } from "./cctp/iris.ts";
import { decodeMessageV2 } from "./cctp/message.ts";
import {
  assertSharedTransition,
  canMove,
  isGaslessMode,
  paymentStateOf,
  type CrosschainPayment,
  type CrosschainState,
  type PaymentMode,
  type RouteQuote,
} from "./domain.ts";
import { SubmissionRejected, type EvmCctpPort, type EvmTxSubmitter, type MintSubmitter, type StellarCctpPort, type UnsignedEvmCall } from "./ports.ts";
import { authorizationNonce, authorizationTypedData, encodeRouterCall, paymentIdBytes32, routeOf, type SignedAuthorization } from "./router.ts";
import { ConcurrentUpdateError, type CrosschainRepository } from "./repository.ts";
import { checkAttestedMessage, checkDepositForBurn, checkRouterPayment } from "./verify.ts";

export interface CrosschainDeps {
  repo: CrosschainRepository;
  evm: EvmCctpPort;
  stellar: StellarCctpPort;
  iris: IrisPort;
  submitters: Record<string, MintSubmitter>;
  activeSubmitter: string;
  /** Sends the gasless source burn from the relayer's account. Absent → gasless modes disabled. */
  evmSubmitter?: EvmTxSubmitter;
  source: EvmNetwork;
  destination: StellarNetwork;
  clock: Clock;
  log: Logger;
  /** Where state changes are announced for the dashboard. */
  events?: EventSink;
  options: {
    quoteTtlSeconds: number;
    pollMs: number;
    minConfirmations: number;
    /** Burn tx not visible after this long → flagged UNCERTAIN (never auto-failed). */
    burnLookupGraceMs?: number;
    /** Wait this long after a mint request before re-submitting a possibly in-flight one. */
    mintResubmitGuardMs?: number;
    /** Lifetime of a signed EIP-3009 authorization. */
    authorizationTtlSeconds?: number;
  };
}

const MAX_BACKOFF_MS = 10 * 60_000;

/**
 * Orchestrates Avalanche Fuji → Stellar Testnet USDC payments over CCTP V2.
 *
 * Safety rules (report §19, payment-rail-environment §6.2):
 *  - the source tx hash is persisted before any further step;
 *  - a burn can back exactly one payment (unique index) and must match the quote;
 *  - Iris output is re-verified from the raw message bytes;
 *  - the mint is idempotent through the CCTP nonce, so it is retried freely,
 *    while a new burn is NEVER created for an existing payment.
 */
export class CrosschainPaymentService {
  constructor(private readonly d: CrosschainDeps) {}

  // ── Quotes ────────────────────────────────────────────────────────────────

  async quote(input: { sourceNetwork: string; destinationNetwork: string; amount: string; payTo: string }): Promise<RouteQuote> {
    const { source, destination } = this.d;
    if (input.sourceNetwork !== source.id || input.destinationNetwork !== destination.id) {
      throw new DomainError("NETWORK_OR_ASSET", `route ${input.sourceNetwork} → ${input.destinationNetwork} not enabled`);
    }
    if (!isValidStellarRecipient(input.payTo)) throw new DomainError("INVALID_INPUT", "payTo is not a Stellar G/M/C address");
    let canonical: bigint;
    try {
      // CCTP carries 6 canonical decimals; Stellar's 7th decimal cannot be bridged.
      canonical = decimalToAtomic(input.amount, source.usdc.decimals);
    } catch {
      throw new DomainError("INVALID_INPUT", "amount must be a decimal with at most 6 decimals");
    }
    if (canonical <= 0n) throw new DomainError("INVALID_INPUT", "amount must be positive");

    const finality = 2000 as const; // Avalanche has no Fast transfer; Standard attests in ~8 s.
    const feeBpsHundredths = await this.d.iris.feeBpsHundredths(source.cctpDomain, destination.cctpDomain, finality);
    const maxFee = maxFeeForBps(canonical, feeBpsHundredths);
    const account = await this.d.stellar.accountStatus(input.payTo);
    const now = this.d.clock.now();
    const q: RouteQuote = {
      id: newRouteQuoteId(),
      sourceNetwork: source.id,
      destinationNetwork: destination.id,
      sourceDomain: source.cctpDomain,
      destinationDomain: destination.cctpDomain,
      payTo: input.payTo,
      destinationAmountAtomic: canonical * 10n,
      // Burn amount + fee ceiling so the merchant receives at least the quoted amount.
      burnAmountAtomic: canonical + maxFee,
      maxFeeAtomic: maxFee,
      feeBpsHundredths,
      finality,
      burnToken: source.usdc.address,
      target: stellarMintTarget(destination.cctpV2.cctpForwarder, input.payTo),
      preflight: { payToExists: account.exists, payToTrustline: account.trustline, payToAuthorized: account.authorized },
      createdAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + this.d.options.quoteTtlSeconds * 1000)),
    };
    this.d.repo.insertQuote(q);
    return q;
  }

  getQuote(id: string): RouteQuote {
    let qid;
    try {
      qid = parseRouteQuoteId(id);
    } catch {
      throw new DomainError("INVALID_INPUT", "invalid quote id");
    }
    const q = this.d.repo.getQuote(qid);
    if (!q) throw new DomainError("NOT_FOUND");
    return q;
  }

  // ── Payment creation ──────────────────────────────────────────────────────

  async createPayment(input: {
    quoteId: string;
    mode: PaymentMode;
    payer?: string;
    orderId?: string;
    idempotencyKey: string;
  }): Promise<{ payment: CrosschainPayment; calls: UnsignedEvmCall[]; authorization?: AuthorizationRequest; replayed: boolean }> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) throw new DomainError("INVALID_INPUT", "bad idempotency key");
    if (isGaslessMode(input.mode) && (!this.d.evm.routerAddress() || !this.d.evmSubmitter)) {
      throw new DomainError("SERVICE_UNAVAILABLE", "gasless modes need CCTP_ROUTER_FUJI and an EVM relayer");
    }
    const payer = this.resolvePayer(input.mode, input.payer);
    const requestHash = sha256(
      JSON.stringify(["crosschain-payment-v1", input.quoteId, input.mode, payer?.toLowerCase() ?? null, input.orderId ?? null]),
    );

    const existing = this.d.repo.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT");
      const waiting = existing.state === "AWAITING_BURN";
      const calls = waiting && existing.mode === "external" ? await this.callsFor(existing) : [];
      const authorization = waiting && isGaslessMode(existing.mode) && !existing.burnAuthorization ? this.authorizationRequest(existing) : undefined;
      return { payment: existing, calls, ...(authorization ? { authorization } : {}), replayed: true };
    }

    const q = this.getQuote(input.quoteId);
    const now = this.d.clock.now();
    if (now.toISOString() >= q.expiresAt) throw new DomainError("QUOTE_EXPIRED");
    const account = await this.d.stellar.accountStatus(q.payTo);
    if (!account.exists || !account.trustline || !account.authorized) {
      // Burning toward a recipient without a USDC trustline would leave the mint failing.
      throw new DomainError("RECIPIENT", "payTo has no authorized USDC trustline on Stellar");
    }

    const payment: CrosschainPayment = {
      id: newId("paymentAttempt"),
      quoteId: q.id,
      state: "AWAITING_BURN",
      uncertain: false,
      mode: input.mode,
      payer,
      orderId: input.orderId ?? null,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      burnAuthorization: null,
      burnSubmissionId: null,
      burnRequestedAt: null,
      burnTxHash: null,
      burnBlock: null,
      cctpNonce: null,
      message: null,
      attestation: null,
      feeExecutedAtomic: null,
      mintSubmitter: null,
      mintSubmissionId: null,
      mintRequestedAt: null,
      mintTxHash: null,
      attempts: 0,
      nextCheckAt: iso(now),
      lastError: null,
      failureCode: null,
      createdAt: iso(now),
      updatedAt: iso(now),
      version: 0,
    };
    try {
      this.d.repo.insertPayment(payment, { paymentId: payment.id, from: null, to: "AWAITING_BURN", note: "created", at: iso(now) });
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        const again = this.d.repo.getByIdempotencyKey(input.idempotencyKey);
        if (again) return this.createPayment(input); // lost a race on the same key → replay path
        throw new DomainError("DUPLICATE", "quote already has a payment attempt");
      }
      throw e;
    }
    this.announce(payment, null, "created");

    if (isGaslessMode(input.mode)) {
      const authorization = this.authorizationRequest(payment);
      if (input.mode === "gasless") return { payment, calls: [], authorization, replayed: false };
      // dev_gasless: sign with the testnet developer key, then hand the signature to the relayer.
      const signature = await this.d.evm.devSignTypedData(authorization.typedData);
      const sig = parseSignature(signature);
      const submitted = await this.submitAuthorization(payment.id, { v: Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0))), r: sig.r, s: sig.s });
      return { payment: submitted, calls: [], authorization, replayed: false };
    }

    const built = await this.d.evm.buildBurnCalls({
      payer: payer!,
      amount: q.burnAmountAtomic,
      maxFee: q.maxFeeAtomic,
      destinationDomain: q.destinationDomain,
      target: q.target,
      finality: q.finality,
    });

    if (input.mode === "external") return { payment, calls: built.calls, replayed: false };

    // dev_signer (testnet only): the backend signs with its developer key.
    if (built.usdcBalance < q.burnAmountAtomic) throw new DomainError("BUDGET", "dev payer has insufficient USDC");
    let current = payment;
    await this.d.evm.sendWithDevSigner(built.calls, (hash) => {
      // Persist the hash the moment it exists, before waiting for the receipt.
      current = this.move(current, "BURN_SUBMITTED", "burn broadcast by dev signer", { burnTxHash: hash });
    });
    return { payment: this.d.repo.getPayment(payment.id) ?? current, calls: [], replayed: false };
  }

  // ── Gasless source leg (EIP-3009 → router → OZ Relayer) ──────────────────

  /** What the payer must sign. Deterministic per payment, so a replayed request returns the same message. */
  authorizationRequest(p: CrosschainPayment): AuthorizationRequest {
    const q = this.quoteOf(p);
    const router = this.d.evm.routerAddress();
    if (!router || !p.payer) throw new DomainError("SERVICE_UNAVAILABLE", "router not configured");
    const paymentId32 = paymentIdBytes32(p.id);
    const route = routeOf(q.destinationDomain, q.target, q.maxFeeAtomic, q.finality);
    const nonce = authorizationNonce(paymentId32, q.burnAmountAtomic, route);
    const ttl = this.d.options.authorizationTtlSeconds ?? 600;
    const validBefore = BigInt(Math.floor(Date.parse(p.createdAt) / 1000) + ttl);
    const typedData = authorizationTypedData({ ...this.d.source, cctpRouter: router }, { payer: p.payer, amount: q.burnAmountAtomic, nonce, validAfter: 0n, validBefore });
    return { router, paymentId32, nonce, validAfter: 0n, validBefore, typedData };
  }

  /**
   * Takes the payer's signature, verifies it off-chain and persists it BEFORE the relayer sees it,
   * then asks the relayer to send `payWithAuthorization`. The payer never pays gas.
   */
  async submitAuthorization(id: string, sig: { v: number; r: Hex; s: Hex }): Promise<CrosschainPayment> {
    let p = this.mustGet(id);
    if (!isGaslessMode(p.mode)) throw new DomainError("INVALID_STATE_TRANSITION", "payment is not gasless");
    if (!/^0x[0-9a-fA-F]{64}$/.test(sig.r) || !/^0x[0-9a-fA-F]{64}$/.test(sig.s) || ![27, 28].includes(sig.v)) throw new DomainError("INVALID_INPUT", "bad signature");
    if (p.burnAuthorization) {
      if (p.burnAuthorization.r === sig.r && p.burnAuthorization.s === sig.s) return p;
      throw new DomainError("INVALID_STATE_TRANSITION", "payment already has an authorization");
    }
    if (p.state !== "AWAITING_BURN") throw new DomainError("INVALID_STATE_TRANSITION");
    const req = this.authorizationRequest(p);
    if (BigInt(Math.floor(this.d.clock.now().getTime() / 1000)) >= req.validBefore) throw new DomainError("EXPIRED", "authorization window closed");
    const signature = `0x${sig.r.slice(2)}${sig.s.slice(2)}${sig.v.toString(16)}` as Hex;
    const recovered = await recoverTypedDataAddress({ ...req.typedData, signature }).catch(() => null);
    if (!recovered || recovered.toLowerCase() !== p.payer!.toLowerCase()) throw new DomainError("APPROVAL_INVALID", "signature is not from the payer");
    p = this.patch(p, { burnAuthorization: { validAfter: "0", validBefore: req.validBefore.toString(), v: sig.v, r: sig.r, s: sig.s } });
    return this.sendBurnToRelayer(p);
  }

  private async sendBurnToRelayer(p: CrosschainPayment): Promise<CrosschainPayment> {
    const q = this.quoteOf(p);
    const a = p.burnAuthorization!;
    const route = routeOf(q.destinationDomain, q.target, q.maxFeeAtomic, q.finality);
    const signed: SignedAuthorization = { validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), v: a.v, r: a.r, s: a.s };
    const data = encodeRouterCall(paymentIdBytes32(p.id), p.payer!, q.burnAmountAtomic, route, signed);
    // Recorded before the call: a crash leaves evidence that a submission may be in flight.
    let cur = this.patch(p, { burnRequestedAt: iso(this.d.clock.now()) });
    try {
      const sub = await this.d.evmSubmitter!.submit(this.d.evm.routerAddress()!, data);
      this.d.log.info("burn submitted via relayer", { paymentId: p.id, submissionId: sub.submissionId });
      return this.patch(cur, { burnSubmissionId: sub.submissionId, lastError: null, nextCheckAt: iso(this.d.clock.now()) });
    } catch (e) {
      cur = this.d.repo.getPayment(cur.id) ?? cur;
      if (e instanceof SubmissionRejected) cur = this.patch(cur, { burnRequestedAt: null });
      return this.reschedule(cur, { error: `BURN_SUBMIT_FAILED:${errText(e)}`, backoff: true, countAttempt: true });
    }
  }

  private async stepAwaitingBurn(p: CrosschainPayment): Promise<CrosschainPayment> {
    if (!p.burnAuthorization || !isGaslessMode(p.mode)) return p;
    const a = p.burnAuthorization;
    if (p.burnSubmissionId) {
      const st = await this.d.evmSubmitter!.status(p.burnSubmissionId);
      if (st.state === "confirmed") return this.move(p, "BURN_SUBMITTED", "burn mined by relayer", { burnTxHash: st.txHash.toLowerCase() as Hex, lastError: null });
      if (st.state === "pending") return this.reschedule(p, {});
      p = this.patch(p, { burnSubmissionId: null, burnRequestedAt: null, lastError: `BURN_RELAYER_FAILED:${st.reason}` });
    }
    const nonce = this.authorizationRequest(p).nonce;
    if (await this.d.evm.authorizationUsed(p.payer!, nonce)) {
      // Consumed on-chain but the relayer lost the hash. An operator can attach it (POST /burn).
      return this.reschedule(p, { uncertain: true, error: "AUTHORIZATION_USED_HASH_UNKNOWN", backoff: true });
    }
    if (BigInt(Math.floor(this.d.clock.now().getTime() / 1000)) >= BigInt(a.validBefore)) {
      return this.move(p, "FAILED", "authorization expired unused", { failureCode: "BURN_NOT_EXECUTED" });
    }
    const guard = this.d.options.mintResubmitGuardMs ?? 60_000;
    if (p.burnRequestedAt && this.d.clock.now().getTime() - Date.parse(p.burnRequestedAt) < guard) return this.reschedule(p, {});
    return this.sendBurnToRelayer(p);
  }

  /** External wallets report the burn tx hash they broadcast. Idempotent for the same hash. */
  attachBurn(id: string, txHash: string): CrosschainPayment {
    if (!isHex32(txHash)) throw new DomainError("INVALID_INPUT", "txHash must be 0x + 64 hex");
    const p = this.mustGet(id);
    const hash = txHash.toLowerCase() as Hex;
    if (p.burnTxHash) {
      if (p.burnTxHash.toLowerCase() === hash) return p;
      throw new DomainError("INVALID_STATE_TRANSITION", "payment already has a different burn tx");
    }
    if (p.state !== "AWAITING_BURN") throw new DomainError("INVALID_STATE_TRANSITION");
    const other = this.d.repo.findByBurnTx(this.d.source.id, hash);
    if (other) throw new DomainError("DUPLICATE", "burn tx already backs another payment");
    return this.move(p, "BURN_SUBMITTED", "burn tx reported by payer", { burnTxHash: hash });
  }

  // ── Reconciliation (worker) ───────────────────────────────────────────────

  async processDue(limit = 20): Promise<number> {
    const due = this.d.repo.listDue(iso(this.d.clock.now()), limit);
    for (const p of due) {
      try {
        await this.step(p);
      } catch (e) {
        if (e instanceof ConcurrentUpdateError) continue;
        this.d.log.error("step failed", { paymentId: p.id, state: p.state, error: errText(e) });
        this.reschedule(p, { error: errText(e), backoff: true });
      }
    }
    return due.length;
  }

  /** Runs one reconciliation step for a payment (used by the worker and the admin endpoint). */
  async step(p: CrosschainPayment): Promise<CrosschainPayment> {
    switch (p.state) {
      case "AWAITING_BURN":
        return this.stepAwaitingBurn(p);
      case "BURN_SUBMITTED":
        return this.stepBurnSubmitted(p);
      case "BURN_CONFIRMED":
        return this.stepBurnConfirmed(p);
      case "ATTESTED":
        return this.stepAttested(p);
      case "MINT_SUBMITTED":
        return this.stepMintSubmitted(p);
      default:
        return p;
    }
  }

  private async stepBurnSubmitted(p: CrosschainPayment): Promise<CrosschainPayment> {
    const q = this.quoteOf(p);
    const r = await this.d.evm.inspectBurn(p.burnTxHash!);
    if (r.kind === "not_found") {
      const grace = this.d.options.burnLookupGraceMs ?? 30 * 60_000;
      const age = this.d.clock.now().getTime() - Date.parse(p.updatedAt);
      if (age > grace && !p.uncertain) {
        return this.reschedule(p, { uncertain: true, error: "BURN_TX_NOT_FOUND", backoff: true });
      }
      return this.reschedule(p, {});
    }
    if (r.kind === "reverted") {
      return this.move(p, "FAILED", "burn reverted", { failureCode: "BURN_REVERTED", burnBlock: r.blockNumber });
    }
    if (r.confirmations < BigInt(this.d.options.minConfirmations)) return this.reschedule(p, {});
    if (r.burns.length !== 1) {
      return this.move(p, "FAILED", "tx is not a single CCTP burn", { failureCode: "BURN_NOT_FOUND_IN_TX", burnBlock: r.blockNumber });
    }
    const gasless = isGaslessMode(p.mode);
    const router = this.d.evm.routerAddress();
    // Gasless burns are deposited by the router; the payer is proven by its event instead.
    const mismatch = checkDepositForBurn(r.burns[0]!, q, gasless ? router : p.payer);
    if (gasless) {
      if (r.routerPayments.length !== 1) mismatch.push("routerEvent");
      else mismatch.push(...checkRouterPayment(r.routerPayments[0], q, paymentIdBytes32(p.id), p.payer));
    }
    if (mismatch.length > 0) {
      return this.move(p, "FAILED", "burn does not match quote", {
        failureCode: "BURN_MISMATCH",
        lastError: mismatch.join(","),
        burnBlock: r.blockNumber,
      });
    }
    return this.move(p, "BURN_CONFIRMED", "DepositForBurn verified", { burnBlock: r.blockNumber });
  }

  private async stepBurnConfirmed(p: CrosschainPayment): Promise<CrosschainPayment> {
    const q = this.quoteOf(p);
    const r = await this.d.iris.lookup(q.sourceDomain, p.burnTxHash!);
    if (r.kind !== "complete") return this.reschedule(p, {});
    const decoded = decodeMessageV2(r.message.message);
    const mismatch = checkAttestedMessage(decoded, q, isGaslessMode(p.mode) ? this.d.evm.routerAddress() : p.payer);
    if (mismatch.length > 0) {
      // Burn was verified but the attested message disagrees: never mint blindly.
      return this.reschedule(p, { uncertain: true, error: `ATTESTATION_MISMATCH:${mismatch.join(",")}`, backoff: true });
    }
    return this.move(p, "ATTESTED", "attestation verified", {
      cctpNonce: decoded.nonce,
      message: r.message.message as Hex,
      attestation: r.message.attestation as Hex,
      feeExecutedAtomic: decoded.body.feeExecuted,
    });
  }

  private async stepAttested(p: CrosschainPayment): Promise<CrosschainPayment> {
    if (await this.d.stellar.isNonceUsed(p.cctpNonce!)) {
      return this.settle(p, null, "nonce already used on Stellar");
    }
    const guard = this.d.options.mintResubmitGuardMs ?? 60_000;
    if (p.mintRequestedAt && this.d.clock.now().getTime() - Date.parse(p.mintRequestedAt) < guard) {
      return this.reschedule(p, {}); // a previous request may still land; give it time
    }
    const q = this.quoteOf(p);
    const acct = await this.d.stellar.accountStatus(q.payTo);
    if (!acct.trustline || !acct.authorized) {
      return this.reschedule(p, { error: "PAYTO_TRUSTLINE_MISSING", backoff: true });
    }
    const submitter = this.d.submitters[this.d.activeSubmitter];
    if (!submitter) throw new Error(`mint submitter ${this.d.activeSubmitter} not configured`);
    // Record the request before calling out, so a crash is visible to recovery.
    let cur = this.patch(p, { mintRequestedAt: iso(this.d.clock.now()), mintSubmitter: submitter.name });
    try {
      const sub = await submitter.submit(cur.message!, cur.attestation!);
      return this.move(cur, "MINT_SUBMITTED", `mint_and_forward submitted via ${submitter.name}`, {
        mintSubmissionId: sub.submissionId,
        mintTxHash: sub.txHash ?? null,
        lastError: null,
      });
    } catch (e) {
      cur = this.d.repo.getPayment(cur.id) ?? cur;
      // Ambiguous failures (timeouts, 5xx) keep mintRequestedAt so the guard waits for a possible landing.
      if (e instanceof SubmissionRejected) cur = this.patch(cur, { mintRequestedAt: null });
      return this.reschedule(cur, { error: `MINT_SUBMIT_FAILED:${errText(e)}`, backoff: true, countAttempt: true });
    }
  }

  private async stepMintSubmitted(p: CrosschainPayment): Promise<CrosschainPayment> {
    const submitter = this.d.submitters[p.mintSubmitter ?? ""];
    if (!submitter) throw new Error(`mint submitter ${p.mintSubmitter} not configured`);
    const st = await submitter.status(p.mintSubmissionId!);
    if (st.state === "pending") {
      const age = this.d.clock.now().getTime() - Date.parse(p.mintRequestedAt ?? p.updatedAt);
      if (age > 5 * 60_000) {
        if (await this.d.stellar.isNonceUsed(p.cctpNonce!)) return this.settle(p, p.mintTxHash, "nonce used while submission pending");
        if (age > 15 * 60_000) {
          // Stuck submission (dropped tx / lost relayer record). Re-submitting is safe: the nonce prevents a double mint.
          return this.move(p, "ATTESTED", "submission stale; will re-submit", {
            lastError: "MINT_SUBMISSION_STALE",
            mintSubmissionId: null,
            mintRequestedAt: null,
            attempts: p.attempts + 1,
          });
        }
      }
      return this.reschedule(p, {});
    }
    if (st.state === "confirmed") {
      const onChain = await this.d.stellar.transactionStatus(st.txHash);
      const used = await this.d.stellar.isNonceUsed(p.cctpNonce!);
      if (onChain === "SUCCESS" && used) return this.settle(p, st.txHash, "mint confirmed on Stellar");
      if (onChain === "NOT_FOUND") return this.reschedule(p, { error: null });
      return this.reschedule(p, { uncertain: true, error: `MINT_STATE_INCONSISTENT:${onChain}:${used}`, backoff: true });
    }
    // failed: if someone else's submission minted, we are settled; otherwise retry the (idempotent) mint.
    if (await this.d.stellar.isNonceUsed(p.cctpNonce!)) return this.settle(p, null, "nonce used by another submission");
    return this.move(p, "ATTESTED", "mint submission failed; will retry", {
      lastError: `MINT_FAILED:${st.reason}`,
      mintSubmissionId: null,
      mintRequestedAt: null,
      attempts: p.attempts + 1,
      nextCheckAt: iso(new Date(this.d.clock.now().getTime() + this.backoffMs(p.attempts + 1))),
    });
  }

  private settle(p: CrosschainPayment, mintTxHash: string | null, note: string): CrosschainPayment {
    const q = this.quoteOf(p);
    const now = iso(this.d.clock.now());
    const settled = this.move(p, "SETTLED", note, { mintTxHash: mintTxHash ?? p.mintTxHash, lastError: null });
    const fee = settled.feeExecutedAtomic ?? 0n;
    this.d.repo.insertReceipt({
      id: newId("paymentReceipt"),
      paymentId: p.id,
      orderId: p.orderId,
      createdAt: now,
      evidence: {
        schema: "tilcai-crosschain-payment-receipt-v1",
        kind: "payment",
        paymentAttemptId: p.id,
        orderId: p.orderId,
        source: {
          network: q.sourceNetwork,
          txHash: settled.burnTxHash,
          block: settled.burnBlock,
          payer: settled.payer,
          burnedAtomic: q.burnAmountAtomic,
          asset: q.burnToken,
        },
        cctp: { version: 2, nonce: settled.cctpNonce, sourceDomain: q.sourceDomain, destinationDomain: q.destinationDomain, feeExecutedAtomic: fee },
        destination: {
          network: q.destinationNetwork,
          txHash: settled.mintTxHash,
          payTo: q.payTo,
          asset: this.d.destination.usdc.sac,
          receivedAtomic: (q.burnAmountAtomic - fee) * 10n,
          nonceUsed: true,
        },
        settledAt: now,
        note: "Payment evidence only; fulfillment is reported separately by the business.",
      },
    });
    return settled;
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  view(id: string) {
    const p = this.mustGet(id);
    const q = this.quoteOf(p);
    return {
      payment: p,
      paymentState: paymentStateOf(p.state, p.uncertain),
      quote: q,
      links: {
        burn: p.burnTxHash ? `${this.d.source.explorer}/tx/${p.burnTxHash}` : null,
        mint: p.mintTxHash ? `${this.d.destination.explorer}/tx/${p.mintTxHash}` : null,
      },
      amounts: {
        destination: `${atomicToDecimal(q.destinationAmountAtomic, this.d.destination.usdc.decimals)} USDC`,
        burn: `${atomicToDecimal(q.burnAmountAtomic, this.d.source.usdc.decimals)} USDC`,
      },
      receipt: this.d.repo.getReceipt(p.id) ?? null,
      events: this.d.repo.events(p.id),
    };
  }

  /** Unsigned calls for an external payer (re-built: allowance may have changed). */
  async callsFor(p: CrosschainPayment): Promise<UnsignedEvmCall[]> {
    const q = this.quoteOf(p);
    const built = await this.d.evm.buildBurnCalls({
      payer: p.payer!,
      amount: q.burnAmountAtomic,
      maxFee: q.maxFeeAtomic,
      destinationDomain: q.destinationDomain,
      target: q.target,
      finality: q.finality,
    });
    return built.calls;
  }

  mustGet(id: string): CrosschainPayment {
    const p = this.d.repo.getPayment(id as PaymentAttemptId);
    if (!p) throw new DomainError("NOT_FOUND");
    return p;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private resolvePayer(mode: PaymentMode, payer?: string): Hex | null {
    if (mode === "dev_signer" || mode === "dev_gasless") {
      const dev = this.d.evm.devSignerAddress();
      if (!dev) throw new DomainError("FORBIDDEN", "dev signer disabled");
      if (payer && payer.toLowerCase() !== dev.toLowerCase()) throw new DomainError("INVALID_INPUT", "payer must be the dev signer");
      return dev;
    }
    if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer)) throw new DomainError("INVALID_INPUT", "payer EVM address required");
    return payer as Hex;
  }

  private quoteOf(p: CrosschainPayment): RouteQuote {
    const q = this.d.repo.getQuote(p.quoteId);
    if (!q) throw new Error(`quote ${p.quoteId} missing for ${p.id}`);
    return q;
  }

  private move(p: CrosschainPayment, to: CrosschainState, note: string, patch: Partial<CrosschainPayment> = {}): CrosschainPayment {
    if (!canMove(p.state, to)) throw new DomainError("INVALID_STATE_TRANSITION", `${p.state} → ${to}`);
    const uncertain = to === "SETTLED" || to === "FAILED" ? false : (patch.uncertain ?? p.uncertain);
    assertSharedTransition(paymentStateOf(p.state, p.uncertain), paymentStateOf(to, uncertain));
    const now = iso(this.d.clock.now());
    const next: CrosschainPayment = {
      ...p,
      nextCheckAt: now,
      ...patch,
      state: to,
      uncertain,
      updatedAt: now,
    };
    const saved = this.d.repo.update(next, p.version, {
      paymentId: p.id,
      from: p.state,
      to,
      note,
      ...(patch.failureCode || patch.lastError ? { data: { failureCode: patch.failureCode, error: patch.lastError } } : {}),
      at: now,
    });
    this.d.log.info("payment transition", { paymentId: p.id, from: p.state, to, note });
    this.announce(saved, p.state, note);
    return saved;
  }

  /** Tells the dashboard that a payment was created (`from` = null) or changed state. */
  private announce(p: CrosschainPayment, from: CrosschainState | null, note: string): void {
    this.d.events?.emit({
      type: "crosschain.payment.transition",
      severity: p.state === "FAILED" ? "error" : "info",
      subject: p.id,
      summary: `Pago crosschain ${from ?? "nuevo"} → ${p.state}: ${note}`,
      data: {
        paymentId: p.id,
        from,
        to: p.state,
        paymentState: paymentStateOf(p.state, p.uncertain),
        note,
        mode: p.mode,
        orderId: p.orderId,
        payer: p.payer,
        burnTxHash: p.burnTxHash,
        mintTxHash: p.mintTxHash,
        attempts: p.attempts,
        failureCode: p.failureCode,
        lastError: p.lastError,
      },
    });
  }

  private patch(p: CrosschainPayment, patch: Partial<CrosschainPayment>): CrosschainPayment {
    return this.d.repo.update({ ...p, ...patch, updatedAt: iso(this.d.clock.now()) }, p.version);
  }

  private reschedule(
    p: CrosschainPayment,
    o: { error?: string | null; uncertain?: boolean; backoff?: boolean; countAttempt?: boolean },
  ): CrosschainPayment {
    const fresh = this.d.repo.getPayment(p.id) ?? p;
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
      assertSharedTransition(paymentStateOf(fresh.state, false), paymentStateOf(fresh.state, true));
      this.d.log.warn("payment flagged uncertain", { paymentId: p.id, state: p.state, error: o.error });
      this.d.events?.emit({
        type: "crosschain.payment.uncertain",
        severity: "warning",
        subject: p.id,
        summary: `Pago crosschain incierto en ${fresh.state}: ${o.error ?? "sin detalle"}`,
        data: { paymentId: p.id, state: fresh.state, error: o.error ?? null, attempts },
      });
      return this.d.repo.update(next, fresh.version, {
        paymentId: p.id,
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

export interface AuthorizationRequest {
  router: Hex;
  paymentId32: Hex;
  nonce: Hex;
  validAfter: bigint;
  validBefore: bigint;
  /** EIP-712 message for eth_signTypedData_v4 (USDC ReceiveWithAuthorization). */
  typedData: ReturnType<typeof authorizationTypedData>;
}
