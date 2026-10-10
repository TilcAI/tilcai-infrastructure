import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { iso, type Clock } from "../../shared/clock.ts";
import type { Logger } from "../../shared/log.ts";
import type { EventSink } from "../monitor/domain.ts";
import {
  amountToCents,
  centsToAmount,
  formatVendisDate,
  parseVendisDate,
  QrMockError,
  type QrCode,
  type QrPayment,
  type VendisPayment,
} from "./domain.ts";
import { qrMatrix, renderQrPng } from "./image.ts";
import type { QrMockRepository } from "./repository.ts";

export interface QrMockConfig {
  email: string;
  password: string;
  /** Base URL of this API as the caller sees it: prefix of `qr_url`. */
  publicUrl: string;
  /** The caller's …/api/v1/devices/simple-qr/callback. Empty = payments are only seen by polling. */
  callbackUrl: string;
}

export interface CallbackOutcome {
  state: QrPayment["callbackState"];
  attempts: number;
  error: string | null;
}

/** "The token is valid for one year." */
const TOKEN_TTL_MS = 365 * 86_400_000;
/** One delivery plus the three retries of the Vendis documentation. */
const CALLBACK_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
/** What an open-amount QR is paid with when nobody says how much. */
const DEFAULT_OPEN_AMOUNT_CENTS = 1000;
/** While one sender is delivering a notification, nobody else picks it up. */
const CALLBACK_LEASE_MS = 30_000;
const GENERATE_ERROR = "Ocurrió un error al generar el QR";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const safeEqual = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * The provider side of a QR Simple collection, in memory of nobody's bank: login, QR
 * generation, status and the payment notification, as in Vendis's API v1.3.
 */
export class QrSimpleMock {
  private readonly key: Buffer;

  constructor(
    private readonly d: {
      repo: QrMockRepository;
      clock: Clock;
      log: Logger;
      events: EventSink;
      config: QrMockConfig;
      fetchImpl?: typeof fetch;
      callbackTimeoutMs?: number;
    },
  ) {
    this.key = createHash("sha256").update(`tilcai-qr-mock:${d.config.password}`).digest();
  }

  // ── api/v1/login ──────────────────────────────────────────────────────────

  login(body: unknown): { access_token: string } {
    const b = isRecord(body) ? body : {};
    const ok =
      typeof b.email === "string" &&
      typeof b.password === "string" &&
      safeEqual(b.email.trim().toLowerCase(), this.d.config.email.trim().toLowerCase()) &&
      safeEqual(b.password, this.d.config.password);
    if (!ok) throw new QrMockError(401, { message: "Credenciales Inválidos" });
    const name = typeof b.token_name === "string" && b.token_name.trim() ? b.token_name.trim().slice(0, 80) : "token";
    const now = this.d.clock.now();
    const token = this.d.repo.createToken(name, iso(now), iso(new Date(now.getTime() + TOKEN_TTL_MS)));
    this.d.events.emit({
      type: "qr.token_issued",
      source: "qr-simple",
      subject: `token:${token.id}`,
      summary: `QR Simple: token «${name}» emitido, vigente un año`,
      data: { tokenId: token.id, name, expiresAt: token.expiresAt },
    });
    return { access_token: this.rawToken(token.id) };
  }

  /** Token id behind an `Authorization: Bearer <id>|<secret>` header. */
  authenticate(authorization: string | undefined): number {
    const raw = /^Bearer (\d{1,12})\|([0-9a-f]{48})$/.exec(authorization ?? "");
    const id = raw ? Number(raw[1]) : NaN;
    const token = raw ? this.d.repo.token(id) : undefined;
    if (!raw || !token || !safeEqual(`${raw[1]}|${raw[2]}`, this.rawToken(id)) || Date.parse(token.expiresAt) <= this.d.clock.now().getTime()) {
      throw new QrMockError(401, { message: "Unauthenticated." });
    }
    return id;
  }

  /** Derived, so the mock can send it back in the callback without storing secrets. */
  private rawToken(id: number): string {
    return `${id}|${createHmac("sha256", this.key).update(`token:${id}`).digest("hex").slice(0, 48)}`;
  }

  // ── api/v1/devices/simple-qr/generate ─────────────────────────────────────

  generate(tokenId: number, body: unknown): { qr_image: string; qr_url: string; qr_id: number } {
    const b = isRecord(body) ? body : {};
    const errors: Record<string, string> = {};
    const deviceId = typeof b.device_id === "number" && Number.isInteger(b.device_id) && b.device_id > 0 ? String(b.device_id) : typeof b.device_id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(b.device_id) ? b.device_id : null;
    if (deviceId === null) errors.device_id = "identificador de dispositivo inválido";
    const amountCents = amountToCents(b.amount);
    if (amountCents === null) errors.amount = "monto decimal con hasta 2 decimales";
    if (typeof b.modify_amount !== "boolean") errors.modify_amount = "debe ser booleano";
    if (typeof b.is_multi_use !== "boolean") errors.is_multi_use = "debe ser booleano";
    const expiresAt = parseVendisDate(b.qr_expiration);
    const now = this.d.clock.now();
    if (!expiresAt) errors.qr_expiration = "formato Y-m-d H:i:s (hora de Bolivia)";
    else if (expiresAt.getTime() <= now.getTime()) errors.qr_expiration = "la fecha ya pasó";
    const text = typeof b.description === "string" ? b.description.trim() : "";
    if (!text || text.length > 120) errors.description = "glosa de 1 a 120 caracteres";
    // Paying exactly nothing is not a payment: a fixed-amount QR needs an amount.
    if (amountCents === 0 && b.modify_amount === false) errors.amount = "un QR de monto fijo necesita un monto mayor a cero";
    if (Object.keys(errors).length > 0 || deviceId === null || amountCents === null || !expiresAt) {
      throw new QrMockError(422, { success: false, message: GENERATE_ERROR, errors });
    }

    const code: QrCode = {
      qrId: 0,
      tokenId,
      deviceId,
      amountCents,
      modifyAmount: b.modify_amount as boolean,
      multiUse: b.is_multi_use as boolean,
      description: `SN${serial(deviceId)} ${text}`,
      // The real code is an encrypted blob plus an identifier; this one is noise in the same shape.
      payload: `${randomBytes(256).toString("base64")}|${randomBytes(12).toString("hex")}`,
      status: "Pendiente",
      expiresAt: iso(expiresAt),
      createdAt: iso(now),
      updatedAt: iso(now),
    };
    for (let attempt = 0; ; attempt++) {
      code.qrId = randomInt(100_000_000, 1_000_000_000);
      try {
        this.d.repo.insertCode(code);
        break;
      } catch (e) {
        if (attempt >= 4 || !String(e).includes("UNIQUE")) throw e;
      }
    }
    this.d.events.emit({
      type: "qr.created",
      source: "qr-simple",
      subject: `qr:${code.qrId}`,
      summary: `QR Simple #${code.qrId} por Bs ${centsToAmount(code.amountCents)} — ${code.description}`,
      data: { qrId: code.qrId, amount: centsToAmount(code.amountCents), currency: "BOB", description: code.description, deviceId, modifyAmount: code.modifyAmount, multiUse: code.multiUse, expiresAt: code.expiresAt },
    });
    return { qr_image: this.png(code).toString("base64"), qr_url: this.imageUrl(code), qr_id: code.qrId };
  }

  // ── api/v1/devices/simple-qr/get/<QR-ID> ──────────────────────────────────

  status(qrId: unknown): { status: string; payments: Array<Omit<VendisPayment, "qr_id"> & { qr_id: string }> } {
    const code = this.find(qrId);
    return {
      status: code.status,
      // As documented: the status answer carries qr_id as a string, the callback as a number.
      payments: this.d.repo.payments(code.qrId).map((p) => ({ ...this.vendisPayment(p), qr_id: String(p.qrId) })),
    };
  }

  private find(qrId: unknown): QrCode {
    const id = typeof qrId === "number" ? qrId : typeof qrId === "string" && /^\d{1,12}$/.test(qrId) ? Number(qrId) : NaN;
    if (Number.isInteger(id)) {
      this.expireDue();
      const code = this.d.repo.code(id);
      if (code) return code;
    }
    throw new QrMockError(404, { success: false, message: "QR no encontrado" });
  }

  // ── QR image (qr_url) ─────────────────────────────────────────────────────

  private tag(code: QrCode): string {
    return createHash("sha256").update(code.payload).digest("hex").slice(0, 16);
  }

  imagePath(code: QrCode): string {
    return `/mock/vendis/qr-image/${code.qrId}-${this.tag(code)}.png`;
  }

  private imageUrl(code: QrCode): string {
    return `${this.d.config.publicUrl.replace(/\/+$/, "")}${this.imagePath(code)}`;
  }

  private png(code: QrCode): Buffer {
    return renderQrPng(qrMatrix(code.payload));
  }

  /** The PNG behind a `qr_url`, or null when the name does not match a QR. */
  image(fileName: string): Buffer | null {
    const m = /^(\d{1,12})-([0-9a-f]{16})\.png$/.exec(fileName);
    const code = m ? this.d.repo.code(Number(m[1])) : undefined;
    return code && m && safeEqual(m[2]!, this.tag(code)) ? this.png(code) : null;
  }

  // ── "Simular depósito" ────────────────────────────────────────────────────

  pending(limit = 20): QrCode[] {
    this.expireDue();
    return this.d.repo.pending(iso(this.d.clock.now()), limit);
  }

  /**
   * Pays a QR as a bank app would: records the payment, marks the QR paid and notifies the
   * caller. Without `qrId` it pays the newest QR that is still waiting.
   */
  async simulateDeposit(input: { qrId?: unknown; amount?: unknown; payerName?: unknown; payerBank?: unknown } = {}): Promise<{ qr: QrCode; payment: QrPayment; callback: CallbackOutcome }> {
    const code = input.qrId === undefined || input.qrId === null ? this.pending(1)[0] : this.find(input.qrId);
    if (!code) throw new QrMockError(404, { success: false, message: "No hay ningún QR pendiente de pago" });
    const now = this.d.clock.now();
    if (code.status === "Anulado" || Date.parse(code.expiresAt) <= now.getTime()) throw new QrMockError(409, { success: false, message: "El QR está vencido o anulado" });
    if (code.status === "Fallido") throw new QrMockError(409, { success: false, message: "El QR no llegó a crearse" });
    if (code.status === "Pagado" && !code.multiUse) throw new QrMockError(409, { success: false, message: "El QR ya fue pagado" });

    let amountCents = code.amountCents > 0 ? code.amountCents : DEFAULT_OPEN_AMOUNT_CENTS;
    if (input.amount !== undefined && input.amount !== null) {
      const asked = amountToCents(input.amount);
      if (asked === null || asked === 0) throw new QrMockError(422, { success: false, message: "Monto inválido" });
      if (!code.modifyAmount && asked !== code.amountCents) throw new QrMockError(422, { success: false, message: "Este QR no permite cambiar el monto" });
      amountCents = asked;
    }
    const name = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : fallback);
    const hasCallback = Boolean(this.d.config.callbackUrl);
    const payment = this.d.repo.pay(
      code.qrId,
      {
        amountCents,
        payerName: name(input.payerName, "PAGADOR NO INFORMADO"),
        payerBank: name(input.payerBank, "BANCO NO INFORMADO"),
        paidAt: iso(now),
        callbackState: hasCallback ? "PENDING" : "SKIPPED",
        callbackAttempts: 0,
        // Reserved for the delivery below: the worker only takes over if this process dies midway.
        callbackNextAt: hasCallback ? iso(new Date(now.getTime() + CALLBACK_LEASE_MS)) : null,
        callbackLastError: null,
        callbackDeliveredAt: null,
      },
      iso(now),
    );
    const paid: QrCode = { ...code, status: "Pagado", updatedAt: iso(now) };
    this.d.events.emit({
      type: "qr.paid",
      source: "qr-simple",
      subject: `qr:${code.qrId}`,
      summary: `QR Simple #${code.qrId}: depósito simulado de Bs ${centsToAmount(amountCents)}`,
      data: { qrId: code.qrId, paymentId: payment.id, amount: centsToAmount(amountCents), currency: "BOB", payerName: payment.payerName, payerBank: payment.payerBank, description: code.description },
    });
    // Notified right away; if the caller is not there, the worker retries.
    const callback = hasCallback ? await this.deliver(payment, paid) : { state: "SKIPPED" as const, attempts: 0, error: null };
    return { qr: paid, payment: { ...payment, callbackState: callback.state, callbackAttempts: callback.attempts, callbackLastError: callback.error }, callback };
  }

  // ── Notificación por HTTP (callback) ──────────────────────────────────────

  /** Retries the notifications that are due. Called by the worker. */
  async deliverDueCallbacks(limit = 20): Promise<number> {
    const now = this.d.clock.now();
    const due = this.d.repo.dueCallbacks(iso(now), limit);
    let sent = 0;
    for (const payment of due) {
      const code = this.d.repo.code(payment.qrId);
      // Two workers on the same database: only the one that reserves it sends it.
      if (!code || !this.d.repo.claimCallback(payment.id, payment.callbackAttempts, iso(new Date(now.getTime() + CALLBACK_LEASE_MS)))) continue;
      await this.deliver(payment, code);
      sent++;
    }
    return sent;
  }

  private async deliver(payment: QrPayment, code: QrCode): Promise<CallbackOutcome> {
    const body: VendisPayment = this.vendisPayment(payment);
    let error: string | null = null;
    try {
      const res = await (this.d.fetchImpl ?? fetch)(this.d.config.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${this.rawToken(code.tokenId)}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.d.callbackTimeoutMs ?? 10_000),
      });
      const answer = (await res.json().catch(() => null)) as { success?: unknown; message?: unknown } | null;
      if (!res.ok || answer?.success !== true) error = `HTTP ${res.status}${typeof answer?.message === "string" ? `: ${answer.message}` : ""}`.slice(0, 200);
    } catch (e) {
      error = errText(e);
    }

    const now = this.d.clock.now();
    const attempts = payment.callbackAttempts + 1;
    const subject = `qr:${code.qrId}`;
    if (error === null) {
      this.d.repo.saveCallback(payment.id, { callbackState: "DELIVERED", callbackAttempts: attempts, callbackNextAt: null, callbackLastError: null, callbackDeliveredAt: iso(now) });
      this.d.events.emit({
        type: "qr.callback_delivered",
        source: "qr-simple",
        subject,
        summary: `QR Simple #${code.qrId}: notificación de pago entregada${attempts > 1 ? ` al intento ${attempts}` : ""}`,
        data: { qrId: code.qrId, paymentId: payment.id, attempts, url: this.d.config.callbackUrl },
      });
      return { state: "DELIVERED", attempts, error: null };
    }
    const delay = CALLBACK_RETRY_DELAYS_MS[attempts - 1];
    const state = delay === undefined ? "FAILED" : "PENDING";
    this.d.repo.saveCallback(payment.id, {
      callbackState: state,
      callbackAttempts: attempts,
      callbackNextAt: delay === undefined ? null : iso(new Date(now.getTime() + delay)),
      callbackLastError: error,
      callbackDeliveredAt: null,
    });
    this.d.log.warn("qr mock: payment notification not delivered", { qrId: code.qrId, attempts, error, final: state === "FAILED" });
    this.d.events.emit({
      type: "qr.callback_failed",
      source: "qr-simple",
      severity: state === "FAILED" ? "error" : "warning",
      subject,
      summary:
        state === "FAILED"
          ? `QR Simple #${code.qrId}: notificación de pago sin entregar tras ${attempts} intentos — ${error}`
          : `QR Simple #${code.qrId}: notificación de pago falló (intento ${attempts}); se reintenta — ${error}`,
      data: { qrId: code.qrId, paymentId: payment.id, attempts, final: state === "FAILED", error, url: this.d.config.callbackUrl },
    });
    return { state, attempts, error };
  }

  /** Voids the QRs that ran out of time. Called by the worker and before every read. */
  expireDue(): number {
    const expired = this.d.repo.expire(iso(this.d.clock.now()));
    for (const code of expired) {
      this.d.events.emit({
        type: "qr.expired",
        source: "qr-simple",
        subject: `qr:${code.qrId}`,
        summary: `QR Simple #${code.qrId} venció sin pago`,
        data: { qrId: code.qrId, amount: centsToAmount(code.amountCents), description: code.description, expiresAt: code.expiresAt },
      });
    }
    return expired.length;
  }

  private vendisPayment(p: QrPayment): VendisPayment {
    return {
      payment_date: formatVendisDate(new Date(p.paidAt)),
      payment_amount: centsToAmount(p.amountCents),
      qr_id: p.qrId,
      payment_name: p.payerName,
      payment_bank: p.payerBank,
    };
  }
}

/** "SN<####>": four digits that identify the device in the glosa. */
function serial(deviceId: string): string {
  if (/^\d+$/.test(deviceId)) return deviceId.slice(-4).padStart(4, "0");
  return String(createHash("sha256").update(deviceId).digest().readUInt16BE(0) % 10_000).padStart(4, "0");
}
