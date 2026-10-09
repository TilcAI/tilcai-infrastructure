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

/** What the relayer reports about a submission, on either chain. */
export type DeploySubmissionStatus = { state: "pending" } | { state: "confirmed"; txHash: string } | { state: "failed"; reason: string };

/** What the account service needs beyond issuing: the fate of a deployment it sent. */
export interface AccountDeployer extends SmartAccountProvider {
  /** Code the accounts run: the factory's implementation (EVM) or the account wasm hash (Stellar). */
  codeRef(): Promise<string>;
  deployStatus(submissionId: string): Promise<DeploySubmissionStatus>;
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

// ── Persistence (M1 · Jhamil, to agree with Omar) ───────────────────────────────────────────────────
// Everything the API reads for a tenant goes through a `…ForTenant` method: an account or delegation of
// another tenant is "not found", never "forbidden", so ids cannot be probed. The plain `get`, `findByAddress`
// and `listDue` are for the worker and for payment routing and are NOT scoped: never call them with an id
// that came from a request without checking `tenantId` first.
// Methods return promises so a Postgres implementation (phase 2) changes nothing for consumers.

export type AccountState = SmartAccount["state"];
export type DelegationState = Delegation["state"];

/** A `SmartAccount` plus what the repository and the reconciliation worker need. */
export interface StoredSmartAccount extends SmartAccount {
  /** The CREATE2 / factory salt the address was derived with. */
  salt: Hex;
  /** Id the relayer gave to the deployment submission. */
  deploySubmissionId?: string;
  /** Client key of the creation request; unique per tenant. */
  idempotencyKey: string;
  /** Hash of the request arguments: the same key with other arguments is a conflict. */
  requestHash: string;
  attempts: number;
  nextCheckAt: string;
  lastError?: string;
  updatedAt: string;
  /** Optimistic lock: `update` must pass the version it read. */
  version: number;
}

export interface StoredDelegation extends Delegation {
  /** Optional client key; unique per account when present. */
  idempotencyKey?: string;
  requestHash?: string;
  /** The request the owner has to sign right now (creation or revocation). */
  signRequest?: OwnerSignRequest;
  /** Relayer submission of the current step. */
  submissionId?: string;
  attempts: number;
  nextCheckAt: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Append-only log. Written in the same transaction as the change it describes. */
export interface AccountEvent {
  accountId: SmartAccountId;
  /** Set when the event is about a delegation of the account. */
  delegationId?: DelegationId;
  from: AccountState | DelegationState | null;
  to: AccountState | DelegationState;
  note: string;
  data?: Record<string, unknown>;
  at: string;
}

export interface SmartAccountRepository {
  /**
   * Stores the account and its creation event in one transaction.
   * Throws `AccountConflictError` (address / external ref / idempotency key already used).
   * With `chargeQuota`, the creation also counts against the tenant's accounts-per-day quota in the same
   * transaction: if the quota is exhausted it throws `QuotaExceededError` and stores nothing, and a conflict
   * (an idempotent replay) counts nothing.
   */
  insert(account: StoredSmartAccount, event: AccountEvent, options?: { chargeQuota?: boolean }): Promise<void>;
  getForTenant(tenantId: TenantId, id: SmartAccountId): Promise<StoredSmartAccount | undefined>;
  findForTenant(tenantId: TenantId, network: AccountNetwork, externalRef: string): Promise<StoredSmartAccount | undefined>;
  getByIdempotencyKey(tenantId: TenantId, key: string): Promise<StoredSmartAccount | undefined>;
  /** Newest first, 50 by default (200 at most). `before` is `{createdAt, id}` of the last row of the previous page. */
  listForTenant(
    tenantId: TenantId,
    filter?: { network?: AccountNetwork; externalRef?: string; limit?: number; before?: { createdAt: string; id: SmartAccountId } },
  ): Promise<StoredSmartAccount[]>;
  /** Worker / payment routing, not scoped by tenant. */
  get(id: SmartAccountId): Promise<StoredSmartAccount | undefined>;
  findByAddress(network: AccountNetwork, address: string): Promise<StoredSmartAccount | undefined>;
  /** `DEPLOYING` accounts whose `nextCheckAt` has passed. */
  listDue(nowIso: string, limit: number): Promise<StoredSmartAccount[]>;
  /**
   * Optimistic update: throws `StaleVersionError` if `expectedVersion` is not the stored one.
   * A change of `state` must follow the account state machine and must carry its `event`
   * (`IllegalTransitionError`, `MissingEventError`); the event is stored in the same transaction.
   * Identity (tenant, network, address, external ref) never changes.
   */
  update(account: StoredSmartAccount, expectedVersion: number, event?: AccountEvent): Promise<StoredSmartAccount>;
  /** Events of the account and of its delegations, oldest first. */
  events(accountId: SmartAccountId): Promise<AccountEvent[]>;
}

export interface DelegationRepository {
  /**
   * Stores the delegation and its creation event in one transaction, only if the account belongs to `tenantId`
   * (otherwise `AccountNotFoundError`). Throws `AccountConflictError` on a repeated idempotency key or on-chain ref.
   */
  insert(tenantId: TenantId, delegation: StoredDelegation, event: AccountEvent): Promise<void>;
  getForTenant(tenantId: TenantId, accountId: SmartAccountId, id: DelegationId): Promise<StoredDelegation | undefined>;
  listForTenant(tenantId: TenantId, accountId: SmartAccountId): Promise<StoredDelegation[]>;
  getByIdempotencyKey(tenantId: TenantId, accountId: SmartAccountId, key: string): Promise<StoredDelegation | undefined>;
  /** Worker, not scoped by tenant. */
  get(id: DelegationId): Promise<StoredDelegation | undefined>;
  findByOnchainRef(accountId: SmartAccountId, onchainRef: string): Promise<StoredDelegation | undefined>;
  /** Delegations in `SUBMITTED` or `REVOKING` whose `nextCheckAt` has passed. */
  listDue(nowIso: string, limit: number): Promise<StoredDelegation[]>;
  /** Same rules as `SmartAccountRepository.update`, with the delegation state machine. */
  update(delegation: StoredDelegation, expectedVersion: number, event?: AccountEvent): Promise<StoredDelegation>;
}
