import { randomBytes, randomInt } from "node:crypto";
import { iso, type Clock } from "../../shared/clock.ts";
import type { Logger } from "../../shared/log.ts";
import type { EventSink } from "../monitor/domain.ts";
import { amountToCents, centsToAmount } from "../qrsimple/domain.ts";
import { CollectionError, ProviderError, type Attempt, type Collection, type ProviderId, type QrProvider } from "./domain.ts";
import type { CollectionRepository } from "./repository.ts";

export interface GatewayOptions {
  /** Consecutive failures that put a provider on cooldown. */
  breakerThreshold: number;
  /** How long a provider on cooldown is skipped (unless every provider is). */
  breakerCooldownMs: number;
  /** A pending QR is asked about at most this often by the worker. */
  pollIntervalMs: number;
  defaultTtlSeconds: number;
}

export const DEFAULT_GATEWAY_OPTIONS: GatewayOptions = { breakerThreshold: 3, breakerCooldownMs: 60_000, pollIntervalMs: 10_000, defaultTtlSeconds: 900 };

export interface CreateInput {
  tenantId: string;
  /** Decimal bolivianos, at most 2 decimals. */
  amount: unknown;
  description: unknown;
  reference?: string;
  expiresInSeconds?: number;
  singleUse?: boolean;
  modifyAmount?: boolean;
  /** Skip the fallback chain and use exactly this provider (diagnostics, tests). */
  provider?: ProviderId;
}

interface Breaker {
  failures: number;
  openUntil: number;
  lastError: string | null;
  lastOkAt: string | null;
  lastFailureAt: string | null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * The QR collection gateway: issues a QR with the principal provider and, when it fails, with the
 * next one of the list. Status, cancel and payment confirmation always go to the provider that
 * issued the QR — a QR belongs to one bank.
 */
export class QrCollectionService {
  private readonly breakers = new Map<ProviderId, Breaker>();

  constructor(
    private readonly d: {
      repo: CollectionRepository;
      /** In order: first = principal, the rest = fallbacks. */
      providers: readonly QrProvider[];
      mode: "live" | "mock";
      clock: Clock;
      log: Logger;
      events: EventSink;
      options?: Partial<GatewayOptions>;
    },
  ) {}

  private get o(): GatewayOptions {
    return { ...DEFAULT_GATEWAY_OPTIONS, ...this.d.options };
  }

  get mode(): "live" | "mock" {
    return this.d.mode;
  }

  /** Providers in order with their configuration and breaker state: what the operator sees. */
  providers(): Array<{ id: ProviderId; label: string; role: "principal" | "fallback"; configured: boolean; coolingDown: boolean; failures: number; lastError: string | null; lastOkAt: string | null; lastFailureAt: string | null }> {
    const now = this.d.clock.now().getTime();
    return this.d.providers.map((p, i) => {
      const b = this.breaker(p.id);
      return { id: p.id, label: p.label, role: i === 0 ? "principal" : "fallback", configured: p.configured(), coolingDown: b.openUntil > now, failures: b.failures, lastError: b.lastError, lastOkAt: b.lastOkAt, lastFailureAt: b.lastFailureAt };
    });
  }

  private breaker(id: ProviderId): Breaker {
    let b = this.breakers.get(id);
    if (!b) {
      b = { failures: 0, openUntil: 0, lastError: null, lastOkAt: null, lastFailureAt: null };
      this.breakers.set(id, b);
    }
    return b;
  }

  private provider(id: ProviderId): QrProvider | undefined {
    return this.d.providers.find((p) => p.id === id);
  }

  // ── Issue ─────────────────────────────────────────────────────────────────

  async create(input: CreateInput): Promise<Collection> {
    const now = this.d.clock.now();
    if (input.reference) {
      const existing = this.d.repo.byReference(input.tenantId, input.reference);
      if (existing) return existing; // idempotent: the same order gets the same QR
    }
    const amountCents = amountToCents(input.amount);
    if (amountCents === null || amountCents <= 0) throw new CollectionError("INVALID_INPUT", "amount must be a positive decimal with at most 2 decimals");
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (!description || description.length > 120) throw new CollectionError("INVALID_INPUT", "description must be 1 to 120 characters");
    const ttl = input.expiresInSeconds ?? this.o.defaultTtlSeconds;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 30 * 86_400) throw new CollectionError("INVALID_INPUT", "expiresInSeconds must be between 60 and 2592000");

    let chain = this.d.providers.filter((p) => !input.provider || p.id === input.provider);
    if (input.provider && chain.length === 0) throw new CollectionError("NO_PROVIDER", `provider ${input.provider} is not in the list of this instance`);
    if (chain.length === 0) throw new CollectionError("NO_PROVIDER", "no QR provider is enabled");

    // Cooling-down providers are tried last, not never: if all of them are cold, the list still gets asked.
    const nowMs = now.getTime();
    const hot = chain.filter((p) => this.breaker(p.id).openUntil <= nowMs);
    const cold = chain.filter((p) => this.breaker(p.id).openUntil > nowMs);
    chain = input.provider ? chain : [...hot, ...cold];

    // ATC parses numeroReferencia as a 32-bit integer (a 12-digit one answers 500 «For input string»): numeric, < 2^31.
    const providerReference = String(randomInt(100_000_000, 2_000_000_000));
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    const attempts: Attempt[] = [];

    for (const p of chain) {
      if (!p.configured()) {
        attempts.push({ provider: p.id, ok: false, skipped: "not-configured", ms: 0 });
        continue;
      }
      const t0 = Date.now();
      try {
        const qr = await p.generate({
          reference: providerReference,
          amountCents,
          currency: "BOB",
          description,
          expiresAt,
          singleUse: input.singleUse ?? true,
          modifyAmount: input.modifyAmount ?? false,
        });
        attempts.push({ provider: p.id, ok: true, ms: Date.now() - t0 });
        this.succeeded(p.id);
        const stamp = iso(this.d.clock.now());
        const c: Collection = {
          id: `qrc_${randomBytes(10).toString("hex")}`,
          tenantId: input.tenantId,
          reference: input.reference ?? null,
          provider: p.id,
          providerRef: qr.providerRef,
          providerReference,
          amountCents,
          currency: "BOB",
          description,
          singleUse: input.singleUse ?? true,
          modifyAmount: input.modifyAmount ?? false,
          status: "PENDING",
          statusMessage: null,
          expiresAt: iso(qr.expiresAt ?? expiresAt),
          imageBase64: qr.imageBase64,
          attempts,
          paidAmountCents: null,
          paidAt: null,
          payerName: null,
          payerBank: null,
          payerAccount: null,
          bankReference: null,
          createdAt: stamp,
          updatedAt: stamp,
          checkedAt: null,
        };
        this.d.repo.insert(c);
        const fellBack = attempts.some((a) => !a.ok && !a.skipped);
        this.d.events.emit({
          type: "qr.collection_created",
          source: "qr-simple",
          severity: fellBack ? "warning" : "info",
          subject: `qrc:${c.id}`,
          summary: `QR de cobro ${c.id} por Bs ${centsToAmount(amountCents)} emitido por ${p.id}${fellBack ? ` tras fallar ${attempts.filter((a) => !a.ok && !a.skipped).map((a) => a.provider).join(", ")}` : ""}`,
          data: { id: c.id, provider: p.id, providerRef: c.providerRef, amount: centsToAmount(amountCents), currency: "BOB", attempts },
        });
        return c;
      } catch (e) {
        const kind = e instanceof ProviderError ? e.kind : "invalid-response";
        attempts.push({ provider: p.id, ok: false, kind, error: errText(e), ms: Date.now() - t0 });
        this.failed(p.id, errText(e));
        this.d.log.warn("qr provider failed to issue", { provider: p.id, kind, error: errText(e), next: chain[chain.indexOf(p) + 1]?.id ?? null });
      }
    }
    this.d.events.emit({
      type: "qr.provider_failed",
      source: "qr-simple",
      severity: "error",
      subject: "qr:gateway",
      summary: `Ningún proveedor pudo emitir el QR: ${attempts.map((a) => `${a.provider} (${a.skipped ?? a.error})`).join("; ")}`,
      data: { attempts },
    });
    throw new CollectionError("ALL_PROVIDERS_FAILED", "no provider could issue the QR", attempts);
  }

  private succeeded(id: ProviderId): void {
    const b = this.breaker(id);
    b.failures = 0;
    b.openUntil = 0;
    b.lastOkAt = iso(this.d.clock.now());
  }

  private failed(id: ProviderId, error: string): void {
    const b = this.breaker(id);
    b.failures++;
    b.lastError = error;
    b.lastFailureAt = iso(this.d.clock.now());
    if (b.failures >= this.o.breakerThreshold) b.openUntil = this.d.clock.now().getTime() + this.o.breakerCooldownMs;
  }

  // ── Read / refresh ────────────────────────────────────────────────────────

  find(tenantId: string, id: string): Collection {
    const c = this.d.repo.get(id);
    if (!c || c.tenantId !== tenantId) throw new CollectionError("NOT_FOUND", "collection not found");
    return c;
  }

  list(tenantId: string, limit = 50): Collection[] {
    return this.d.repo.list(tenantId, Math.min(Math.max(limit, 1), 200));
  }

  /** The collection as the issuing provider sees it now. A provider outage keeps the stored state. */
  async get(tenantId: string, id: string): Promise<Collection> {
    return this.refresh(this.find(tenantId, id));
  }

  async refresh(c: Collection): Promise<Collection> {
    if (c.status !== "PENDING") return c;
    const p = this.provider(c.provider);
    if (!p) return c;
    const now = this.d.clock.now();
    try {
      const s = await p.status(c.providerRef);
      this.succeeded(p.id);
      const next: Collection = { ...c, checkedAt: iso(now), updatedAt: iso(now) };
      if (s.state !== c.status) {
        next.status = s.state;
        next.statusMessage = s.message;
        if (s.state === "PAID" && s.payment) {
          next.paidAmountCents = s.payment.amountCents ?? c.amountCents;
          next.paidAt = s.payment.paidAt ?? iso(now);
          next.payerName = s.payment.payerName;
          next.payerBank = s.payment.payerBank;
          next.payerAccount = s.payment.payerAccount;
          next.bankReference = s.payment.bankReference;
        } else if (s.state === "PAID") {
          next.paidAmountCents = c.amountCents;
          next.paidAt = iso(now);
        }
      } else if (Date.parse(c.expiresAt) + 60_000 < now.getTime()) {
        // The bank still says pending a minute after the QR's end: it can no longer be paid.
        next.status = "EXPIRED";
      }
      this.d.repo.save(next);
      if (next.status !== c.status) this.announce(next);
      return next;
    } catch (e) {
      this.failed(p.id, errText(e));
      this.d.log.warn("qr provider status failed", { provider: p.id, id: c.id, error: errText(e) });
      this.d.repo.save({ ...c, checkedAt: iso(now) });
      return { ...c, checkedAt: iso(now) };
    }
  }

  private announce(c: Collection): void {
    const paid = c.status === "PAID";
    this.d.events.emit({
      type: paid ? "qr.collection_paid" : "qr.collection_closed",
      source: "qr-simple",
      severity: c.status === "ERROR" ? "error" : "info",
      subject: `qrc:${c.id}`,
      summary: paid
        ? `QR de cobro ${c.id} pagado: Bs ${centsToAmount(c.paidAmountCents ?? c.amountCents)} vía ${c.provider}`
        : `QR de cobro ${c.id} (${c.provider}) pasó a ${c.status}`,
      data: { id: c.id, provider: c.provider, providerRef: c.providerRef, status: c.status, amount: centsToAmount(c.amountCents), paidAmount: c.paidAmountCents === null ? null : centsToAmount(c.paidAmountCents), reference: c.reference },
    });
  }

  async cancel(tenantId: string, id: string): Promise<Collection> {
    const c = this.find(tenantId, id);
    if (c.status !== "PENDING") throw new CollectionError("INVALID_INPUT", `a ${c.status} collection cannot be cancelled`);
    const p = this.provider(c.provider);
    if (!p?.cancel) throw new CollectionError("UNSUPPORTED", `${c.provider} has no cancel operation: the QR lapses at ${c.expiresAt}`);
    try {
      await p.cancel(c.providerRef);
    } catch (e) {
      throw new CollectionError("PROVIDER_ERROR", errText(e));
    }
    const now = iso(this.d.clock.now());
    const next: Collection = { ...c, status: "CANCELLED", updatedAt: now, checkedAt: now };
    this.d.repo.save(next);
    this.announce(next);
    return next;
  }

  /** A provider's payment notification. Only a hint: the state is confirmed by asking the provider. */
  async onNotification(provider: ProviderId, providerRef: string): Promise<Collection | null> {
    const c = this.d.repo.byProviderRef(provider, providerRef);
    return c ? this.refresh(c) : null;
  }

  /** Worker: asks the provider about every pending QR that has not been looked at recently. */
  async processDue(limit = 20): Promise<number> {
    const before = iso(new Date(this.d.clock.now().getTime() - this.o.pollIntervalMs));
    const due = this.d.repo.due(before, limit);
    for (const c of due) await this.refresh(c);
    return due.length;
  }

  /** Mock mode only: pays the QR as a bank app would. */
  provider_(id: ProviderId): QrProvider | undefined {
    return this.provider(id);
  }
}
