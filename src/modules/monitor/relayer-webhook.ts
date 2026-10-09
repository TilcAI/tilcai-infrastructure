import { createHmac, timingSafeEqual } from "node:crypto";
import type { NewMonitorEvent } from "./domain.ts";

/**
 * Notifications of the OpenZeppelin Relayer (1.8.x, `src/models/notification/webhook_notification.rs`).
 * The relayer POSTs `{id, event, payload, timestamp}` and, when the notification has a signing
 * key, an `X-Signature` header: base64(HMAC-SHA256(key, body)).
 *
 * They are shown on the dashboard and never decide anything: a payment or a payout only
 * settles when TilcAI has checked the chain itself.
 */
export interface RelayerNotification {
  id: string;
  event: string;
  timestamp: string;
  payload: Record<string, unknown> & { payload_type?: string };
}

export function verifyRelayerSignature(signingKey: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", signingKey).update(rawBody).digest();
  const given = Buffer.from(signature, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function parseRelayerNotification(body: unknown): RelayerNotification | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || typeof b.event !== "string" || !b.payload || typeof b.payload !== "object") return null;
  return {
    id: b.id.slice(0, 80),
    event: b.event.slice(0, 80),
    timestamp: typeof b.timestamp === "string" ? b.timestamp : "",
    payload: b.payload as RelayerNotification["payload"],
  };
}

/** What TilcAI was doing with a relayer transaction, if it sent it. */
export type Correlate = (relayerTxId: string) => { kind: string; id: string } | null;

const FAILED = new Set(["failed", "expired", "canceled"]);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function relayerNotificationToEvent(n: RelayerNotification, correlate: Correlate): NewMonitorEvent {
  const base = { source: "relayer" as const, dedupeKey: `relayer:${n.id}` };
  const type = n.payload.payload_type;
  const tx = type === "transaction_failure" ? (n.payload.transaction as Record<string, unknown> | undefined) : n.payload;

  if ((type === "transaction" || type === "transaction_failure") && tx && typeof tx.id === "string") {
    const status = String(tx.status ?? "unknown").toLowerCase();
    const failed = FAILED.has(status) || type === "transaction_failure";
    const relayerId = str(tx.relayer_id);
    const hash = str(tx.hash);
    const reason = str(n.payload.failure_reason) ?? str(tx.status_reason);
    const related = correlate(tx.id);
    return {
      ...base,
      type: "relayer.transaction_update",
      severity: failed ? "error" : "info",
      subject: tx.id,
      summary: `Relayer ${relayerId ?? "?"}: transacción ${status}${hash ? ` (${hash.slice(0, 12)}…)` : ""}${failed && reason ? ` — ${reason}` : ""}`,
      data: {
        notificationId: n.id,
        relayerId,
        transactionId: tx.id,
        status,
        statusReason: reason,
        hash,
        // EVM transactions carry from/to/nonce; Stellar ones the source account and fee.
        from: str(tx.from) ?? str(tx.source_account),
        to: str(tx.to),
        nonce: tx.nonce ?? tx.sequence_number ?? null,
        fee: tx.fee ?? null,
        speed: str(tx.speed),
        createdAt: str(tx.created_at),
        sentAt: str(tx.sent_at),
        confirmedAt: str(tx.confirmed_at),
        related,
        relayerTimestamp: n.timestamp,
      },
    };
  }

  if (type === "relayer_disabled" || type === "relayer_enabled") {
    const relayer = (n.payload.relayer ?? {}) as Record<string, unknown>;
    const disabled = type === "relayer_disabled";
    const reason = disabled ? str(n.payload.disable_reason) : null;
    return {
      ...base,
      type: "relayer.state_update",
      severity: disabled ? "error" : "info",
      subject: str(relayer.id),
      summary: disabled ? `Relayer ${str(relayer.id) ?? "?"} deshabilitado${reason ? `: ${reason}` : ""}` : `Relayer ${str(relayer.id) ?? "?"} habilitado de nuevo`,
      data: {
        notificationId: n.id,
        relayerId: str(relayer.id),
        network: str(relayer.network),
        networkType: str(relayer.network_type),
        address: str(relayer.address),
        enabled: !disabled,
        reason,
        retryCount: n.payload.retry_count ?? null,
        relayerTimestamp: n.timestamp,
      },
    };
  }

  return {
    ...base,
    type: "relayer.notification",
    subject: n.id,
    summary: `Relayer: ${n.event}${type ? ` (${type})` : ""}`,
    data: { notificationId: n.id, event: n.event, payloadType: type ?? null, payload: n.payload, relayerTimestamp: n.timestamp },
  };
}
