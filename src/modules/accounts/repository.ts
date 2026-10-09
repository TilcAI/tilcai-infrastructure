import type { DatabaseSync } from "node:sqlite";
import { tx } from "../../db/sqlite.ts";
import { systemClock, type Clock } from "../../shared/clock.ts";
import type { Hex } from "../../shared/hex.ts";
import { consumeQuotaSql, utcDay } from "../tenants/quota.ts";
import type { TenantId } from "../tenants/ports.ts";
import {
  AccountConflictError,
  AccountNotFoundError,
  IdentityChangeError,
  IllegalTransitionError,
  MissingEventError,
  QuotaExceededError,
  StaleVersionError,
  canMoveAccount,
  canMoveDelegation,
} from "./domain.ts";
import type {
  AccountEvent,
  AccountNetwork,
  DelegationId,
  DelegationRepository,
  DelegationRule,
  OwnerSignRequest,
  SmartAccountId,
  SmartAccountRepository,
  StoredDelegation,
  StoredSmartAccount,
} from "./ports.ts";

type Row = Record<string, any>;

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
/** JSON with sorted keys, to compare two objects that may list their keys in another order. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : typeof x === "bigint" ? x.toString() : x));
const maybe = <K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } =>
  (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** Maps a violated unique guarantee to the error that names it. Anything else is not ours to interpret. */
function conflictOf(e: unknown): AccountConflictError | undefined {
  const m = String((e as Error)?.message ?? e);
  if (!m.includes("UNIQUE constraint failed")) return undefined;
  if (m.includes("ux_accounts_address") || m.includes("smart_accounts.address")) return new AccountConflictError("ADDRESS");
  if (m.includes("external_ref")) return new AccountConflictError("EXTERNAL_REF");
  if (m.includes("idempotency_key")) return new AccountConflictError("IDEMPOTENCY_KEY");
  if (m.includes("onchain_ref")) return new AccountConflictError("ONCHAIN_REF");
  return undefined;
}

function appendEvent(db: DatabaseSync, ev: AccountEvent): void {
  db.prepare("INSERT INTO account_events (account_id, delegation_id, from_state, to_state, note, data_json, at) VALUES (?,?,?,?,?,?,?)").run(
    ev.accountId,
    ev.delegationId ?? null,
    ev.from,
    ev.to,
    ev.note,
    ev.data ? json(ev.data) : null,
    ev.at,
  );
}

function toEvent(r: Row): AccountEvent {
  return {
    accountId: r.account_id,
    ...maybe("delegationId", r.delegation_id),
    from: r.from_state,
    to: r.to_state,
    note: r.note,
    ...(r.data_json ? { data: JSON.parse(r.data_json) } : {}),
    at: r.at,
  };
}

// ── Accounts ─────────────────────────────────────────────────────────────────────────────────────────

export class SqliteSmartAccountRepository implements SmartAccountRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  async insert(a: StoredSmartAccount, ev: AccountEvent, options?: { chargeQuota?: boolean }): Promise<void> {
    if (ev.accountId !== a.id || ev.delegationId) throw new TypeError("the creation event must belong to the account");
    tx(this.db, () => {
      try {
        this.db
          .prepare(
            `INSERT INTO smart_accounts (id, tenant_id, external_ref, network, address, owner_json, state, code_ref, salt,
               deploy_submission_id, deploy_tx_hash, idempotency_key, request_hash, attempts, next_check_at, last_error,
               created_at, updated_at, version)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
          )
          .run(
            a.id, a.tenantId, a.externalRef, a.network, a.address, json(a.owner), a.state, a.codeRef, a.salt,
            a.deploySubmissionId ?? null, a.deployTxHash ?? null, a.idempotencyKey, a.requestHash, a.attempts, a.nextCheckAt,
            a.lastError ?? null, a.createdAt, a.updatedAt,
          );
      } catch (e) {
        throw conflictOf(e) ?? e;
      }
      appendEvent(this.db, ev);
      // Last on purpose: a conflict above has already thrown and counted nothing; a refusal here rolls everything back.
      if (options?.chargeQuota && !consumeQuotaSql(this.db, a.tenantId, utcDay(this.clock.now()), "account")) {
        throw new QuotaExceededError(a.tenantId, "account");
      }
    });
  }

  async getForTenant(tenantId: TenantId, id: SmartAccountId) {
    return this.one("SELECT * FROM smart_accounts WHERE tenant_id = ? AND id = ?", tenantId, id);
  }

  async findForTenant(tenantId: TenantId, network: AccountNetwork, externalRef: string) {
    return this.one("SELECT * FROM smart_accounts WHERE tenant_id = ? AND network = ? AND external_ref = ?", tenantId, network, externalRef);
  }

  async getByIdempotencyKey(tenantId: TenantId, key: string) {
    return this.one("SELECT * FROM smart_accounts WHERE tenant_id = ? AND idempotency_key = ?", tenantId, key);
  }

  async listForTenant(
    tenantId: TenantId,
    filter: { network?: AccountNetwork; externalRef?: string; limit?: number; before?: { createdAt: string; id: SmartAccountId } } = {},
  ) {
    const where = ["tenant_id = ?"];
    const args: Array<string | number> = [tenantId];
    if (filter.network) (where.push("network = ?"), args.push(filter.network));
    if (filter.externalRef !== undefined) (where.push("external_ref = ?"), args.push(filter.externalRef));
    if (filter.before) (where.push("(created_at < ? OR (created_at = ? AND id < ?))"), args.push(filter.before.createdAt, filter.before.createdAt, filter.before.id));
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 200);
    const rows = this.db
      .prepare(`SELECT * FROM smart_accounts WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...args, limit) as Row[];
    return rows.map(toAccount);
  }

  async get(id: SmartAccountId) {
    return this.one("SELECT * FROM smart_accounts WHERE id = ?", id);
  }

  async findByAddress(network: AccountNetwork, address: string) {
    return this.one("SELECT * FROM smart_accounts WHERE network = ? AND lower(address) = lower(?)", network, address);
  }

  async listDue(nowIso: string, limit: number) {
    const rows = this.db
      .prepare("SELECT * FROM smart_accounts WHERE state = 'DEPLOYING' AND next_check_at <= ? ORDER BY next_check_at LIMIT ?")
      .all(nowIso, limit) as Row[];
    return rows.map(toAccount);
  }

  async update(next: StoredSmartAccount, expectedVersion: number, ev?: AccountEvent): Promise<StoredSmartAccount> {
    return tx(this.db, () => {
      const cur = this.db.prepare("SELECT * FROM smart_accounts WHERE id = ?").get(next.id) as Row | undefined;
      if (!cur) throw new AccountNotFoundError();
      if (cur.version !== expectedVersion) throw new StaleVersionError();
      if (cur.tenant_id !== next.tenantId) throw new IdentityChangeError("tenantId");
      if (cur.network !== next.network) throw new IdentityChangeError("network");
      if (String(cur.address).toLowerCase() !== next.address.toLowerCase()) throw new IdentityChangeError("address");
      if (cur.external_ref !== next.externalRef) throw new IdentityChangeError("externalRef");
      if (canonical(JSON.parse(cur.owner_json)) !== canonical(next.owner)) throw new IdentityChangeError("owner");
      if (next.state !== cur.state) {
        if (!canMoveAccount(cur.state, next.state)) throw new IllegalTransitionError(cur.state, next.state);
        if (!ev) throw new MissingEventError();
      }
      if (ev && (ev.accountId !== next.id || ev.delegationId)) throw new TypeError("the event must belong to the account");
      const res = this.db
        .prepare(
          `UPDATE smart_accounts SET state=?, code_ref=?, deploy_submission_id=?, deploy_tx_hash=?, attempts=?, next_check_at=?,
             last_error=?, updated_at=?, version=? WHERE id=? AND version=?`,
        )
        .run(
          next.state, next.codeRef, next.deploySubmissionId ?? null, next.deployTxHash ?? null, next.attempts, next.nextCheckAt,
          next.lastError ?? null, next.updatedAt, expectedVersion + 1, next.id, expectedVersion,
        );
      if (Number(res.changes) !== 1) throw new StaleVersionError();
      if (ev) appendEvent(this.db, ev);
      return toAccount(this.db.prepare("SELECT * FROM smart_accounts WHERE id = ?").get(next.id) as Row);
    });
  }

  async events(accountId: SmartAccountId) {
    const rows = this.db.prepare("SELECT * FROM account_events WHERE account_id = ? ORDER BY seq").all(accountId) as Row[];
    return rows.map(toEvent);
  }

  private one(sql: string, ...args: string[]): StoredSmartAccount | undefined {
    const r = this.db.prepare(sql).get(...args) as Row | undefined;
    return r ? toAccount(r) : undefined;
  }
}

function toAccount(r: Row): StoredSmartAccount {
  return {
    id: r.id as SmartAccountId,
    tenantId: r.tenant_id as TenantId,
    externalRef: r.external_ref,
    network: r.network,
    address: r.address,
    owner: JSON.parse(r.owner_json),
    state: r.state,
    codeRef: r.code_ref,
    ...maybe("deployTxHash", r.deploy_tx_hash),
    createdAt: r.created_at,
    salt: r.salt as Hex,
    ...maybe("deploySubmissionId", r.deploy_submission_id),
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash,
    attempts: r.attempts,
    nextCheckAt: r.next_check_at,
    ...maybe("lastError", r.last_error),
    updatedAt: r.updated_at,
    version: r.version,
  };
}

// ── Delegations ──────────────────────────────────────────────────────────────────────────────────────

const ruleToJson = (r: DelegationRule) => json(r);
function ruleFromJson(s: string): DelegationRule {
  const o = JSON.parse(s);
  return { ...o, maxPerCallAtomic: BigInt(o.maxPerCallAtomic), maxPerPeriodAtomic: BigInt(o.maxPerPeriodAtomic) };
}

export class SqliteDelegationRepository implements DelegationRepository {
  constructor(private readonly db: DatabaseSync) {}

  async insert(tenantId: TenantId, d: StoredDelegation, ev: AccountEvent): Promise<void> {
    if (ev.accountId !== d.accountId || ev.delegationId !== d.id) throw new TypeError("the creation event must belong to the delegation");
    tx(this.db, () => {
      let res;
      try {
        // Inserted FROM the account row, so a delegation can only be created on an account of this tenant.
        res = this.db
          .prepare(
            `INSERT INTO account_delegations (id, account_id, rule_json, state, onchain_ref, sign_request_json, submission_id,
               idempotency_key, request_hash, attempts, next_check_at, last_error, created_at, updated_at, version)
             SELECT ?,a.id,?,?,?,?,?,?,?,?,?,?,?,?,0 FROM smart_accounts a WHERE a.id = ? AND a.tenant_id = ?`,
          )
          .run(
            d.id, ruleToJson(d.rule), d.state, d.onchainRef ?? null, d.signRequest ? json(d.signRequest) : null,
            d.submissionId ?? null, d.idempotencyKey ?? null, d.requestHash ?? null, d.attempts, d.nextCheckAt,
            d.lastError ?? null, d.createdAt, d.updatedAt, d.accountId, tenantId,
          );
      } catch (e) {
        throw conflictOf(e) ?? e;
      }
      if (Number(res.changes) !== 1) throw new AccountNotFoundError();
      appendEvent(this.db, ev);
    });
  }

  async getForTenant(tenantId: TenantId, accountId: SmartAccountId, id: DelegationId) {
    return this.one(`${SCOPED} AND d.account_id = ? AND d.id = ?`, tenantId, accountId, id);
  }

  async listForTenant(tenantId: TenantId, accountId: SmartAccountId) {
    const rows = this.db.prepare(`${SCOPED} AND d.account_id = ? ORDER BY d.created_at, d.id`).all(tenantId, accountId) as Row[];
    return rows.map(toDelegation);
  }

  async getByIdempotencyKey(tenantId: TenantId, accountId: SmartAccountId, key: string) {
    return this.one(`${SCOPED} AND d.account_id = ? AND d.idempotency_key = ?`, tenantId, accountId, key);
  }

  async get(id: DelegationId) {
    const r = this.db.prepare("SELECT * FROM account_delegations WHERE id = ?").get(id) as Row | undefined;
    return r ? toDelegation(r) : undefined;
  }

  async findByOnchainRef(accountId: SmartAccountId, onchainRef: string) {
    const r = this.db.prepare("SELECT * FROM account_delegations WHERE account_id = ? AND onchain_ref = ?").get(accountId, onchainRef) as Row | undefined;
    return r ? toDelegation(r) : undefined;
  }

  async listDue(nowIso: string, limit: number) {
    const rows = this.db
      .prepare("SELECT * FROM account_delegations WHERE state IN ('SUBMITTED','REVOKING') AND next_check_at <= ? ORDER BY next_check_at LIMIT ?")
      .all(nowIso, limit) as Row[];
    return rows.map(toDelegation);
  }

  async update(next: StoredDelegation, expectedVersion: number, ev?: AccountEvent): Promise<StoredDelegation> {
    return tx(this.db, () => {
      const cur = this.db.prepare("SELECT * FROM account_delegations WHERE id = ?").get(next.id) as Row | undefined;
      if (!cur) throw new AccountNotFoundError();
      if (cur.version !== expectedVersion) throw new StaleVersionError();
      if (cur.account_id !== next.accountId) throw new IdentityChangeError("accountId");
      if (canonical(JSON.parse(cur.rule_json)) !== canonical(JSON.parse(ruleToJson(next.rule)))) throw new IdentityChangeError("rule");
      if (next.state !== cur.state) {
        if (!canMoveDelegation(cur.state, next.state)) throw new IllegalTransitionError(cur.state, next.state);
        if (!ev) throw new MissingEventError();
      }
      if (ev && (ev.accountId !== next.accountId || ev.delegationId !== next.id)) throw new TypeError("the event must belong to the delegation");
      let res;
      try {
        res = this.db
          .prepare(
            `UPDATE account_delegations SET state=?, onchain_ref=?, sign_request_json=?, submission_id=?, attempts=?, next_check_at=?,
               last_error=?, updated_at=?, version=? WHERE id=? AND version=?`,
          )
          .run(
            next.state, next.onchainRef ?? null, next.signRequest ? json(next.signRequest) : null, next.submissionId ?? null,
            next.attempts, next.nextCheckAt, next.lastError ?? null, next.updatedAt, expectedVersion + 1, next.id, expectedVersion,
          );
      } catch (e) {
        throw conflictOf(e) ?? e;
      }
      if (Number(res.changes) !== 1) throw new StaleVersionError();
      if (ev) appendEvent(this.db, ev);
      return toDelegation(this.db.prepare("SELECT * FROM account_delegations WHERE id = ?").get(next.id) as Row);
    });
  }

  private one(sql: string, ...args: string[]): StoredDelegation | undefined {
    const r = this.db.prepare(sql).get(...args) as Row | undefined;
    return r ? toDelegation(r) : undefined;
  }
}

/** Delegations of the accounts that belong to the tenant given as the first argument. */
const SCOPED = "SELECT d.* FROM account_delegations d JOIN smart_accounts a ON a.id = d.account_id WHERE a.tenant_id = ?";

function toDelegation(r: Row): StoredDelegation {
  return {
    id: r.id as DelegationId,
    accountId: r.account_id as SmartAccountId,
    rule: ruleFromJson(r.rule_json),
    state: r.state,
    ...maybe("onchainRef", r.onchain_ref),
    ...(r.sign_request_json ? { signRequest: JSON.parse(r.sign_request_json) as OwnerSignRequest } : {}),
    ...maybe("submissionId", r.submission_id),
    ...maybe("idempotencyKey", r.idempotency_key),
    ...maybe("requestHash", r.request_hash),
    attempts: r.attempts,
    nextCheckAt: r.next_check_at,
    ...maybe("lastError", r.last_error),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}
