import { createAppContext } from "../../app-context.ts";
import { announceStart, announceStop } from "../lifecycle.ts";
import { startWorker } from "./loop.ts";

const ctx = createAppContext("worker");
const w = startWorker(ctx);
announceStart(ctx);
// The loop's timer is unref'd: without the API server next to it, nothing else keeps
// this process alive.
const keepAlive = setInterval(() => {}, 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    clearInterval(keepAlive);
    announceStop(ctx, sig);
    await w.stop();
    ctx.db.close();
    process.exit(0);
  });
}
