import { openDatabase } from "../../src/db/sqlite.ts";
import { silentLogger } from "../../src/shared/log.ts";
import type { MonitorEvent, NewMonitorEvent } from "../../src/modules/monitor/domain.ts";
import { SqliteMonitorRepository } from "../../src/modules/monitor/repository.ts";
import { MonitorService } from "../../src/modules/monitor/service.ts";
import { SqliteQrMockRepository } from "../../src/modules/qrsimple/repository.ts";
import { QrSimpleMock, type QrMockConfig } from "../../src/modules/qrsimple/service.ts";
import { FakeClock } from "./fakes.ts";

/** A real event log over an in-memory database, with the clock in the test's hands. */
export function monitorHarness() {
  const db = openDatabase(":memory:");
  const clock = new FakeClock();
  const repo = new SqliteMonitorRepository(db);
  const monitor = new MonitorService(repo, clock, silentLogger);
  const types = () => monitor.list({ limit: 500 }).map((e) => e.type);
  return { db, clock, repo, monitor, types };
}

export interface FakeHttpCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A `fetch` that records what it was asked and answers what the test queued (default: 200 Ok). */
export function fakeFetch() {
  const calls: FakeHttpCall[] = [];
  const queue: Array<{ status: number; body: unknown } | Error> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: String(init?.body ?? "") });
    const next = queue.shift() ?? { status: 200, body: { success: true, message: "Ok" } };
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls, queue };
}

export const QR_CONFIG: QrMockConfig = {
  email: "caja@comercio.test",
  password: "clave-de-prueba",
  publicUrl: "https://tilcai.test",
  callbackUrl: "https://comercio.test/api/v1/devices/simple-qr/callback",
};

export function qrHarness(config: Partial<QrMockConfig> = {}) {
  const h = monitorHarness();
  const http = fakeFetch();
  const repo = new SqliteQrMockRepository(h.db);
  const mock = new QrSimpleMock({ repo, clock: h.clock, log: silentLogger, events: h.monitor, config: { ...QR_CONFIG, ...config }, fetchImpl: http.impl });
  const login = () => mock.login({ email: QR_CONFIG.email, password: QR_CONFIG.password, token_name: "pruebas" }).access_token;
  /** A valid generate body that expires `minutes` from the fake clock's now (Bolivia time). */
  const body = (over: Record<string, unknown> = {}, minutes = 30) => ({
    device_id: 17,
    amount: 119.2,
    modify_amount: false,
    is_multi_use: false,
    qr_expiration: new Date(h.clock.now().getTime() + minutes * 60_000 - 4 * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
    description: "Pago QR OP-3F2A91C0",
    ...over,
  });
  return { ...h, http, repo, mock, login, body };
}

export const eventsOf = (events: MonitorEvent[], type: NewMonitorEvent["type"]) => events.filter((e) => e.type === type);
