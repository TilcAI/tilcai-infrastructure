/**
 * Creates tenants and issues their API keys (fase SCA M1). Talks to the database directly, not over HTTP.
 *   npm run tenant -- create --name Optus
 *   npm run tenant -- key --tenant tenant_… --label "backend" --scopes accounts:read,accounts:write
 *   npm run tenant -- list
 * In a container: docker compose -f deploy/docker-compose.yml exec tilcai npm run tenant -- list
 */
import { loadEnv } from "../../config/env.ts";
import { openDatabase } from "../../db/sqlite.ts";
import { runTenantCli } from "../../modules/tenants/admin-cli.ts";
import { SqliteTenantRegistry } from "../../modules/tenants/registry.ts";

const env = loadEnv();
const db = openDatabase(env.DATABASE_PATH);
const code = await runTenantCli(new SqliteTenantRegistry(db), process.argv.slice(2), (line) => console.log(line));
db.close();
process.exit(code);
