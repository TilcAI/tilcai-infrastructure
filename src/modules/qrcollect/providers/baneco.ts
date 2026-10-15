import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  boliviaDate,
  endOfBoliviaDay,
  ProviderError,
  type CollectionState,
  type ProviderPayment,
  type ProviderQr,
  type ProviderQrRequest,
  type ProviderStatus,
  type QrProvider,
} from "../domain.ts";
import { callJson, isRecord, str, toCents } from "../http.ts";

export interface BanecoConfig {
  /** https://apimktdesa.baneco.com.bo/ApiGateway/ in certification. */
  baseUrl: string;
  user: string;
  password: string;
  /** 256-bit AES key the bank issues per environment: 32 characters, 64 hex digits or 44 base64. */
  encryptionKey: string;
  /** The account the payments are credited to (checking or savings). */
  paymentAccount: string;
  /** Up to 5 characters; makes the bank credit each branch separately. Optional. */
  branchCode?: string;
  timeoutMs: number;
}

/** Maximum lengths of generateQR's text fields (specification v1.3.0, section 7.2). */
export const BANECO_LIMITS = { transactionId: 30, accountCredit: 10, currency: 3, description: 100, branchCode: 5 } as const;

/** Token lifetime when the JWT carries no `exp` (the bank's tokens last 30 minutes). */
const DEFAULT_TOKEN_MS = 25 * 60_000;

/**
 * Banco Económico, "API Market" v1.3.0 (Pago Simple por QR).
 *
 *   auth      POST api/authentication/authenticate {userName, password: AES(password)} → JWT
 *   generate  POST api/qrsimple/generateQR  Bearer, accountCredit = AES(account)
 *   status    GET  api/qrsimple/v2/statusQR/{qrId}   0 pending · 1 paid · 9 cancelled
 *   cancel    DELETE api/qrsimple/cancelQR {qrId}
 *
 * AES-256-CBC, PKCS#7, base64 of IV(16 bytes) ‖ ciphertext; the IV is random per message. This was
 * checked against the vector in the specification (key 40A3…8629, "1234").
 */
export class BanecoProvider implements QrProvider {
  readonly id = "baneco" as const;
  readonly label = "Banco Económico (QR Simple)";
  private token: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly c: BanecoConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  configured(): boolean {
    return Boolean(this.c.baseUrl && this.c.user && this.c.password && this.c.encryptionKey && this.c.paymentAccount);
  }

  // ── AES ───────────────────────────────────────────────────────────────────

  private key(): Buffer {
    const k = this.c.encryptionKey.trim();
    const raw = /^[0-9a-fA-F]{64}$/.test(k) ? Buffer.from(k, "hex") : Buffer.from(k, "utf8");
    if (raw.length === 32) return raw;
    const b64 = Buffer.from(k, "base64");
    if (b64.length === 32) return b64;
    throw new ProviderError(this.id, "auth", "BANECO_ENCRIPTION_KEY is not a 256-bit key");
  }

  encrypt(text: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", this.key(), iv);
    return Buffer.concat([iv, cipher.update(text, "utf8"), cipher.final()]).toString("base64");
  }

  decrypt(b64: string): string {
    const raw = Buffer.from(b64, "base64");
    const d = createDecipheriv("aes-256-cbc", this.key(), raw.subarray(0, 16));
    return Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString("utf8");
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  private url(path: string): string {
    return `${this.c.baseUrl.replace(/\/+$/, "")}/${path}`;
  }

  private async login(): Promise<string> {
    const { status, body } = await callJson(this.id, this.fetchImpl, this.url("api/authentication/authenticate"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ userName: this.c.user, password: this.encrypt(this.c.password) }),
      timeoutMs: this.c.timeoutMs,
    });
    const b = isRecord(body) ? body : {};
    const token = str(b.token);
    if (status >= 500) throw new ProviderError(this.id, "http", `authentication answered HTTP ${status}`, status);
    if (status >= 400 || b.responseCode !== 0 || !token) {
      throw new ProviderError(this.id, "auth", `authentication refused${str(b.message) ? `: ${str(b.message)}` : ` (HTTP ${status})`}`.slice(0, 200), status);
    }
    this.token = { value: token, expiresAt: this.now() + (jwtLifetimeMs(token) ?? DEFAULT_TOKEN_MS) - 60_000 };
    return token;
  }

  private bearer(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now()) return Promise.resolve(this.token.value);
    // Concurrent callers share one login.
    this.inflight ??= this.login().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async authed(method: string, path: string, json?: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.bearer(attempt > 0);
      const { status, body } = await callJson(this.id, this.fetchImpl, this.url(path), {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(json !== undefined ? { "content-type": "application/json" } : {}) },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        timeoutMs: this.c.timeoutMs,
      });
      if (status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      if (status >= 500) throw new ProviderError(this.id, "http", `HTTP ${status}`, status);
      if (!isRecord(body)) throw new ProviderError(this.id, status >= 400 ? "http" : "invalid-response", `HTTP ${status} without a JSON answer`, status);
      // The bank reports business errors as responseCode ≠ 0 (often with HTTP 200).
      if (typeof body.responseCode === "number" && body.responseCode !== 0) {
        throw new ProviderError(this.id, "rejected", `${body.responseCode}: ${str(body.message) ?? "sin mensaje"}`.slice(0, 200), status);
      }
      if (status >= 400) throw new ProviderError(this.id, "http", `HTTP ${status}${str(body.message) ? `: ${str(body.message)}` : ""}`.slice(0, 200), status);
      return body;
    }
  }

  // ── QrProvider ────────────────────────────────────────────────────────────

  async generate(req: ProviderQrRequest): Promise<ProviderQr> {
    // Field limits of the specification (generateQR): checked here so a bad value says which one it is
    // instead of a generic refusal from the bank.
    if (req.reference.length > BANECO_LIMITS.transactionId) throw new ProviderError(this.id, "rejected", `transactionId exceeds ${BANECO_LIMITS.transactionId} characters`);
    if (this.c.paymentAccount.length > BANECO_LIMITS.accountCredit) {
      throw new ProviderError(this.id, "rejected", `BANECO_PAYMENT_ACCOUNT exceeds ${BANECO_LIMITS.accountCredit} characters (the limit applies to the plain account number)`);
    }
    if (req.currency.length !== BANECO_LIMITS.currency) throw new ProviderError(this.id, "rejected", "currency must be a 3-letter code");
    const dueDate = boliviaDate(req.expiresAt);
    const body = await this.authed("POST", "api/qrsimple/generateQR", {
      transactionId: req.reference,
      accountCredit: this.encrypt(this.c.paymentAccount),
      currency: req.currency,
      amount: Number(`${Math.trunc(req.amountCents / 100)}.${String(req.amountCents % 100).padStart(2, "0")}`),
      // 100 characters at most; longer notes are cut, not refused.
      description: req.description.slice(0, BANECO_LIMITS.description),
      dueDate,
      singleUse: req.singleUse,
      modifyAmount: req.modifyAmount,
      ...(this.c.branchCode ? { branchCode: this.c.branchCode.slice(0, BANECO_LIMITS.branchCode) } : {}),
    });
    const qrId = str(body.qrId);
    const image = str(body.qrImage);
    if (!qrId || !image) throw new ProviderError(this.id, "invalid-response", "generateQR answered without qrId or qrImage");
    // The bank only takes a due date: the QR lives until the end of that Bolivian day.
    return { providerRef: qrId, imageBase64: image, expiresAt: endOfBoliviaDay(dueDate) };
  }

  async status(providerRef: string): Promise<ProviderStatus> {
    const body = await this.authed("GET", `api/qrsimple/v2/statusQR/${encodeURIComponent(providerRef)}`);
    const code = Number(body.statusQrCode ?? body.statusQRCode);
    const state: CollectionState = code === 0 ? "PENDING" : code === 1 ? "PAID" : code === 9 ? "CANCELLED" : "ERROR";
    if (!Number.isInteger(code)) throw new ProviderError(this.id, "invalid-response", "statusQR answered without a status code");
    const list = Array.isArray(body.payment) ? body.payment : isRecord(body.payment) ? [body.payment] : [];
    const p = list.filter(isRecord).at(-1);
    return { state, message: str(body.message), payment: state === "PAID" && p ? payment(p) : null };
  }

  async cancel(providerRef: string): Promise<void> {
    await this.authed("DELETE", "api/qrsimple/cancelQR", { qrId: providerRef });
  }
}

function payment(p: Record<string, unknown>): ProviderPayment {
  const date = str(p.paymentDate)?.slice(0, 10);
  const time = str(p.paymentTime);
  return {
    amountCents: toCents(p.amount),
    // Bolivia local time without zone, as the bank sends it; kept as text, not reinterpreted.
    paidAt: date ? `${date}${time ? `T${time}` : ""}` : null,
    payerName: str(p.senderName),
    payerBank: str(p.senderBankCode),
    payerAccount: str(p.senderAccount),
    bankReference: str(p.transactionId),
  };
}

function jwtLifetimeMs(token: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number; iat?: number };
    if (typeof claims.exp === "number") return Math.max(0, claims.exp * 1000 - Date.now());
  } catch {
    /* opaque token */
  }
  return null;
}
