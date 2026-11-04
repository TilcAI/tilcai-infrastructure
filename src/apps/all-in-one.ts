/** API + reconciliation worker in one process (single-host deployment next to the Relayer). */
import { createAppContext } from "../app-context.ts";
import { buildServer } from "./api/server.ts";
import { announceStart, announceStop } from "./lifecycle.ts";
import { startWorker } from "./worker/loop.ts";

const ctx = createAppContext("tilcai");
const worker = startWorker(ctx);
const app = buildServer(ctx, { worker: worker.state });
await app.listen({ host: ctx.env.API_HOST, port: ctx.env.API_PORT });
announceStart(ctx);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    announceStop(ctx, sig);
    await Promise.all([app.close(), worker.stop()]);
    ctx.db.close();
    process.exit(0);
  });
}
