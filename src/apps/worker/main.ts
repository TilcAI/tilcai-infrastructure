import { createAppContext } from "../../app-context.ts";
import { startWorker } from "./loop.ts";

const ctx = createAppContext("worker");
const w = startWorker(ctx);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    await w.stop();
    ctx.db.close();
    process.exit(0);
  });
}
