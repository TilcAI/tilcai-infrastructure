import { randomUUID } from "node:crypto";
import { ID_PREFIXES, parseId, type EntityId, type IdKind } from "tilcai-core/src/contracts.ts";
import type { DelegationId, SmartAccountId } from "../modules/accounts/ports.ts";
import type { TenantId } from "../modules/tenants/ports.ts";

/**
 * Entity IDs follow `tilcai-shared-v1` (`<prefix>_<suffix>`). Infrastructure-only
 * entities that the shared contract does not define get their own prefixes here;
 * they are never accepted where a shared ID is expected.
 */
export function newId<K extends IdKind>(kind: K): EntityId<K> {
  return parseId(kind, `${ID_PREFIXES[kind]}_${randomUUID()}`);
}

export const LOCAL_PREFIXES = {
  routeQuote: "route_quote",
  tenant: "tenant",
  tenantKey: "tenant_key",
  smartAccount: "account",
  delegation: "delegation",
} as const;
export type RouteQuoteId = string & { readonly __brand: "routeQuote" };

export function newRouteQuoteId(): RouteQuoteId {
  return `${LOCAL_PREFIXES.routeQuote}_${randomUUID()}` as RouteQuoteId;
}

export function parseRouteQuoteId(value: unknown): RouteQuoteId {
  if (typeof value !== "string" || !/^route_quote_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new TypeError("Invalid route quote ID.");
  }
  return value as RouteQuoteId;
}

/** Fase SCA: terceros y cuentas. Mismo formato que los demás IDs (`<prefijo>_<uuid>`), solo de infraestructura. */
const localId = (prefix: string) => `${prefix}_${randomUUID()}`;
export const newTenantId = () => localId(LOCAL_PREFIXES.tenant) as TenantId;
export const newTenantKeyId = () => localId(LOCAL_PREFIXES.tenantKey);
export const newSmartAccountId = () => localId(LOCAL_PREFIXES.smartAccount) as SmartAccountId;
export const newDelegationId = () => localId(LOCAL_PREFIXES.delegation) as DelegationId;
