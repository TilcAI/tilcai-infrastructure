// SCA phase M1–M5 · owners: Jose (Stellar) + Saul (EVM, backend). TilcAI issues and sponsors smart
// contract accounts for tenants and is never a signer of an account it issues.
// Stellar: OpenZeppelin `stellar-accounts` smart account (contracts/soroban).
// EVM: OpenZeppelin Contracts `Account` on ERC-4337 EntryPoint v0.9 (contracts/evm).
import type { Hex } from "../../shared/hex.ts";
import type { TenantId } from "../tenants/ports.ts";

export type AccountNetwork = "stellar:testnet" | "eip155:43113";
export type SmartAccountId = string & { readonly __brand: "smartAccount" };
export type DelegationId = string & { readonly __brand: "delegation" };

/**
 * The owner's credential. TilcAI only ever receives public material.
 * webauthn-p256: 65-byte uncompressed point · ed25519: 32 bytes (Stellar only) · secp256k1: EOA (EVM only).
 */
export type OwnerCredential =
  | { kind: "webauthn-p256"; publicKey: Hex; credentialId: string; rpId: string }
  | { kind: "ed25519"; publicKey: Hex }
  | { kind: "secp256k1"; address: Hex };

export interface SmartAccount {
  id: SmartAccountId;
  tenantId: TenantId;
  /** The tenant's own reference for the account holder; unique per tenant and network. */
  externalRef: string;
  network: AccountNetwork;
  address: string;
  owner: OwnerCredential;
  /** DEPLOYING until the deployment is confirmed on-chain. The address is final from the start. */
  state: "DEPLOYING" | "ACTIVE" | "FAILED";
  /** Code the account runs: wasm hash (Stellar) or implementation address (EVM). */
  codeRef: string;
  deployTxHash?: string;
  createdAt: string;
}

/** What an agent key may do, as the account enforces it on-chain. Commercial terms stay in the gateway. */
export interface DelegationRule {
  agentKey: { kind: "ed25519"; publicKey: Hex } | { kind: "secp256k1"; address: Hex };
  /** Exact asset contract: USDC SAC (Stellar) or USDC token (EVM). Never the label "USDC". */
  assetId: string;
  /** Final recipients the agent may pay. On EVM these are the Stellar payTo carried in the CCTP hook. */
  payTo: readonly string[];
  maxPerCallAtomic: bigint;
  maxPerPeriodAtomic: bigint;
  periodSeconds: number;
  validUntil: string;
}

export interface Delegation {
  id: DelegationId;
  accountId: SmartAccountId;
  rule: DelegationRule;
  state: "AWAITING_OWNER" | "SUBMITTED" | "ACTIVE" | "REVOKING" | "REVOKED" | "FAILED";
  /** Context rule id (Stellar) or session id (EVM), once it exists on-chain. */
  onchainRef?: string;
}

/** Something only the owner can sign. TilcAI builds it; the tenant's UI collects the signature. */
export interface OwnerSignRequest {
  /** What the credential signs: WebAuthn challenge, ed25519 message or EIP-712 hash. */
  digest: Hex;
  /** Returned unchanged with the signature: auth entry XDR (Stellar) or UserOperation JSON (EVM). */
  payload: string;
  expiresAt: string;
}

export interface SmartAccountProvider {
  readonly network: AccountNetwork;
  /** Final address for (owner, salt). The factory derives it from the owner key, so nobody can deploy another owner there. */
  addressFor(owner: OwnerCredential, salt: Hex): Promise<string>;
  /** Fees paid by the relayer. Idempotent: an account that already exists is not an error. */
  deploy(owner: OwnerCredential, salt: Hex): Promise<{ address: string; submissionId: string }>;
  isDeployed(address: string): Promise<boolean>;
  prepareDelegation(account: SmartAccount, rule: DelegationRule): Promise<OwnerSignRequest>;
  prepareRevocation(account: SmartAccount, delegation: Delegation): Promise<OwnerSignRequest>;
  /** Attaches the owner's signature to the prepared request and submits it through the relayer. */
  submitOwnerSigned(account: SmartAccount, request: OwnerSignRequest, signature: string): Promise<{ submissionId: string }>;
}

/**
 * EVM only. TilcAI's relayer sends UserOperations itself through `EntryPoint.handleOps`:
 * no external bundler and no paymaster (plan ADR-12).
 */
export interface UserOperationSubmitter {
  /** Accepts only zero-fee operations whose sender is an account issued by TilcAI; simulates before sending. */
  submit(userOp: unknown): Promise<{ submissionId: string; userOpHash: Hex }>;
  status(submissionId: string): Promise<{ state: "pending" } | { state: "confirmed"; txHash: Hex; success: boolean } | { state: "failed"; reason: string }>;
}
