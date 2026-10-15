import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { CollectionError, ProviderError, type ProviderId, type QrProvider } from "../../src/modules/qrcollect/domain.ts";
import { AtcProvider, deriveWebhookSecret } from "../../src/modules/qrcollect/providers/atc.ts";
import { BANECO_LIMITS, BanecoProvider } from "../../src/modules/qrcollect/providers/baneco.ts";
import { MockProvider } from "../../src/modules/qrcollect/providers/mock.ts";
import { registerQrCollectRoutes } from "../../src/modules/qrcollect/routes.ts";
import { SqliteCollectionRepository } from "../../src/modules/qrcollect/repository.ts";
import { QrCollectionService } from "../../src/modules/qrcollect/service.ts";
import { silentLogger } from "../../src/shared/log.ts";
import { eventsOf, qrHarness } from "../support/monitor-fakes.ts";
import { LEGACY_TENANT_ID } from "../../src/modules/tenants/ports.ts";

type Handler = (req: { url: string; method: string; headers: Record<string, string>; body: any }) => { status?: number; body: unknown } | Error;

/** A fetch that answers by route: `METHOD path-suffix` → handler. Records every call. */
function router(routes: Record<string, Handler>) {
  const calls: Array<{ key: string; url: string; headers: Record<string, string>; body: any }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const u = String(url);
    const key = Object.keys(routes).find((k) => {
      const [m, suffix] = k.split(" ") as [string, string];
      return m === method && u.includes(suffix);
    });
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? (() => { try { return JSON.parse(String(init.body)); } catch { return String(init.body); } })() : undefined;
    calls.push({ key: key ?? `${method} ${u}`, url: u, headers, body });
    if (!key) return new Response("not found", { status: 404 });
    const r = routes[key]!({ url: u, method, headers, body });
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const KEY = "40A318B299F245C2B697176723088629"; // the specification's example key
const BANECO = { baseUrl: "https://baneco.test/ApiGateway/", user: "u", password: "p", encryptionKey: KEY, paymentAccount: "1234567890", timeoutMs: 1000 };
const ATC = {
  baseUrl: "https://atc.test/sandbox/",
  clientId: "cid",
  clientSecret: "csecret",
  establishmentId: 7,
  establishmentName: "Comercio",
  webhookUrl: "https://pay.test/v1/qr/webhooks/atc",
  webhookHeader: "x-tilcai-webhook",
  webhookSecret: "s3cret",
  timeoutMs: 1000,
};
const jwt = (expInSeconds: number) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expInSeconds })).toString("base64url")}.s`;
const REQ = { reference: "123456789", amountCents: 1250, currency: "BOB" as const, description: "Pago de prueba", expiresAt: new Date("2026-10-15T20:00:00Z"), singleUse: true, modifyAmount: false };

// ── Baneco ──────────────────────────────────────────────────────────────────

test("baneco AES matches the specification's vector and round-trips", () => {
  const p = new BanecoProvider(BANECO);
  // The bank's own example: text "1234", key 40A3…8629.
  assert.equal(p.decrypt("KJAzqjmwjxIOqVo5J3IH0/7fGmNdzuyszrlqexVSeos="), "1234");
  const a = p.encrypt("1234567890");
  assert.notEqual(a, p.encrypt("1234567890"), "random IV per message");
  assert.equal(p.decrypt(a), "1234567890");
});

test("baneco: logs in once, encrypts the password and the account, sends the documented body", async () => {
  const http = router({
    "POST api/authentication/authenticate": () => ({ body: { token: jwt(1800), responseCode: 0, message: "" } }),
    "POST api/qrsimple/generateQR": () => ({ body: { qrId: "21061401016000000003", qrImage: "iVBOR", responseCode: 0, message: "" } }),
  });
  const p = new BanecoProvider(BANECO, http.impl);
  const first = await p.generate({ ...REQ, description: "x".repeat(150) });
  await p.generate(REQ);
  assert.equal(http.calls.filter((c) => c.key === "POST api/authentication/authenticate").length, 1, "token reused");
  const login = http.calls[0]!.body;
  assert.equal(login.userName, "u");
  assert.notEqual(login.password, "p");
  assert.equal(p.decrypt(login.password), "p");
  const gen = http.calls[1]!;
  assert.match(gen.headers.authorization!, /^Bearer h\./);
  assert.equal(p.decrypt(gen.body.accountCredit), "1234567890");
  assert.deepEqual(
    { ...gen.body, accountCredit: "*" },
    { transactionId: "123456789", accountCredit: "*", currency: "BOB", amount: 12.5, description: "x".repeat(BANECO_LIMITS.description), dueDate: "2026-10-15", singleUse: true, modifyAmount: false },
  );
  assert.equal(first.providerRef, "21061401016000000003");
  // The bank only takes a date: the QR lives until the end of that Bolivian day.
  assert.equal(first.expiresAt?.toISOString(), "2026-10-16T03:59:59.000Z");
});

test("baneco: field limits are checked before calling the bank", async () => {
  const http = router({});
  const longAccount = new BanecoProvider({ ...BANECO, paymentAccount: "12345678901" }, http.impl);
  await assert.rejects(longAccount.generate(REQ), (e: unknown) => e instanceof ProviderError && e.kind === "rejected" && /10 characters/.test(e.message));
  const p = new BanecoProvider(BANECO, http.impl);
  await assert.rejects(p.generate({ ...REQ, reference: "9".repeat(31) }), /transactionId exceeds 30/);
  assert.equal(http.calls.length, 0);
});

test("baneco: expired token (401) logs in again once; responseCode ≠ 0 is a rejection; 5xx and bad logins are typed", async () => {
  let logins = 0;
  let generates = 0;
  const http = router({
    "POST api/authentication/authenticate": () => ({ body: { token: jwt(1800), responseCode: 0 } }),
    "POST api/qrsimple/generateQR": () => {
      generates++;
      if (generates === 1) return { status: 401, body: {} };
      if (generates === 2) return { body: { responseCode: 12, message: "Cuenta no habilitada" } };
      return { status: 503, body: {} };
    },
  });
  const original = http.impl;
  const counting = (async (u: any, i: any) => {
    if (String(u).includes("authenticate")) logins++;
    return original(u, i);
  }) as typeof fetch;
  const p = new BanecoProvider(BANECO, counting);
  await assert.rejects(p.generate(REQ), (e: unknown) => e instanceof ProviderError && e.kind === "rejected" && /12: Cuenta no habilitada/.test(e.message));
  assert.equal(logins, 2, "one login, one after the 401");
  await assert.rejects(p.generate(REQ), (e: unknown) => e instanceof ProviderError && e.kind === "http" && e.httpStatus === 503);

  const bad = new BanecoProvider(BANECO, router({ "POST api/authentication/authenticate": () => ({ status: 401, body: { responseCode: 1, message: "Credenciales de autenticacion no validas." } }) }).impl);
  await assert.rejects(bad.generate(REQ), (e: unknown) => e instanceof ProviderError && e.kind === "auth");
  const down = new BanecoProvider(BANECO, router({ "POST api/authentication/authenticate": () => new Error("ECONNREFUSED") }).impl);
  await assert.rejects(down.generate(REQ), (e: unknown) => e instanceof ProviderError && e.kind === "network");
});

test("baneco: status codes 0/1/9, the payment of a paid QR, and cancel", async () => {
  const http = router({
    "POST api/authentication/authenticate": () => ({ body: { token: jwt(1800), responseCode: 0 } }),
    "GET statusQR/pending": () => ({ body: { statusQrCode: 0, responseCode: 0 } }),
    "GET statusQR/paid": () => ({
      body: { statusQrCode: 1, payment: [{ qrId: "paid", transactionId: "T1", paymentDate: "2021-06-14T00:00:00", paymentTime: "17:06:29", amount: 1.2, senderBankCode: "1016", senderName: "PEDRO PEREZ", senderAccount: "******1913" }], responseCode: 0 },
    }),
    "GET statusQR/void": () => ({ body: { statusQrCode: 9, responseCode: 0 } }),
    "DELETE api/qrsimple/cancelQR": () => ({ body: { responseCode: 0, message: "" } }),
  });
  const p = new BanecoProvider(BANECO, http.impl);
  assert.equal((await p.status("pending")).state, "PENDING");
  assert.equal((await p.status("void")).state, "CANCELLED");
  const paid = await p.status("paid");
  assert.equal(paid.state, "PAID");
  assert.deepEqual(paid.payment, { amountCents: 120, paidAt: "2021-06-14T17:06:29", payerName: "PEDRO PEREZ", payerBank: "1016", payerAccount: "******1913", bankReference: "T1" });
  await p.cancel("pending");
  assert.deepEqual(http.calls.at(-1)!.body, { qrId: "pending" });
});

// ── ATC ─────────────────────────────────────────────────────────────────────

test("atc: OAuth client credentials, headers, body and the simple/mld paths", async () => {
  const http = router({
    "POST oauth-client-credentials/access-token": () => ({ status: 201, body: { access_token: "tok", token_type: "Bearer", expires_in: 3600 } }),
    "POST qr/simple/v2/generate": () => ({ body: { success: true, data: { numeroReferencia: "11198511", estado: "PENDIENTE", fechaExpiracion: "2026-10-15T16:10:52", qr: "iVBOR" } } }),
    "POST qr/mld/v2/generate": () => ({ body: { success: true, data: { numeroReferencia: "11198512", estado: "PENDIENTE", qr: "iVBOR" } } }),
  });
  const simple = new AtcProvider("simple", ATC, http.impl, () => Date.parse("2026-10-15T19:00:00Z"));
  const mld = new AtcProvider("mld", ATC, http.impl, () => Date.parse("2026-10-15T19:00:00Z"));
  assert.deepEqual([simple.id, mld.id], ["atc-simple", "atc-mld"]);
  const q = await simple.generate(REQ);
  await mld.generate(REQ);
  const token = http.calls[0]!;
  assert.equal(token.headers.authorization, `Basic ${Buffer.from("cid:csecret").toString("base64")}`);
  assert.match(token.url, /\?grant_type=client_credentials$/);
  const gen = http.calls[1]!;
  assert.equal(gen.headers.access_token, "tok");
  assert.equal(gen.headers.client_id, "cid");
  assert.deepEqual(gen.body, {
    glosa: "Pago de prueba",
    moneda: "BOB",
    monto: 12.5,
    numeroReferencia: "123456789",
    vigencia: 3600,
    idEstablecimiento: 7,
    nombreEstablecimiento: "Comercio",
    webhook: { url: "https://pay.test/v1/qr/webhooks/atc", key: "x-tilcai-webhook", value: "s3cret" },
  });
  assert.equal(q.providerRef, "11198511");
  // "2026-10-15T16:10:52" is Bolivia time.
  assert.equal(q.expiresAt?.toISOString(), "2026-10-15T20:10:52.000Z");
  assert.equal(http.calls.filter((c) => c.key.includes("access-token")).length, 1, "QR Simple and QR MLD share one token");
});

test("atc: verify states, payment data, and error bodies", async () => {
  const http = router({
    "POST oauth-client-credentials": () => ({ body: { access_token: "tok", expires_in: 3600 } }),
    "GET verify/1": () => ({ body: { success: true, data: { estado: "PENDIENTE", importe: 0.1 } } }),
    "GET verify/2": () => ({
      body: {
        success: true,
        data: { estado: "PAGADO", importe: 12.5, clienteOrigen: { nombreCliente: "ANA", numeroCuenta: "***55", ciNitCliente: "1" }, bancoOrigen: { nombreBanco: "BNB", fechaTransaccion: "2026-10-15T15:00:00", numeroOrdenAch: "ACH9", codigoBanco: "1017" } },
      },
    }),
    "GET verify/3": () => ({ body: { success: true, data: { estado: "EXPIRADO" } } }),
    "GET verify/9": () => ({ status: 404, body: { success: false, message: "Error al consultar estado de QR", errors: [{ field: "numeroReferencia", message: "no existe", code: "TRANSACCION_NO_ENCONTRADA" }] } }),
    "POST qr/simple/v2/generate": () => ({ status: 500, body: { success: false, message: "Error al generar QR", errors: [{ field: "general", message: 'For input string: "1792094140434"', code: "QR_GENERATION_ERROR" }] } }),
  });
  const p = new AtcProvider("simple", ATC, http.impl);
  assert.equal((await p.status("1")).state, "PENDING");
  assert.equal((await p.status("3")).state, "EXPIRED");
  assert.deepEqual((await p.status("2")).payment, { amountCents: 1250, paidAt: "2026-10-15T15:00:00", payerName: "ANA", payerBank: "BNB", payerAccount: "***55", bankReference: "ACH9" });
  await assert.rejects(p.status("9"), (e: unknown) => e instanceof ProviderError && e.kind === "rejected" && /TRANSACCION_NO_ENCONTRADA/.test(e.message));
  await assert.rejects(p.generate(REQ), (e: unknown) => e instanceof ProviderError && e.kind === "http" && e.httpStatus === 500 && /QR_GENERATION_ERROR|Error al generar/.test(e.message));
  assert.equal((p as QrProvider).cancel, undefined, "ATC documents no cancel");
  assert.equal(AtcProvider.webhookReference({ numeroReferencia: 11198511 }), "11198511");
  assert.match(deriveWebhookSecret("x"), /^[0-9a-f]{48}$/);
});

// ── Gateway: fallback ───────────────────────────────────────────────────────

/** A scriptable provider. */
function fake(id: ProviderId, o: { configured?: boolean; failIssue?: string[] | "always"; states?: Array<string> } = {}) {
  const calls = { generate: 0, status: 0, cancel: 0 };
  const p: QrProvider & { calls: typeof calls; failing: boolean; state: "PENDING" | "PAID" | "CANCELLED" | "EXPIRED" | "ERROR"; down: boolean } = {
    id,
    label: id,
    calls,
    failing: o.failIssue === "always",
    state: "PENDING",
    down: false,
    configured: () => o.configured ?? true,
    async generate() {
      calls.generate++;
      if (p.failing) throw new ProviderError(id, "http", `${id} is down`, 503);
      return { providerRef: `${id}-${calls.generate}`, imageBase64: "iVBOR", expiresAt: null };
    },
    async status() {
      calls.status++;
      if (p.down) throw new ProviderError(id, "network", "ECONNRESET");
      return { state: p.state, message: null, payment: p.state === "PAID" ? { amountCents: 1250, paidAt: "2026-10-15T15:00:00", payerName: "ANA", payerBank: "BNB", payerAccount: null, bankReference: "ACH1" } : null };
    },
  };
  return p;
}

function gateway(providers: QrProvider[], mode: "live" | "mock" = "live") {
  const h = qrHarness();
  const service = new QrCollectionService({
    repo: new SqliteCollectionRepository(h.db),
    providers,
    mode,
    clock: h.clock,
    log: silentLogger,
    events: h.monitor,
    options: { breakerThreshold: 2, breakerCooldownMs: 60_000, pollIntervalMs: 5_000 },
  });
  return { ...h, service };
}
const ask = (service: QrCollectionService, over: Record<string, unknown> = {}) => service.create({ tenantId: LEGACY_TENANT_ID, amount: "12.50", description: "Pedido 1", ...over });

test("fallback: the principal issues when it works; the others are not asked", async () => {
  const [a, b, c] = [fake("baneco"), fake("atc-simple"), fake("atc-mld")];
  const g = gateway([a, b, c]);
  const q = await ask(g.service);
  assert.equal(q.provider, "baneco");
  assert.deepEqual([a.calls.generate, b.calls.generate, c.calls.generate], [1, 0, 0]);
  assert.deepEqual(q.attempts.map((x) => [x.provider, x.ok]), [["baneco", true]]);
  assert.equal(eventsOf(g.monitor.list({}), "qr.collection_created")[0]!.severity, "info");
});

test("fallback: it continues down the list until one provider issues, and records every attempt", async () => {
  const [a, b, c] = [fake("baneco", { failIssue: "always" }), fake("atc-simple", { failIssue: "always" }), fake("atc-mld")];
  const g = gateway([a, b, c]);
  const q = await ask(g.service);
  assert.equal(q.provider, "atc-mld");
  assert.deepEqual(q.attempts.map((x) => [x.provider, x.ok, x.kind ?? null]), [["baneco", false, "http"], ["atc-simple", false, "http"], ["atc-mld", true, null]]);
  const created = eventsOf(g.monitor.list({}), "qr.collection_created")[0]!;
  assert.equal(created.severity, "warning");
  assert.match(created.summary, /tras fallar baneco, atc-simple/);
});

test("fallback: unconfigured providers are skipped; with none left the error carries the attempts", async () => {
  const g = gateway([fake("baneco", { configured: false }), fake("atc-simple", { failIssue: "always" })]);
  await assert.rejects(ask(g.service), (e: unknown) => {
    assert.ok(e instanceof CollectionError);
    assert.equal(e.code, "ALL_PROVIDERS_FAILED");
    assert.deepEqual(e.attempts.map((x) => [x.provider, x.skipped ?? x.kind]), [["baneco", "not-configured"], ["atc-simple", "http"]]);
    return true;
  });
  assert.deepEqual(eventsOf(g.monitor.list({}), "qr.provider_failed").map((e) => e.severity), ["error"]);
});

test("fallback: a provider that fails repeatedly cools down and is tried last; success clears it", async () => {
  const [a, b] = [fake("baneco", { failIssue: "always" }), fake("atc-simple")];
  const g = gateway([a, b]);
  await ask(g.service); // baneco fails (1)
  await ask(g.service); // baneco fails (2) → cooling down
  assert.equal(a.calls.generate, 2);
  assert.equal(g.service.providers()[0]!.coolingDown, true);
  const q = await ask(g.service); // atc first now; baneco not asked at all because atc succeeds
  assert.equal(q.provider, "atc-simple");
  assert.deepEqual(q.attempts.map((x) => x.provider), ["atc-simple"]);
  assert.equal(a.calls.generate, 2);
  // After the cooldown the principal is asked first again, and one success clears its record.
  g.clock.advance(61_000);
  a.failing = false;
  assert.equal((await ask(g.service)).provider, "baneco");
  assert.equal(g.service.providers()[0]!.failures, 0);
  // If every provider is cooling down they are all still tried (an outage must not become a blackout).
  a.failing = true;
  b.failing = true;
  for (let i = 0; i < 2; i++) await assert.rejects(ask(g.service));
  assert.ok(g.service.providers().every((p) => p.coolingDown));
  b.failing = false;
  assert.equal((await ask(g.service)).provider, "atc-simple");
});

test("create validates input and is idempotent per reference", async () => {
  const a = fake("baneco");
  const g = gateway([a]);
  for (const bad of [{ amount: "0" }, { amount: "1.234" }, { amount: "abc" }, { description: "" }, { description: "x".repeat(121) }, { expiresInSeconds: 5 }]) {
    await assert.rejects(ask(g.service, bad), (e: unknown) => e instanceof CollectionError && e.code === "INVALID_INPUT", JSON.stringify(bad));
  }
  assert.equal(a.calls.generate, 0);
  const one = await ask(g.service, { reference: "ORDER-1" });
  const two = await ask(g.service, { reference: "ORDER-1" });
  assert.equal(two.id, one.id);
  assert.equal(a.calls.generate, 1);
  await assert.rejects(g.service.get("other-tenant", one.id), (e: unknown) => e instanceof CollectionError && e.code === "NOT_FOUND");
  await assert.rejects(ask(g.service, { provider: "atc-mld" }), (e: unknown) => e instanceof CollectionError && e.code === "NO_PROVIDER");
});

test("status goes to the issuing provider, marks PAID once, and survives a provider outage", async () => {
  const [a, b] = [fake("baneco", { failIssue: "always" }), fake("atc-simple")];
  const g = gateway([a, b]);
  const q = await ask(g.service);
  assert.equal(q.provider, "atc-simple");

  b.down = true;
  assert.equal((await g.service.get(LEGACY_TENANT_ID, q.id)).status, "PENDING", "outage keeps the stored state");
  assert.equal(a.calls.status, 0, "never asks a provider that did not issue it");

  b.down = false;
  b.state = "PAID";
  const paid = await g.service.get(LEGACY_TENANT_ID, q.id);
  assert.equal(paid.status, "PAID");
  assert.equal(paid.paidAmountCents, 1250);
  assert.equal(paid.payerName, "ANA");
  const calls = b.calls.status;
  await g.service.get(LEGACY_TENANT_ID, q.id);
  assert.equal(b.calls.status, calls, "a final state is not asked again");
  assert.equal(eventsOf(g.monitor.list({}), "qr.collection_paid").length, 1);
});

test("worker: processDue asks pending QRs not seen within the poll interval, and expires stale ones", async () => {
  const a = fake("baneco");
  const g = gateway([a]);
  const q = await ask(g.service, { expiresInSeconds: 120 });
  assert.equal(await g.service.processDue(), 1);
  assert.equal(await g.service.processDue(), 0, "just checked");
  g.clock.advance(6_000);
  a.state = "PAID";
  assert.equal(await g.service.processDue(), 1);
  assert.equal(g.service.find(LEGACY_TENANT_ID, q.id).status, "PAID");

  const old = await ask(g.service, { expiresInSeconds: 60, reference: "late" });
  g.clock.advance(60_000 + 61_000 + 6_000);
  a.state = "PENDING";
  await g.service.processDue();
  assert.equal(g.service.find(LEGACY_TENANT_ID, old.id).status, "EXPIRED");
});

test("cancel: calls the provider that supports it and refuses the one that does not", async () => {
  const withCancel = fake("baneco");
  withCancel.cancel = async () => void withCancel.calls.cancel++;
  const noCancel = fake("atc-simple");
  const g = gateway([withCancel, noCancel]);
  const a = await ask(g.service, { provider: "baneco" });
  const b = await ask(g.service, { provider: "atc-simple" });
  assert.equal((await g.service.cancel(LEGACY_TENANT_ID, a.id)).status, "CANCELLED");
  assert.equal(withCancel.calls.cancel, 1);
  await assert.rejects(g.service.cancel(LEGACY_TENANT_ID, b.id), (e: unknown) => e instanceof CollectionError && e.code === "UNSUPPORTED");
  await assert.rejects(g.service.cancel(LEGACY_TENANT_ID, a.id), (e: unknown) => e instanceof CollectionError && e.code === "INVALID_INPUT");
});

// ── Mock replaces the real providers ────────────────────────────────────────

test("mock mode: the mock is the only provider; a simulated deposit shows as PAID", async () => {
  const h = qrHarness();
  const service = new QrCollectionService({
    repo: new SqliteCollectionRepository(h.db),
    providers: [new MockProvider(h.mock, { email: "caja@comercio.test", password: "clave-de-prueba" })],
    mode: "mock",
    clock: h.clock,
    log: silentLogger,
    events: h.monitor,
  });
  assert.equal(service.mode, "mock");
  const q = await service.create({ tenantId: LEGACY_TENANT_ID, amount: "34.50", description: "Pedido mock" });
  assert.equal(q.provider, "mock");
  assert.equal(q.status, "PENDING");
  assert.ok(Buffer.from(q.imageBase64, "base64").subarray(1, 4).toString() === "PNG");
  await h.mock.simulateDeposit({ qrId: q.providerRef, payerName: "ANA", payerBank: "BNB" });
  const paid = await service.get(LEGACY_TENANT_ID, q.id);
  assert.equal(paid.status, "PAID");
  assert.equal(paid.paidAmountCents, 3450);
  assert.equal(paid.payerName, "ANA");
});

// ── HTTP: webhooks ──────────────────────────────────────────────────────────

test("webhooks: wrong secret → 401; right secret refreshes the matching QR from the provider", async () => {
  const b = fake("atc-simple");
  const g = gateway([b]);
  const q = await ask(g.service);
  b.state = "PAID";

  const app = Fastify();
  registerQrCollectRoutes(app, {
    service: g.service,
    tenantOf: () => LEGACY_TENANT_ID,
    webhook: { header: "x-tilcai-webhook", secret: "s3cret" },
    mock: null,
    send: (reply, status, body) => reply.code(status).send(body),
  });
  const bad = await app.inject({ method: "POST", url: "/v1/qr/webhooks/atc", headers: { "x-tilcai-webhook": "nope" }, payload: { numeroReferencia: q.providerRef } });
  assert.equal(bad.statusCode, 401);
  assert.equal(g.service.find(LEGACY_TENANT_ID, q.id).status, "PENDING");

  const ok = await app.inject({ method: "POST", url: "/v1/qr/webhooks/atc", headers: { "x-tilcai-webhook": "s3cret" }, payload: { numeroReferencia: q.providerRef, codigoRespuesta: "SUCCESS" } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { received: true, matched: true });
  assert.equal(g.service.find(LEGACY_TENANT_ID, q.id).status, "PAID");

  const baneco = await app.inject({ method: "POST", url: "/v1/qr/webhooks/baneco?key=wrong", payload: { payment: { qrId: "x" } } });
  assert.equal(baneco.statusCode, 401);

  // The public contract: create answers 201 with the image and the attempts; the providers listing shows the order.
  const created = await app.inject({ method: "POST", url: "/v1/qr", payload: { amount: "5.00", description: "HTTP" } });
  assert.equal(created.statusCode, 201);
  const body = created.json();
  assert.equal(body.provider, "atc-simple");
  assert.equal(body.amount, "5.00");
  assert.ok(body.qr_image);
  assert.equal((await app.inject({ method: "POST", url: "/v1/qr", payload: { amount: "-1", description: "x" } })).statusCode, 400);
  const list = (await app.inject({ method: "GET", url: "/v1/qr/providers" })).json();
  assert.deepEqual(list.providers.map((p: any) => [p.id, p.role]), [["atc-simple", "principal"]]);
  await app.close();
});
