import type { StellarNetwork as AuthorityV1Network } from "tilcai-core/experimental/authority";
import type { StellarNetworkId } from "tilcai-core/networks";

/** Version of the boundary mapping; authority v1 records and commitments retain their original IDs. */
export const STELLAR_NETWORK_COMPAT_SCHEMA = "tilcai-stellar-network-compat-v1" as const;

/** Resolve a parsed Core authority v1 ID for Infrastructure's existing registry. */
export function operationalNetworkFromAuthorityV1(value: unknown): StellarNetworkId {
  if (value === "stellar:testnet") return "stellar:testnet";
  if (value === "stellar:mainnet") return "stellar:pubnet";
  throw new TypeError("Unsupported Core authority v1 Stellar network.");
}

/** Describe an existing Infrastructure ID in Core authority v1 without rewriting stored records. */
export function authorityV1NetworkFromOperational(value: unknown): AuthorityV1Network {
  if (value === "stellar:testnet") return "stellar:testnet";
  if (value === "stellar:pubnet") return "stellar:mainnet";
  throw new TypeError("Unsupported Infrastructure Stellar network.");
}
