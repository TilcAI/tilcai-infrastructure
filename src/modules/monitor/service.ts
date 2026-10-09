import { randomUUID } from "node:crypto";
import { iso, type Clock } from "../../shared/clock.ts";
import type { Logger } from "../../shared/log.ts";
import type { EventSink, MonitorAlert, MonitorEvent, MonitorEventType, NewMonitorEvent } from "./domain.ts";
import type { EventQuery, MonitorRepository } from "./repository.ts";

/** Nothing bigger than this goes into an event: the dashboard gets facts, not payloads. */
const MAX_DATA_BYTES = 16 * 1024;

/**
 * The event log behind the dashboard. Services call `emit`; readers (the API, the forwarder
 * to tilcai-web) follow the log by `seq`.
 *
 * Emitting must never break what is being monitored: a failure to store an event is logged
 * and swallowed.
 */
export class MonitorService implements EventSink {
  private readonly listeners = new Set<(e: MonitorEvent) => void>();

  constructor(
    private readonly repo: MonitorRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  emit(input: NewMonitorEvent): void {
    this.record(input);
  }

  /** Like `emit`, but tells the caller what was stored (null = duplicate or failure). */
  record(input: NewMonitorEvent): MonitorEvent | null {
    try {
      const data = sanitize(input.data ?? {});
      const event = this.repo.append(
        {
          id: `evt_${randomUUID()}`,
          type: input.type,
          source: input.source ?? "tilcai",
          severity: input.severity ?? "info",
          subject: input.subject ?? null,
          summary: input.summary.slice(0, 300),
          data,
          at: iso(this.clock.now()),
        },
        input.dedupeKey,
      );
      if (event) for (const l of this.listeners) l(event);
      return event;
    } catch (e) {
      this.log.warn("monitor event not stored", { type: input.type, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  /** Called for events emitted by this process (others are found by polling `list`). */
  subscribe(listener: (e: MonitorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(q: EventQuery): MonitorEvent[] {
    return this.repo.list(q);
  }

  tail(limit: number, q?: Omit<EventQuery, "after" | "limit">): MonitorEvent[] {
    return this.repo.tail(limit, q);
  }

  latest(type: MonitorEventType): MonitorEvent | undefined {
    return this.repo.latest(type);
  }

  head(): number {
    return this.repo.head();
  }

  alerts(): MonitorAlert[] {
    return this.repo.alerts();
  }

  /** Sets what is wrong right now and emits an event for every change. */
  setAlerts(next: Array<Omit<MonitorAlert, "since">>): void {
    const now = iso(this.clock.now());
    const { raised, cleared } = this.repo.replaceAlerts(next.map((a) => ({ ...a, since: now })));
    for (const a of raised) {
      this.emit({ type: "alert.raised", severity: a.severity, subject: a.code, summary: a.message, data: { code: a.code } });
    }
    for (const a of cleared) {
      this.emit({ type: "alert.cleared", subject: a.code, summary: `Resuelto: ${a.message}`, data: { code: a.code, since: a.since } });
    }
  }

  prune(retentionDays: number): number {
    return this.repo.prune(iso(new Date(this.clock.now().getTime() - retentionDays * 86_400_000)));
  }
}

/** JSON-safe copy without secrets by name and without oversized values. */
function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(data, (key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (/(secret|password|private|authorization|api[_-]?key|token|signature)$/i.test(key) && typeof value === "string") return "[redacted]";
    if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}…`;
    return value;
  });
  if (Buffer.byteLength(text) > MAX_DATA_BYTES) return { truncated: true, preview: text.slice(0, 2000) };
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Lets a noisy condition through once per window and counts what it held back, so a caller
 * that repeats the same failing request cannot fill the log.
 */
export class Throttle {
  private readonly seen = new Map<string, { at: number; suppressed: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 500,
  ) {}

  /** Null = keep quiet. Otherwise how many identical ones were skipped since the last pass. */
  pass(key: string): { suppressed: number } | null {
    const now = this.clock.now().getTime();
    const entry = this.seen.get(key);
    if (entry && now - entry.at < this.windowMs) {
      entry.suppressed++;
      return null;
    }
    if (!entry && this.seen.size >= this.maxKeys) {
      for (const [k, v] of this.seen) if (now - v.at >= this.windowMs) this.seen.delete(k);
      if (this.seen.size >= this.maxKeys) return null;
    }
    this.seen.set(key, { at: now, suppressed: 0 });
    return { suppressed: entry?.suppressed ?? 0 };
  }
}
