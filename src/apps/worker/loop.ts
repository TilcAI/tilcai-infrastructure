import type { AppContext } from "../../app-context.ts";

/** Reconciliation loop: advances every due crosschain payment and vault payout. Stops on signal. */
export function startWorker(ctx: AppContext): { stop(): Promise<void> } {
  let running = true;
  let wake: (() => void) | null = null;
  const done = (async () => {
    ctx.log.info("worker started", { pollMs: ctx.env.WORKER_POLL_MS });
    while (running) {
      // Each queue fails on its own: a stuck one never holds the other back.
      for (const pass of [() => ctx.crosschain.processDue(), () => ctx.vault?.processDue()]) {
        try {
          await pass();
        } catch (e) {
          ctx.log.error("worker iteration failed", { error: e instanceof Error ? e.message : String(e) });
        }
      }
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, ctx.env.WORKER_POLL_MS).unref();
      });
    }
    ctx.log.info("worker stopped");
  })();
  return {
    async stop() {
      running = false;
      wake?.();
      await done;
    },
  };
}
