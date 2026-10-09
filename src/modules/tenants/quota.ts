import type { DatabaseSync } from "node:sqlite";
import type { QuotaKind, TenantId } from "./ports.ts";

/** UTC day (`YYYY-MM-DD`) a quota counter belongs to. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Counts one sponsored action against the tenant's quota for `day`, or counts nothing.
 *
 * It is ONE statement, so two connections (the API and the worker are separate processes on the same file)
 * cannot both take the last unit: the increment and the comparison with the limit happen together, under
 * SQLite's write lock.
 *   - first action of the day: the row is inserted only if the limit is at least 1;
 *   - later ones: `count` is incremented only if it is still below the limit (`DO UPDATE … WHERE`).
 * A rejection leaves no row and no change. A suspended or unknown tenant is a rejection.
 *
 * Callers inside a transaction get all-or-nothing with their own writes: if the transaction is rolled back,
 * so is the count.
 */
export function consumeQuotaSql(db: DatabaseSync, tenantId: TenantId, day: string, kind: QuotaKind): boolean {
  const res = db
    .prepare(
      `INSERT INTO tenant_usage (tenant_id, day, kind, count)
       SELECT t.id, ?2, ?3, 1 FROM tenants t
       WHERE t.id = ?1 AND t.status = 'ACTIVE'
         AND (CASE ?3 WHEN 'account' THEN t.quota_accounts_per_day ELSE t.quota_sponsored_ops_per_day END) >= 1
       ON CONFLICT (tenant_id, day, kind) DO UPDATE SET count = count + 1
       WHERE count < (SELECT CASE excluded.kind WHEN 'account' THEN t.quota_accounts_per_day ELSE t.quota_sponsored_ops_per_day END
                      FROM tenants t WHERE t.id = excluded.tenant_id AND t.status = 'ACTIVE')`,
    )
    .run(tenantId, day, kind);
  return Number(res.changes) === 1;
}
