/**
 * Monitoring events: what the dashboard in tilcai-web shows and interprets.
 *
 * The wire contract is `tilcai-monitor-v1`. tilcai-web keeps a copy of these types
 * (src/lib/monitor/contract.ts): a new type or field goes to both sides.
 */
import type { MonitorEventType, MonitorSource, MonitorSeverity } from "tilcai-core/monitor";
export * from "tilcai-core/monitor";
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
