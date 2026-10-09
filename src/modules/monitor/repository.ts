import type { DatabaseSync } from "node:sqlite";
import { tx } from "../../db/sqlite.ts";
import type { MonitorAlert, MonitorEvent, MonitorEventType, MonitorSeverity, MonitorSource, SinkState } from "./domain.ts";

export interface EventQuery {
  /** Only events after this position. */
  after?: number;
  limit?: number;
  /** Exact type or a prefix ending in a dot ("vault."). */
  type?: string;
  source?: MonitorSource;
  minSeverity?: MonitorSeverity;
}

export interface MonitorRepository {
  /** Appends the event. Returns null when its dedupe key was already stored. */
  append(e: Omit<MonitorEvent, "seq">, dedupeKey?: string): MonitorEvent | null;
  list(q: EventQuery): MonitorEvent[];
  /** The newest events first-to-last (a page that ends at the head of the log). */
  tail(limit: number, q?: Omit<EventQuery, "after" | "limit">): MonitorEvent[];
  latest(type: MonitorEventType): MonitorEvent | undefined;
  head(): number;
  count(): number;
  prune(beforeIso: string): number;
  sink(name: string, nowIso: string): SinkState;
  sinks(): SinkState[];
  saveSink(s: SinkState, nowIso: string): void;
  alerts(): MonitorAlert[];
  /** Replaces the active alerts; returns what appeared and what went away. */
  replaceAlerts(next: MonitorAlert[]): { raised: MonitorAlert[]; cleared: MonitorAlert[] };
}

const SEVERITY_RANK: Record<MonitorSeverity, number> = { info: 0, warning: 1, error: 2 };
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export class SqliteMonitorRepository implements MonitorRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(e: Omit<MonitorEvent, "seq">, dedupeKey?: string): MonitorEvent | null {
    const res = this.db
      .prepare(
        `INSERT INTO monitor_events (id, type, source, severity, subject, summary, data_json, dedupe_key, at)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .run(e.id, e.type, e.source, e.severity, e.subject, e.summary, json(e.data), dedupeKey ?? null, e.at);
    if (Number(res.changes) !== 1) return null;
    return { ...e, seq: Number(res.lastInsertRowid) };
  }

  list(q: EventQuery): MonitorEvent[] {
    const { where, args } = filters(q);
    const rows = this.db
      .prepare(`SELECT * FROM monitor_events WHERE seq > ? ${where} ORDER BY seq LIMIT ?`)
      .all(q.after ?? 0, ...args, clampLimit(q.limit));
    return rows.map(toEvent);
  }

  tail(limit: number, q: Omit<EventQuery, "after" | "limit"> = {}): MonitorEvent[] {
    const { where, args } = filters(q);
    const rows = this.db
      .prepare(`SELECT * FROM monitor_events WHERE 1=1 ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...args, clampLimit(limit));
    return rows.map(toEvent).reverse();
  }

  latest(type: MonitorEventType): MonitorEvent | undefined {
    const r = this.db.prepare("SELECT * FROM monitor_events WHERE type = ? ORDER BY seq DESC LIMIT 1").get(type);
    return r ? toEvent(r) : undefined;
  }

  head(): number {
    const r = this.db.prepare("SELECT MAX(seq) AS head FROM monitor_events").get() as { head: number | null };
    return r.head ?? 0;
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM monitor_events").get() as { n: number }).n);
  }

  prune(beforeIso: string): number {
    return Number(this.db.prepare("DELETE FROM monitor_events WHERE at < ?").run(beforeIso).changes);
  }

  sink(name: string, nowIso: string): SinkState {
    this.db
      .prepare("INSERT INTO monitor_sinks (name, next_attempt_at, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING")
      .run(name, nowIso, nowIso);
    return toSink(this.db.prepare("SELECT * FROM monitor_sinks WHERE name = ?").get(name) as Record<string, any>);
  }

  sinks(): SinkState[] {
    return (this.db.prepare("SELECT * FROM monitor_sinks ORDER BY name").all() as Array<Record<string, any>>).map(toSink);
  }

  saveSink(s: SinkState, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE monitor_sinks SET last_seq=?, attempts=?, next_attempt_at=?, last_error=?, last_delivered_at=?, updated_at=?
         WHERE name=?`,
      )
      .run(s.lastSeq, s.attempts, s.nextAttemptAt, s.lastError, s.lastDeliveredAt, nowIso, s.name);
  }

  alerts(): MonitorAlert[] {
    return (this.db.prepare("SELECT * FROM monitor_alerts ORDER BY since, code").all() as Array<Record<string, any>>).map((r) => ({
      code: r.code,
      severity: r.severity,
      message: r.message,
      since: r.since,
    }));
  }

  replaceAlerts(next: MonitorAlert[]): { raised: MonitorAlert[]; cleared: MonitorAlert[] } {
    return tx(this.db, () => {
      const before = new Map(this.alerts().map((a) => [a.code, a]));
      const now = new Map(next.map((a) => [a.code, a]));
      const raised = next.filter((a) => !before.has(a.code));
      const cleared = [...before.values()].filter((a) => !now.has(a.code));
      for (const a of cleared) this.db.prepare("DELETE FROM monitor_alerts WHERE code = ?").run(a.code);
      for (const a of raised) {
        this.db.prepare("INSERT INTO monitor_alerts (code, severity, message, since) VALUES (?,?,?,?)").run(a.code, a.severity, a.message, a.since);
      }
      // A condition that persists keeps the moment it started but shows today's numbers.
      for (const a of next) {
        if (before.has(a.code)) this.db.prepare("UPDATE monitor_alerts SET severity=?, message=? WHERE code=?").run(a.severity, a.message, a.code);
      }
      return { raised, cleared };
    });
  }
}

function filters(q: Omit<EventQuery, "after" | "limit">): { where: string; args: Array<string | number> } {
  const parts: string[] = [];
  const args: Array<string | number> = [];
  if (q.type) {
    if (q.type.endsWith(".")) {
      parts.push("AND type LIKE ? ESCAPE '\\'");
      args.push(`${q.type.replace(/[\\%_]/g, "\\$&")}%`);
    } else {
      parts.push("AND type = ?");
      args.push(q.type);
    }
  }
  if (q.source) {
    parts.push("AND source = ?");
    args.push(q.source);
  }
  if (q.minSeverity && q.minSeverity !== "info") {
    const allowed = (Object.keys(SEVERITY_RANK) as MonitorSeverity[]).filter((s) => SEVERITY_RANK[s] >= SEVERITY_RANK[q.minSeverity!]);
    parts.push(`AND severity IN (${allowed.map(() => "?").join(",")})`);
    args.push(...allowed);
  }
  return { where: parts.join(" "), args };
}

const clampLimit = (n: number | undefined) => Math.min(Math.max(Math.trunc(n ?? 100), 1), 500);

function toEvent(r: unknown): MonitorEvent {
  const row = r as Record<string, any>;
  return {
    seq: Number(row.seq),
    id: row.id,
    type: row.type,
    source: row.source,
    severity: row.severity,
    subject: row.subject,
    summary: row.summary,
    data: JSON.parse(row.data_json),
    at: row.at,
  };
}

function toSink(r: Record<string, any>): SinkState {
  return {
    name: r.name,
    lastSeq: Number(r.last_seq),
    attempts: Number(r.attempts),
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    lastDeliveredAt: r.last_delivered_at,
  };
}
