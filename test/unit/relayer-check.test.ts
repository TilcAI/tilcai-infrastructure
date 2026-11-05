import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../support/relayer-check-fixture.ts", import.meta.url));
const secret = "fake-api-key-never-print-this";

async function run(scenario: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, scenario], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const failures: Array<[string, RegExp]> = [
    ["health_failed", /FAIL  GET \/api\/v1\/health/],
    ["key_missing", /FAIL  relayer API key configured/],
    ["plugin_missing", /FAIL  x402 \/supported  -> plugin id is absent/],
    ["supported_missing", /FAIL  x402 \/supported advertises stellar:testnet/],
    ["supported_invalid", /FAIL  x402 \/supported  -> invalid response/],
    ["supported_partial_invalid", /FAIL  x402 \/supported  -> invalid response/],
    ["list_empty", /FAIL  GET \/api\/v1\/relayers  -> 0 relayer\(s\)/],
    ["invalid_list", /FAIL  GET \/api\/v1\/relayers  -> invalid response/],
    ["wrong_id", /FAIL  configured Stellar relayer exists/],
    ["wrong_network", /FAIL  Stellar relayer network  -> expected testnet/],
    ["wrong_type", /FAIL  Stellar relayer type  -> expected stellar/],
    ["paused", /FAIL  Stellar relayer enabled/],
    ["disallowed", /FAIL  no mainnet relayers enabled/],
    ["account_missing", /FAIL  Stellar relayer account exists on Stellar Testnet/],
    ["account_transport", /FAIL  Stellar relayer account exists on Stellar Testnet  -> request failed/],
    ["http_auth_x402", /FAIL  x402 \/supported  -> HTTP 401/],
    ["http_500", /FAIL  x402 \/supported  -> HTTP 500/],
    ["http_auth_list", /FAIL  GET \/api\/v1\/relayers  -> HTTP 401/],
    ["http_auth_detail", /FAIL  Stellar relayer address  -> HTTP 401/],
    ["http_auth_balance", /FAIL  Stellar relayer balance  -> HTTP 401/],
    ["invalid_detail", /FAIL  Stellar relayer address  -> invalid response/],
    ["transport", /FAIL  x402 \/supported  -> request failed/],
];
for (const [scenario, expected] of failures) {
  test(`relayer:check ${scenario} exits 1 with a safe diagnostic`, async () => {
    const result = await run(scenario);
    assert.equal(result.code, 1, `${scenario}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, expected, scenario);
    assert.match(result.stderr, /relayer:check: \d+ check\(s\) failed/, scenario);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), `${scenario}: secret leaked`);
    if (scenario === "transport") assert.match(result.stdout, /FAIL  GET \/api\/v1\/relayers  -> request failed/);
  });
}

test("relayer:check accumulates independent failures, then exits nonzero", async () => {
  const { code, stdout, stderr } = await run("combined");
  assert.equal(code, 1);
  assert.match(stdout, /FAIL  GET \/api\/v1\/health/);
  assert.match(stdout, /FAIL  x402 \/supported  -> invalid response/);
  assert.match(stdout, /PASS  GET \/api\/v1\/relayers/);
  assert.match(stdout, /FAIL  no mainnet relayers enabled/);
  assert.match(stdout, /FAIL  Stellar relayer network  -> expected testnet/);
  assert.match(stderr, /relayer:check: 4 check\(s\) failed/);
  assert.doesNotMatch(`${stdout}${stderr}`, new RegExp(secret));
});

test("relayer:check succeeds only when applicable checks pass", async () => {
  for (const scenario of ["success", "mainnet_optional_plugin"]) {
    const { code, stdout, stderr } = await run(scenario);
    assert.equal(code, 0, `${scenario}: ${stdout}\n${stderr}`);
    assert.match(stdout, /PASS  Stellar relayer account exists/);
    assert.doesNotMatch(stdout, /FAIL/);
    assert.equal(stderr, "");
    assert.doesNotMatch(stdout, new RegExp(secret));
    if (scenario === "mainnet_optional_plugin") assert.match(stdout, /SKIP  x402 \/supported/);
  }
});
