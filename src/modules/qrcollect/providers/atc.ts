import { createHmac } from "node:crypto";
import { ProviderError, type CollectionState, type ProviderId, type ProviderPayment, type ProviderQr, type ProviderQrRequest, type ProviderStatus, type QrProvider } from "../domain.ts";
import { callJson, isRecord, str, toCents } from "../http.ts";

export interface AtcConfig {
  /** https://atcgwapitest.redenlace.com.bo/sandbox/ in certification; https://api.redenlace.com.bo/ in production. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** The establishment enabled for this integrator in ATC. */
  establishmentId: number;
  establishmentName: string;
  /** Where ATC posts the payment confirmation (must be reachable from ATC). */
  webhookUrl: string;
  /** Header name and value ATC sends back with the confirmation. */
  webhookHeader: string;
  webhookSecret: string;
  timeoutMs: number;
}

type Kind = "simple" | "mld";
const SESSIONS = new WeakMap<AtcConfig, { token: { value: string; expiresAt: number } | null; inflight: Promise<string> | null }>();

const STATES: Record<string, CollectionState> = { PENDIENTE: "PENDING", PAGADO: "PAID", CANCELADO: "CANCELLED", EXPIRADO: "EXPIRED", ERROR: "ERROR" };

/** The webhook secret when none is configured: stable, derived from the client secret. */
export function deriveWebhookSecret(clientSecret: string): string {
  return createHmac("sha256", clientSecret).update("tilcai-qr-webhook").digest("hex").slice(0, 48);
}

/**
 * Red Enlace ATC, "Cobro por QR" v2 (OAuth 2.0 client credentials).
 *
 *   token     POST oauth-client-credentials/access-token?grant_type=client_credentials  (Basic id:secret)
 *   generate  POST qr/simple/v2/generate   |  qr/mld/v2/generate     headers access_token + client_id
 *   verify    GET  qr/simple/v2/verify/{numeroReferencia}  |  qr/mld/v2/verify/…
 *
 * QR Simple and QR MLD (BCB's interoperable QR) share everything but the path, so one class serves
 * both. ATC documents no cancel operation; the payment confirmation comes by webhook, and the
 * gateway also polls `verify`.
 */
export class AtcProvider implements QrProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** QR Simple and QR MLD log in with the same credentials: they share one token while they share a config. */
  private readonly session: { token: { value: string; expiresAt: number } | null; inflight: Promise<string> | null };

  constructor(
    private readonly kind: Kind,
    private readonly c: AtcConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    let session = SESSIONS.get(c);
    if (!session) SESSIONS.set(c, (session = { token: null, inflight: null }));
    this.session = session;
    this.id = kind === "simple" ? "atc-simple" : "atc-mld";
    this.label = kind === "simple" ? "Red Enlace ATC (QR Simple)" : "Red Enlace ATC (QR MLD / BCB)";
  }

  configured(): boolean {
    return Boolean(this.c.baseUrl && this.c.clientId && this.c.clientSecret);
  }

  private url(path: string): string {
    return `${this.c.baseUrl.replace(/\/+$/, "")}/${path}`;
  }

  private async login(): Promise<string> {
    const basic = Buffer.from(`${this.c.clientId}:${this.c.clientSecret}`).toString("base64");
    const { status, body } = await callJson(this.id, this.fetchImpl, this.url("oauth-client-credentials/access-token?grant_type=client_credentials"), {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: "",
      timeoutMs: this.c.timeoutMs,
    });
    const b = isRecord(body) ? body : {};
    const token = str(b.access_token);
    if (status >= 500) throw new ProviderError(this.id, "http", `token endpoint answered HTTP ${status}`, status);
    if (status >= 400 || !token) throw new ProviderError(this.id, "auth", `token refused (HTTP ${status})`, status);
    const ttl = typeof b.expires_in === "number" ? b.expires_in : 3600;
    this.session.token = { value: token, expiresAt: this.now() + Math.max(30, ttl - 60) * 1000 };
    return token;
  }

  private bearer(force = false): Promise<string> {
    const s = this.session;
    if (!force && s.token && s.token.expiresAt > this.now()) return Promise.resolve(s.token.value);
    s.inflight ??= this.login().finally(() => {
      s.inflight = null;
    });
    return s.inflight;
  }

  private async authed(method: string, path: string, json?: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.bearer(attempt > 0);
      const { status, body } = await callJson(this.id, this.fetchImpl, this.url(path), {
        method,
        headers: {
          // The two pages of the portal disagree on where the token goes; both are accepted.
          access_token: token,
          authorization: `Bearer ${token}`,
          client_id: this.c.clientId,
          accept: "application/json",
          ...(json !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        timeoutMs: this.c.timeoutMs,
      });
      if ((status === 401 || status === 403) && attempt === 0) {
        this.session.token = null;
        continue;
      }
      if (status >= 500) throw new ProviderError(this.id, "http", `HTTP ${status}${isRecord(body) && str(body.message) ? `: ${str(body.message)}` : ""}`.slice(0, 200), status);
      if (!isRecord(body)) throw new ProviderError(this.id, status >= 400 ? "http" : "invalid-response", `HTTP ${status} without a JSON answer`, status);
      if (status >= 400 || body.success === false) {
        const first = Array.isArray(body.errors) ? body.errors.find(isRecord) : undefined;
        const detail = [str(first?.code), str(first?.message) ?? str(body.message)].filter(Boolean).join(": ");
        throw new ProviderError(this.id, status === 401 || status === 403 ? "auth" : "rejected", `HTTP ${status}${detail ? ` ${detail}` : ""}`.slice(0, 200), status);
      }
      return body;
    }
  }

  async generate(req: ProviderQrRequest): Promise<ProviderQr> {
    const vigencia = Math.max(30, Math.round((req.expiresAt.getTime() - this.now()) / 1000));
    const body = await this.authed("POST", `qr/${this.kind}/v2/generate`, {
      glosa: req.description.slice(0, 120),
      moneda: req.currency,
      monto: Number(`${Math.trunc(req.amountCents / 100)}.${String(req.amountCents % 100).padStart(2, "0")}`),
      numeroReferencia: req.reference,
      vigencia,
      idEstablecimiento: this.c.establishmentId,
      nombreEstablecimiento: this.c.establishmentName,
      webhook: { url: this.c.webhookUrl, key: this.c.webhookHeader, value: this.c.webhookSecret },
    });
    const data = isRecord(body.data) ? body.data : {};
    const ref = str(data.numeroReferencia);
    const image = str(data.qr);
    if (!ref || !image) throw new ProviderError(this.id, "invalid-response", "generate answered without numeroReferencia or qr");
    if (str(data.estado) === "ERROR") throw new ProviderError(this.id, "rejected", `generate: ${str(data.mensaje) ?? "estado ERROR"}`);
    const exp = str(data.fechaExpiracion);
    // "yyyy-MM-dd'T'HH:mm:ss" without a zone: Bolivia time. If it does not parse, our own computation stands.
    const parsed = exp && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(exp) ? new Date(Date.parse(`${exp}Z`) + 4 * 3_600_000) : null;
    return { providerRef: ref, imageBase64: image, expiresAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(this.now() + vigencia * 1000) };
  }

  async status(providerRef: string): Promise<ProviderStatus> {
    const body = await this.authed("GET", `qr/${this.kind}/v2/verify/${encodeURIComponent(providerRef)}`);
    const data = isRecord(body.data) ? body.data : {};
    const estado = str(data.estado)?.toUpperCase() ?? "";
    const state = STATES[estado];
    if (!state) throw new ProviderError(this.id, "invalid-response", `verify answered an unknown estado «${estado}»`);
    return { state, message: str(data.mensaje), payment: state === "PAID" ? payment(data) : null };
  }

  /**
   * What the webhook body says, normalized. It is never trusted on its own: the gateway confirms
   * with `verify` before marking anything paid.
   */
  static webhookReference(body: unknown): string | null {
    return isRecord(body) ? str(body.numeroReferencia) : null;
  }
}

function payment(d: Record<string, unknown>): ProviderPayment {
  const client = isRecord(d.clienteOrigen) ? d.clienteOrigen : {};
  const bank = isRecord(d.bancoOrigen) ? d.bancoOrigen : {};
  return {
    amountCents: toCents(d.importe ?? d.monto),
    paidAt: str(bank.fechaTransaccion) ?? str(d.fechaHoraTransaccion),
    payerName: str(client.nombreCliente),
    payerBank: str(bank.nombreBanco) ?? str(bank.codigoBanco),
    payerAccount: str(client.numeroCuenta),
    bankReference: str(bank.numeroOrdenAch),
  };
}
