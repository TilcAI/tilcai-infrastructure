import type { DatabaseSync } from "node:sqlite";
import { tx } from "../../db/sqlite.ts";
import type { MonitorAlert, MonitorEvent, MonitorEventType, MonitorSeverity, MonitorSource, SinkGap, SinkState } from "./domain.ts";

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
  /** Deletes what the window allows, in one transaction, and records the gap of every receiver that lost pending events. */
  prune(p: PruneWindow, nowIso: string): PruneResult;
  /** When the first event after `afterSeq` happened: how long a receiver at that cursor has been waiting. */
  oldestPendingAt(afterSeq: number): string | null;
  sink(name: string, nowIso: string): SinkState;
  sinks(): SinkState[];
  /** Saves the cursor and retry state. The gap is left alone: only `prune` sets it and `clearGap` clears it. */
  saveSink(s: SinkState, nowIso: string): void;
  /** Clears the gap once the receiver acknowledged a delivery that carried it. False if it changed meanwhile. */
  clearGap(name: string, told: SinkGap): boolean;
  alerts(): MonitorAlert[];
  /** Replaces the active alerts; returns what appeared and what went away. */
  replaceAlerts(next: MonitorAlert[]): { raised: MonitorAlert[]; cleared: MonitorAlert[] };
}

export interface PruneWindow {
  /** Events up to every configured receiver's cursor go when older than this. */
  deliveredBefore: string;
  /** Anything older than this goes, acknowledged or not. Never later than `deliveredBefore`. */
  pendingBefore: string;
  sinks: readonly string[];
}

export interface PruneResult {
  removed: number;
  /** What this prune took from each receiver before it got it. */
  gaps: Array<SinkGap & { sink: string }>;
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

  prune(p: PruneWindow, nowIso: string): PruneResult {
    return tx(this.db, () => {
      const active = p.sinks.map((name) => this.sink(name, nowIso));
      // What every configured receiver has acknowledged. With none configured, nothing is pending.
      const floor = active.length ? Math.min(...active.map((s) => s.lastSeq)) : Number.MAX_SAFE_INTEGER;
      const gaps: PruneResult["gaps"] = [];
      for (const s of active) {
        const lost = this.db
          .prepare("SELECT MIN(seq) AS fromSeq, MAX(seq) AS toSeq, COUNT(*) AS n FROM monitor_events WHERE at < ? AND seq > ?")
          .get(p.pendingBefore, s.lastSeq) as { fromSeq: number | null; toSeq: number | null; n: number };
        if (!Number(lost.n)) continue;
        const now: SinkGap = { fromSeq: Number(lost.fromSeq), toSeq: Number(lost.toSeq), count: Number(lost.n), prunedAt: nowIso };
        // A gap the receiver has not been told about yet grows instead of being replaced.
        const merged: SinkGap = s.gap
          ? { fromSeq: Math.min(s.gap.fromSeq, now.fromSeq), toSeq: Math.max(s.gap.toSeq, now.toSeq), count: s.gap.count + now.count, prunedAt: nowIso }
          : now;
        this.db.prepare("UPDATE monitor_sinks SET gap_json = ?, updated_at = ? WHERE name = ?").run(JSON.stringify(merged), nowIso, s.name);
        gaps.push({ sink: s.name, ...now });
      }
      const removed = this.db
        .prepare("DELETE FROM monitor_events WHERE at < ? AND (seq <= ? OR at < ?)")
        .run(p.deliveredBefore, floor, p.pendingBefore).changes;
      return { removed: Number(removed), gaps };
    });
  }

  oldestPendingAt(afterSeq: number): string | null {
    const r = this.db.prepare("SELECT at FROM monitor_events WHERE seq > ? ORDER BY seq LIMIT 1").get(afterSeq) as { at: string } | undefined;
    return r?.at ?? null;
  }

  clearGap(name: string, told: SinkGap): boolean {
    // Only the gap that was sent: one that grew meanwhile still has to reach the receiver.
    return Number(this.db.prepare("UPDATE monitor_sinks SET gap_json = NULL WHERE name = ? AND gap_json = ?").run(name, JSON.stringify(told)).changes) === 1;
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
    gap: r.gap_json ? (JSON.parse(r.gap_json) as SinkGap) : null,
  };
}
