import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../app-context.ts";
import { DomainError } from "../../shared/errors.ts";
import { MONITOR_SCHEMA, MONITOR_SEVERITIES, MONITOR_SOURCES, type MonitorEvent } from "../../modules/monitor/domain.ts";
import { parseRelayerNotification, relayerNotificationToEvent, verifyRelayerSignature } from "../../modules/monitor/relayer-webhook.ts";
import type { ResourceSnapshot } from "../../modules/monitor/resources.ts";
import { isLoopback } from "./auth.ts";

export const RELAYER_WEBHOOK_PATH = "/v1/webhooks/relayer";

const EventsQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  type: z.string().regex(/^[a-z_.]{1,60}$/).optional(),
  source: z.enum(MONITOR_SOURCES).optional(),
  severity: z.enum(MONITOR_SEVERITIES).optional(),
});

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const send = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).type("application/json; charset=utf-8").send(json(body));

/**
 * What the dashboard reads when it asks instead of waiting for the push:
 *
 *   GET  /v1/monitor/events      the log, by position (`after`) or its tail
 *   GET  /v1/monitor/stream      the same, live (Server-Sent Events)
 *   GET  /v1/monitor/resources   process, database, relayer and vault right now, and the alerts
 *   POST /v1/webhooks/relayer    notifications of the OpenZeppelin Relayer (signed by the relayer)
 */
export function registerMonitorRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/monitor/events", async (req, reply) => {
    const q = EventsQuery.parse(req.query);
    const filter = { ...(q.type ? { type: q.type } : {}), ...(q.source ? { source: q.source } : {}), ...(q.severity ? { minSeverity: q.severity } : {}) };
    // Without a position the caller wants the latest; with one, what came after it.
    const events = q.after === undefined ? ctx.monitor.tail(q.limit, filter) : ctx.monitor.list({ after: q.after, limit: q.limit, ...filter });
    return send(reply, 200, { schema: MONITOR_SCHEMA, head: ctx.monitor.head(), events });
  });

  let cached: { at: number; snapshot: ResourceSnapshot } | null = null;
  app.get("/v1/monitor/resources", async (_req, reply) => {
    // The snapshot reads the relayer and the chain: a dashboard that polls shares one for a few seconds.
    if (!cached || Date.now() - cached.at > 5000) cached = { at: Date.now(), snapshot: await ctx.resources.snapshot() };
    return send(reply, 200, { schema: MONITOR_SCHEMA, resources: cached.snapshot, alerts: ctx.monitor.alerts() });
  });

  app.get("/v1/monitor/stream", (req, reply) => {
    const q = z.object({ after: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const resumed = Number(req.headers["last-event-id"]);
    let cursor = q.after ?? (Number.isInteger(resumed) && resumed >= 0 ? resumed : ctx.monitor.head());
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const flush = () => {
      let batch: MonitorEvent[];
      do {
        batch = ctx.monitor.list({ after: cursor, limit: 200 });
        for (const e of batch) {
          cursor = e.seq;
          res.write(`id: ${e.seq}\nevent: monitor\ndata: ${json(e)}\n\n`);
        }
      } while (batch.length === 200);
    };
    // The worker may be another process writing to the same database: poll, and do not wait
    // for the next poll when the event came from this one.
    const poll = setInterval(flush, 1000);
    const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
    const unsubscribe = ctx.monitor.subscribe(() => setImmediate(flush));
    req.raw.on("close", () => {
      clearInterval(poll);
      clearInterval(beat);
      unsubscribe();
    });
    flush();
  });

  // The signature covers the exact bytes the relayer sent, so the body is kept raw here.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post(RELAYER_WEBHOOK_PATH, { bodyLimit: 512 * 1024 }, async (req, reply) => {
      const raw = req.body as Buffer;
      const key = ctx.env.RELAYER_WEBHOOK_SIGNING_KEY;
      const signature = req.headers["x-signature"];
      const trusted = key ? verifyRelayerSignature(key, raw, typeof signature === "string" ? signature : undefined) : isLoopback(req.ip);
      if (!trusted) return send(reply, 401, { error: new DomainError("UNAUTHENTICATED").contract });
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(reply, 400, { error: new DomainError("INVALID_INPUT").contract });
      }
      const notification = parseRelayerNotification(body);
      if (!notification) return send(reply, 400, { error: new DomainError("INVALID_INPUT").contract });
      const stored = ctx.monitor.record(relayerNotificationToEvent(notification, ctx.correlate));
      // 200 also for a repeated delivery: the relayer must not keep retrying what is already here.
      return send(reply, 200, { ok: true, stored: stored !== null });
    });
  });
}
