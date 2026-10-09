// Child process for the cross-process quota test: tries to take `attempts` units and prints how many it got.
//   node --import tsx test/support/quota-worker.ts <dbPath> <tenantId> <attempts>
import { openDatabase } from "../../src/db/sqlite.ts";
import { SqliteTenantRegistry } from "../../src/modules/tenants/registry.ts";
import type { TenantId } from "../../src/modules/tenants/ports.ts";

const [dbPath, tenantId, attempts] = process.argv.slice(2) as [string, TenantId, string];
const db = openDatabase(dbPath);
const reg = new SqliteTenantRegistry(db);
let got = 0;
for (let i = 0; i < Number(attempts); i++) if (await reg.consumeQuota(tenantId, "operation")) got++;
db.close();
console.log(got);
