/**
 * Network and asset registry (testnet). Identifiers use CAIP-2 so they line up
 * with x402 `network` values. CCTP and USDC addresses verified on-chain on 2026-10-02 by
 * tilcai-cctp-engine (`npm run verify`) and Circle's references:
 *   https://developers.circle.com/cctp/evm-smart-contracts
 *   https://developers.circle.com/cctp/references/stellar-contracts
 */
import type { Env } from "./env.ts";

export type NetworkId = "eip155:43113" | "stellar:testnet";

export interface EvmNetwork {
  id: "eip155:43113";
  family: "evm";
  name: string;
  chainId: number;
  rpc: string;
  explorer: string;
  nativeSymbol: string;
  cctpDomain: number;
  usdc: { address: `0x${string}`; decimals: 6; eip712Name: string; eip712Version: string };
  /** TilcaiCctpRouter (gasless source leg). Absent until deployed on the network. */
  cctpRouter?: `0x${string}`;
  /** TilcaiCctpRouterV2 (payers that are smart accounts: EIP-3009 with a `bytes` signature). */
  cctpRouterV2?: `0x${string}`;
  /** TilcaiAccountFactory: issues the smart accounts of the SCA phase. */
  accountFactory?: `0x${string}`;
  cctpV2: { tokenMessenger: `0x${string}`; messageTransmitter: `0x${string}` };
  /** TilcaiVault (pays purchases settled off-chain). Absent until deployed on the network. */
  vault?: `0x${string}`;
  /** ERC-4337 EntryPoint the smart accounts are built for (OpenZeppelin Contracts 5.7 `Account` default). */
  erc4337: { entryPoint: `0x${string}`; version: "0.9" };
  /** secp256r1 verification precompile (RIP-7212 / ACP-204): passkey signatures checked on-chain. */
  p256Precompile: `0x${string}`;
}

export interface StellarNetwork {
  id: "stellar:testnet";
  family: "stellar";
  name: string;
  rpc: string;
  horizon: string;
  passphrase: string;
  explorer: string;
  cctpDomain: number;
  /** USDC is a classic asset with a Stellar Asset Contract (SAC) for Soroban. */
  usdc: { code: "USDC"; issuer: string; sac: string; decimals: 7 };
  cctpV2: { tokenMessengerMinter: string; messageTransmitter: string; cctpForwarder: string };
  /** `tilcai_account_factory`: issues the smart accounts of the SCA phase. Absent until deployed. */
  accountFactory?: string;
  /** `tilcai_vault` (pays purchases settled off-chain). Absent until deployed. */
  vault?: string;
}

export type Network = EvmNetwork | StellarNetwork;

export interface NetworkRegistry {
  avalancheFuji: EvmNetwork;
  stellarTestnet: StellarNetwork;
  byId(id: string): Network | undefined;
}

export function networks(env: Env): NetworkRegistry {
  const avalancheFuji: EvmNetwork = {
    id: "eip155:43113",
    family: "evm",
    name: "Avalanche Fuji",
    chainId: 43113,
    rpc: env.RPC_AVALANCHE_FUJI,
    explorer: "https://testnet.snowtrace.io",
    nativeSymbol: "AVAX",
    cctpDomain: 1,
    usdc: { address: "0x5425890298aed601595a70AB815c96711a31Bc65", decimals: 6, eip712Name: "USD Coin", eip712Version: "2" },
    ...(env.CCTP_ROUTER_FUJI ? { cctpRouter: env.CCTP_ROUTER_FUJI as `0x${string}` } : {}),
    ...(env.CCTP_ROUTER_V2_FUJI ? { cctpRouterV2: env.CCTP_ROUTER_V2_FUJI as `0x${string}` } : {}),
    ...(env.ACCOUNT_FACTORY_FUJI ? { accountFactory: env.ACCOUNT_FACTORY_FUJI as `0x${string}` } : {}),
    ...(env.VAULT_FUJI ? { vault: env.VAULT_FUJI as `0x${string}` } : {}),
    // Same CREATE2 address on every EVM testnet.
    cctpV2: {
      tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    },
    // Both verified on Fuji on 2026-10-06 (`npm run sca:preflight`).
    erc4337: { entryPoint: "0x433709009B8330FDa32311DF1C2AFA402eD8D009", version: "0.9" },
    p256Precompile: "0x0000000000000000000000000000000000000100",
  };
  const stellarTestnet: StellarNetwork = {
    id: "stellar:testnet",
    family: "stellar",
    name: "Stellar Testnet",
    rpc: env.RPC_STELLAR_TESTNET,
    horizon: env.HORIZON_STELLAR_TESTNET,
    passphrase: "Test SDF Network ; September 2015",
    explorer: "https://stellar.expert/explorer/testnet",
    cctpDomain: 27,
    usdc: {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      decimals: 7,
    },
    cctpV2: {
      tokenMessengerMinter: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
      messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
      cctpForwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
    },
    ...(env.ACCOUNT_FACTORY_STELLAR ? { accountFactory: env.ACCOUNT_FACTORY_STELLAR } : {}),
    ...(env.VAULT_STELLAR ? { vault: env.VAULT_STELLAR } : {}),
  };
  const all: Network[] = [avalancheFuji, stellarTestnet];
  return { avalancheFuji, stellarTestnet, byId: (id) => all.find((n) => n.id === id) };
}
