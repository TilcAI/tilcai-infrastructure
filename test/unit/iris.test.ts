import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openDatabase } from "../../src/db/sqlite.ts";
import { startWorker } from "../../src/apps/worker/loop.ts";
import type { AppContext } from "../../src/app-context.ts";
import { IrisClient, IrisError } from "../../src/modules/crosschain/cctp/iris.ts";
import { harness, MERCHANT } from "../support/fakes.ts";
import { tempDir } from "../support/sca.ts";

const quoteInput = { sourceNetwork: "eip155:43113", destinationNetwork: "stellar:testnet", amount: "1.25", payTo: MERCHANT };

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const clientFor = (body: unknown): IrisClient =>
  new IrisClient("https://iris.invalid", async () => response(body), 100);

const clientForRaw = (raw: string): IrisClient =>
  new IrisClient("https://iris.invalid", async () => new Response(raw), 100);

async function rejectsKind(run: () => Promise<unknown>, kind: IrisError["kind"]) {
  await assert.rejects(run, (e: unknown) => e instanceof IrisError && e.kind === kind);
}

function abortingFetch(start?: () => void): typeof fetch {
  return async (_input, init) => {
    const signal = init?.signal;
    start?.();
    return new Promise<Response>((_resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error("abort signal not received")), 1000);
      signal?.addEventListener("abort", () => {
        clearTimeout(watchdog);
        reject(signal.reason);
      }, { once: true });
    });
  };
}

test("H-13: one deadline aborts a hung fetch and a hung response body", async () => {
  const fetchState: { signal?: AbortSignal } = {};
  const fetchClient = new IrisClient("https://iris.invalid", async (_input, init) => {
    fetchState.signal = init?.signal ?? undefined;
    return abortingFetch()(_input, init);
  }, 30);
  await rejectsKind(() => fetchClient.lookup(1, "0x01"), "timeout");
  assert.equal(fetchState.signal?.aborted, true);

  const bodyState: { signal?: AbortSignal } = {};
  const bodyClient = new IrisClient("https://iris.invalid", async (_input, init) => {
    bodyState.signal = init?.signal ?? undefined;
    return {
      ok: true,
      status: 200,
      text: () => new Promise((_resolve, reject) => {
        const watchdog = setTimeout(() => reject(new Error("body abort signal not received")), 1000);
        bodyState.signal!.addEventListener("abort", () => {
          clearTimeout(watchdog);
          reject(bodyState.signal!.reason);
        }, { once: true });
      }),
    } as Response;
  }, 30);
  await rejectsKind(() => bodyClient.feeBpsHundredths(1, 27, 2000), "timeout");
  assert.equal(bodyState.signal?.aborted, true);
});

test("H-13: abort, HTTP, malformed JSON and malformed messages remain distinct", async () => {
  const aborted = new IrisClient("https://iris.invalid", async () => {
    throw new DOMException("cancelled", "AbortError");
  });
  await rejectsKind(() => aborted.lookup(1, "0x01"), "aborted");

  const unavailable = new IrisClient("https://iris.invalid", async () => response(null, 503));
  await rejectsKind(() => unavailable.lookup(1, "0x01"), "http");
  await rejectsKind(() => unavailable.feeBpsHundredths(1, 27, 2000), "http");

  const brokenJson = new IrisClient("https://iris.invalid", async () => new Response("{", { status: 200 }));
  await rejectsKind(() => brokenJson.lookup(1, "0x01"), "invalid_response");
  await rejectsKind(() => brokenJson.feeBpsHundredths(1, 27, 2000), "invalid_response");
  const brokenBody = new IrisClient("https://iris.invalid", async () => Object.assign(new Response("[]"), {
    text: async () => { throw new TypeError("body stream lost"); },
  }));
  await rejectsKind(() => brokenBody.feeBpsHundredths(1, 27, 2000), "network");
  await rejectsKind(() => clientFor({}).lookup(1, "0x01"), "invalid_response");
  await rejectsKind(() => clientFor({ messages: [null] }).lookup(1, "0x01"), "invalid_response");
  await rejectsKind(() => clientFor({ messages: [{ status: "" }] }).lookup(1, "0x01"), "invalid_response");
  await rejectsKind(() => clientFor({ messages: [{ status: "complete", attestation: "PENDING", message: "0x00" }] }).lookup(1, "0x01"), "invalid_response");
  assert.deepEqual(await clientFor({ messages: [] }).lookup(1, "0x01"), { kind: "not_found" });
  const missing = new IrisClient("https://iris.invalid", async () => response(null, 404));
  assert.deepEqual(await missing.lookup(1, "0x01"), { kind: "not_found" });
});

test("H-13: timeout reprograms the first payment and lets the next one advance without new submissions", async () => {
  const h = harness();
  const firstQuote = await h.svc.quote(quoteInput);
  const first = (await h.svc.createPayment({ quoteId: firstQuote.id, mode: "dev_signer", idempotencyKey: "iris-first" })).payment;
  await h.svc.step(h.svc.mustGet(first.id));
  h.clock.advance(1);
  const secondQuote = await h.svc.quote(quoteInput);
  const second = (await h.svc.createPayment({ quoteId: secondQuote.id, mode: "dev_signer", idempotencyKey: "iris-second" })).payment;
  await h.svc.step(h.svc.mustGet(second.id));
  const burns = h.evm.counter;
  const hung = new IrisClient("https://iris.invalid", abortingFetch(), 30);
  h.iris.lookup = (domain, hash) => hash === first.burnTxHash
    ? hung.lookup(domain, hash)
    : Promise.resolve({ kind: "pending", status: "pending_confirmations" });

  assert.equal(await h.svc.processDue(), 2);
  const firstAfter = h.svc.mustGet(first.id);
  const secondAfter = h.svc.mustGet(second.id);
  assert.equal(firstAfter.state, "BURN_CONFIRMED");
  assert.match(firstAfter.lastError ?? "", /timed out/);
  assert.ok(Date.parse(firstAfter.nextCheckAt) > h.clock.t);
  assert.equal(secondAfter.state, "BURN_CONFIRMED");
  assert.ok(Date.parse(secondAfter.nextCheckAt) > h.clock.t);
  assert.equal(h.evm.counter, burns);
  assert.equal(h.submitter.submits.length, 0);
});

test("H-13: HTTP and JSON failures in lookup also remain retryable", async () => {
  for (const fetchImpl of [
    async () => response(null, 503),
    async () => new Response("{", { status: 200 }),
    async () => { throw new DOMException("cancelled", "AbortError"); },
  ] satisfies Array<typeof fetch>) {
    const h = harness();
    const quote = await h.svc.quote(quoteInput);
    const payment = (await h.svc.createPayment({ quoteId: quote.id, mode: "dev_signer", idempotencyKey: "iris-retry" })).payment;
    await h.svc.step(h.svc.mustGet(payment.id));
    const client = new IrisClient("https://iris.invalid", fetchImpl, 30);
    h.iris.lookup = (domain, hash) => client.lookup(domain, hash);
    await h.svc.processDue();
    const after = h.svc.mustGet(payment.id);
    assert.equal(after.state, "BURN_CONFIRMED");
    assert.ok(Date.parse(after.nextCheckAt) > h.clock.t);
    assert.equal(h.evm.counter, 1);
    assert.equal(h.submitter.submits.length, 0);
  }
});

test("H-13: fee timeout rejects the quote before SQLite persistence", async () => {
  const h = harness();
  const hung = new IrisClient("https://iris.invalid", abortingFetch(), 30);
  h.iris.feeBpsHundredths = () => hung.feeBpsHundredths(1, 27, 2000);
  await rejectsKind(() => h.svc.quote(quoteInput), "timeout");
  assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM route_quotes").get() as { n: number }).n, 0);
});

test("H-13: worker stop finishes after an Iris deadline during reconciliation", async () => {
  const h = harness();
  const quote = await h.svc.quote(quoteInput);
  const payment = (await h.svc.createPayment({ quoteId: quote.id, mode: "dev_signer", idempotencyKey: "iris-worker" })).payment;
  await h.svc.step(h.svc.mustGet(payment.id));
  let started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  const state: { signal?: AbortSignal } = {};
  const hung = new IrisClient("https://iris.invalid", async (_input, init) => {
    state.signal = init?.signal ?? undefined;
    return abortingFetch(started)(_input, init);
  }, 30);
  h.iris.lookup = (domain, hash) => hung.lookup(domain, hash);
  const ctx = {
    crosschain: h.svc,
    vaults: {},
    accountService: null,
    qrMock: null,
    qrCollect: null,
    forwarder: null,
    env: { WORKER_POLL_MS: 1000, MONITOR_RESOURCES_INTERVAL_MS: 30_000, MONITOR_RETENTION_DAYS: 14 },
    log: { info() {}, warn() {}, error() {} },
    monitor: { subscribe: () => () => {}, setAlerts() {}, emit() {}, prune: () => 0 },
    resources: {
      snapshot: async () => ({ alerts: [], process: { rssBytes: 0 }, host: { name: "test" }, relayer: { up: true }, vault: null }),
      stop() {},
    },
  } as unknown as AppContext;
  const worker = startWorker(ctx);
  await entered;
  const start = Date.now();
  await worker.stop();
  assert.ok(Date.now() - start < 1000);
  assert.equal(state.signal?.aborted, true);
  assert.equal(h.svc.mustGet(payment.id).state, "BURN_CONFIRMED");
  assert.equal(h.submitter.submits.length, 0);
});

test("H-24: exact tier, explicit zero and conservative decimal conversion", async () => {
  const valid = [
    { finalityThreshold: 1000, minimumFee: 4 },
    { finalityThreshold: 2000, minimumFee: 1.09 },
  ];
  assert.equal(await clientFor(valid).feeBpsHundredths(1, 27, 2000), 109n);
  assert.equal(await clientFor([{ finalityThreshold: 2000, minimumFee: 0 }]).feeBpsHundredths(1, 27, 2000), 0n);
  assert.equal(await clientFor([{ finalityThreshold: 2000, minimumFee: 0.0001 }]).feeBpsHundredths(1, 27, 2000), 1n);
  assert.equal(await clientFor([{ finalityThreshold: 2000, minimumFee: 1.0901 }]).feeBpsHundredths(1, 27, 2000), 110n);
  assert.equal(await clientFor([{ finalityThreshold: 2000, minimumFee: 1.005 }]).feeBpsHundredths(1, 27, 2000), 101n);
  assert.equal(await clientFor([{ finalityThreshold: 2000, minimumFee: 1e-7 }]).feeBpsHundredths(1, 27, 2000), 1n);
  assert.equal(await clientForRaw('[{"finalityThreshold":2000,"minimumFee":1.0900000000000001}]').feeBpsHundredths(1, 27, 2000), 110n);
  assert.equal(await clientForRaw('[{"finalityThreshold":2000,"minimumFee":1e-324}]').feeBpsHundredths(1, 27, 2000), 1n);
  assert.equal(await clientForRaw('[{"finalityThreshold":2e3,"minimumFee":1.09}]').feeBpsHundredths(1, 27, 2000), 109n);
  await rejectsKind(
    () => clientForRaw('[{"finalityThreshold":2000.0000000000000001,"minimumFee":1.09}]').feeBpsHundredths(1, 27, 2000),
    "invalid_response",
  );
  await rejectsKind(
    () => clientForRaw('[{"finalityThreshold":2000,"minimumFee":1e309}]').feeBpsHundredths(1, 27, 2000),
    "invalid_response",
  );
});

test("H-24: invalid fees never persist a quote, including after SQLite reopen", async () => {
  const { dir, cleanup } = tempDir();
  const path = join(dir, "iris.sqlite");
  const db = openDatabase(path);
  let closed = false;
  try {
    const h = harness(db);
    const invalid: unknown[] = [
      null, {}, [], [{ finalityThreshold: 1000, minimumFee: 1 }],
      [{ finalityThreshold: 2000 }], [{ finalityThreshold: 2000, minimumFee: null }],
      [{ finalityThreshold: 2000, minimumFee: -1 }], [{ finalityThreshold: 2000, minimumFee: "1" }],
      [{ finalityThreshold: 2000, minimumFee: 0 }, { finalityThreshold: 2000, minimumFee: 1 }],
      [{ finalityThreshold: 2000, minimumFee: 1e100 }],
    ];
    for (const body of invalid) {
      const client = clientFor(body);
      h.iris.feeBpsHundredths = () => client.feeBpsHundredths(1, 27, 2000);
      await rejectsKind(() => h.svc.quote(quoteInput), "invalid_response");
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM route_quotes").get() as { n: number }).n, 0);
    db.close();
    closed = true;
    const reopened = openDatabase(path);
    try {
      assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM route_quotes").get() as { n: number }).n, 0);
      const valid = harness(reopened);
      valid.iris.feeBpsHundredths = () => clientFor([{ finalityThreshold: 2000, minimumFee: 1.09 }]).feeBpsHundredths(1, 27, 2000);
      const positive = await valid.svc.quote(quoteInput);
      assert.equal(positive.feeBpsHundredths, 109n);
      assert.equal(positive.maxFeeAtomic, 150n);
      valid.iris.feeBpsHundredths = () => clientFor([{ finalityThreshold: 2000, minimumFee: 0 }]).feeBpsHundredths(1, 27, 2000);
      const zero = await valid.svc.quote(quoteInput);
      assert.equal(zero.feeBpsHundredths, 0n);
      assert.equal(zero.maxFeeAtomic, 0n);
      assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM route_quotes").get() as { n: number }).n, 2);
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) db.close();
    cleanup();
  }
});
