import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createAppContext } from "../../src/app-context.ts";
import { loadEnv } from "../../src/config/env.ts";
import { LEGACY_TENANT_ID } from "../../src/modules/tenants/ports.ts";
import { tempDir } from "../support/sca.ts";

const env = (over: Record<string, string>) => loadEnv({ LOG_LEVEL: "fatal", ...over });

test("starting the app puts TILCAI_API_KEYS in the legacy tenant, with the payments scope only", async () => {
  const ctx = createAppContext("test", env({ DATABASE_PATH: ":memory:", TILCAI_API_KEYS: "legacy-key-one,legacy-key-two" }));
  for (const k of ["legacy-key-one", "legacy-key-two"]) {
    const r = await ctx.tenants.authenticate(k);
    assert.equal(r?.tenant.id, LEGACY_TENANT_ID, "Optipagos and optus-agentBE keep their identity");
    assert.deepEqual(r?.scopes, ["payments"]);
  }
  assert.equal(await ctx.tenants.authenticate("not-a-key"), undefined);
  assert.ok(ctx.accounts && ctx.delegations, "the repositories are in the context for the API");
  ctx.db.close();
});

test("the legacy keys follow TILCAI_API_KEYS across restarts: removing one revokes it", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const DATABASE_PATH = join(dir, "tilcai.db");
    const first = createAppContext("test", env({ DATABASE_PATH, TILCAI_API_KEYS: "key-a-legacy,key-b-legacy" }));
    assert.equal((await first.tenants.authenticate("key-b-legacy"))?.tenant.id, LEGACY_TENANT_ID);
    first.db.close();

    const second = createAppContext("test", env({ DATABASE_PATH, TILCAI_API_KEYS: "key-a-legacy" }));
    assert.equal((await second.tenants.authenticate("key-a-legacy"))?.tenant.id, LEGACY_TENANT_ID);
    assert.equal(await second.tenants.authenticate("key-b-legacy"), undefined, "rotating a key out of the list takes effect on restart");
    second.db.close();
  } finally {
    cleanup();
  }
});

/** Runs `fn` and returns what it wrote to stderr, where the logger puts errors. */
function stderrOf(fn: () => void): string {
  let out = "";
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => ((out += String(chunk)), true)) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = write;
  }
  return out;
}

test("a restart whose TILCAI_API_KEYS collides with an issued key refuses to start instead of keeping the removed key alive", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const DATABASE_PATH = join(dir, "tilcai.db");
    const first = createAppContext("test", env({ DATABASE_PATH, TILCAI_API_KEYS: "old-legacy-key" }));
    const tenant = await first.tenants.createTenant({ name: "Optus" });
    const { key: issued } = await first.tenants.issueKey(tenant.id, { label: "backend", scopes: ["accounts:read"] });
    first.db.close();

    // The operator retires the old key and, by mistake, lists a tenant's key: the sync rolls back as a whole,
    // so the old key would stay active if the process went on.
    let error: unknown;
    const logged = stderrOf(() => {
      try {
        createAppContext("test", env({ DATABASE_PATH, LOG_LEVEL: "error", TILCAI_API_KEYS: issued }));
      } catch (e) {
        error = e;
      }
    });
    assert.ok(error instanceof Error, "the context is not built, so nothing listens");
    assert.match(error.message, /refusing to start/);
    assert.equal((error.cause as any)?.contract?.code, "DUPLICATE");
    for (const secret of [issued, "old-legacy-key"]) {
      assert.ok(!error.message.includes(secret) && !logged.includes(secret), "no key value in the error or the logs");
    }
    assert.match(logged, /could not sync TILCAI_API_KEYS/);

    // Fixed with a fresh value, it starts: the new key is the legacy one, the old one is revoked, the tenant's key is untouched.
    const fixed = createAppContext("test", env({ DATABASE_PATH, TILCAI_API_KEYS: "new-legacy-key" }));
    assert.equal((await fixed.tenants.authenticate("new-legacy-key"))?.tenant.id, LEGACY_TENANT_ID);
    assert.equal(await fixed.tenants.authenticate("old-legacy-key"), undefined);
    assert.equal((await fixed.tenants.authenticate(issued))?.tenant.id, tenant.id);
    fixed.db.close();
  } finally {
    cleanup();
  }
});

test("a database error while syncing TILCAI_API_KEYS refuses to start", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const DATABASE_PATH = join(dir, "tilcai.db");
    const first = createAppContext("test", env({ DATABASE_PATH, TILCAI_API_KEYS: "key-a-legacy,key-b-legacy" }));
    first.db.exec("CREATE TRIGGER fail_revoke BEFORE UPDATE ON tenant_api_keys BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    first.db.close();

    assert.throws(() => createAppContext("test", env({ DATABASE_PATH, TILCAI_API_KEYS: "key-a-legacy" })), (e: any) => {
      assert.match(e.message, /refusing to start/);
      assert.match(String(e.cause?.message), /injected failure/);
      return true;
    });
  } finally {
    cleanup();
  }
});

test("with no TILCAI_API_KEYS there are no legacy keys", async () => {
  const ctx = createAppContext("test", env({ DATABASE_PATH: ":memory:" }));
  assert.equal(await ctx.tenants.authenticate("anything"), undefined);
  assert.equal((await ctx.tenants.get(LEGACY_TENANT_ID))?.status, "ACTIVE");
  ctx.db.close();
});
