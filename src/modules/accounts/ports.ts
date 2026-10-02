// Phase 3 · owner: Jose (+ Saul for EVM). Account abstraction on both sides of a crosschain payment.
// Stellar: Soroban smart account (OpenZeppelin stellar-contracts: context rules, signers, policies).
// EVM: ERC-4337 smart account + paymaster so the payer needs no AVAX for the source burn.
import type { PrincipalId } from "tilcai-core/src/contracts.ts";

export interface StellarSmartAccountProvider {
  /** Deploys a C… account owned by the principal's passkey/ed25519 signer; fees sponsored by the relayer. */
  create(principalId: PrincipalId, owner: { kind: "passkey" | "ed25519"; publicKey: string }): Promise<{ address: string; txHash: string }>;
  /** Owner-signed: adds a restricted delegated signer with a spending-limit/allow-list policy. */
  addDelegatedSigner(account: string, rule: { signer: string; assetSac: string; payTo: string[]; maxPerPeriod: bigint; periodLedgers: number; validUntilLedger: number }): Promise<{ ruleId: number; txHash: string }>;
  revokeRule(account: string, ruleId: number): Promise<{ txHash: string }>;
}

export interface EvmSmartAccountProvider {
  /** Counterfactual ERC-4337 account address (deployed on first UserOperation). */
  addressFor(owner: string, salt: bigint): Promise<string>;
  /** Builds a UserOperation that executes approve + depositForBurnWithHook as one batch. */
  buildCrosschainBurnUserOp(account: string, calls: Array<{ to: string; data: string }>): Promise<{ userOp: unknown; userOpHash: string }>;
}

export interface PaymasterProvider {
  /** Verifying paymaster: sponsors gas only for allow-listed targets (USDC, TokenMessengerV2) and limits per principal. */
  sponsor(userOp: unknown, policy: { principalId: PrincipalId; maxGasWei: bigint }): Promise<{ paymasterAndData: string; validUntil: number }>;
}
