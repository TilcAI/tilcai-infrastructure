import { createHash } from "node:crypto";
import { encodeAbiParameters, keccak256 } from "viem";
import { iso, type Clock } from "../../shared/clock.ts";
import { DomainError } from "../../shared/errors.ts";
import type { Hex } from "../../shared/hex.ts";
import { newSmartAccountId } from "../../shared/ids.ts";
import type { Logger } from "../../shared/log.ts";
import { SubmissionRejected } from "../crosschain/ports.ts";
import type { EventSink } from "../monitor/domain.ts";
import type { TenantId } from "../tenants/ports.ts";
import { AccountConflictError, QuotaExceededError, StaleVersionError } from "./domain.ts";
import { PasskeyFormatError } from "./evm/passkey.ts";
import type { AccountDeployer, AccountEvent, AccountNetwork, OwnerCredential, SmartAccountId, SmartAccountRepository, StoredSmartAccount } from "./ports.ts";

export interface AccountServiceDeps {
  repo: SmartAccountRepository;
  /** One per network TilcAI issues accounts on. */
  providers: Partial<Record<AccountNetwork, AccountDeployer>>;
  clock: Clock;
  log: Logger;
  events?: EventSink;
  options: { pollMs: number; transactionsEnabled?: boolean };
}

export interface CreateAccountInput {
  tenantId: TenantId;
  network: string;
  externalRef: string;
  owner: OwnerCredential;
  idempotencyKey: string;
}

const MAX_BACKOFF_MS = 10 * 60_000;
/** After this many refused deployments the dashboard is told; the account keeps being retried. */
const ANNOUNCE_AFTER_ATTEMPTS = 3;

/**
 * Issues smart contract accounts for tenants (fase SCA §7.2).
 *
 *  - The address is final when the request returns: it is derived from the owner's key, the
 *    tenant and the tenant's reference, so asking again gives the same account.
 *  - The relayer pays the deployment. TilcAI holds no key of the account and cannot move its funds.
 *  - A deployment is never given up on: the account stays DEPLOYING and is retried, and it becomes
 *    ACTIVE the moment its address has code, whoever deployed it.
 */
export class AccountService {
  constructor(private readonly d: AccountServiceDeps) {}

  private provider(network: string): AccountDeployer {
    const p = this.d.providers[network as AccountNetwork];
    if (!p) throw new DomainError("NETWORK_OR_ASSET", `accounts are not issued on ${network}`);
    return p;
  }

  networks(): AccountNetwork[] {
    return Object.keys(this.d.providers) as AccountNetwork[];
  }

  async create(input: CreateAccountInput): Promise<{ account: StoredSmartAccount; replayed: boolean }> {
    if (this.d.options.transactionsEnabled === false) throw new DomainError("SERVICE_UNAVAILABLE", "transactions are disabled for this environment");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) throw new DomainError("INVALID_INPUT", "bad idempotency key");
    if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(input.externalRef)) throw new DomainError("INVALID_INPUT", "externalRef: 1-128 of A-Z a-z 0-9 _ . : @ -");
    const provider = this.provider(input.network);
    const network = provider.network;
    const owner = normalizeOwner(input.owner);
    const requestHash = sha256(JSON.stringify(["account-v1", network, input.externalRef, owner]));

    const byKey = await this.d.repo.getByIdempotencyKey(input.tenantId, input.idempotencyKey);
    if (byKey) {
      if (byKey.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT");
      return { account: byKey, replayed: true };
    }
    // One account per holder and network: the same holder with the same passkey is the same account.
    const byRef = await this.d.repo.findForTenant(input.tenantId, network, input.externalRef);
    if (byRef) {
      if (byRef.requestHash !== requestHash) throw new DomainError("DUPLICATE", "externalRef already has an account with another owner");
      return { account: byRef, replayed: true };
    }

    const salt = accountSalt(input.tenantId, input.externalRef);
    let address: string;
    let codeRef: string;
    try {
      [address, codeRef] = await Promise.all([provider.addressFor(owner, salt), provider.codeRef()]);
    } catch (e) {
      if (e instanceof PasskeyFormatError || e instanceof TypeError) throw new DomainError("INVALID_INPUT", e.message);
      throw new DomainError("SERVICE_UNAVAILABLE", `account factory unreachable: ${errText(e)}`);
    }

    const now = iso(this.d.clock.now());
    const account: StoredSmartAccount = {
      id: newSmartAccountId(),
      tenantId: input.tenantId,
      externalRef: input.externalRef,
      network,
      address,
      owner,
      state: "DEPLOYING",
      codeRef,
      salt,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      attempts: 0,
      nextCheckAt: now,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    try {
      await this.d.repo.insert(account, { accountId: account.id, from: null, to: "DEPLOYING", note: "created", at: now }, { chargeQuota: true });
    } catch (e) {
      if (e instanceof QuotaExceededError) throw new DomainError("BUDGET", "accounts-per-day quota exhausted", 429);
      if (e instanceof AccountConflictError) {
        // Lost a race with the same request: answer with what the winner stored.
        const again = (await this.d.repo.getByIdempotencyKey(input.tenantId, input.idempotencyKey)) ?? (await this.d.repo.findForTenant(input.tenantId, network, input.externalRef));
        if (again && again.requestHash === requestHash) return { account: again, replayed: true };
        throw new DomainError(e.reason === "IDEMPOTENCY_KEY" ? "IDEMPOTENCY_CONFLICT" : "DUPLICATE", `account conflict: ${e.reason}`);
      }
      throw e;
    }
    this.announce(account, null, "created");
    // The caller already has its address; the deployment is the worker's business from here on.
    return { account: await this.step(account), replayed: false };
  }

  async get(tenantId: TenantId, id: string): Promise<StoredSmartAccount> {
    const a = await this.d.repo.getForTenant(tenantId, id as SmartAccountId);
    if (!a) throw new DomainError("NOT_FOUND");
    return a;
  }

  async view(tenantId: TenantId, id: string): Promise<{ account: StoredSmartAccount; events: AccountEvent[] }> {
    const account = await this.get(tenantId, id);
    return { account, events: await this.d.repo.events(account.id) };
  }

  async list(tenantId: TenantId, filter: { network?: AccountNetwork; externalRef?: string; limit?: number }): Promise<StoredSmartAccount[]> {
    return this.d.repo.listForTenant(tenantId, filter);
  }

  /** An account TilcAI issued to this tenant that is able to sign (deployed), by address. */
  async activeByAddress(tenantId: TenantId, network: AccountNetwork, address: string): Promise<StoredSmartAccount | undefined> {
    const a = await this.d.repo.findByAddress(network, address);
    return a && a.tenantId === tenantId && a.state === "ACTIVE" ? a : undefined;
  }

  async processDue(limit = 20): Promise<void> {
    for (const account of await this.d.repo.listDue(iso(this.d.clock.now()), limit)) {
      try {
        await this.step(account);
      } catch (e) {
        if (!(e instanceof StaleVersionError)) this.d.log.error("account step failed", { accountId: account.id, error: errText(e) });
      }
    }
  }

  /** One reconciliation step of a DEPLOYING account. Never throws for a failing dependency: it reschedules. */
  async step(account: StoredSmartAccount): Promise<StoredSmartAccount> {
    if (account.state !== "DEPLOYING") return account;
    const provider = this.d.providers[account.network];
    if (!provider) return account;
    try {
      // The chain is the only evidence that counts, and it covers a deployment made by anyone.
      if (await provider.isDeployed(account.address)) {
        let deployTxHash = account.deployTxHash;
        if (!deployTxHash && account.deploySubmissionId) {
          const st = await provider.deployStatus(account.deploySubmissionId).catch(() => null);
          if (st?.state === "confirmed") deployTxHash = st.txHash;
        }
        return this.move(account, "ACTIVE", "account has code on-chain", { ...(deployTxHash ? { deployTxHash } : {}), lastError: undefined });
      }
      if (account.deploySubmissionId) {
        const st = await provider.deployStatus(account.deploySubmissionId);
        // Confirmed but the code is not visible yet: the next round sees it.
        if (st.state !== "failed") return this.reschedule(account, {});
        account = await this.reschedule(account, { deploySubmissionId: undefined, lastError: `DEPLOY_RELAYER_FAILED:${st.reason}`, countAttempt: true, immediate: true });
      }
      const sent = await provider.deploy(account.owner, account.salt);
      this.d.log.info("account deployment submitted", { accountId: account.id, submissionId: sent.submissionId });
      return this.reschedule(account, { deploySubmissionId: sent.submissionId, lastError: undefined });
    } catch (e) {
      if (e instanceof StaleVersionError) throw e;
      const refused = e instanceof SubmissionRejected;
      return this.reschedule(account, { lastError: `${refused ? "DEPLOY_REJECTED" : "DEPLOY_PENDING"}:${errText(e)}`, countAttempt: true, backoff: true });
    }
  }

  private async move(account: StoredSmartAccount, to: "ACTIVE", note: string, patch: Partial<StoredSmartAccount>): Promise<StoredSmartAccount> {
    const now = iso(this.d.clock.now());
    const next = await this.d.repo.update({ ...account, ...patch, state: to, updatedAt: now }, account.version, { accountId: account.id, from: account.state, to, note, at: now });
    this.announce(next, account.state, note);
    return next;
  }

  private async reschedule(
    account: StoredSmartAccount,
    o: { deploySubmissionId?: string | undefined; lastError?: string | undefined; countAttempt?: boolean; backoff?: boolean; immediate?: boolean },
  ): Promise<StoredSmartAccount> {
    const now = this.d.clock.now();
    const attempts = account.attempts + (o.countAttempt ? 1 : 0);
    const wait = o.immediate ? 0 : o.backoff ? Math.min(this.d.options.pollMs * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS) : this.d.options.pollMs;
    const next: StoredSmartAccount = { ...account, attempts, nextCheckAt: iso(new Date(now.getTime() + wait)), updatedAt: iso(now) };
    if ("deploySubmissionId" in o) setOrDrop(next, "deploySubmissionId", o.deploySubmissionId);
    if ("lastError" in o) setOrDrop(next, "lastError", o.lastError);
    const stored = await this.d.repo.update(next, account.version);
    if (o.countAttempt && attempts === ANNOUNCE_AFTER_ATTEMPTS) {
      this.d.events?.emit({
        type: "account.deploy_delayed",
        severity: "warning",
        subject: account.id,
        summary: `La cuenta ${short(account.address)} sigue sin desplegarse tras ${attempts} intentos: ${stored.lastError ?? "sin detalle"}`,
        data: { accountId: account.id, tenantId: account.tenantId, network: account.network, address: account.address, attempts, lastError: stored.lastError ?? null },
        dedupeKey: `account.deploy_delayed:${account.id}`,
      });
    }
    return stored;
  }

  private announce(a: StoredSmartAccount, from: string | null, note: string): void {
    this.d.events?.emit({
      type: "account.transition",
      subject: a.id,
      summary: from === null ? `Cuenta ${short(a.address)} emitida para ${a.tenantId} (${a.network})` : `Cuenta ${short(a.address)}: ${from} → ${a.state}`,
      data: { accountId: a.id, tenantId: a.tenantId, network: a.network, address: a.address, from, to: a.state, note, deployTxHash: a.deployTxHash ?? null },
      dedupeKey: `account.transition:${a.id}:${a.state}`,
    });
  }
}

/** The factory salt: fixed by who asks and for whom, so the same request always lands on the same address. */
export function accountSalt(tenantId: TenantId, externalRef: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "string" }], ["tilcai-account-v1", tenantId, externalRef]));
}

function normalizeOwner(owner: OwnerCredential): OwnerCredential {
  if (owner.kind === "ed25519") return { kind: owner.kind, publicKey: owner.publicKey.toLowerCase() as Hex };
  if (owner.kind !== "webauthn-p256") return owner;
  return { kind: owner.kind, publicKey: owner.publicKey.toLowerCase() as Hex, credentialId: owner.credentialId, rpId: owner.rpId };
}

function setOrDrop<K extends "deploySubmissionId" | "lastError">(a: StoredSmartAccount, key: K, value: string | undefined): void {
  if (value === undefined) delete a[key];
  else a[key] = value;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-4)}`;
