import type { DatabaseSync } from "node:sqlite";
import { tx } from "../../db/sqlite.ts";
import { systemClock, iso, type Clock } from "../../shared/clock.ts";
import { DomainError } from "../../shared/errors.ts";
import { newTenantId, newTenantKeyId } from "../../shared/ids.ts";
import { generateApiKey, hashApiKey, keyHint, MAX_API_KEY_LENGTH, sameHash } from "./keys.ts";
import { consumeQuotaSql, utcDay } from "./quota.ts";
import {
  LEGACY_TENANT_ID,
  TENANT_SCOPES,
  type QuotaKind,
  type Tenant,
  type TenantAdmin,
  type TenantApiKeyInfo,
  type TenantId,
  type TenantQuota,
  type TenantRegistry,
  type TenantScope,
} from "./ports.ts";

/** What a new tenant gets unless the operator says otherwise. Review with the team before real use. */
export const DEFAULT_QUOTA: TenantQuota = { accountsPerDay: 20, sponsoredOpsPerDay: 200 };
const MAX_QUOTA = 1_000_000_000;

/** Compared on a miss too, so a wrong key and an unknown key take the same path. */
const NO_KEY = "00".repeat(32);

type Row = Record<string, any>;

/** Tenants, API keys and daily quotas on SQLite. The only class that knows the tables. */
export class SqliteTenantRegistry implements TenantRegistry, TenantAdmin {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
    private readonly environment: "testnet" | "mainnet" = "testnet",
  ) {}

  // ── TenantRegistry ────────────────────────────────────────────────────────

  async authenticate(apiKey: string) {
    if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > MAX_API_KEY_LENGTH) return undefined;
    const hash = hashApiKey(apiKey);
    const row = this.db
      .prepare(
        `SELECT k.*, k.id AS credential_id,
                t.id, t.name, t.status, t.quota_accounts_per_day, t.quota_sponsored_ops_per_day, t.created_at AS tenant_created_at
         FROM tenant_api_keys k JOIN tenants t ON t.id = k.tenant_id
         WHERE k.key_hash = ?`,
      )
      .get(hash) as Row | undefined;
    // The row was found by the hash of what the caller sent; compare in constant time anyway, and also on a miss.
    const same = sameHash(row?.key_hash ?? NO_KEY, hash);
    const now = iso(this.clock.now());
    if (!row || !same || row.revoked_at || row.status !== "ACTIVE" ||
        (row.source === "issued" && row.environment !== this.environment) ||
        (row.expires_at && row.expires_at <= now)) return undefined;
    // Bound write frequency; this is operational metadata, not an authorization cache.
    if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) >= 60_000) {
      this.db.prepare("UPDATE tenant_api_keys SET last_used_at = ? WHERE id = ?").run(now, row.credential_id);
      row.last_used_at = now;
    }
    return { tenant: toTenant({ ...row, created_at: row.tenant_created_at }), scopes: parseScopes(row.scopes_json), key: toKeyInfo({ ...row, id: row.credential_id }) };
  }

  async get(id: TenantId) {
    const row = this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as Row | undefined;
    return row ? toTenant(row) : undefined;
  }

  async consumeQuota(id: TenantId, kind: QuotaKind) {
    return consumeQuotaSql(this.db, id, utcDay(this.clock.now()), kind);
  }

  async usage(id: TenantId) {
    const rows = this.db
      .prepare("SELECT kind, count FROM tenant_usage WHERE tenant_id = ? AND day = ?")
      .all(id, utcDay(this.clock.now())) as Row[];
    const of = (kind: QuotaKind) => Number(rows.find((r) => r.kind === kind)?.count ?? 0);
    return { accounts: of("account"), operations: of("operation") };
  }

  // ── TenantAdmin ───────────────────────────────────────────────────────────

  async createTenant(input: { name: string; quota?: Partial<TenantQuota> }): Promise<Tenant> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length < 1 || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new DomainError("INVALID_INPUT", "tenant name must be 1–80 printable characters");
    const quota = { ...DEFAULT_QUOTA, ...input.quota };
    for (const v of [quota.accountsPerDay, quota.sponsoredOpsPerDay]) {
      if (!Number.isInteger(v) || v < 0 || v > MAX_QUOTA) throw new DomainError("INVALID_INPUT", `quota must be an integer between 0 and ${MAX_QUOTA}`);
    }
    const tenant: Tenant = { id: newTenantId(), name, status: "ACTIVE", quota, createdAt: iso(this.clock.now()) };
    try {
      this.db
        .prepare("INSERT INTO tenants (id, name, status, quota_accounts_per_day, quota_sponsored_ops_per_day, created_at) VALUES (?,?,?,?,?,?)")
        .run(tenant.id, tenant.name, tenant.status, quota.accountsPerDay, quota.sponsoredOpsPerDay, tenant.createdAt);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new DomainError("DUPLICATE", "a tenant with that name already exists");
      throw e;
    }
    return tenant;
  }

  async setStatus(id: TenantId, status: Tenant["status"]): Promise<Tenant> {
    if (status !== "ACTIVE" && status !== "SUSPENDED") throw new DomainError("INVALID_INPUT", "status must be ACTIVE or SUSPENDED");
    const res = this.db.prepare("UPDATE tenants SET status = ? WHERE id = ?").run(status, id);
    if (Number(res.changes) !== 1) throw new DomainError("NOT_FOUND", "tenant not found");
    return (await this.get(id))!;
  }

  async list(): Promise<Tenant[]> {
    return (this.db.prepare("SELECT * FROM tenants ORDER BY created_at, id").all() as Row[]).map(toTenant);
  }

  async issueKey(id: TenantId, input: { label: string; scopes: readonly TenantScope[]; expiresAt?: string }) {
    return tx(this.db, () => this.issueKeyNow(id, input));
  }

  private issueKeyNow(id: TenantId, input: { label: string; scopes: readonly TenantScope[]; expiresAt?: string }) {
    const label = typeof input.label === "string" ? input.label.trim() : "";
    if (label.length < 1 || label.length > 80 || /[\u0000-\u001f]/.test(label)) throw new DomainError("INVALID_INPUT", "label must be 1–80 printable characters");
    const scopes = [...new Set(input.scopes)];
    if (scopes.length === 0 || scopes.some((s) => !TENANT_SCOPES.includes(s))) {
      throw new DomainError("INVALID_INPUT", `scopes must be a non-empty subset of ${TENANT_SCOPES.join(", ")}`);
    }
    const tenant = this.db.prepare("SELECT status FROM tenants WHERE id = ?").get(id);
    if (!tenant) throw new DomainError("NOT_FOUND", "tenant not found");
    if (tenant.status !== "ACTIVE") throw new DomainError("FORBIDDEN", "tenant is suspended");
    const now = this.clock.now().getTime();
    const expiration = input.expiresAt ?? new Date(now + 90 * 86_400_000).toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiration) || !Number.isFinite(Date.parse(expiration)) || new Date(expiration).toISOString() !== expiration || Date.parse(expiration) <= now || Date.parse(expiration) > now + 365 * 86_400_000) {
      throw new DomainError("INVALID_INPUT", "expiresAt must be a canonical UTC timestamp within the next 365 days");
    }
    const key = generateApiKey(this.environment);
    const info: TenantApiKeyInfo = { id: newTenantKeyId(), tenantId: id, hint: keyHint(key), label, scopes, source: "issued", environment: this.environment, expiresAt: expiration, createdAt: iso(this.clock.now()) };
    this.db
      .prepare("INSERT INTO tenant_api_keys (id, tenant_id, key_hash, key_hint, label, scopes_json, source, created_at, environment, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(info.id, id, hashApiKey(key), info.hint, label, JSON.stringify(scopes), info.source, info.createdAt, this.environment, expiration);
    this.db.prepare("INSERT INTO tenant_key_events(key_id, kind, at) VALUES (?, 'issued', ?)").run(info.id, info.createdAt);
    return { info, key };
  }

  async rotateKey(keyId: string, overlapSeconds = 0) {
    if (!Number.isInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > 86400) throw new DomainError("INVALID_INPUT", "overlap must be 0–86400 seconds");
    return tx(this.db, () => {
      const old = this.db.prepare("SELECT * FROM tenant_api_keys WHERE id = ?").get(keyId) as Row | undefined;
      if (!old) throw new DomainError("NOT_FOUND", "key not found");
      const now = iso(this.clock.now());
      if (old.source !== "issued" || old.revoked_at || old.environment !== this.environment || (old.expires_at && old.expires_at <= now)) {
        throw new DomainError("INVALID_INPUT", "only an active issued key in this environment can be rotated");
      }
      const next = this.issueKeyNow(old.tenant_id, { label: old.label, scopes: parseScopes(old.scopes_json) });
      if (overlapSeconds === 0) this.db.prepare("UPDATE tenant_api_keys SET revoked_at = ? WHERE id = ?").run(now, keyId);
      else {
        const until = iso(new Date(this.clock.now().getTime() + overlapSeconds * 1000));
        this.db.prepare("UPDATE tenant_api_keys SET expires_at = ? WHERE id = ?").run(old.expires_at && old.expires_at < until ? old.expires_at : until, keyId);
      }
      this.db.prepare("INSERT INTO tenant_key_events(key_id, kind, at) VALUES (?, 'rotated', ?)").run(keyId, now);
      return next;
    });
  }

  async revokeKey(keyId: string): Promise<void> {
    tx(this.db, () => {
      const old = this.db.prepare("SELECT revoked_at FROM tenant_api_keys WHERE id = ?").get(keyId);
      if (!old) throw new DomainError("NOT_FOUND", "key not found");
      if (old.revoked_at) return;
      const now = iso(this.clock.now());
      this.db.prepare("UPDATE tenant_api_keys SET revoked_at = ? WHERE id = ?").run(now, keyId);
      this.db.prepare("INSERT INTO tenant_key_events(key_id, kind, at) VALUES (?, 'revoked', ?)").run(keyId, now);
    });
  }

  async listKeys(id: TenantId): Promise<TenantApiKeyInfo[]> {
    const rows = this.db.prepare("SELECT * FROM tenant_api_keys WHERE tenant_id = ? ORDER BY created_at, id").all(id) as Row[];
    return rows.map(toKeyInfo);
  }

  async syncLegacyKeys(keys: readonly string[]) {
    return this.syncLegacyKeysSync(keys);
  }

  /** `syncLegacyKeys`, throwing at the call: startup must stop on a failure, not find out from a rejected promise. */
  syncLegacyKeysSync(keys: readonly string[]): { added: number; revoked: number; active: number } {
    const wanted = [...new Set(keys.filter((k) => typeof k === "string" && k.length > 0).map(hashApiKey))];
    const now = iso(this.clock.now());
    return tx(this.db, () => {
      let added = 0;
      for (const hash of wanted) {
        const row = this.db.prepare("SELECT id, tenant_id, source, revoked_at FROM tenant_api_keys WHERE key_hash = ?").get(hash) as Row | undefined;
        if (!row) {
          this.db
            .prepare("INSERT INTO tenant_api_keys (id, tenant_id, key_hash, key_hint, label, scopes_json, source, created_at) VALUES (?,?,?,?,?,?,?,?)")
            .run(newTenantKeyId(), LEGACY_TENANT_ID, hash, "(env)", "TILCAI_API_KEYS", JSON.stringify(["payments"]), "env", now);
          added++;
        } else if (row.tenant_id !== LEGACY_TENANT_ID || row.source !== "env") {
          // The same secret is already issued to a tenant: sharing it would let that tenant's key act as the legacy one.
          throw new DomainError("DUPLICATE", "a TILCAI_API_KEYS value is already issued to another tenant");
        } else if (row.revoked_at) {
          this.db.prepare("UPDATE tenant_api_keys SET revoked_at = NULL WHERE id = ?").run(row.id);
          added++;
        }
      }
      const live = this.db.prepare("SELECT id, key_hash FROM tenant_api_keys WHERE source = 'env' AND revoked_at IS NULL").all() as Row[];
      const keep = new Set(wanted);
      let revoked = 0;
      for (const k of live) {
        if (keep.has(k.key_hash)) continue;
        this.db.prepare("UPDATE tenant_api_keys SET revoked_at = ? WHERE id = ?").run(now, k.id);
        revoked++;
      }
      return { added, revoked, active: wanted.length };
    });
  }
}

function toTenant(r: Row): Tenant {
  return {
    id: r.id as TenantId,
    name: r.name,
    status: r.status,
    quota: { accountsPerDay: Number(r.quota_accounts_per_day), sponsoredOpsPerDay: Number(r.quota_sponsored_ops_per_day) },
    createdAt: r.created_at,
  };
}

function parseScopes(json: string): TenantScope[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v.filter((s) => TENANT_SCOPES.includes(s)) as TenantScope[]) : [];
  } catch {
    return [];
  }
}

function toKeyInfo(r: Row): TenantApiKeyInfo {
  return {
    id: r.id,
    tenantId: r.tenant_id as TenantId,
    hint: r.key_hint,
    label: r.label,
    scopes: parseScopes(r.scopes_json),
    source: r.source,
    ...(r.source === "issued" ? { environment: r.environment } : {}),
    createdAt: r.created_at,
    ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
    ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
    ...(r.revoked_at ? { revokedAt: r.revoked_at } : {}),
  };
}
