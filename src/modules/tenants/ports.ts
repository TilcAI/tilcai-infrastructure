// SCA phase M1 · owners: Jhamil (data, quotas) + Omar (authentication, API). A tenant is a third party (Optus is the first) that asks TilcAI to
// issue and sponsor accounts and to move payments. Replaces the flat TILCAI_API_KEYS list.
export type TenantId = string & { readonly __brand: "tenant" };

export type TenantScope = "payments" | "accounts:read" | "accounts:write";
export const TENANT_SCOPES: readonly TenantScope[] = ["payments", "accounts:read", "accounts:write"];

/** What TilcAI's relayers will pay for a tenant per UTC day. */
export interface TenantQuota {
  accountsPerDay: number;
  sponsoredOpsPerDay: number;
}

/** `account` = an account deployment, `operation` = any other sponsored action (UserOp, delegation, burn…). */
export type QuotaKind = "account" | "operation";

export interface Tenant {
  id: TenantId;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  /** What TilcAI's relayers will pay for this tenant per UTC day. */
  quota: TenantQuota;
  createdAt: string;
}

/**
 * The tenant that owns everything created before tenants existed. The keys listed in
 * TILCAI_API_KEYS authenticate as this tenant with the `payments` scope only, so Optipagos and
 * optus-agentBE keep working unchanged. Created by migration 5.
 */
export const LEGACY_TENANT_ID = "tenant_legacy" as TenantId;

export interface TenantRegistry {
  /** Keys are stored hashed; the comparison is constant-time. */
  authenticate(apiKey: string): Promise<{ tenant: Tenant; scopes: readonly TenantScope[] } | undefined>;
  get(id: TenantId): Promise<Tenant | undefined>;
  /** Atomic: counts one sponsored action against today's quota, or returns false and counts nothing. */
  consumeQuota(id: TenantId, kind: QuotaKind): Promise<boolean>;
  /** What the tenant has used today (UTC). Reading never counts. */
  usage(id: TenantId): Promise<{ accounts: number; operations: number }>;
}

export interface TenantApiKeyInfo {
  id: string;
  tenantId: TenantId;
  /** First characters of the key, to recognise it in a list. The key itself is never stored. */
  hint: string;
  label: string;
  scopes: readonly TenantScope[];
  /** `env` keys mirror TILCAI_API_KEYS and follow it; `issued` keys come from the CLI. */
  source: "issued" | "env";
  createdAt: string;
  revokedAt?: string;
}

/** Operator side (CLI). Never exposed over HTTP. */
export interface TenantAdmin {
  createTenant(input: { name: string; quota?: Partial<TenantQuota> }): Promise<Tenant>;
  setStatus(id: TenantId, status: Tenant["status"]): Promise<Tenant>;
  list(): Promise<Tenant[]>;
  /** The returned `key` is the only time the secret exists in clear: only its hash is kept. */
  issueKey(id: TenantId, input: { label: string; scopes: readonly TenantScope[] }): Promise<{ info: TenantApiKeyInfo; key: string }>;
  revokeKey(keyId: string): Promise<void>;
  listKeys(id: TenantId): Promise<TenantApiKeyInfo[]>;
  /** Makes the legacy tenant's `env` keys match TILCAI_API_KEYS exactly: adds new ones, revokes the ones removed. */
  syncLegacyKeys(keys: readonly string[]): Promise<{ added: number; revoked: number; active: number }>;
}
