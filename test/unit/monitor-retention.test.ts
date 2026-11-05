import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadEnv } from "../../src/config/env.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import type { RetentionPolicy } from "../../src/modules/monitor/domain.ts";
import { WEB_SINK, WebForwarder, type MonitorDelivery } from "../../src/modules/monitor/forwarder.ts";
import { SqliteMonitorRepository } from "../../src/modules/monitor/repository.ts";
import { MonitorService } from "../../src/modules/monitor/service.ts";
import { silentLogger } from "../../src/shared/log.ts";
import { FakeClock } from "../support/fakes.ts";
import { fakeFetch } from "../support/monitor-fakes.ts";
import { tempDir } from "../support/sca.ts";

const DAY = 86_400_000;
const POLICY: RetentionPolicy = { retentionDays: 14, pendingMaxDays: 90, sinks: [WEB_SINK] };

/**
 * The event log on a database file, as a process would open it, with the clock and the receiver in the
 * test's hands. `restart` opens the same file again with a new process's objects.
 */
function logOnFile(path: string, clock: FakeClock, http: ReturnType<typeof receiver>) {
  const db = openDatabase(path);
  const repo = new SqliteMonitorRepository(db);
  const monitor = new MonitorService(repo, clock, silentLogger);
  const forwarder = new WebForwarder({ repo, url: "https://web.test/api/monitor/events", secret: "secreto-compartido-de-prueba", origin: { env: "testnet", instance: "host-a" }, clock, log: silentLogger, fetchImpl: http.impl });
  const sink = () => repo.sink(WEB_SINK, clock.now().toISOString());
  const deliveries = () => http.calls.map((c) => JSON.parse(c.body) as MonitorDelivery);
  /** What the receiver took: the calls it answered, not the ones made while it was down. */
  const delivered = () => deliveries().filter((_, i) => !http.failed.has(i)).flatMap((d) => d.events.map((e) => e.seq));
  const stored = () => monitor.list({ limit: 500 }).map((e) => e.seq);
  /** Lets the forwarder's backoff pass and delivers what is pending. */
  const drain = async () => {
    clock.advance(10 * 60_000);
    return forwarder.tick();
  };
  return { db, repo, monitor, forwarder, sink, deliveries, delivered, stored, drain };
}

/** A receiver that answers what the test says: `down` makes every call fail until set back. */
function receiver() {
  const http = fakeFetch() as ReturnType<typeof fakeFetch> & { failed: Set<number>; down: boolean };
  http.failed = new Set();
  http.down = false;
  const ok = http.impl;
  http.impl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!http.down) return ok(url, init);
    http.failed.add(http.calls.length);
    http.calls.push({ url: String(url), headers: {}, body: String(init?.body ?? "") });
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;
  return http;
}

test("retention: a receiver down longer than the retention gets every pending event after a restart", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "tilcai.db");
    const clock = new FakeClock();
    const http = receiver();
    const first = logOnFile(path, clock, http);
    first.monitor.emit({ type: "system.started", summary: "1" });
    first.monitor.emit({ type: "system.started", summary: "2" });
    assert.equal(await first.drain(), 2);
    http.down = true;
    first.monitor.emit({ type: "qr.paid", summary: "3, pending" });
    await first.drain();
    clock.advance(20 * DAY);
    first.monitor.emit({ type: "qr.paid", summary: "4, pending" });
    // 1 and 2 were delivered and are old: they go. 3 is old too, but the receiver never got it.
    assert.equal(first.monitor.prune(POLICY), 2);
    assert.deepEqual(first.stored(), [3, 4]);
    first.db.close();

    const second = logOnFile(path, clock, http);
    assert.equal(second.monitor.prune(POLICY), 0, "a restart keeps what is pending");
    http.down = false;
    assert.equal(await second.drain(), 2);
    assert.deepEqual(second.delivered(), [1, 2, 3, 4], "nothing the receiver lacked was lost");
    assert.equal(second.sink().lastSeq, 4);
    // Delivered now, and old: the next prune takes 3.
    assert.equal(second.monitor.prune(POLICY), 1);
    assert.deepEqual(second.stored(), [4]);
    second.db.close();
  } finally {
    cleanup();
  }
});

test("retention: past MONITOR_PENDING_MAX_DAYS the pending events go, and the receiver is told the exact gap, never a silent success", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const clock = new FakeClock();
    const http = receiver();
    const log = logOnFile(join(dir, "tilcai.db"), clock, http);
    log.monitor.emit({ type: "system.started", summary: "1" });
    await log.drain();
    http.down = true;
    for (let i = 0; i < 3; i++) log.monitor.emit({ type: "qr.paid", summary: `${i + 2}, pending` });
    await log.drain();
    clock.advance(91 * DAY);
    log.monitor.emit({ type: "qr.paid", summary: "5, pending but recent" });

    assert.equal(log.monitor.prune(POLICY), 4);
    const gapEvent = log.monitor.list({ type: "monitor.gap" })[0]!;
    assert.equal(gapEvent.severity, "error");
    assert.deepEqual(gapEvent.data, { sink: WEB_SINK, fromSeq: 2, toSeq: 4, count: 3, pendingMaxDays: 90 });
    assert.deepEqual(log.sink().gap, { fromSeq: 2, toSeq: 4, count: 3, prunedAt: clock.now().toISOString() });

    // Still down: the gap waits with the events.
    await log.drain();
    assert.ok(log.sink().gap);

    http.down = false;
    await log.drain();
    const last = log.deliveries().at(-1)!;
    assert.deepEqual(last.gap, { fromSeq: 2, toSeq: 4, count: 3, prunedAt: gapEvent.at });
    assert.deepEqual(last.events.map((e) => e.seq), [5, gapEvent.seq], "what survived, and the gap event in its place in the log");
    assert.equal(log.sink().gap, null, "told once it acknowledged");
    log.monitor.emit({ type: "qr.paid", summary: "after" });
    await log.drain();
    assert.equal(log.deliveries().at(-1)!.gap, undefined);
    log.db.close();
  } finally {
    cleanup();
  }
});

test("retention: two gaps before the receiver hears of them add up; a 5xx keeps the gap for the next delivery", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const clock = new FakeClock();
    const http = receiver();
    const log = logOnFile(join(dir, "tilcai.db"), clock, http);
    http.down = true;
    log.monitor.emit({ type: "qr.paid", summary: "1" });
    await log.drain();
    clock.advance(91 * DAY);
    log.monitor.prune(POLICY);
    log.monitor.emit({ type: "qr.paid", summary: "3" });
    clock.advance(91 * DAY);
    log.monitor.prune(POLICY);
    // Events 1 and 3 lost (2 is the first gap event, gone with them); the second gap event survives.
    assert.deepEqual({ ...log.sink().gap, prunedAt: undefined }, { fromSeq: 1, toSeq: 3, count: 3, prunedAt: undefined });

    http.down = false;
    http.queue.push({ status: 503, body: { error: "busy" } });
    await log.drain();
    assert.ok(log.sink().gap, "a refused delivery did not tell the receiver");
    await log.drain();
    assert.equal(log.deliveries().at(-1)!.gap!.count, 3);
    assert.equal(log.sink().gap, null);
    log.db.close();
  } finally {
    cleanup();
  }
});

test("retention: a gap that grows while a delivery is in flight is not cleared by it", async () => {
  const clock = new FakeClock();
  const db = openDatabase(":memory:");
  const repo = new SqliteMonitorRepository(db);
  const monitor = new MonitorService(repo, clock, silentLogger);
  monitor.emit({ type: "qr.paid", summary: "1" });
  clock.advance(91 * DAY);
  monitor.prune(POLICY);
  const sent = repo.sink(WEB_SINK, clock.now().toISOString()).gap!;
  // Meanwhile the hourly prune takes more.
  monitor.emit({ type: "qr.paid", summary: "3" });
  clock.advance(91 * DAY);
  monitor.prune(POLICY);
  assert.equal(repo.clearGap(WEB_SINK, sent), false);
  assert.equal(repo.sink(WEB_SINK, clock.now().toISOString()).gap!.count, 3);
  db.close();
});

test("retention: the floor is the slowest configured receiver; one no longer configured protects nothing", async () => {
  const clock = new FakeClock();
  const db = openDatabase(":memory:");
  const repo = new SqliteMonitorRepository(db);
  const monitor = new MonitorService(repo, clock, silentLogger);
  for (let i = 0; i < 6; i++) monitor.emit({ type: "qr.paid", summary: String(i + 1) });
  const now = () => clock.now().toISOString();
  repo.saveSink({ ...repo.sink("web", now()), lastSeq: 5 }, now());
  repo.saveSink({ ...repo.sink("archive", now()), lastSeq: 2 }, now());
  repo.saveSink({ ...repo.sink("retired", now()), lastSeq: 0 }, now());
  clock.advance(20 * DAY);

  assert.equal(monitor.prune({ ...POLICY, sinks: ["web", "archive"] }), 2, "up to the slowest cursor, 2");
  assert.deepEqual(monitor.list({}).map((e) => e.seq), [3, 4, 5, 6]);
  // Each receiver still gets what it lacks, and only that.
  assert.deepEqual(monitor.list({ after: repo.sink("web", now()).lastSeq }).map((e) => e.seq), [6]);
  assert.deepEqual(monitor.list({ after: repo.sink("archive", now()).lastSeq }).map((e) => e.seq), [3, 4, 5, 6]);
  assert.equal(repo.sink("retired", now()).gap, null, "a sink that is not configured is not told about losses either");

  assert.equal(monitor.prune({ ...POLICY, sinks: [] }), 4, "with no receiver configured, the retention alone decides");
  db.close();
});

test("retention: how long the oldest pending event has waited is readable for the alert", () => {
  const clock = new FakeClock();
  const db = openDatabase(":memory:");
  const repo = new SqliteMonitorRepository(db);
  const monitor = new MonitorService(repo, clock, silentLogger);
  monitor.emit({ type: "qr.paid", summary: "1" });
  const first = clock.now().toISOString();
  clock.advance(DAY);
  monitor.emit({ type: "qr.paid", summary: "2" });
  assert.equal(repo.oldestPendingAt(0), first);
  assert.equal(repo.oldestPendingAt(1), clock.now().toISOString());
  assert.equal(repo.oldestPendingAt(2), null);
  db.close();
});

test("retention: MONITOR_PENDING_MAX_DAYS cannot be shorter than the retention", () => {
  assert.equal(loadEnv({}).MONITOR_PENDING_MAX_DAYS, 90);
  assert.throws(() => loadEnv({ MONITOR_RETENTION_DAYS: "30", MONITOR_PENDING_MAX_DAYS: "20" }), /MONITOR_PENDING_MAX_DAYS/);
  assert.equal(loadEnv({ MONITOR_RETENTION_DAYS: "30", MONITOR_PENDING_MAX_DAYS: "30" }).MONITOR_PENDING_MAX_DAYS, 30);
});
