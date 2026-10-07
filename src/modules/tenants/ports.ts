// SCA phase M1 · owners: Jhamil (data, quotas) + Omar (authentication, API). A tenant is a third party (Optus is the first) that asks TilcAI to
// issue and sponsor accounts and to move payments. Replaces the flat TILCAI_API_KEYS list.
export type TenantId = string & { readonly __brand: "tenant" };

export type TenantScope = "payments" | "accounts:read" | "accounts:write";

export interface Tenant {
  id: TenantId;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  /** What TilcAI's relayers will pay for this tenant per UTC day. */
  quota: { accountsPerDay: number; sponsoredOpsPerDay: number };
  createdAt: string;
}

export interface TenantRegistry {
  /** Keys are stored hashed; the comparison is constant-time. */
  authenticate(apiKey: string): Promise<{ tenant: Tenant; scopes: readonly TenantScope[] } | undefined>;
  get(id: TenantId): Promise<Tenant | undefined>;
  /** Atomic: counts one sponsored action against today's quota, or returns false and counts nothing. */
  consumeQuota(id: TenantId, kind: "account" | "operation"): Promise<boolean>;
}
