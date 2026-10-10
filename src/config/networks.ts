/**
 * Network and asset registry. Identifiers use CAIP-2 so they line up with x402.
 * Protocol addresses come from Circle, Stellar and Avalanche official references;
 * TilcAI-owned contract addresses always come from the environment.
 */
import type { Env } from "./env.ts";

/** Official protocol values. TilcAI deployment tools import these instead of duplicating them. */
export const AVALANCHE_MAINNET = {
  chainId: 43114,
  id: "eip155:43114" as const,
  usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" as const,
  tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as const,
  messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as const,
  p256Precompile: "0x0000000000000000000000000000000000000100" as const,
};

export const STELLAR_MAINNET = {
  id: "stellar:pubnet" as const,
  passphrase: "Public Global Stellar Network ; September 2015",
  usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  usdcSac: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  tokenMessengerMinter: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
  messageTransmitter: "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
  cctpForwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
};

export type EvmNetworkId = "eip155:43113" | "eip155:43114";
export type StellarNetworkId = "stellar:testnet" | "stellar:pubnet";
export type NetworkId = EvmNetworkId | StellarNetworkId;

export interface EvmNetwork {
  id: EvmNetworkId;
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
  id: StellarNetworkId;
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
  environment: Env["TILCAI_ENV"];
  /** Active source and destination. Application code must use these two. */
  avalanche: EvmNetwork;
  stellar: StellarNetwork;
  /** Complete registry is exposed for validation and backwards-compatible test helpers. */
  avalancheFuji: EvmNetwork;
  stellarTestnet: StellarNetwork;
  avalancheMainnet: EvmNetwork;
  stellarMainnet: StellarNetwork;
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

  const avalancheMainnet: EvmNetwork = {
    id: AVALANCHE_MAINNET.id,
    family: "evm",
    name: "Avalanche C-Chain",
    chainId: AVALANCHE_MAINNET.chainId,
    rpc: env.RPC_AVALANCHE_MAINNET,
    explorer: "https://explorer.avax.network/c-chain",
    nativeSymbol: "AVAX",
    cctpDomain: 1,
    // https://developers.circle.com/stablecoins/usdc-contract-addresses
    usdc: { address: AVALANCHE_MAINNET.usdc, decimals: 6, eip712Name: "USD Coin", eip712Version: "2" },
    ...(env.CCTP_ROUTER_AVALANCHE_MAINNET ? { cctpRouter: env.CCTP_ROUTER_AVALANCHE_MAINNET as `0x${string}` } : {}),
    ...(env.CCTP_ROUTER_V2_AVALANCHE_MAINNET ? { cctpRouterV2: env.CCTP_ROUTER_V2_AVALANCHE_MAINNET as `0x${string}` } : {}),
    ...(env.ACCOUNT_FACTORY_AVALANCHE_MAINNET ? { accountFactory: env.ACCOUNT_FACTORY_AVALANCHE_MAINNET as `0x${string}` } : {}),
    ...(env.VAULT_AVALANCHE_MAINNET ? { vault: env.VAULT_AVALANCHE_MAINNET as `0x${string}` } : {}),
    // https://developers.circle.com/cctp/references/contract-addresses
    cctpV2: {
      tokenMessenger: AVALANCHE_MAINNET.tokenMessengerV2,
      messageTransmitter: AVALANCHE_MAINNET.messageTransmitterV2,
    },
    // Deliberately has no default: phase 2 must verify this deployment's bytecode on C-Chain.
    erc4337: { entryPoint: env.ERC4337_ENTRYPOINT_AVALANCHE_MAINNET as `0x${string}`, version: "0.9" },
    // ACP-204, active on Avalanche C-Chain.
    p256Precompile: AVALANCHE_MAINNET.p256Precompile,
  };
  const stellarMainnet: StellarNetwork = {
    id: STELLAR_MAINNET.id,
    family: "stellar",
    name: "Stellar Public Network",
    rpc: env.RPC_STELLAR_MAINNET,
    horizon: env.HORIZON_STELLAR_MAINNET,
    passphrase: STELLAR_MAINNET.passphrase,
    explorer: "https://stellar.expert/explorer/public",
    cctpDomain: 27,
    // https://developers.stellar.org/docs/build/agentic-payments/x402
    usdc: {
      code: "USDC",
      issuer: STELLAR_MAINNET.usdcIssuer,
      sac: STELLAR_MAINNET.usdcSac,
      decimals: 7,
    },
    // https://developers.circle.com/cctp/references/stellar-contracts
    cctpV2: {
      tokenMessengerMinter: STELLAR_MAINNET.tokenMessengerMinter,
      messageTransmitter: STELLAR_MAINNET.messageTransmitter,
      cctpForwarder: STELLAR_MAINNET.cctpForwarder,
    },
    ...(env.ACCOUNT_FACTORY_STELLAR_MAINNET ? { accountFactory: env.ACCOUNT_FACTORY_STELLAR_MAINNET } : {}),
    ...(env.VAULT_STELLAR_MAINNET ? { vault: env.VAULT_STELLAR_MAINNET } : {}),
  };
  const all: Network[] = [avalancheFuji, stellarTestnet, avalancheMainnet, stellarMainnet];
  const mainnet = env.TILCAI_ENV === "mainnet";
  return {
    environment: env.TILCAI_ENV,
    avalanche: mainnet ? avalancheMainnet : avalancheFuji,
    stellar: mainnet ? stellarMainnet : stellarTestnet,
    avalancheFuji,
    stellarTestnet,
    avalancheMainnet,
    stellarMainnet,
    byId: (id) => all.find((n) => n.id === id),
  };
}
