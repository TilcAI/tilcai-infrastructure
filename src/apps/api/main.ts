import { createAppContext } from "../../app-context.ts";
import { buildServer } from "./server.ts";

const ctx = createAppContext("api");
const app = buildServer(ctx);
await app.listen({ host: ctx.env.API_HOST, port: ctx.env.API_PORT });
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    await app.close();
    ctx.db.close();
    process.exit(0);
  });
}
