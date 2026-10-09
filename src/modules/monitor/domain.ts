/**
 * Monitoring events: what the dashboard in tilcai-web shows and interprets.
 *
 * The wire contract is `tilcai-monitor-v1`. tilcai-web keeps a copy of these types
 * (src/lib/monitor/contract.ts): a new type or field goes to both sides.
 */
export const MONITOR_SCHEMA = "tilcai-monitor-v1";

/** Who the event is about: TilcAI itself, the OpenZeppelin Relayer or the QR Simple mock. */
export const MONITOR_SOURCES = ["tilcai", "relayer", "qr-simple"] as const;
export type MonitorSource = (typeof MONITOR_SOURCES)[number];

export const MONITOR_SEVERITIES = ["info", "warning", "error"] as const;
export type MonitorSeverity = (typeof MONITOR_SEVERITIES)[number];

/** Every event type TilcAI emits. The prefix before the first dot is the dashboard's category. */
export const MONITOR_EVENT_TYPES = [
  "system.started", // a process came up (role: all | api | worker)
  "system.stopping", // a process is shutting down on a signal
  "resources.snapshot", // periodic picture of the process, database, queues, relayer and vault
  "alert.raised", // a condition became wrong (see resources.ts for the codes)
  "alert.cleared", // …and it is fine again
  "api.request_rejected", // the API answered with an operational error (5xx, vault refusals)
  "crosschain.payment.transition", // a CCTP payment changed state (from = null when created)
  "crosschain.payment.uncertain", // a payment needs reconciliation before anyone trusts it
  "vault.disbursement.transition", // a vault payout changed state (from = null when created)
  "vault.disbursement.uncertain", // a relayer call ended without an answer
  "vault.disbursement.rejected", // the vault could not take a payout (no funds, paused, limits)
  "relayer.transaction_update", // webhook: a relayer transaction moved (sent, mined, failed…)
  "relayer.state_update", // webhook: a relayer was disabled or enabled again
  "relayer.notification", // webhook: any other notification, kept as it came
  "qr.token_issued", // mock: a caller logged in
  "qr.created", // mock: a QR was generated
  "qr.paid", // mock: someone pressed "Simular depósito"
  "qr.expired", // mock: a QR ran out of time without being paid
  "qr.callback_delivered", // mock: the caller acknowledged the payment notification
  "qr.callback_failed", // mock: the notification could not be delivered (retried up to 3 times)
] as const;
export type MonitorEventType = (typeof MONITOR_EVENT_TYPES)[number];

export interface MonitorEvent {
  /** Position in TilcAI's log: strictly increasing, the cursor of every reader. */
  seq: number;
  id: string;
  type: MonitorEventType;
  source: MonitorSource;
  severity: MonitorSeverity;
  /** The entity the event is about (a payment, a payout, a relayer transaction, a QR). */
  subject: string | null;
  /** One line a person can read without opening `data`. */
  summary: string;
  data: Record<string, unknown>;
  at: string;
}

export interface NewMonitorEvent {
  type: MonitorEventType;
  source?: MonitorSource;
  severity?: MonitorSeverity;
  subject?: string | null;
  summary: string;
  data?: Record<string, unknown>;
  /** Same key twice → stored once. */
  dedupeKey?: string;
}

/** What the services see: emitting never throws and never slows a payment down. */
export interface EventSink {
  emit(event: NewMonitorEvent): void;
}

export const noEvents: EventSink = { emit() {} };

export interface MonitorAlert {
  code: string;
  severity: Exclude<MonitorSeverity, "info">;
  message: string;
  since: string;
}

export interface SinkState {
  name: string;
  lastSeq: number;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  lastDeliveredAt: string | null;
}
