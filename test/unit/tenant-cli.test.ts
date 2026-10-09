import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { openDatabase } from "../../src/db/sqlite.ts";
import { runTenantCli } from "../../src/modules/tenants/admin-cli.ts";
import { SqliteTenantRegistry } from "../../src/modules/tenants/registry.ts";
import { tempDir } from "../support/sca.ts";

const run = promisify(execFile);

function cli() {
  const reg = new SqliteTenantRegistry(openDatabase(":memory:"));
  const lines: string[] = [];
  const exec = async (...argv: string[]) => {
    lines.length = 0;
    const code = await runTenantCli(reg, argv, (l) => lines.push(l));
    return { code, text: lines.join("\n") };
  };
  return { reg, exec };
}
const grab = (text: string, re: RegExp): string => {
  const m = re.exec(text);
  assert.ok(m, `expected ${re} in:\n${text}`);
  return m[1]!;
};

test("create a tenant, issue a key, and the key works", async () => {
  const { reg, exec } = cli();
  const created = await exec("create", "--name", "Optus", "--accounts-per-day", "5", "--ops-per-day", "50");
  assert.equal(created.code, 0);
  const tenantId = grab(created.text, /tenant created: (tenant_[\w-]+)/);
  assert.match(created.text, /5 accounts, 50 sponsored operations/);
  assert.deepEqual((await reg.get(tenantId as never))?.quota, { accountsPerDay: 5, sponsoredOpsPerDay: 50 });

  const issued = await exec("key", "--tenant", tenantId, "--label", "backend prod", "--scopes", "accounts:read, accounts:write");
  assert.equal(issued.code, 0);
  const key = grab(issued.text, /API key: (tilc_test_\S+)/);
  assert.match(issued.text, /cannot be shown again/);
  const auth = await reg.authenticate(key);
  assert.equal(auth?.tenant.id, tenantId);
  assert.deepEqual(auth?.scopes, ["accounts:read", "accounts:write"]);
});

test("the key is shown once: nothing the CLI prints afterwards contains it", async () => {
  const { exec } = cli();
  const tenantId = grab((await exec("create", "--name", "Once")).text, /(tenant_[\w-]+)/);
  const key = grab((await exec("key", "--tenant", tenantId, "--label", "k", "--scopes", "payments")).text, /API key: (\S+)/);
  const secret = key.slice("tilc_test_".length);
  for (const args of [["list"], ["list", "--json"], ["suspend", "--tenant", tenantId], ["activate", "--tenant", tenantId]]) {
    const r = await exec(...args);
    assert.ok(!r.text.includes(secret), `"${args.join(" ")}" must not print the secret`);
  }
  const listed = await exec("list");
  assert.match(listed.text, new RegExp(`tilc_test_${secret.slice(0, 4)}…`), "only a short hint is listed");
});

test("--json output is machine readable and carries the key only when it is issued", async () => {
  const { exec } = cli();
  const created = await exec("create", "--name", "Json", "--json");
  const tenant = JSON.parse(created.text);
  assert.equal(tenant.name, "Json");
  const issued = JSON.parse((await exec("key", "--tenant", tenant.id, "--label", "k", "--scopes", "payments", "--json")).text);
  assert.match(issued.key, /^tilc_test_/);
  assert.deepEqual(issued.scopes, ["payments"]);
  const listed = JSON.parse((await exec("list", "--json")).text);
  const mine = listed.find((t: any) => t.id === tenant.id);
  assert.equal(mine.keys.length, 1);
  assert.ok(!("key" in mine.keys[0]) && !("hash" in mine.keys[0]) && !("keyHash" in mine.keys[0]));
});

test("revoke a key, suspend and activate a tenant", async () => {
  const { reg, exec } = cli();
  const tenantId = grab((await exec("create", "--name", "Ops")).text, /(tenant_[\w-]+)/);
  const issued = await exec("key", "--tenant", tenantId, "--label", "k", "--scopes", "payments");
  const key = grab(issued.text, /API key: (\S+)/);
  const keyId = grab(issued.text, /key id : (tenant_key_[\w-]+)/);

  assert.equal((await exec("suspend", "--tenant", tenantId)).code, 0);
  assert.equal(await reg.authenticate(key), undefined, "a suspended tenant's key is refused");
  assert.equal((await exec("activate", "--tenant", tenantId)).code, 0);
  assert.equal((await reg.authenticate(key))?.tenant.id, tenantId);
  assert.equal((await exec("revoke-key", "--key", keyId)).code, 0);
  assert.equal(await reg.authenticate(key), undefined);
  assert.match((await exec("list")).text, /REVOKED/);
});

test("bad input is reported with a clear message and a non-zero exit code", async () => {
  const { exec } = cli();
  const id = grab((await exec("create", "--name", "Valid")).text, /(tenant_[\w-]+)/);
  const cases: Array<[string[], number, RegExp]> = [
    [["create"], 1, /--name is required/],
    [["create", "--name", "valid"], 1, /already exists/],
    [["create", "--name", "Q", "--accounts-per-day", "many"], 1, /whole number/],
    [["key", "--tenant", id, "--label", "k", "--scopes", "admin"], 1, /subset of/],
    [["key", "--tenant", id, "--scopes", "payments"], 1, /--label is required/],
    [["key", "--tenant", "tenant_ghost", "--label", "k", "--scopes", "payments"], 1, /tenant not found/],
    [["revoke-key", "--key", "tenant_key_ghost"], 1, /key not found/],
    [["suspend", "--tenant", "tenant_ghost"], 1, /tenant not found/],
    [["frobnicate"], 64, /usage:/],
    [[], 64, /usage:/],
    [["create", "--nonsense"], 64, /usage:/],
  ];
  for (const [args, code, re] of cases) {
    const r = await exec(...args);
    assert.equal(r.code, code, args.join(" "));
    assert.match(r.text, re, args.join(" "));
  }
});

test("the real command: npm run tenant works against a database file, in separate processes", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const root = join(import.meta.dirname, "..", "..");
    const env = { ...process.env, DATABASE_PATH: join(dir, "tilcai.db"), LOG_LEVEL: "fatal" };
    const tenant = (...args: string[]) => run(process.execPath, ["--import", "tsx", "--no-warnings", join(root, "src/apps/cli/tenant.ts"), ...args], { cwd: root, env, encoding: "utf8" });

    const created = await tenant("create", "--name", "Smoke");
    const tenantId = grab(created.stdout, /(tenant_[\w-]+)/);
    const issued = await tenant("key", "--tenant", tenantId, "--label", "ci", "--scopes", "payments");
    const key = grab(issued.stdout, /API key: (\S+)/);
    const listed = await tenant("list");
    assert.match(listed.stdout, /Smoke/);
    assert.ok(!listed.stdout.includes(key.slice(10)), "a later process cannot show the key");

    const db = openDatabase(env.DATABASE_PATH);
    assert.equal((await new SqliteTenantRegistry(db).authenticate(key))?.tenant.id, tenantId, "the key issued by the CLI works for the server");
    db.close();
    await assert.rejects(tenant("key", "--tenant", "tenant_ghost", "--label", "x", "--scopes", "payments"), (e: any) => e.code === 1 && /tenant not found/.test(e.stdout));
  } finally {
    cleanup();
  }
});
