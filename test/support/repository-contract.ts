import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountConflictError,
  AccountNotFoundError,
  IdentityChangeError,
  IllegalTransitionError,
  MissingEventError,
  QuotaExceededError,
  StaleVersionError,
} from "../../src/modules/accounts/domain.ts";
import { LEGACY_TENANT_ID, type TenantId } from "../../src/modules/tenants/ports.ts";
import { iso } from "../../src/shared/clock.ts";
import { accountEvent, delegationEvent, newAccount, newDelegation, type RepoFixture } from "./sca.ts";

const rejects = (p: Promise<unknown>, cls: new (...a: any[]) => Error, check?: (e: any) => boolean) =>
  assert.rejects(p, (e: unknown) => e instanceof cls && (check ? check(e) : true));

const conflict = (reason: string) => (e: AccountConflictError) => e.reason === reason;

/**
 * The behaviour every implementation of TenantRegistry, SmartAccountRepository and DelegationRepository must have
 * (plan ADR-04: the repository suite runs against both engines). Written only against the interfaces.
 */
export function defineRepositoryContract(label: string, make: () => RepoFixture): void {
  const t = (name: string, fn: (f: RepoFixture) => Promise<void>) => test(`[${label}] ${name}`, async () => fn(make()));
  const tenant = (f: RepoFixture, name: string, quota?: { accountsPerDay?: number; sponsoredOpsPerDay?: number }) => f.tenants.createTenant({ name, ...(quota ? { quota } : {}) });

  // ── Tenants and keys ───────────────────────────────────────────────────────────────────────────

  t("a key authenticates its tenant with its scopes; wrong, revoked and suspended keys do not", async (f) => {
    const a = await tenant(f, "Optus");
    const { info, key } = await f.tenants.issueKey(a.id, { label: "backend", scopes: ["accounts:read", "accounts:write"] });
    const ok = await f.tenants.authenticate(key);
    assert.equal(ok?.tenant.id, a.id);
    assert.deepEqual(ok?.scopes, ["accounts:read", "accounts:write"]);
    assert.equal(await f.tenants.authenticate(`${key}x`), undefined);
    assert.equal(await f.tenants.authenticate(""), undefined);
    assert.equal(await f.tenants.authenticate("x".repeat(5000)), undefined);

    await f.tenants.setStatus(a.id, "SUSPENDED");
    assert.equal(await f.tenants.authenticate(key), undefined, "a suspended tenant's keys stop working");
    await f.tenants.setStatus(a.id, "ACTIVE");
    assert.equal((await f.tenants.authenticate(key))?.tenant.id, a.id);

    await f.tenants.revokeKey(info.id);
    assert.equal(await f.tenants.authenticate(key), undefined);
    const listed = await f.tenants.listKeys(a.id);
    assert.equal(listed.length, 1);
    assert.ok(listed[0]!.revokedAt);
    assert.ok(!JSON.stringify(listed).includes(key), "the secret is never listed");
  });

  t("a tenant's key never authenticates as another tenant", async (f) => {
    const a = await tenant(f, "A");
    const b = await tenant(f, "B");
    const ka = await f.tenants.issueKey(a.id, { label: "a", scopes: ["payments"] });
    const kb = await f.tenants.issueKey(b.id, { label: "b", scopes: ["accounts:read"] });
    assert.equal((await f.tenants.authenticate(ka.key))?.tenant.id, a.id);
    assert.equal((await f.tenants.authenticate(kb.key))?.tenant.id, b.id);
    assert.deepEqual((await f.tenants.authenticate(kb.key))?.scopes, ["accounts:read"]);
  });

  t("tenant names are unique ignoring case, and inputs are validated", async (f) => {
    await tenant(f, "Optus");
    await assert.rejects(tenant(f, "optus"), (e: any) => e.contract?.code === "DUPLICATE");
    await assert.rejects(tenant(f, "  "), (e: any) => e.contract?.code === "INVALID_INPUT");
    await assert.rejects(tenant(f, "Q", { accountsPerDay: -1 }), (e: any) => e.contract?.code === "INVALID_INPUT");
    await assert.rejects(tenant(f, "Q2", { accountsPerDay: 1.5 }), (e: any) => e.contract?.code === "INVALID_INPUT");
    const x = await tenant(f, "X");
    await assert.rejects(f.tenants.issueKey(x.id, { label: "k", scopes: [] }), (e: any) => e.contract?.code === "INVALID_INPUT");
    await assert.rejects(f.tenants.issueKey(x.id, { label: "k", scopes: ["admin" as never] }), (e: any) => e.contract?.code === "INVALID_INPUT");
    await assert.rejects(f.tenants.issueKey("tenant_nope" as TenantId, { label: "k", scopes: ["payments"] }), (e: any) => e.contract?.code === "NOT_FOUND");
  });

  // ── Quotas ───────────────────────────────────────────────────────────────────────────────────────

  t("an exhausted quota rejects without consuming", async (f) => {
    const a = await tenant(f, "A", { accountsPerDay: 2, sponsoredOpsPerDay: 1 });
    const takes = [];
    for (let i = 0; i < 5; i++) takes.push(await f.tenants.consumeQuota(a.id, "account"));
    assert.deepEqual(takes, [true, true, false, false, false]);
    assert.deepEqual(await f.tenants.usage(a.id), { accounts: 2, operations: 0 }, "refusals are not counted");
    assert.deepEqual([await f.tenants.consumeQuota(a.id, "operation"), await f.tenants.consumeQuota(a.id, "operation")], [true, false]);
    assert.deepEqual(await f.tenants.usage(a.id), { accounts: 2, operations: 1 });
  });

  t("the quota resets at the UTC day boundary", async (f) => {
    const a = await tenant(f, "A", { accountsPerDay: 1 });
    assert.equal(await f.tenants.consumeQuota(a.id, "account"), true);
    assert.equal(await f.tenants.consumeQuota(a.id, "account"), false);
    f.clock.advance(11 * 3600_000); // 23:00 UTC, same day
    assert.equal(await f.tenants.consumeQuota(a.id, "account"), false);
    f.clock.advance(2 * 3600_000); // next day
    assert.equal(await f.tenants.consumeQuota(a.id, "account"), true);
    assert.deepEqual(await f.tenants.usage(a.id), { accounts: 1, operations: 0 }, "usage is for today only");
  });

  t("zero quota, suspended and unknown tenants are refused and count nothing", async (f) => {
    const zero = await tenant(f, "Zero", { accountsPerDay: 0, sponsoredOpsPerDay: 0 });
    assert.equal(await f.tenants.consumeQuota(zero.id, "account"), false);
    assert.equal(await f.tenants.consumeQuota(zero.id, "operation"), false);
    const s = await tenant(f, "Susp");
    await f.tenants.setStatus(s.id, "SUSPENDED");
    assert.equal(await f.tenants.consumeQuota(s.id, "account"), false);
    assert.equal(await f.tenants.consumeQuota("tenant_nope" as TenantId, "account"), false);
    assert.deepEqual(await f.tenants.usage(s.id), { accounts: 0, operations: 0 });
  });

  t("a tenant cannot count against another tenant's quota or see its usage", async (f) => {
    const a = await tenant(f, "A", { accountsPerDay: 1 });
    const b = await tenant(f, "B", { accountsPerDay: 3 });
    assert.equal(await f.tenants.consumeQuota(a.id, "account"), true);
    assert.equal(await f.tenants.consumeQuota(a.id, "account"), false, "A is out of quota");
    for (let i = 0; i < 3; i++) assert.equal(await f.tenants.consumeQuota(b.id, "account"), true, "B is not affected by A");
    assert.equal(await f.tenants.consumeQuota(b.id, "account"), false);
    assert.deepEqual(await f.tenants.usage(a.id), { accounts: 1, operations: 0 });
    assert.deepEqual(await f.tenants.usage(b.id), { accounts: 3, operations: 0 });
  });

  // ── Legacy tenant ───────────────────────────────────────────────────────────────────────────────

  t("TILCAI_API_KEYS belong to the legacy tenant with the payments scope, and follow the list", async (f) => {
    const first = await f.tenants.syncLegacyKeys(["old-key-1", "old-key-2"]);
    assert.deepEqual(first, { added: 2, revoked: 0, active: 2 });
    for (const k of ["old-key-1", "old-key-2"]) {
      const r = await f.tenants.authenticate(k);
      assert.equal(r?.tenant.id, LEGACY_TENANT_ID);
      assert.deepEqual(r?.scopes, ["payments"], "legacy keys can pay and nothing else");
    }
    assert.deepEqual(await f.tenants.syncLegacyKeys(["old-key-1", "old-key-2"]), { added: 0, revoked: 0, active: 2 }, "idempotent");
    assert.deepEqual(await f.tenants.syncLegacyKeys(["old-key-2", "new-key-3"]), { added: 1, revoked: 1, active: 2 });
    assert.equal(await f.tenants.authenticate("old-key-1"), undefined, "a key removed from TILCAI_API_KEYS stops working");
    assert.equal((await f.tenants.authenticate("new-key-3"))?.tenant.id, LEGACY_TENANT_ID);
    assert.deepEqual(await f.tenants.syncLegacyKeys(["old-key-1"]), { added: 1, revoked: 2, active: 1 }, "a removed key that comes back is reactivated");
    assert.equal((await f.tenants.authenticate("old-key-1"))?.tenant.id, LEGACY_TENANT_ID);
    assert.deepEqual(await f.tenants.syncLegacyKeys([]), { added: 0, revoked: 1, active: 0 });
  });

  t("a key issued to a tenant is never taken over by the legacy list", async (f) => {
    const a = await tenant(f, "A");
    const { key } = await f.tenants.issueKey(a.id, { label: "k", scopes: ["accounts:read"] });
    await assert.rejects(f.tenants.syncLegacyKeys([key]), (e: any) => e.contract?.code === "DUPLICATE");
    assert.equal((await f.tenants.authenticate(key))?.tenant.id, a.id, "it still authenticates as its own tenant");
  });

  // ── Accounts ─────────────────────────────────────────────────────────────────────────────────────

  t("an account round-trips with its creation event", async (f) => {
    const a = await tenant(f, "A");
    const acc = newAccount(a.id, f.clock, { deployTxHash: "tx1", deploySubmissionId: "sub1", lastError: "boom" });
    await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "created", f.clock));
    assert.deepEqual(await f.accounts.getForTenant(a.id, acc.id), acc);
    const bare = newAccount(a.id, f.clock);
    await f.accounts.insert(bare, accountEvent(bare, "DEPLOYING", "created", f.clock));
    const back = (await f.accounts.getForTenant(a.id, bare.id))!;
    assert.equal(back.deployTxHash, undefined);
    assert.equal(back.lastError, undefined);
    assert.deepEqual(back.owner, bare.owner);
    const evs = await f.accounts.events(acc.id);
    assert.deepEqual(evs.map((e) => [e.from, e.to, e.note]), [[null, "DEPLOYING", "created"]]);
  });

  t("unique guarantees: address per network, external ref per tenant and network, idempotency key per tenant", async (f) => {
    const a = await tenant(f, "A");
    const b = await tenant(f, "B");
    const base = newAccount(a.id, f.clock, { externalRef: "alice", idempotencyKey: "idem-key-1" });
    await f.accounts.insert(base, accountEvent(base, "DEPLOYING", "created", f.clock));

    const sameRef = newAccount(a.id, f.clock, { externalRef: "alice" });
    await rejects(f.accounts.insert(sameRef, accountEvent(sameRef, "DEPLOYING", "c", f.clock)), AccountConflictError, conflict("EXTERNAL_REF"));
    const otherTenantSameRef = newAccount(b.id, f.clock, { externalRef: "alice" });
    await f.accounts.insert(otherTenantSameRef, accountEvent(otherTenantSameRef, "DEPLOYING", "c", f.clock));
    const otherNetworkSameRef = newAccount(a.id, f.clock, { externalRef: "alice", network: "eip155:43113" });
    await f.accounts.insert(otherNetworkSameRef, accountEvent(otherNetworkSameRef, "DEPLOYING", "c", f.clock));

    const sameAddress = newAccount(b.id, f.clock, { address: base.address });
    await rejects(f.accounts.insert(sameAddress, accountEvent(sameAddress, "DEPLOYING", "c", f.clock)), AccountConflictError, conflict("ADDRESS"));
    const sameKey = newAccount(a.id, f.clock, { idempotencyKey: "idem-key-1" });
    await rejects(f.accounts.insert(sameKey, accountEvent(sameKey, "DEPLOYING", "c", f.clock)), AccountConflictError, conflict("IDEMPOTENCY_KEY"));
    const otherTenantSameKey = newAccount(b.id, f.clock, { idempotencyKey: "idem-key-1" });
    await f.accounts.insert(otherTenantSameKey, accountEvent(otherTenantSameKey, "DEPLOYING", "c", f.clock));

    for (const rejected of [sameRef, sameAddress, sameKey]) {
      assert.equal(await f.accounts.get(rejected.id), undefined, "a rejected account is not stored");
      assert.deepEqual(await f.accounts.events(rejected.id), [], "and neither is its event");
    }
  });

  t("EVM addresses are unique ignoring case", async (f) => {
    const a = await tenant(f, "A");
    const b = await tenant(f, "B");
    const lower = newAccount(a.id, f.clock, { network: "eip155:43113", address: `0x${"ab".repeat(20)}` });
    await f.accounts.insert(lower, accountEvent(lower, "DEPLOYING", "c", f.clock));
    const upper = newAccount(b.id, f.clock, { network: "eip155:43113", address: `0x${"AB".repeat(20)}` });
    await rejects(f.accounts.insert(upper, accountEvent(upper, "DEPLOYING", "c", f.clock)), AccountConflictError, conflict("ADDRESS"));
    assert.equal((await f.accounts.findByAddress("eip155:43113", `0x${"Ab".repeat(20)}`))?.id, lower.id);
  });

  t("a tenant cannot read another tenant's accounts", async (f) => {
    const a = await tenant(f, "A");
    const b = await tenant(f, "B");
    const acc = newAccount(a.id, f.clock, { externalRef: "alice", idempotencyKey: "idem-key-a" });
    await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "c", f.clock));
    assert.equal((await f.accounts.getForTenant(a.id, acc.id))?.id, acc.id);
    assert.equal(await f.accounts.getForTenant(b.id, acc.id), undefined, "another tenant's account is simply not found");
    assert.equal(await f.accounts.findForTenant(b.id, "stellar:testnet", "alice"), undefined);
    assert.equal(await f.accounts.getByIdempotencyKey(b.id, "idem-key-a"), undefined);
    assert.deepEqual(await f.accounts.listForTenant(b.id), []);
    assert.equal((await f.accounts.listForTenant(a.id)).length, 1);
    assert.equal((await f.accounts.findByAddress("stellar:testnet", acc.address))?.tenantId, a.id, "routing lookups say who owns it");
  });

  t("listing: newest first, filters, and a cursor that survives equal timestamps", async (f) => {
    const a = await tenant(f, "A");
    const made = [];
    for (let i = 0; i < 5; i++) {
      const acc = newAccount(a.id, f.clock, { externalRef: i === 2 ? "needle" : `u${i}`, network: i === 3 ? "eip155:43113" : "stellar:testnet" });
      await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "c", f.clock)); // same createdAt on purpose
      made.push(acc);
    }
    const seen: string[] = [];
    let before: { createdAt: string; id: any } | undefined;
    for (;;) {
      const page = await f.accounts.listForTenant(a.id, { limit: 2, ...(before ? { before } : {}) });
      if (page.length === 0) break;
      seen.push(...page.map((p) => p.id));
      const last = page[page.length - 1]!;
      before = { createdAt: last.createdAt, id: last.id };
    }
    assert.equal(new Set(seen).size, 5, "every account exactly once");
    assert.deepEqual(seen, [...seen].sort().reverse(), "newest first (ties broken by id, descending)");
    assert.deepEqual((await f.accounts.listForTenant(a.id, { externalRef: "needle" })).map((x) => x.id), [made[2]!.id]);
    assert.deepEqual((await f.accounts.listForTenant(a.id, { network: "eip155:43113" })).map((x) => x.id), [made[3]!.id]);
    assert.equal((await f.accounts.listForTenant(a.id, { limit: 0 })).length, 1, "the limit is clamped");
  });

  t("account state machine: DEPLOYING → ACTIVE | FAILED, each change with its event, both final", async (f) => {
    const a = await tenant(f, "A");
    const acc = newAccount(a.id, f.clock);
    await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "created", f.clock));

    await rejects(f.accounts.update({ ...acc, state: "ACTIVE", updatedAt: iso(f.clock.now()) }, 0), MissingEventError);
    assert.equal((await f.accounts.get(acc.id))!.state, "DEPLOYING", "a refused change leaves the account as it was");

    const active = await f.accounts.update({ ...acc, state: "ACTIVE", deployTxHash: "0xabc", updatedAt: iso(f.clock.now()) }, 0, accountEvent(acc, "ACTIVE", "code found on-chain", f.clock, "DEPLOYING"));
    assert.equal(active.version, 1);
    assert.equal(active.deployTxHash, "0xabc");
    assert.deepEqual((await f.accounts.events(acc.id)).map((e) => `${e.from}>${e.to}`), ["null>DEPLOYING", "DEPLOYING>ACTIVE"]);
    await rejects(f.accounts.update({ ...active, state: "FAILED" }, 1, accountEvent(acc, "FAILED", "x", f.clock, "ACTIVE")), IllegalTransitionError);
    await rejects(f.accounts.update({ ...active, state: "DEPLOYING" }, 1, accountEvent(acc, "DEPLOYING", "x", f.clock, "ACTIVE")), IllegalTransitionError);

    const failing = newAccount(a.id, f.clock);
    await f.accounts.insert(failing, accountEvent(failing, "DEPLOYING", "created", f.clock));
    const failed = await f.accounts.update({ ...failing, state: "FAILED", lastError: "reverted" }, 0, accountEvent(failing, "FAILED", "deployment reverted", f.clock, "DEPLOYING"));
    assert.equal(failed.state, "FAILED");
    await rejects(f.accounts.update({ ...failed, state: "ACTIVE" }, 1, accountEvent(failing, "ACTIVE", "x", f.clock, "FAILED")), IllegalTransitionError);
  });

  t("updates are optimistic: the second writer loses and writes no event", async (f) => {
    const a = await tenant(f, "A");
    const acc = newAccount(a.id, f.clock);
    await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "created", f.clock));
    const reader1 = (await f.accounts.get(acc.id))!;
    const reader2 = (await f.accounts.get(acc.id))!;
    await f.accounts.update({ ...reader1, attempts: 1 }, reader1.version);
    await rejects(f.accounts.update({ ...reader2, state: "ACTIVE" }, reader2.version, accountEvent(acc, "ACTIVE", "late", f.clock, "DEPLOYING")), StaleVersionError);
    const now = (await f.accounts.get(acc.id))!;
    assert.equal(now.state, "DEPLOYING");
    assert.equal(now.attempts, 1);
    assert.equal((await f.accounts.events(acc.id)).length, 1, "the loser's event was not written");
  });

  t("an account never changes tenant, network, address, external ref or owner", async (f) => {
    const a = await tenant(f, "A");
    const b = await tenant(f, "B");
    const acc = newAccount(a.id, f.clock);
    await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "created", f.clock));
    for (const [field, change] of [
      ["tenantId", { tenantId: b.id }],
      ["network", { network: "eip155:43113" as const }],
      ["address", { address: "CZZZ" }],
      ["externalRef", { externalRef: "someone-else" }],
      ["owner", { owner: { kind: "ed25519" as const, publicKey: `0x${"99".repeat(32)}` as any } }],
    ] as const) {
      await rejects(f.accounts.update({ ...acc, ...change } as any, 0), IdentityChangeError, (e) => e.field === field);
    }
    const same = await f.accounts.update({ ...acc, owner: { ...acc.owner } as any, attempts: 3, lastError: "retrying", nextCheckAt: "2026-10-09T00:00:00.000Z" }, 0);
    assert.equal(same.attempts, 3);
    assert.equal(same.lastError, "retrying");
  });

  t("listDue returns only DEPLOYING accounts whose check time has come", async (f) => {
    const a = await tenant(f, "A");
    const due = newAccount(a.id, f.clock, { nextCheckAt: "2026-10-08T11:00:00.000Z" });
    const later = newAccount(a.id, f.clock, { nextCheckAt: "2026-10-08T13:00:00.000Z" });
    const done = newAccount(a.id, f.clock, { nextCheckAt: "2026-10-08T11:00:00.000Z" });
    for (const x of [due, later, done]) await f.accounts.insert(x, accountEvent(x, "DEPLOYING", "c", f.clock));
    await f.accounts.update({ ...done, state: "ACTIVE" }, 0, accountEvent(done, "ACTIVE", "ok", f.clock, "DEPLOYING"));
    assert.deepEqual((await f.accounts.listDue(iso(f.clock.now()), 10)).map((x) => x.id), [due.id]);
  });

  // ── Creation against the quota ───────────────────────────────────────────────────────────────────

  t("creating an account within the quota counts once, atomically with the insert", async (f) => {
    const a = await tenant(f, "A", { accountsPerDay: 2 });
    for (let i = 0; i < 2; i++) {
      const acc = newAccount(a.id, f.clock);
      await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "c", f.clock), { chargeQuota: true });
    }
    assert.equal((await f.tenants.usage(a.id)).accounts, 2);

    const over = newAccount(a.id, f.clock);
    await rejects(f.accounts.insert(over, accountEvent(over, "DEPLOYING", "c", f.clock), { chargeQuota: true }), QuotaExceededError);
    assert.equal(await f.accounts.get(over.id), undefined, "nothing is stored when the quota is exhausted");
    assert.deepEqual(await f.accounts.events(over.id), []);
    assert.equal((await f.tenants.usage(a.id)).accounts, 2, "and nothing is consumed");
  });

  t("an idempotent replay or a conflict consumes no quota", async (f) => {
    const a = await tenant(f, "A", { accountsPerDay: 3 });
    const first = newAccount(a.id, f.clock, { idempotencyKey: "same-key-1", externalRef: "alice" });
    await f.accounts.insert(first, accountEvent(first, "DEPLOYING", "c", f.clock), { chargeQuota: true });
    assert.equal((await f.tenants.usage(a.id)).accounts, 1);
    const replay = newAccount(a.id, f.clock, { idempotencyKey: "same-key-1" });
    await rejects(f.accounts.insert(replay, accountEvent(replay, "DEPLOYING", "c", f.clock), { chargeQuota: true }), AccountConflictError);
    const dupRef = newAccount(a.id, f.clock, { externalRef: "alice" });
    await rejects(f.accounts.insert(dupRef, accountEvent(dupRef, "DEPLOYING", "c", f.clock), { chargeQuota: true }), AccountConflictError);
    assert.equal((await f.tenants.usage(a.id)).accounts, 1, "refused requests did not use the quota");
  });

  t("inserting without chargeQuota does not count; a suspended tenant cannot charge", async (f) => {
    const a = await tenant(f, "A", { accountsPerDay: 1 });
    const free = newAccount(a.id, f.clock);
    await f.accounts.insert(free, accountEvent(free, "DEPLOYING", "c", f.clock));
    assert.equal((await f.tenants.usage(a.id)).accounts, 0);
    await f.tenants.setStatus(a.id, "SUSPENDED");
    const blocked = newAccount(a.id, f.clock);
    await rejects(f.accounts.insert(blocked, accountEvent(blocked, "DEPLOYING", "c", f.clock), { chargeQuota: true }), QuotaExceededError);
  });

  t("the creation event must be the account's own", async (f) => {
    const a = await tenant(f, "A");
    const acc = newAccount(a.id, f.clock);
    const other = newAccount(a.id, f.clock);
    await assert.rejects(f.accounts.insert(acc, accountEvent(other, "DEPLOYING", "c", f.clock)), TypeError);
    assert.equal(await f.accounts.get(acc.id), undefined);
  });

  // ── Delegations ───────────────────────────────────────────────────────────────────────────────────

  t("a delegation can only be created on an account of the same tenant", async (f) => {
    const a = await tenant(f, "A");
    const b = await tenant(f, "B");
    const acc = newAccount(a.id, f.clock);
    await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "c", f.clock));

    const intruder = newDelegation(acc.id, f.clock);
    await rejects(f.delegations.insert(b.id, intruder, delegationEvent(intruder, "AWAITING_OWNER", "created", f.clock)), AccountNotFoundError);
    assert.equal(await f.delegations.get(intruder.id), undefined);
    assert.equal((await f.accounts.events(acc.id)).length, 1, "the refused delegation left no event");

    const mine = newDelegation(acc.id, f.clock);
    await f.delegations.insert(a.id, mine, delegationEvent(mine, "AWAITING_OWNER", "created", f.clock));
    assert.deepEqual(await f.delegations.getForTenant(a.id, acc.id, mine.id), mine);
    assert.equal(await f.delegations.getForTenant(b.id, acc.id, mine.id), undefined, "another tenant does not see it");
    assert.deepEqual(await f.delegations.listForTenant(b.id, acc.id), []);
    assert.equal((await f.delegations.listForTenant(a.id, acc.id)).length, 1);
    assert.equal(await f.delegations.getByIdempotencyKey(b.id, acc.id, "nope"), undefined);
  });

  t("a delegation's amounts survive beyond 2^53 and its sign request round-trips", async (f) => {
    const a = await tenant(f, "A");
    const acc = newAccount(a.id, f.clock);
    await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "c", f.clock));
    const d = newDelegation(acc.id, f.clock, { signRequest: { digest: `0x${"aa".repeat(32)}` as any, payload: "<xdr/>", expiresAt: "2026-10-08T12:10:00.000Z" }, idempotencyKey: "deleg-key-1", requestHash: "h1" });
    await f.delegations.insert(a.id, d, delegationEvent(d, "AWAITING_OWNER", "created", f.clock));
    const back = (await f.delegations.get(d.id))!;
    assert.equal(back.rule.maxPerPeriodAtomic, 12_345_678_901_234_567_890n);
    assert.equal(typeof back.rule.maxPerCallAtomic, "bigint");
    assert.deepEqual(back.signRequest, d.signRequest);
    assert.deepEqual(back.rule.payTo, d.rule.payTo);
  });

  t("delegation uniqueness: creation key per account, on-chain reference per account", async (f) => {
    const a = await tenant(f, "A");
    const acc1 = newAccount(a.id, f.clock);
    const acc2 = newAccount(a.id, f.clock);
    for (const x of [acc1, acc2]) await f.accounts.insert(x, accountEvent(x, "DEPLOYING", "c", f.clock));

    const d1 = newDelegation(acc1.id, f.clock, { idempotencyKey: "deleg-key-1" });
    await f.delegations.insert(a.id, d1, delegationEvent(d1, "AWAITING_OWNER", "created", f.clock));
    const dup = newDelegation(acc1.id, f.clock, { idempotencyKey: "deleg-key-1" });
    await rejects(f.delegations.insert(a.id, dup, delegationEvent(dup, "AWAITING_OWNER", "created", f.clock)), AccountConflictError, conflict("IDEMPOTENCY_KEY"));
    const otherAccountSameKey = newDelegation(acc2.id, f.clock, { idempotencyKey: "deleg-key-1" });
    await f.delegations.insert(a.id, otherAccountSameKey, delegationEvent(otherAccountSameKey, "AWAITING_OWNER", "created", f.clock));
    assert.equal((await f.delegations.getByIdempotencyKey(a.id, acc1.id, "deleg-key-1"))?.id, d1.id);
    const noKeyA = newDelegation(acc1.id, f.clock);
    const noKeyB = newDelegation(acc1.id, f.clock);
    for (const x of [noKeyA, noKeyB]) await f.delegations.insert(a.id, x, delegationEvent(x, "AWAITING_OWNER", "created", f.clock));

    const withRef = (await f.delegations.get(noKeyA.id))!;
    await f.delegations.update({ ...withRef, onchainRef: "ctx-rule-7" }, withRef.version);
    const other = (await f.delegations.get(noKeyB.id))!;
    await rejects(f.delegations.update({ ...other, onchainRef: "ctx-rule-7" }, other.version), AccountConflictError, conflict("ONCHAIN_REF"));
    const onOtherAccount = (await f.delegations.get(otherAccountSameKey.id))!;
    await f.delegations.update({ ...onOtherAccount, onchainRef: "ctx-rule-7" }, onOtherAccount.version);
    assert.equal((await f.delegations.findByOnchainRef(acc1.id, "ctx-rule-7"))?.id, noKeyA.id);
    assert.equal((await f.delegations.findByOnchainRef(acc2.id, "ctx-rule-7"))?.id, otherAccountSameKey.id);
  });

  t("delegation state machine, with an event for every change and in the account's log", async (f) => {
    const a = await tenant(f, "A");
    const acc = newAccount(a.id, f.clock);
    await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "created", f.clock));
    const d = newDelegation(acc.id, f.clock);
    await f.delegations.insert(a.id, d, delegationEvent(d, "AWAITING_OWNER", "created", f.clock));

    const path: Array<[StoredStates, string]> = [
      ["SUBMITTED", "owner signature sent through the relayer"],
      ["ACTIVE", "rule confirmed on-chain"],
      ["REVOKING", "owner signed the revocation"],
      ["REVOKED", "revocation confirmed"],
    ];
    let cur = (await f.delegations.get(d.id))!;
    await rejects(f.delegations.update({ ...cur, state: "SUBMITTED" }, cur.version), MissingEventError);
    for (const [to, note] of path) {
      cur = await f.delegations.update({ ...cur, state: to as any }, cur.version, delegationEvent(d, to as any, note, f.clock, cur.state));
    }
    assert.equal(cur.state, "REVOKED");
    assert.equal(cur.version, 4);
    const log = await f.accounts.events(acc.id);
    assert.deepEqual(log.map((e) => `${e.delegationId ? "d" : "a"}:${e.from}>${e.to}`), ["a:null>DEPLOYING", "d:null>AWAITING_OWNER", "d:AWAITING_OWNER>SUBMITTED", "d:SUBMITTED>ACTIVE", "d:ACTIVE>REVOKING", "d:REVOKING>REVOKED"]);
    await rejects(f.delegations.update({ ...cur, state: "ACTIVE" }, cur.version, delegationEvent(d, "ACTIVE", "x", f.clock, "REVOKED")), IllegalTransitionError);
  });

  t("delegation transitions that are not allowed are refused; a failed revocation goes back to ACTIVE", async (f) => {
    const a = await tenant(f, "A");
    const acc = newAccount(a.id, f.clock);
    await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "created", f.clock));
    const mk = async () => {
      const d = newDelegation(acc.id, f.clock);
      await f.delegations.insert(a.id, d, delegationEvent(d, "AWAITING_OWNER", "created", f.clock));
      return d;
    };
    const go = async (d: Awaited<ReturnType<typeof mk>>, to: string) => {
      const cur = (await f.delegations.get(d.id))!;
      return f.delegations.update({ ...cur, state: to as any }, cur.version, delegationEvent(d, to as any, `to ${to}`, f.clock, cur.state));
    };
    const fresh = await mk();
    await rejects(go(fresh, "ACTIVE"), IllegalTransitionError); // must be SUBMITTED first
    await rejects(go(fresh, "REVOKED"), IllegalTransitionError);
    await rejects(go(fresh, "REVOKING"), IllegalTransitionError);
    await go(fresh, "SUBMITTED");
    await go(fresh, "ACTIVE");
    await rejects(go(fresh, "REVOKED"), IllegalTransitionError); // must pass through REVOKING
    await go(fresh, "REVOKING");
    assert.equal((await go(fresh, "ACTIVE")).state, "ACTIVE", "the revocation failed on-chain: the rule still binds");

    const dead = await mk();
    await go(dead, "FAILED");
    for (const to of ["SUBMITTED", "ACTIVE", "AWAITING_OWNER"]) await rejects(go(dead, to), IllegalTransitionError);
  });

  t("a delegation's rule and account never change; its events must be its own", async (f) => {
    const a = await tenant(f, "A");
    const acc = newAccount(a.id, f.clock);
    const acc2 = newAccount(a.id, f.clock);
    for (const x of [acc, acc2]) await f.accounts.insert(x, accountEvent(x, "DEPLOYING", "c", f.clock));
    const d = newDelegation(acc.id, f.clock);
    await f.delegations.insert(a.id, d, delegationEvent(d, "AWAITING_OWNER", "created", f.clock));
    await rejects(f.delegations.update({ ...d, rule: { ...d.rule, maxPerCallAtomic: d.rule.maxPerCallAtomic + 1n } }, 0), IdentityChangeError, (e) => e.field === "rule");
    await rejects(f.delegations.update({ ...d, accountId: acc2.id }, 0), IdentityChangeError, (e) => e.field === "accountId");
    const stranger = newDelegation(acc.id, f.clock);
    await assert.rejects(f.delegations.update({ ...d, state: "SUBMITTED" }, 0, delegationEvent(stranger, "SUBMITTED", "x", f.clock, "AWAITING_OWNER")), TypeError);
    await rejects(f.delegations.update({ ...d, attempts: 1 }, 5), StaleVersionError);
  });

  t("delegations due for reconciliation are the SUBMITTED and REVOKING ones", async (f) => {
    const a = await tenant(f, "A");
    const acc = newAccount(a.id, f.clock);
    await f.accounts.insert(acc, accountEvent(acc, "DEPLOYING", "c", f.clock));
    const mk = async (to?: string) => {
      const d = newDelegation(acc.id, f.clock, { nextCheckAt: "2026-10-08T11:00:00.000Z" });
      await f.delegations.insert(a.id, d, delegationEvent(d, "AWAITING_OWNER", "created", f.clock));
      if (to) await f.delegations.update({ ...d, state: to as any }, 0, delegationEvent(d, to as any, "x", f.clock, "AWAITING_OWNER"));
      return d;
    };
    const awaiting = await mk();
    const submitted = await mk("SUBMITTED");
    const failed = await mk("FAILED");
    const due = (await f.delegations.listDue(iso(f.clock.now()), 10)).map((x) => x.id);
    assert.deepEqual(due, [submitted.id]);
    assert.ok(!due.includes(awaiting.id) && !due.includes(failed.id));
  });

  t("the legacy tenant exists from the start", async (f) => {
    const legacy = await f.tenants.get(LEGACY_TENANT_ID);
    assert.equal(legacy?.name, "legacy");
    assert.equal(legacy?.status, "ACTIVE");
  });
}

type StoredStates = "SUBMITTED" | "ACTIVE" | "REVOKING" | "REVOKED";
