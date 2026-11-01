import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../../src/db/sqlite.ts";
import { SqliteTenantRegistry } from "../../src/modules/tenants/registry.ts";
import { TestClock } from "../support/sca.ts";
import { runTenantCli } from "../../src/modules/tenants/admin-cli.ts";
import { createAppContext } from "../../src/app-context.ts";
import { loadEnv } from "../../src/config/env.ts";
import { buildServer } from "../../src/apps/api/server.ts";
import { DatabaseSync } from "node:sqlite";

const input = { label: "fexpo backend", scopes: ["payments"] as const };

test("issued keys expire, remain scoped to environment, and persist only hashes", async () => {
  const db = openDatabase(":memory:");
  try {
    const clock = new TestClock();
    const testnet = new SqliteTenantRegistry(db, clock, "testnet");
    const mainnet = new SqliteTenantRegistry(db, clock, "mainnet");
    const tenant = await testnet.createTenant({ name: "Fexpo" });
    const issued = await mainnet.issueKey(tenant.id, input);
    assert.match(issued.key, /^tilc_live_/);
    assert.equal(await testnet.authenticate(issued.key), undefined);
    assert.equal((await mainnet.authenticate(issued.key))?.tenant.id, tenant.id);
    assert.equal((await mainnet.listKeys(tenant.id))[0]!.lastUsedAt, clock.now().toISOString());
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM tenant_api_keys").all()).includes(issued.key));
    clock.advance(90 * 86_400_000);
    assert.equal(await mainnet.authenticate(issued.key), undefined);
    await assert.rejects(mainnet.issueKey(tenant.id, { ...input, expiresAt: "2026-02-30T00:00:00.000Z" }));
    await assert.rejects(mainnet.issueKey(tenant.id, { ...input, expiresAt: new Date(clock.t + 366 * 86_400_000).toISOString() }));
    await mainnet.setStatus(tenant.id, "SUSPENDED");
    await assert.rejects(mainnet.issueKey(tenant.id, input));
  } finally { db.close(); }
});

test("rotation is atomic, preserves scopes, and never extends the old expiry", async () => {
  const db = openDatabase(":memory:");
  try {
    const clock = new TestClock();
    const reg = new SqliteTenantRegistry(db, clock);
    const tenant = await reg.createTenant({ name: "Optipagos" });
    const first = await reg.issueKey(tenant.id, { ...input, expiresAt: new Date(clock.t + 60_000).toISOString() });
    const second = await reg.rotateKey(first.info.id, 3600);
    assert.deepEqual(second.info.scopes, first.info.scopes);
    assert.ok(await reg.authenticate(first.key));
    clock.advance(60_000);
    assert.equal(await reg.authenticate(first.key), undefined);
    assert.ok(await reg.authenticate(second.key));
    const third = await reg.rotateKey(second.info.id);
    assert.equal(await reg.authenticate(second.key), undefined);
    assert.ok(await reg.authenticate(third.key));
    await assert.rejects(reg.rotateKey(second.info.id));
    await assert.rejects(reg.rotateKey(third.info.id, 86401));
    db.exec("CREATE TRIGGER fail_rotate BEFORE INSERT ON tenant_key_events WHEN NEW.kind = 'rotated' BEGIN SELECT RAISE(ABORT,'injected'); END");
    await assert.rejects(reg.rotateKey(third.info.id), /injected/);
    assert.ok(await reg.authenticate(third.key));
    assert.equal((await reg.listKeys(tenant.id)).length, 3);
    assert.throws(() => db.exec("DELETE FROM tenant_key_events"), /insert-only/);
  } finally { db.close(); }
});

test("migration from schema 5 preserves issued and env keys", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db, 5);
    const { hashApiKey } = await import("../../src/modules/tenants/keys.ts");
    for (const source of ["env", "issued"]) db.prepare("INSERT INTO tenant_api_keys(id,tenant_id,key_hash,key_hint,label,scopes_json,source,created_at) VALUES (?, 'tenant_legacy', ?, 'hint','old','[\"payments\"]',?,?)").run(source, hashApiKey(source), source, new Date().toISOString());
    migrate(db);
    migrate(db);
    assert.ok(await new SqliteTenantRegistry(db).authenticate("issued"));
    const live = new SqliteTenantRegistry(db, undefined, "mainnet");
    assert.ok(await live.authenticate("env"));
    assert.equal(await live.authenticate("issued"), undefined);
  } finally { db.close(); }
});

test("operator CLI accepts expiration and rotation without exposing previous secrets", async () => {
  const db = openDatabase(":memory:");
  try {
    const reg = new SqliteTenantRegistry(db);
    const t = await reg.createTenant({ name: "Partner" });
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    assert.equal(await runTenantCli(reg, ["key", "--tenant", t.id, "--label", "k", "--scopes", "payments", "--expires-at", new Date(Date.now() + 600_000).toISOString(), "--json"], out), 0);
    const first = JSON.parse(lines.pop()!);
    assert.equal(await runTenantCli(reg, ["rotate-key", "--key", first.keyId, "--overlap-seconds", "60", "--json"], out), 0);
    const next = JSON.parse(lines.pop()!);
    assert.notEqual(first.key, next.key);
    assert.ok(next.expiresAt);
  } finally { db.close(); }
});

test("auth context accepts read-only scopes, isolates partners and rejects invalid loopback keys", async () => {
  const ctx = createAppContext("api", loadEnv({ DATABASE_PATH: ":memory:", LOG_LEVEL: "fatal" }));
  const app = buildServer(ctx);
  try {
    const a = await ctx.tenants.createTenant({ name: "Fexpo" });
    const b = await ctx.tenants.createTenant({ name: "Optipagos" });
    const ka = await ctx.tenants.issueKey(a.id, { label: "read", scopes: ["accounts:read"] });
    const kb = await ctx.tenants.issueKey(b.id, input);
    for (const [tenant, issued] of [[a, ka], [b, kb]] as const) {
      const headers = { authorization: `Bearer ${issued.key}` };
      const result = await app.inject({ url: "/v1/auth/context", headers });
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.equal(result.json().tenantId, tenant.id);
      assert.equal(result.json().credential.id, issued.info.id);
      assert.ok(!result.body.includes(issued.key));
      assert.ok(!result.body.includes("key_hash"));
      assert.equal((await app.inject({ url: "/v1/vault", headers })).statusCode, 403);
    }
    assert.equal((await app.inject({ url: "/v1/auth/context", headers: { authorization: "Bearer invalid" } })).statusCode, 401);
    await ctx.tenants.revokeKey(ka.info.id);
    assert.equal((await app.inject({ url: "/v1/auth/context", headers: { authorization: `Bearer ${ka.key}` } })).statusCode, 401);
    await ctx.tenants.setStatus(b.id, "SUSPENDED");
    assert.equal((await app.inject({ url: "/v1/auth/context", headers: { authorization: `Bearer ${kb.key}` } })).statusCode, 401);
  } finally { await app.close(); ctx.resources.stop(); ctx.db.close(); }
});
