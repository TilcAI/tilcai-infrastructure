/**
 * Monitoring events: what the dashboard in tilcai-web shows and interprets.
 *
 * The wire contract is `tilcai-monitor-v1`. tilcai-web keeps a copy of these types
 * (src/lib/monitor/contract.ts): a new type or field goes to both sides.
 */
import { MONITOR_EVENT_TYPES as CORE_MONITOR_EVENT_TYPES, type MonitorSource, type MonitorSeverity } from "tilcai-core/monitor";
export * from "tilcai-core/monitor";

/**
 * The event types of tilcai-core/monitor plus the ones this backend emits before Core carries them.
 * `monitor.gap` (N-11): events a receiver never got were pruned past MONITOR_PENDING_MAX_DAYS, the loss made
 * explicit. It belongs in tilcai-core/monitor: add it there in the next Core release and drop this extension.
 * These local declarations take precedence over the same names from `export *`.
 */
export const MONITOR_EVENT_TYPES = [...CORE_MONITOR_EVENT_TYPES, "monitor.gap"] as const;
export type MonitorEventType = (typeof MONITOR_EVENT_TYPES)[number];

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
  /** Pending events of this receiver that were pruned and it has not been told about yet. */
  gap: SinkGap | null;
}

/** Positions a receiver will never get. `count` is exact; the range may hold events it did get. */
export interface SinkGap {
  fromSeq: number;
  toSeq: number;
  count: number;
  /** When the last of them was pruned. */
  prunedAt: string;
}

/**
 * What a prune may delete. Delivered events go after `retentionDays`. Events a configured receiver
 * has not acknowledged are kept for up to `pendingMaxDays`; past that they go too, and the receiver
 * gets a gap instead of a silent loss.
 */
export interface RetentionPolicy {
  retentionDays: number;
  pendingMaxDays: number;
  /** The receivers configured now. A sink left in the table but no longer configured protects nothing. */
  sinks: readonly string[];
}
