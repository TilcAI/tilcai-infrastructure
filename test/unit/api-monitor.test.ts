import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createAppContext } from "../../src/app-context.ts";
import { buildServer } from "../../src/apps/api/server.ts";
import { loadEnv } from "../../src/config/env.ts";
import type { MonitorEvent } from "../../src/modules/monitor/domain.ts";

const API_KEY = "clave-de-servicio-de-prueba";
const OUTSIDE = "203.0.113.7";
const QR = { QR_MOCK_ENABLED: "true", QR_MOCK_EMAIL: "caja@comercio.test", QR_MOCK_PASSWORD: "clave-de-prueba", QR_MOCK_PUBLIC_URL: "https://tilcai.test" };

/** The real API over an in-memory database. Nothing here reaches the relayer or the chain. */
function api(env: Record<string, string> = {}) {
  const ctx = createAppContext("api", loadEnv({ DATABASE_PATH: ":memory:", LOG_LEVEL: "fatal", TILCAI_API_KEYS: API_KEY, ...env }));
  const app = buildServer(ctx);
  const auth = { authorization: `Bearer ${API_KEY}` };
  const events = async (query = "") => ((await app.inject({ url: `/v1/monitor/events${query}`, headers: auth })).json() as { events: MonitorEvent[] }).events;
  const close = async () => {
    await app.close();
    ctx.resources.stop();
    ctx.db.close();
  };
  return { ctx, app, auth, events, close };
}

const vendisDate = (minutesFromNow: number) => new Date(Date.now() + minutesFromNow * 60_000 - 4 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
const qrBody = (over: Record<string, unknown> = {}) => ({ device_id: 17, amount: 23.84, modify_amount: false, is_multi_use: false, qr_expiration: vendisDate(30), description: "Pago QR OP-TEST0001", ...over });

async function vendisToken(app: ReturnType<typeof api>["app"]) {
  const res = await app.inject({ method: "POST", url: "/mock/vendis/api/v1/login", remoteAddress: OUTSIDE, payload: { email: QR.QR_MOCK_EMAIL, password: QR.QR_MOCK_PASSWORD, token_name: "t" } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { access_token: string }).access_token;
}

test("monitor API: needs a service key, pages by position and filters", async () => {
  const t = api();
  t.ctx.monitor.emit({ type: "system.started", summary: "arriba" });
  t.ctx.monitor.emit({ type: "vault.disbursement.rejected", severity: "error", summary: "sin fondos" });
  t.ctx.monitor.emit({ type: "qr.paid", source: "qr-simple", summary: "depósito" });

  assert.equal((await t.app.inject({ url: "/v1/monitor/events", remoteAddress: OUTSIDE })).statusCode, 401);
  assert.equal((await t.app.inject({ url: "/v1/monitor/stream", remoteAddress: OUTSIDE })).statusCode, 401);
  assert.equal((await t.app.inject({ url: "/v1/monitor/resources", headers: { authorization: "Bearer otra" } })).statusCode, 401);

  const res = await t.app.inject({ url: "/v1/monitor/events", headers: t.auth });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { schema: string; head: number; events: MonitorEvent[] };
  assert.deepEqual([body.schema, body.head, body.events.map((e) => e.type)], ["tilcai-monitor-v1", 3, ["system.started", "vault.disbursement.rejected", "qr.paid"]]);
  assert.deepEqual((await t.events("?after=1")).map((e) => e.seq), [2, 3]);
  assert.deepEqual((await t.events("?limit=1")).map((e) => e.seq), [3]);
  assert.deepEqual((await t.events("?type=vault.")).map((e) => e.seq), [2]);
  assert.deepEqual((await t.events("?source=qr-simple")).map((e) => e.seq), [3]);
  assert.deepEqual((await t.events("?severity=error&after=0")).map((e) => e.seq), [2]);
  assert.equal((await t.app.inject({ url: "/v1/monitor/events?limit=0", headers: t.auth })).statusCode, 400);
  assert.equal((await t.app.inject({ url: "/v1/monitor/events?type=DROP%20TABLE", headers: t.auth })).statusCode, 400);
  await t.close();
});

test("monitor API: the stream sends what is in the log and what arrives while it is open", async () => {
  const t = api();
  t.ctx.monitor.emit({ type: "system.started", summary: "antes" });
  await t.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (t.app.server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/monitor/stream?after=0`, { headers: t.auth });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  const reader = res.body!.getReader();
  let text = "";
  const readUntil = async (marker: string) => {
    while (!text.includes(marker)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before "${marker}"`);
      text += Buffer.from(value).toString("utf8");
    }
  };
  await readUntil('"summary":"antes"');
  t.ctx.monitor.emit({ type: "qr.paid", source: "qr-simple", summary: "durante" });
  await readUntil('"summary":"durante"');
  assert.match(text, /^retry: 3000\n\n/);
  assert.match(text, /id: 1\nevent: monitor\ndata: \{"seq":1,/);
  assert.match(text, /id: 2\nevent: monitor\ndata: \{"seq":2,/);
  await reader.cancel();
  await t.close();
});

test("monitor API: a failing dependency is announced once a minute, not once per request", async () => {
  const t = api();
  // No vault configured: every call answers 503.
  for (let i = 0; i < 3; i++) assert.equal((await t.app.inject({ url: "/v1/vault", headers: t.auth })).statusCode, 503);
  // A caller's own mistake is not an operational event.
  assert.equal((await t.app.inject({ url: "/v1/crosschain/quotes/nope", headers: t.auth })).statusCode, 400);
  const rejected = await t.events("?type=api.request_rejected");
  assert.equal(rejected.length, 1);
  assert.deepEqual([rejected[0]!.severity, rejected[0]!.subject, rejected[0]!.data.code, rejected[0]!.data.status], ["error", "GET /v1/vault", "SERVICE_UNAVAILABLE", 503]);
  await t.close();
});

const sign = (key: string, body: string) => createHmac("sha256", key).update(body).digest("base64");
const notification = JSON.stringify({
  id: "5f1c1c9a-0000-4000-8000-0000000000aa",
  event: "transaction_update",
  payload: { payload_type: "transaction", id: "tx-1", hash: "0xabc123", status: "mined", from: "0xcc0b", to: "0x841d", relayer_id: "avalanche-fuji-relayer", created_at: "2026-10-09T07:00:00Z" },
  timestamp: "2026-10-09T07:00:05+00:00",
});

test("relayer webhook: signed by the relayer it is stored once; anything else is refused", async () => {
  const t = api({ RELAYER_WEBHOOK_SIGNING_KEY: "whsec-prueba" });
  const post = (body: string, signature?: string, remoteAddress = OUTSIDE) =>
    t.app.inject({ method: "POST", url: "/v1/webhooks/relayer", remoteAddress, headers: { "content-type": "application/json", ...(signature ? { "x-signature": signature } : {}) }, payload: body });

  assert.equal((await post(notification)).statusCode, 401);
  assert.equal((await post(notification, sign("otra-clave", notification))).statusCode, 401);
  // A TilcAI key does not replace the relayer's signature, and loopback is no exception once a key is set.
  assert.equal((await t.app.inject({ method: "POST", url: "/v1/webhooks/relayer", headers: { ...t.auth, "content-type": "application/json" }, payload: notification })).statusCode, 401);
  assert.equal((await post(notification.replace("mined", "confirmed"), sign("whsec-prueba", notification))).statusCode, 401);
  assert.equal((await t.events()).length, 0);

  const ok = await post(notification, sign("whsec-prueba", notification));
  assert.deepEqual([ok.statusCode, ok.json()], [200, { ok: true, stored: true }]);
  // The relayer retries a delivery it thinks failed: accepted, not stored again.
  assert.deepEqual((await post(notification, sign("whsec-prueba", notification))).json(), { ok: true, stored: false });
  const [event] = await t.events("?type=relayer.");
  assert.deepEqual([event!.type, event!.source, event!.subject, event!.data.status, event!.data.hash], ["relayer.transaction_update", "relayer", "tx-1", "mined", "0xabc123"]);
  assert.equal((await t.events()).length, 1);

  for (const bad of ["{no es json", JSON.stringify({ event: "x" }), "[]"]) assert.equal((await post(bad, sign("whsec-prueba", bad))).statusCode, 400, bad);
  await t.close();
});

test("relayer webhook: without a signing key only the relayer on this host is trusted", async () => {
  const t = api();
  const headers = { "content-type": "application/json" };
  assert.equal((await t.app.inject({ method: "POST", url: "/v1/webhooks/relayer", remoteAddress: OUTSIDE, headers, payload: notification })).statusCode, 401);
  assert.equal((await t.app.inject({ method: "POST", url: "/v1/webhooks/relayer", headers, payload: notification })).statusCode, 200);
  assert.equal((await t.events("?type=relayer.transaction_update")).length, 1);
  await t.close();
});

test("relayer webhook: the transaction is tied to the payout TilcAI sent with it", async () => {
  const t = api();
  t.ctx.db
    .prepare(
      `INSERT INTO vault_disbursements (id, state, network, vault, to_address, amount_atomic, idempotency_key, request_hash, submission_id, from_block, next_check_at, created_at, updated_at)
       VALUES ('vault_disbursement_x1', 'SUBMITTED', 'eip155:43113', '0x841d', '0xb1', '1000000', 'k-1', 'h', 'tx-1', '1', 't', 't', 't')`,
    )
    .run();
  await t.app.inject({ method: "POST", url: "/v1/webhooks/relayer", headers: { "content-type": "application/json" }, payload: notification });
  assert.deepEqual((await t.events("?type=relayer.transaction_update"))[0]!.data.related, { kind: "vault_disbursement", id: "vault_disbursement_x1" });
  await t.close();
});

test("QR mock over HTTP: Vendis's endpoints with Vendis's tokens, from login to a paid QR", async () => {
  const t = api(QR);
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => t.app.inject({ method: "POST", url: `/mock/vendis${url}`, remoteAddress: OUTSIDE, headers, payload: payload as object });

  const denied = await post("/api/v1/login", { email: QR.QR_MOCK_EMAIL, password: "mala" });
  assert.deepEqual([denied.statusCode, denied.json()], [401, { message: "Credenciales Inválidos" }]);
  const token = await vendisToken(t.app);
  const bearer = { authorization: `Bearer ${token}` };

  // TilcAI's own key is not a Vendis token.
  assert.deepEqual([(await post("/api/v1/devices/simple-qr/generate", qrBody(), t.auth)).statusCode, (await post("/api/v1/devices/simple-qr/generate", qrBody())).json()], [401, { message: "Unauthenticated." }]);
  const invalid = await post("/api/v1/devices/simple-qr/generate", qrBody({ amount: "x" }), bearer);
  assert.equal(invalid.statusCode, 422);
  assert.deepEqual([invalid.json().success, invalid.json().message], [false, "Ocurrió un error al generar el QR"]);
  assert.equal((await t.app.inject({ method: "POST", url: "/mock/vendis/api/v1/devices/simple-qr/generate", headers: { ...bearer, "content-type": "application/json" }, payload: "{mal" })).statusCode, 400);

  const created = await post("/api/v1/devices/simple-qr/generate", qrBody(), bearer);
  assert.equal(created.statusCode, 200);
  const { success, data } = created.json() as { success: boolean; data: { qr_image: string; qr_url: string; qr_id: number } };
  assert.equal(success, true);
  assert.match(data.qr_url, new RegExp(`^https://tilcai\\.test/mock/vendis/qr-image/${data.qr_id}-[0-9a-f]{16}\\.png$`));

  const image = await t.app.inject({ url: new URL(data.qr_url).pathname, remoteAddress: OUTSIDE });
  assert.deepEqual([image.statusCode, image.headers["content-type"]], [200, "image/png"]);
  assert.deepEqual(image.rawPayload, Buffer.from(data.qr_image, "base64"));
  assert.equal((await t.app.inject({ url: `/mock/vendis/qr-image/${data.qr_id}-0000000000000000.png` })).statusCode, 404);

  const status = () => t.app.inject({ url: `/mock/vendis/api/v1/devices/simple-qr/get/${data.qr_id}`, remoteAddress: OUTSIDE, headers: bearer });
  assert.deepEqual((await status()).json(), { success: true, data: { status: "Pendiente", payments: [] } });
  assert.equal((await t.app.inject({ url: `/mock/vendis/api/v1/devices/simple-qr/get/${data.qr_id}`, remoteAddress: OUTSIDE })).statusCode, 401);
  const missing = await t.app.inject({ url: "/mock/vendis/api/v1/devices/simple-qr/get/1", headers: bearer });
  assert.deepEqual([missing.statusCode, missing.json()], [404, { success: false, message: "QR no encontrado" }]);

  const paid = await t.app.inject({ method: "POST", url: "/mock/vendis/simulate/deposit", payload: { qr_id: data.qr_id } });
  assert.equal(paid.statusCode, 200);
  assert.deepEqual([paid.json().success, paid.json().data.status, paid.json().data.callback.state], [true, "Pagado", "SKIPPED"]);
  const after = (await status()).json() as { data: { status: string; payments: Array<Record<string, string>> } };
  assert.equal(after.data.status, "Pagado");
  assert.deepEqual([after.data.payments[0]!.payment_amount, after.data.payments[0]!.qr_id], ["23.84", String(data.qr_id)]);
  assert.equal((await t.app.inject({ method: "POST", url: "/mock/vendis/simulate/deposit", payload: { qr_id: data.qr_id } })).statusCode, 409);

  assert.deepEqual((await t.events("?source=qr-simple")).map((e) => e.type), ["qr.token_issued", "qr.created", "qr.paid"]);
  await t.close();
});

test("QR mock simulator: the host itself, the simulator key or a service key; nobody else", async () => {
  const t = api({ ...QR, QR_MOCK_SIMULATOR_KEY: "llave-del-simulador" });
  const token = await vendisToken(t.app);
  await t.app.inject({ method: "POST", url: "/mock/vendis/api/v1/devices/simple-qr/generate", headers: { authorization: `Bearer ${token}` }, payload: qrBody() });
  const page = (query = "", remoteAddress = OUTSIDE, headers: Record<string, string> = {}) => t.app.inject({ url: `/mock/vendis/${query}`, remoteAddress, headers });

  assert.equal((await page()).statusCode, 401);
  assert.equal((await page("?key=otra")).statusCode, 401);
  // A Vendis token is the caller's credential, not the operator's.
  assert.equal((await page("", OUTSIDE, { authorization: `Bearer ${token}` })).statusCode, 401);
  assert.equal((await t.app.inject({ method: "POST", url: "/mock/vendis/simulate/deposit", remoteAddress: OUTSIDE, payload: {} })).statusCode, 401);
  assert.equal((await t.app.inject({ url: "/mock/vendis/simulate/pending", remoteAddress: OUTSIDE })).statusCode, 401);

  const html = await page("?key=llave-del-simulador");
  assert.equal(html.statusCode, 200);
  assert.match(String(html.headers["content-type"]), /^text\/html/);
  assert.match(String(html.headers["content-security-policy"]), /script-src 'nonce-[^']+'/);
  assert.equal((html.body.match(/<button/g) ?? []).length, 1);
  assert.match(html.body, />Simular depósito<\/button>/);
  assert.match(html.body, /Bs 23\.84/);
  assert.equal((await page("", "127.0.0.1")).statusCode, 200);
  assert.equal((await t.app.inject({ url: "/mock/vendis", remoteAddress: "127.0.0.1" })).statusCode, 200);
  assert.equal((await page("", OUTSIDE, t.auth)).statusCode, 200);

  const pending = await t.app.inject({ url: "/mock/vendis/simulate/pending?key=llave-del-simulador", remoteAddress: OUTSIDE });
  assert.equal((pending.json() as { data: unknown[] }).data.length, 1);
  // The button, pressed from outside with the key: pays the QR on screen.
  const paid = await t.app.inject({ method: "POST", url: "/mock/vendis/simulate/deposit?key=llave-del-simulador", remoteAddress: OUTSIDE, payload: {} });
  assert.deepEqual([paid.statusCode, paid.json().data.status], [200, "Pagado"]);
  const nothing = await t.app.inject({ method: "POST", url: "/mock/vendis/simulate/deposit", payload: {} });
  assert.deepEqual([nothing.statusCode, nothing.json().message], [404, "No hay ningún QR pendiente de pago"]);
  await t.close();
});

test("QR mock: switched off, its paths do not exist and the health check says so", async () => {
  const t = api();
  assert.equal((await t.app.inject({ method: "POST", url: "/mock/vendis/api/v1/login", payload: {} })).statusCode, 404);
  assert.equal((await t.app.inject({ url: "/mock/vendis/" })).statusCode, 404);
  // The rest of the API still asks for its key on paths that merely look similar.
  assert.equal((await t.app.inject({ url: "/mock/vendisx", remoteAddress: OUTSIDE })).statusCode, 401);
  await t.close();
});

test("configuration: the mock needs credentials and the push needs a secret", () => {
  assert.throws(() => loadEnv({ QR_MOCK_ENABLED: "true" }), /QR_MOCK_EMAIL, QR_MOCK_PASSWORD/);
  assert.throws(() => loadEnv({ QR_MOCK_ENABLED: "true", QR_MOCK_EMAIL: "a@b.c", QR_MOCK_PASSWORD: "corta" }), /QR_MOCK_PASSWORD/);
  assert.throws(() => loadEnv({ MONITOR_WEB_URL: "https://web.test/api/monitor/events" }), /MONITOR_WEB_SECRET/);
  assert.throws(() => loadEnv({ MONITOR_WEB_URL: "no-es-url", MONITOR_WEB_SECRET: "x".repeat(20) }), /MONITOR_WEB_URL/);
  const env = loadEnv({});
  assert.deepEqual([env.QR_MOCK_ENABLED, env.MONITOR_WEB_URL, env.MONITOR_RESOURCES_INTERVAL_MS], [false, "", 30_000]);
  assert.equal(loadEnv({ ...QR }).QR_MOCK_ENABLED, true);
});
