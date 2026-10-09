import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MONITOR_SCHEMA } from "../../src/modules/monitor/domain.ts";
import { signDelivery, WEB_SINK, WebForwarder, type MonitorDelivery } from "../../src/modules/monitor/forwarder.ts";
import { parseRelayerNotification, relayerNotificationToEvent, verifyRelayerSignature } from "../../src/modules/monitor/relayer-webhook.ts";
import { alertsOf, type ResourceSnapshot } from "../../src/modules/monitor/resources.ts";
import { Throttle } from "../../src/modules/monitor/service.ts";
import { silentLogger } from "../../src/shared/log.ts";
import { fakeFetch, monitorHarness } from "../support/monitor-fakes.ts";

test("event log: positions grow, readers page by position and filter by type, source and severity", () => {
  const h = monitorHarness();
  h.monitor.emit({ type: "system.started", summary: "arriba" });
  h.monitor.emit({ type: "vault.disbursement.transition", summary: "REQUESTED → SUBMITTED", subject: "vault_disbursement_1" });
  h.monitor.emit({ type: "vault.disbursement.rejected", severity: "error", summary: "sin fondos" });
  h.monitor.emit({ type: "qr.paid", source: "qr-simple", summary: "depósito" });

  const all = h.monitor.list({});
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(h.monitor.head(), 4);
  assert.match(all[0]!.id, /^evt_[0-9a-f-]{36}$/);
  assert.equal(all[0]!.at, "2026-10-02T12:00:00.000Z");
  assert.deepEqual(h.monitor.list({ after: 2 }).map((e) => e.seq), [3, 4]);
  assert.deepEqual(h.monitor.list({ type: "vault." }).map((e) => e.seq), [2, 3]);
  assert.deepEqual(h.monitor.list({ type: "qr.paid" }).map((e) => e.seq), [4]);
  assert.deepEqual(h.monitor.list({ source: "qr-simple" }).map((e) => e.seq), [4]);
  assert.deepEqual(h.monitor.list({ minSeverity: "warning" }).map((e) => e.seq), [3]);
  // The tail is the end of the log, oldest first.
  assert.deepEqual(h.monitor.tail(2).map((e) => e.seq), [3, 4]);
  assert.equal(h.monitor.latest("vault.disbursement.rejected")?.seq, 3);
});

test("event log: a wildcard in the type filter is taken literally", () => {
  const h = monitorHarness();
  h.monitor.emit({ type: "qr.paid", summary: "x" });
  assert.equal(h.monitor.list({ type: "%." }).length, 0);
  assert.equal(h.monitor.list({ type: "q_." }).length, 0);
});

test("event log: the same dedupe key is stored once", () => {
  const h = monitorHarness();
  assert.ok(h.monitor.record({ type: "relayer.notification", summary: "a", dedupeKey: "relayer:1" }));
  assert.equal(h.monitor.record({ type: "relayer.notification", summary: "a otra vez", dedupeKey: "relayer:1" }), null);
  assert.ok(h.monitor.record({ type: "relayer.notification", summary: "b", dedupeKey: "relayer:2" }));
  // A skipped duplicate may leave a gap in the positions; readers only need them to grow.
  const stored = h.monitor.list({});
  assert.deepEqual(stored.map((e) => e.summary), ["a", "b"]);
  assert.ok(stored[1]!.seq > stored[0]!.seq);
  assert.equal(h.monitor.head(), stored[1]!.seq);
});

test("event log: secrets by name and oversized values never reach the log", () => {
  const h = monitorHarness();
  h.monitor.emit({
    type: "relayer.notification",
    summary: "s".repeat(1000),
    data: { api_key: "k-123", nested: { Authorization: "Bearer abc", accessToken: "t", note: "ok" }, calldata: "0x" + "ab".repeat(4000), units: 10n },
  });
  const e = h.monitor.list({})[0]!;
  assert.equal(e.summary.length, 300);
  assert.equal(e.data.api_key, "[redacted]");
  assert.deepEqual(e.data.nested, { Authorization: "[redacted]", accessToken: "[redacted]", note: "ok" });
  assert.equal((e.data.calldata as string).length, 2001);
  assert.equal(e.data.units, "10");

  h.monitor.emit({ type: "relayer.notification", summary: "enorme", data: { rows: Array.from({ length: 400 }, (_, i) => "x".repeat(100) + i) } });
  assert.equal(h.monitor.list({ after: 1 })[0]!.data.truncated, true);
});

test("event log: emitting never throws, even with the database gone", () => {
  const h = monitorHarness();
  h.db.close();
  assert.doesNotThrow(() => h.monitor.emit({ type: "system.started", summary: "x" }));
  assert.equal(h.monitor.record({ type: "system.started", summary: "x" }), null);
});

test("event log: subscribers hear what this process emits, and old events are pruned", () => {
  const h = monitorHarness();
  const heard: number[] = [];
  const off = h.monitor.subscribe((e) => heard.push(e.seq));
  h.monitor.emit({ type: "system.started", summary: "1" });
  h.clock.advance(10 * 86_400_000);
  h.monitor.emit({ type: "system.started", summary: "2" });
  off();
  h.monitor.emit({ type: "system.started", summary: "3" });
  assert.deepEqual(heard, [1, 2]);
  assert.equal(h.monitor.prune(7), 1);
  assert.deepEqual(h.monitor.list({}).map((e) => e.seq), [2, 3]);
});

test("alerts: an event when a condition appears and another when it goes away, nothing while it lasts", () => {
  const h = monitorHarness();
  const empty = { code: "VAULT_EMPTY", severity: "error" as const, message: "El vault no tiene USDC" };
  h.monitor.setAlerts([empty]);
  h.clock.advance(30_000);
  h.monitor.setAlerts([{ ...empty, message: "El vault sigue sin USDC" }]);
  assert.deepEqual(h.types(), ["alert.raised"]);
  // Still the moment it started, with today's wording.
  assert.deepEqual(h.monitor.alerts(), [{ ...empty, message: "El vault sigue sin USDC", since: "2026-10-02T12:00:00.000Z" }]);

  h.monitor.setAlerts([{ code: "RELAYER_DOWN", severity: "error", message: "relayer caído" }]);
  assert.deepEqual(h.types(), ["alert.raised", "alert.raised", "alert.cleared"]);
  const cleared = h.monitor.list({ type: "alert.cleared" })[0]!;
  assert.equal(cleared.subject, "VAULT_EMPTY");
  assert.equal(cleared.severity, "info");
  h.monitor.setAlerts([]);
  assert.deepEqual(h.monitor.alerts(), []);
});

test("throttle: one pass per window, with the count of what was held back", () => {
  const h = monitorHarness();
  const t = new Throttle(h.clock, 60_000);
  assert.deepEqual(t.pass("a"), { suppressed: 0 });
  assert.equal(t.pass("a"), null);
  assert.equal(t.pass("a"), null);
  assert.deepEqual(t.pass("b"), { suppressed: 0 });
  h.clock.advance(60_000);
  assert.deepEqual(t.pass("a"), { suppressed: 2 });
});

function forwarderHarness() {
  const h = monitorHarness();
  const http = fakeFetch();
  const forwarder = new WebForwarder({
    repo: h.repo,
    url: "https://web.test/api/monitor/events",
    secret: "secreto-compartido-de-prueba",
    origin: { env: "testnet", instance: "host-a" },
    clock: h.clock,
    log: silentLogger,
    fetchImpl: http.impl,
  });
  const sink = () => h.repo.sink(WEB_SINK, h.clock.now().toISOString());
  return { ...h, http, forwarder, sink };
}

test("forwarder: delivers in order, signed, and moves its cursor only when the receiver accepts", async () => {
  const h = forwarderHarness();
  h.monitor.emit({ type: "system.started", summary: "1" });
  h.monitor.emit({ type: "qr.paid", source: "qr-simple", summary: "2" });
  assert.equal(await h.forwarder.tick(), 2);

  const call = h.http.calls[0]!;
  assert.equal(call.url, "https://web.test/api/monitor/events");
  const delivery = JSON.parse(call.body) as MonitorDelivery;
  assert.equal(delivery.schema, MONITOR_SCHEMA);
  assert.deepEqual(delivery.origin, { env: "testnet", instance: "host-a" });
  assert.equal(delivery.head, 2);
  assert.deepEqual(delivery.events.map((e) => e.seq), [1, 2]);
  // What the receiver recomputes: HMAC-SHA256 of "<timestamp>.<body>".
  const timestamp = call.headers["x-tilcai-timestamp"]!;
  assert.equal(timestamp, String(Math.floor(h.clock.now().getTime() / 1000)));
  assert.equal(call.headers["x-tilcai-signature"], `v1=${createHmac("sha256", "secreto-compartido-de-prueba").update(`${timestamp}.${call.body}`).digest("hex")}`);
  assert.equal(call.headers["x-tilcai-signature"], signDelivery("secreto-compartido-de-prueba", timestamp, call.body));
  assert.equal(call.headers["x-tilcai-delivery"], delivery.deliveryId);

  assert.equal(h.sink().lastSeq, 2);
  assert.equal(await h.forwarder.tick(), 0);
  assert.equal(h.http.calls.length, 1);
});

test("forwarder: a receiver that is down gets everything later, after a growing wait", async () => {
  const h = forwarderHarness();
  h.monitor.emit({ type: "system.started", summary: "1" });
  h.http.queue.push({ status: 503, body: { error: "down" } }, new Error("connect ECONNREFUSED"));

  assert.equal(await h.forwarder.tick(), 0);
  assert.equal(h.sink().lastSeq, 0);
  assert.equal(h.sink().attempts, 1);
  assert.match(h.sink().lastError!, /HTTP 503/);
  // Not before its turn.
  h.clock.advance(3000);
  assert.equal(await h.forwarder.tick(), 0);
  assert.equal(h.http.calls.length, 1);

  h.clock.advance(1000);
  assert.equal(await h.forwarder.tick(), 0);
  assert.equal(h.sink().attempts, 2);
  assert.match(h.sink().lastError!, /ECONNREFUSED/);

  h.monitor.emit({ type: "qr.paid", summary: "2" });
  h.clock.advance(8000);
  assert.equal(await h.forwarder.tick(), 2);
  assert.deepEqual((JSON.parse(h.http.calls[2]!.body) as MonitorDelivery).events.map((e) => e.seq), [1, 2]);
  assert.deepEqual({ lastSeq: h.sink().lastSeq, attempts: h.sink().attempts, lastError: h.sink().lastError }, { lastSeq: 2, attempts: 0, lastError: null });
});

test("forwarder: a long backlog drains in batches of 100", async () => {
  const h = forwarderHarness();
  for (let i = 0; i < 230; i++) h.monitor.emit({ type: "qr.created", summary: String(i) });
  assert.equal(await h.forwarder.tick(), 230);
  assert.deepEqual(h.http.calls.map((c) => (JSON.parse(c.body) as MonitorDelivery).events.length), [100, 100, 30]);
});

const sign = (key: string, body: string) => createHmac("sha256", key).update(body).digest("base64");

test("relayer webhook: only the relayer's own signature over the exact body is accepted", () => {
  const body = Buffer.from('{"id":"n-1","event":"transaction_update","payload":{},"timestamp":"t"}');
  assert.equal(verifyRelayerSignature("whsec", body, sign("whsec", body.toString())), true);
  assert.equal(verifyRelayerSignature("whsec", body, sign("otra", body.toString())), false);
  assert.equal(verifyRelayerSignature("whsec", Buffer.from(body.toString().replace("n-1", "n-2")), sign("whsec", body.toString())), false);
  assert.equal(verifyRelayerSignature("whsec", body, undefined), false);
  assert.equal(verifyRelayerSignature("whsec", body, "no es base64 !!"), false);
});

test("relayer webhook: a confirmed EVM transaction points at the payout that sent it", () => {
  const n = parseRelayerNotification({
    id: "5f1c1c9a-0000-4000-8000-000000000001",
    event: "transaction_update",
    timestamp: "2026-10-09T07:00:00+00:00",
    payload: {
      payload_type: "transaction",
      id: "tx-abc",
      hash: "0x9d3fa6b1c2",
      status: "confirmed",
      status_reason: null,
      created_at: "2026-10-09T06:59:50+00:00",
      sent_at: "2026-10-09T06:59:51+00:00",
      confirmed_at: "2026-10-09T06:59:58+00:00",
      from: "0xcc0bbfaffb786c8bb1212c3555b8c6d0b195d6f5",
      to: "0x841dd47db3124839be1d878dd277e1b07d6932b6",
      nonce: 42,
      relayer_id: "avalanche-fuji-relayer",
      data: "0xdeadbeef",
      speed: "fast",
    },
  })!;
  const e = relayerNotificationToEvent(n, (id) => (id === "tx-abc" ? { kind: "vault_disbursement", id: "vault_disbursement_1" } : null));
  assert.equal(e.type, "relayer.transaction_update");
  assert.equal(e.source, "relayer");
  assert.equal(e.severity, "info");
  assert.equal(e.subject, "tx-abc");
  assert.equal(e.dedupeKey, "relayer:5f1c1c9a-0000-4000-8000-000000000001");
  assert.match(e.summary, /avalanche-fuji-relayer: transacción confirmed \(0x9d3fa6b1c2…\)/);
  assert.deepEqual(e.data?.related, { kind: "vault_disbursement", id: "vault_disbursement_1" });
  assert.equal(e.data?.nonce, 42);
  // The calldata stays in the relayer.
  assert.equal("data" in (e.data ?? {}), false);
});

test("relayer webhook: failures and relayer state changes are errors; anything else is kept as it came", () => {
  const failure = relayerNotificationToEvent(
    parseRelayerNotification({
      id: "n-2",
      event: "transaction_update",
      timestamp: "t",
      payload: { payload_type: "transaction_failure", failure_reason: "insufficient funds for gas", transaction: { id: "tx-9", status: "failed", relayer_id: "stellar-example", source_account: "GABC", fee: 100, sequence_number: "77" } },
    })!,
    () => null,
  );
  assert.equal(failure.severity, "error");
  assert.match(failure.summary, /transacción failed — insufficient funds for gas/);
  assert.equal(failure.data?.from, "GABC");
  assert.equal(failure.data?.nonce, "77");

  const disabled = relayerNotificationToEvent(
    parseRelayerNotification({ id: "n-3", event: "relayer_state_update", timestamp: "t", payload: { payload_type: "relayer_disabled", disable_reason: "RPC validation failed", relayer: { id: "avalanche-fuji-relayer", network: "avalanche-fuji-testnet", network_type: "evm" } } })!,
    () => null,
  );
  assert.deepEqual([disabled.type, disabled.severity, disabled.subject], ["relayer.state_update", "error", "avalanche-fuji-relayer"]);
  assert.equal(disabled.data?.enabled, false);

  const enabled = relayerNotificationToEvent(parseRelayerNotification({ id: "n-4", event: "relayer_state_update", timestamp: "t", payload: { payload_type: "relayer_enabled", retry_count: 3, relayer: { id: "stellar-example" } } })!, () => null);
  assert.deepEqual([enabled.type, enabled.severity, enabled.data?.enabled, enabled.data?.retryCount], ["relayer.state_update", "info", true, 3]);

  const other = relayerNotificationToEvent(parseRelayerNotification({ id: "n-5", event: "stellar_dex", timestamp: "t", payload: { payload_type: "stellar_dex", swap_results: [] } })!, () => null);
  assert.equal(other.type, "relayer.notification");

  assert.equal(parseRelayerNotification({ event: "x", payload: {} }), null);
  assert.equal(parseRelayerNotification("texto"), null);
});

function snapshot(over: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    takenAt: "2026-10-09T07:00:00.000Z",
    process: { role: "all", pid: 1, node: "v24", uptimeSeconds: 10, rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, cpuLoad: 0.01, eventLoopDelayMs: { mean: 0, p99: 1, max: 2 } },
    host: { name: "h", cpus: 4, loadAverage: [0, 0, 0], totalMemoryBytes: 1, freeMemoryBytes: 1 },
    database: { path: ":memory:", sizeBytes: null, walBytes: null, crosschainPayments: {}, vaultDisbursements: {}, qrCodes: {}, qrCallbacksPending: 0, monitorEvents: 0 },
    relayer: {
      up: true,
      authenticated: true,
      relayers: [
        { id: "avalanche-fuji-relayer", network: "avalanche-fuji-testnet", networkType: "evm", address: "0xcc", paused: false, systemDisabled: false, balance: "1.01", unit: "AVAX" },
        { id: "stellar-example", network: "testnet", networkType: "stellar", address: "G…", paused: false, systemDisabled: false, balance: "9999.79", unit: "XLM" },
      ],
    },
    vault: { address: "0x841d", paused: false, operatorIsRelayer: true, balance: "250", pending: "0", maxPerDisbursement: "100", dailyLimit: "1000", availableToday: "1000" },
    monitor: { head: 0, sinks: [] },
    alerts: [],
    ...over,
  };
}

test("alerts of a snapshot: a healthy system has none", () => {
  assert.deepEqual(alertsOf(snapshot(), true), []);
});

test("alerts of a snapshot: an empty vault is an error, the one that stopped the payouts unnoticed", () => {
  const codes = (s: ResourceSnapshot, vault = true) => alertsOf(s, vault).map((a) => `${a.severity}:${a.code}`);
  const vault = snapshot().vault!;
  assert.deepEqual(codes(snapshot({ vault: { ...vault, balance: "0" } })), ["error:VAULT_EMPTY"]);
  assert.deepEqual(codes(snapshot({ vault: { ...vault, balance: "5", pending: "12" } })), ["error:VAULT_INSUFFICIENT"]);
  assert.deepEqual(codes(snapshot({ vault: { ...vault, balance: "20" } })), ["warning:VAULT_LOW"]);
  assert.deepEqual(codes(snapshot({ vault: { ...vault, paused: true, operatorIsRelayer: false, availableToday: "0" } })), ["error:VAULT_PAUSED", "error:VAULT_OPERATOR_MISMATCH", "warning:VAULT_DAILY_LIMIT_REACHED"]);
  assert.deepEqual(codes(snapshot({ vault: null, vaultError: "timeout" })), ["warning:VAULT_UNREADABLE"]);
  // No vault configured: nothing to complain about.
  assert.deepEqual(codes(snapshot({ vault: null }), false), []);
});

test("alerts of a snapshot: relayer down, out of gas or disabled, and a dashboard that does not answer", () => {
  const codes = (s: ResourceSnapshot) => alertsOf(s, true).map((a) => `${a.severity}:${a.code}`);
  const relayers = snapshot().relayer.relayers;
  assert.deepEqual(codes(snapshot({ relayer: { up: false, authenticated: false, relayers: [] } })), ["error:RELAYER_DOWN"]);
  assert.deepEqual(codes(snapshot({ relayer: { up: true, authenticated: false, relayers: [] } })), ["warning:RELAYER_UNAUTHENTICATED"]);
  assert.deepEqual(
    codes(snapshot({ relayer: { up: true, authenticated: true, relayers: [{ ...relayers[0]!, balance: "0.01" }, { ...relayers[1]!, paused: true, systemDisabled: true, balance: "2" }] } })),
    ["warning:RELAYER_LOW_GAS:avalanche-fuji-relayer", "error:RELAYER_PAUSED:stellar-example", "error:RELAYER_DISABLED:stellar-example", "warning:RELAYER_LOW_GAS:stellar-example"],
  );
  const sink = { name: "web", lastSeq: 10, attempts: 3, nextAttemptAt: "t", lastError: "HTTP 503", lastDeliveredAt: null, lag: 40 };
  assert.deepEqual(codes(snapshot({ monitor: { head: 50, sinks: [sink] } })), ["warning:MONITOR_SINK_FAILING:web"]);
  assert.deepEqual(codes(snapshot({ monitor: { head: 50, sinks: [{ ...sink, attempts: 2 }] } })), []);
});
