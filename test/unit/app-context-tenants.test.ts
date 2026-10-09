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

test("with no TILCAI_API_KEYS there are no legacy keys", async () => {
  const ctx = createAppContext("test", env({ DATABASE_PATH: ":memory:" }));
  assert.equal(await ctx.tenants.authenticate("anything"), undefined);
  assert.equal((await ctx.tenants.get(LEGACY_TENANT_ID))?.status, "ACTIVE");
  ctx.db.close();
});
