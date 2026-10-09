import { createHmac, randomUUID } from "node:crypto";
import { iso, type Clock } from "../../shared/clock.ts";
import type { Logger } from "../../shared/log.ts";
import { MONITOR_SCHEMA, type MonitorEvent } from "./domain.ts";
import type { MonitorRepository } from "./repository.ts";

export const WEB_SINK = "web";
const BATCH = 100;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface MonitorDelivery {
  schema: typeof MONITOR_SCHEMA;
  deliveryId: string;
  sentAt: string;
  /** Which TilcAI is talking (several can report to one dashboard). */
  origin: { env: string; instance: string };
  /** Newest position in TilcAI's log: tells the receiver how far behind it is. */
  head: number;
  events: MonitorEvent[];
}

/** `v1=<hex>`: HMAC-SHA256 of "<unix seconds>.<body>" with the shared secret. */
export function signDelivery(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * Sends the event log to tilcai-web, in order and at least once.
 *
 * The cursor only moves when the receiver answers 2xx, so a dashboard that was down gets
 * everything it missed. The receiver ignores events it already has (same `id`).
 */
export class WebForwarder {
  constructor(
    private readonly d: {
      repo: MonitorRepository;
      url: string;
      secret: string;
      origin: { env: string; instance: string };
      clock: Clock;
      log: Logger;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  /** Delivers what is pending. Returns how many events the receiver took. */
  async tick(): Promise<number> {
    let delivered = 0;
    // A long backlog (the dashboard was down) drains in a few batches per tick.
    for (let i = 0; i < 5; i++) {
      const n = await this.deliverBatch();
      delivered += n;
      if (n < BATCH) break;
    }
    return delivered;
  }

  private async deliverBatch(): Promise<number> {
    const now = this.d.clock.now();
    const sink = this.d.repo.sink(WEB_SINK, iso(now));
    if (Date.parse(sink.nextAttemptAt) > now.getTime()) return 0;
    const events = this.d.repo.list({ after: sink.lastSeq, limit: BATCH });
    if (events.length === 0) return 0;

    const delivery: MonitorDelivery = {
      schema: MONITOR_SCHEMA,
      deliveryId: randomUUID(),
      sentAt: iso(now),
      origin: this.d.origin,
      head: this.d.repo.head(),
      events,
    };
    const body = JSON.stringify(delivery);
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    try {
      const res = await (this.d.fetchImpl ?? fetch)(this.d.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tilcai-timestamp": timestamp,
          "x-tilcai-signature": signDelivery(this.d.secret, timestamp, body),
          "x-tilcai-delivery": delivery.deliveryId,
        },
        body,
        signal: AbortSignal.timeout(this.d.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
    } catch (e) {
      const attempts = sink.attempts + 1;
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      this.d.repo.saveSink(
        { ...sink, attempts, lastError: error, nextAttemptAt: iso(new Date(now.getTime() + Math.min(2000 * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS))) },
        iso(now),
      );
      // Once when it starts failing, then quietly: the dashboard being down is not news every second.
      if (attempts === 1) this.d.log.warn("monitor delivery to tilcai-web failed; will retry", { error, pending: delivery.head - sink.lastSeq });
      return 0;
    }
    if (sink.attempts > 0) this.d.log.info("monitor delivery to tilcai-web recovered", { after: sink.attempts });
    this.d.repo.saveSink(
      { ...sink, lastSeq: events[events.length - 1]!.seq, attempts: 0, lastError: null, lastDeliveredAt: iso(now), nextAttemptAt: iso(now) },
      iso(now),
    );
    return events.length;
  }
}
