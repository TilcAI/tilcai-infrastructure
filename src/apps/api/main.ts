import { createAppContext } from "../../app-context.ts";
import { announceStart, announceStop } from "../lifecycle.ts";
import { buildServer } from "./server.ts";

const ctx = createAppContext("api");
const app = buildServer(ctx);
await app.listen({ host: ctx.env.API_HOST, port: ctx.env.API_PORT });
announceStart(ctx);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    announceStop(ctx, sig);
    await app.close();
    ctx.resources.stop();
    ctx.db.close();
    process.exit(0);
  });
}
