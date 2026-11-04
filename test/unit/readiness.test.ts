import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAppContext } from "../../src/app-context.ts";
import { buildServer } from "../../src/apps/api/server.ts";
import { startWorker } from "../../src/apps/worker/loop.ts";
import { loadEnv } from "../../src/config/env.ts";
import { RelayerHttpError, type RelayerClient } from "../../src/modules/relayer/client.ts";
import { checkReadiness, type Readiness, type WorkerState } from "../../src/modules/readiness/service.ts";

const RELAYER_KEY = "relayer-key-that-must-never-show";
const OUTSIDE = "203.0.113.7";
type Listed = Awaited<ReturnType<RelayerClient["listRelayers"]>>;

const evm = (id: string, network: string, over: Partial<Listed[number]> = {}) => ({ id, name: id, network, network_type: "evm", paused: false, address: `0x${"ab".repeat(20)}`, ...over });
const stellar = (id: string, network: string, over: Partial<Listed[number]> = {}) => ({ id, name: id, network, network_type: "stellar", paused: false, address: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", ...over });

/** What deploy/relayer/config/config.json serves: the testnet relayers. */
const TESTNET = [evm("avalanche-fuji-relayer", "avalanche-fuji-testnet"), evm("monad-testnet-relayer", "monad-testnet"), stellar("stellar-example", "testnet")];
/** What deploy/relayer/config/config.mainnet.json serves, unpaused. */
const MAINNET = [evm("avalanche-mainnet-relayer", "avalanche-c-chain"), stellar("stellar-mainnet-relayer", "mainnet")];

/** A relayer that answers from a list. Read calls only: there is nothing here that sends. */
function fakeRelayer(opts: { up?: boolean; list?: Listed; listError?: Error; details?: Record<string, Record<string, unknown>> } = {}) {
  const calls = { health: 0, list: 0 };
  const relayer = {
    async health() {
      calls.health++;
      return opts.up ?? true;
    },
    async listRelayers() {
      calls.list++;
      if (opts.listError) throw opts.listError;
      return opts.list ?? TESTNET;
    },
    async getRelayer(id: string) {
      return opts.details?.[id] ?? {};
    },
  };
  return { relayer: relayer as unknown as RelayerClient, calls };
}

const mainnetEnv = (over: Record<string, string> = {}) => ({
  TILCAI_ENV: "mainnet",
  TILCAI_API_KEYS_MAINNET: "mainnet-api-key",
  DATABASE_PATH_MAINNET: ":memory:",
  // Never opened by a mainnet process; it only has to differ from the mainnet path.
  DATABASE_PATH: "unused-testnet.db",
  RELAYER_URL_MAINNET: "http://mainnet-relayer:8080",
  RELAYER_API_KEY_MAINNET: RELAYER_KEY,
  RELAYER_AVALANCHE_MAINNET_ID: "avalanche-mainnet-relayer",
  RELAYER_STELLAR_MAINNET_ID: "stellar-mainnet-relayer",
  CCTP_ROUTER_AVALANCHE_MAINNET: `0x${"11".repeat(20)}`,
  STELLAR_SIMULATION_SOURCE_MAINNET: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  RPC_AVALANCHE_MAINNET: "https://api.avax.network/ext/bc/C/rpc",
  RPC_STELLAR_MAINNET: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  HORIZON_STELLAR_MAINNET: "https://horizon.stellar.lobstr.co",
  ...over,
});

/** The real API over an in-memory database, with the relayer replaced by `relayer`. */
function api(relayer: RelayerClient, env: Record<string, string> = {}, opts: { worker?: () => WorkerState } = {}) {
  const ctx = createAppContext("api", loadEnv({ DATABASE_PATH: ":memory:", LOG_LEVEL: "fatal", TILCAI_API_KEYS: "service-key", RELAYER_API_KEY: RELAYER_KEY, ...env }));
  ctx.relayer = relayer;
  const app = buildServer(ctx, opts);
  const get = async (url: string) => {
    const res = await app.inject({ url, remoteAddress: OUTSIDE });
    assert.ok(!res.body.includes(RELAYER_KEY), "no secret in the answer");
    return { status: res.statusCode, body: res.json() as Readiness & { ok?: boolean } };
  };
  const close = async () => {
    await app.close();
    ctx.resources.stop();
    ctx.db.close();
  };
  return { ctx, get, close };
}

const failed = (r: Readiness) => r.checks.filter((c) => c.required && !c.ok).map((c) => `${c.name}: ${c.detail ?? ""}`);

test("readiness: a sound testnet relayer is ready, without credentials and with the checks it ran", async () => {
  const t = api(fakeRelayer().relayer);
  const r = await t.get("/ready");
  assert.equal(r.status, 200, failed(r.body).join(" | "));
  assert.equal(r.body.mode, "transactional");
  assert.deepEqual(
    r.body.checks.map((c) => c.name),
    ["database", "relayer.reachable", "relayer.auth", "relayer.eip155:43113", "relayer.eip155:10143", "relayer.stellar:testnet", "stellar.mintSubmitter"],
  );
  assert.match(r.body.checks.find((c) => c.name === "relayer.stellar:testnet")!.detail!, /^stellar-example: testnet, signer GA5ZSE…KZVN$/);
  await t.close();
});

test("readiness: a relayer outage fails /ready but never /health, so the platform does not restart the process", async () => {
  const t = api(fakeRelayer({ up: false }).relayer);
  const live = await t.get("/health");
  assert.equal(live.status, 200);
  assert.equal(live.body.ok, true);
  const r = await t.get("/ready");
  assert.equal(r.status, 503);
  assert.deepEqual(failed(r.body).map((f) => f.split(":")[0]), ["relayer.reachable", "relayer.auth", "relayer.eip155", "relayer.eip155", "relayer.stellar"]);
  await t.close();
});

test("readiness: a rejected relayer key, a missing relayer key and a relayer that fails to list are not ready", async () => {
  for (const [env, relayer, expected] of [
    [{}, fakeRelayer({ listError: new RelayerHttpError(401, "unauthorized") }).relayer, "key rejected (401)"],
    [{ RELAYER_API_KEY: "" }, fakeRelayer().relayer, "no relayer API key configured"],
    [{}, fakeRelayer({ listError: new RelayerHttpError(500, "boom") }).relayer, "could not list relayers (HTTP 500)"],
  ] as const) {
    const t = api(relayer, env);
    const r = await t.get("/ready");
    assert.equal(r.status, 503);
    assert.equal(r.body.checks.find((c) => c.name === "relayer.auth")?.detail, expected);
    await t.close();
  }
});

test("readiness: every relayer must exist, on its network and type, unpaused and with a signer", async () => {
  const cases: Array<[Listed, string, string]> = [
    [TESTNET.filter((r) => r.id !== "monad-testnet-relayer"), "relayer.eip155:10143", "monad-testnet-relayer: not found on this relayer"],
    [[...TESTNET.slice(0, 2), stellar("stellar-example", "mainnet")], "relayer.stellar:testnet", "stellar-example: network mainnet, expected testnet"],
    [[evm("avalanche-fuji-relayer", "avalanche-fuji-testnet", { network_type: "stellar" }), ...TESTNET.slice(1)], "relayer.eip155:43113", "avalanche-fuji-relayer: type stellar, expected evm"],
    [[evm("avalanche-fuji-relayer", "avalanche-fuji-testnet", { paused: true }), ...TESTNET.slice(1)], "relayer.eip155:43113", "avalanche-fuji-relayer: paused"],
    [[evm("avalanche-fuji-relayer", "avalanche-fuji-testnet", { address: "" }), ...TESTNET.slice(1)], "relayer.eip155:43113", "avalanche-fuji-relayer: no signer address"],
  ];
  for (const [list, name, detail] of cases) {
    const t = api(fakeRelayer({ list }).relayer);
    const r = await t.get("/ready");
    assert.equal(r.status, 503, detail);
    assert.deepEqual(failed(r.body), [`${name}: ${detail}`]);
    await t.close();
  }
  // The list may leave the address out: the relayer's own record then has to carry it.
  const fromRecord = fakeRelayer({ list: [evm("avalanche-fuji-relayer", "avalanche-fuji-testnet", { address: undefined }), ...TESTNET.slice(1)], details: { "avalanche-fuji-relayer": { address: `0x${"cd".repeat(20)}` } } });
  const t = api(fromRecord.relayer);
  assert.equal((await t.get("/ready")).status, 200);
  await t.close();
});

test("readiness: an empty relayer id is not ready", async () => {
  const t = api(fakeRelayer().relayer, { RELAYER_MONAD_TESTNET_ID: "" });
  assert.deepEqual(failed((await t.get("/ready")).body), ["relayer.eip155:10143: no relayer id configured"]);
  await t.close();
});

test("readiness: a local mint submitter needs its key", async () => {
  const t = api(fakeRelayer().relayer, { STELLAR_MINT_SUBMITTER: "local" });
  assert.deepEqual(failed((await t.get("/ready")).body), ["stellar.mintSubmitter: STELLAR_MINT_SUBMITTER=local without STELLAR_OPERATOR_SECRET"]);
  await t.close();
});

test("readiness: read-only mainnet is ready with its database alone, and reports the relayer without requiring it", async () => {
  const t = api(fakeRelayer({ up: false }).relayer, mainnetEnv());
  const r = await t.get("/ready");
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "read-only");
  assert.deepEqual(r.body.checks.map((c) => [c.name, c.ok, c.required]), [["database", true, true], ["relayer.reachable", false, false]]);
  assert.equal((await t.get("/health")).status, 200);
  await t.close();
});

test("readiness: before enabling mainnet transactions, ?mode=transactional fails on a relayer configured for testnet", async () => {
  // The shared relayer of deploy/docker-compose.yml, as docker-compose.mainnet.yml reaches it by default.
  const shared = api(fakeRelayer({ list: TESTNET }).relayer, mainnetEnv());
  const r = await shared.get("/ready?mode=transactional");
  assert.equal(r.status, 503);
  assert.deepEqual(failed(r.body), ["relayer.eip155:43114: avalanche-mainnet-relayer: not found on this relayer", "relayer.stellar:pubnet: stellar-mainnet-relayer: not found on this relayer"]);
  assert.equal((await shared.get("/ready")).status, 200, "the read-only process itself stays ready");
  await shared.close();

  // The mainnet ids, but on testnet networks: the ids alone prove nothing.
  const misnamed = api(fakeRelayer({ list: [evm("avalanche-mainnet-relayer", "avalanche-fuji-testnet"), stellar("stellar-mainnet-relayer", "testnet")] }).relayer, mainnetEnv());
  assert.deepEqual(failed((await misnamed.get("/ready?mode=transactional")).body), [
    "relayer.eip155:43114: avalanche-mainnet-relayer: network avalanche-fuji-testnet, expected avalanche-c-chain",
    "relayer.stellar:pubnet: stellar-mainnet-relayer: network testnet, expected mainnet",
  ]);
  await misnamed.close();

  // config.mainnet.json ships its relayers paused: they have to be unpaused on purpose.
  const paused = api(fakeRelayer({ list: MAINNET.map((r) => ({ ...r, paused: true })) }).relayer, mainnetEnv());
  assert.equal((await paused.get("/ready?mode=transactional")).status, 503);
  await paused.close();

  const sound = api(fakeRelayer({ list: MAINNET }).relayer, mainnetEnv());
  assert.equal((await sound.get("/ready?mode=transactional")).status, 200);
  await sound.close();
});

test("readiness: mainnet with transactions enabled requires the relayer", async () => {
  const t = api(fakeRelayer({ list: TESTNET }).relayer, mainnetEnv({ MAINNET_TRANSACTIONS_ENABLED: "true" }));
  const r = await t.get("/ready");
  assert.equal(r.status, 503);
  assert.equal(r.body.mode, "transactional");
  await t.close();
});

test("readiness: a stopped or silent worker in this process is not ready", async () => {
  const now = Date.now();
  for (const [state, ok, detail] of [
    [{ running: true, lastRoundAt: now - 1000 }, true, /^last round \d+ s ago$/],
    [{ running: false, lastRoundAt: now }, false, /^stopped$/],
    [{ running: true, lastRoundAt: now - 10 * 60_000 }, false, /^no round for \d+ s$/],
  ] as const) {
    const t = api(fakeRelayer().relayer, {}, { worker: () => state });
    const r = await t.get("/ready");
    const worker = r.body.checks.find((c) => c.name === "worker")!;
    assert.equal(r.status, ok ? 200 : 503);
    assert.equal(worker.ok, ok);
    assert.match(worker.detail!, detail);
    await t.close();
  }
});

test("readiness: answers are reused for a few seconds, an unknown mode is refused, and no key is needed", async () => {
  const fake = fakeRelayer();
  const t = api(fake.relayer);
  await t.get("/ready");
  await t.get("/ready");
  assert.equal(fake.calls.list, 1, "a public probe does not hit the relayer on every call");
  const bad = await t.get("/ready?mode=everything");
  assert.equal(bad.status, 400);
  await t.close();
});

test("readiness: a relayer that does not answer is a failed check within the timeout, not a hung probe", async () => {
  const db = new DatabaseSync(":memory:");
  const hung = { health: () => new Promise<boolean>(() => {}), listRelayers: () => new Promise<never>(() => {}), getRelayer: () => new Promise<never>(() => {}) };
  const started = Date.now();
  const r = await checkReadiness(
    { db, relayer: hung, relayerApiKeySet: true, relayers: [], mintSubmitter: { kind: "relayer", localKeySet: false }, workerMaxSilenceMs: 1000, timeoutMs: 50 },
    "transactional",
  );
  assert.ok(Date.now() - started < 2000);
  assert.equal(r.ready, false);
  assert.equal(r.checks.find((c) => c.name === "relayer.reachable")?.ok, false);
  db.close();
});

test("readiness: the real worker reports its rounds while it runs and that it stopped after stop()", async () => {
  const ctx = createAppContext("tilcai", loadEnv({ DATABASE_PATH: ":memory:", LOG_LEVEL: "fatal", WORKER_POLL_MS: "500" }));
  const worker = startWorker(ctx);
  const first = worker.state();
  assert.equal(first.running, true);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(worker.state().lastRoundAt > first.lastRoundAt, "each round moves lastRoundAt");
  await worker.stop();
  assert.equal(worker.state().running, false);
  ctx.db.close();
});
