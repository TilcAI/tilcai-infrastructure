import type { AppContext } from "../../app-context.ts";
import type { ResourceSnapshot } from "../../modules/monitor/resources.ts";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Background work of TilcAI, in two loops that never wait for each other:
 *  - reconciliation advances every due crosschain payment, vault payout and account deployment;
 *  - housekeeping feeds the dashboard (events to tilcai-web, resource snapshots) and runs the
 *    QR mock's clock (payment notifications, expirations). A slow dashboard or a caller that
 *    does not answer its callback never delays a payment.
 * Both stop on signal.
 */
export function startWorker(ctx: AppContext): { stop(): Promise<void> } {
  const reconcile = loop(ctx, "worker", ctx.env.WORKER_POLL_MS, [() => ctx.crosschain.processDue(), ...Object.values(ctx.vaults).map((v) => () => v.processDue()), () => ctx.accountService?.processDue()]);

  let lastSnapshotAt = 0;
  let lastPruneAt = Date.now();
  const housekeeping = loop(ctx, "housekeeping", 1000, [
    () => ctx.qrMock?.deliverDueCallbacks(),
    async () => void ctx.qrMock?.expireDue(),
    () => ctx.forwarder?.tick(),
    async () => {
      if (Date.now() - lastSnapshotAt < ctx.env.MONITOR_RESOURCES_INTERVAL_MS) return;
      lastSnapshotAt = Date.now();
      await recordResources(ctx);
    },
    async () => {
      if (Date.now() - lastPruneAt < 3_600_000) return;
      lastPruneAt = Date.now();
      const removed = ctx.monitor.prune(ctx.env.MONITOR_RETENTION_DAYS);
      if (removed > 0) ctx.log.info("old monitor events removed", { removed, olderThanDays: ctx.env.MONITOR_RETENTION_DAYS });
    },
  ]);
  // An event of this process goes out now, not at the next tick.
  const unsubscribe = ctx.monitor.subscribe(() => housekeeping.wake());

  return {
    async stop() {
      unsubscribe();
      await Promise.all([reconcile.stop(), housekeeping.stop()]);
      ctx.resources.stop();
    },
  };
}

/** Takes a resource snapshot, updates the alerts and leaves both in the event log. */
export async function recordResources(ctx: AppContext): Promise<ResourceSnapshot> {
  const snapshot = await ctx.resources.snapshot();
  ctx.monitor.setAlerts(snapshot.alerts);
  const mb = Math.round(snapshot.process.rssBytes / 1_048_576);
  ctx.monitor.emit({
    type: "resources.snapshot",
    // Always informative: what is wrong travels in `alert.raised`, once, not in every snapshot.
    subject: snapshot.host.name,
    summary: [
      `Memoria ${mb} MB`,
      `relayer ${snapshot.relayer.up ? "arriba" : "caído"}`,
      snapshot.vault ? `vault ${snapshot.vault.balance} USDC` : "sin vault",
      `${snapshot.alerts.length} alerta(s)`,
    ].join(" · "),
    data: snapshot as unknown as Record<string, unknown>,
  });
  return snapshot;
}

/** Runs the passes every `everyMs`. Each one fails on its own: a stuck one never holds the others back. */
function loop(ctx: AppContext, name: string, everyMs: number, passes: Array<() => Promise<unknown> | undefined>): { stop(): Promise<void>; wake(): void } {
  let running = true;
  let wake: (() => void) | null = null;
  let woken = false;
  const done = (async () => {
    ctx.log.info(`${name} started`, { pollMs: everyMs });
    while (running) {
      woken = false;
      const results = await Promise.allSettled(passes.map(async (pass) => pass()));
      for (const r of results) {
        if (r.status === "rejected") ctx.log.error(`${name} iteration failed`, { error: errText(r.reason) });
      }
      // Something asked for another round while this one was running: do not sleep on it.
      if (woken || !running) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, everyMs).unref();
      });
      wake = null;
    }
    ctx.log.info(`${name} stopped`);
  })();
  return {
    wake() {
      woken = true;
      wake?.();
    },
    async stop() {
      running = false;
      wake?.();
      await done;
    },
  };
}
