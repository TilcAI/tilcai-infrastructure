import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { amountToCents, centsToAmount, formatVendisDate, parseVendisDate, QrMockError } from "../../src/modules/qrsimple/domain.ts";
import { QR_QUIET_MODULES, QR_SCALE, qrMatrix, renderQrPng } from "../../src/modules/qrsimple/image.ts";
import { simulatorPage } from "../../src/modules/qrsimple/page.ts";
import { eventsOf, QR_CONFIG, qrHarness } from "../support/monitor-fakes.ts";

function rejects(fn: () => unknown, status: number, message: RegExp) {
  assert.throws(fn, (e: unknown) => e instanceof QrMockError && e.status === status && message.test(String(e.body.message)));
}
async function rejectsAsync(p: Promise<unknown>, status: number, message: RegExp) {
  await assert.rejects(p, (e: unknown) => e instanceof QrMockError && e.status === status && message.test(String(e.body.message)));
}

/** Decodes the grayscale PNG the mock writes: width, height and one byte per pixel. */
function readGrayPng(png: Buffer) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.deepEqual([png[24], png[25]], [8, 0]); // 8-bit grayscale
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixel = (x: number, y: number) => raw[y * (width + 1) + 1 + x]!;
  return { width, height, pixel };
}

test("dates are Vendis's «Y-m-d H:i:s» in Bolivia time", () => {
  assert.equal(parseVendisDate("2026-10-09 03:30:00")?.toISOString(), "2026-10-09T07:30:00.000Z");
  assert.equal(formatVendisDate(new Date("2026-10-09T07:30:00.000Z")), "2026-10-09 03:30:00");
  // The day changes four hours later than in UTC.
  assert.equal(formatVendisDate(new Date("2026-01-01T02:00:00.000Z")), "2025-12-31 22:00:00");
  for (const bad of ["2026-02-31 10:00:00", "2026-10-09", "09/10/2026 10:00:00", "2026-10-09 25:00:00", "", null, 20261009]) {
    assert.equal(parseVendisDate(bad), null, String(bad));
  }
});

test("amounts are bolivianos with at most two decimals, never floats", () => {
  assert.equal(amountToCents(119.2), 11920);
  assert.equal(amountToCents("119.20"), 11920);
  assert.equal(amountToCents(0), 0);
  assert.equal(amountToCents(0.07), 7);
  assert.equal(amountToCents(1e6), 100_000_000);
  for (const bad of [-1, 1.234, "1,5", "abc", NaN, Infinity, 1e6 + 1, null, true]) assert.equal(amountToCents(bad), null, String(bad));
  assert.equal(centsToAmount(11920), "119.20");
  assert.equal(centsToAmount(7), "0.07");
});

test("login: the configured credentials get a token that lasts one year; anything else is refused", () => {
  const h = qrHarness();
  rejects(() => h.mock.login({ email: QR_CONFIG.email, password: "otra" }), 401, /^Credenciales Inválidos$/);
  rejects(() => h.mock.login({ email: "x@y.z", password: QR_CONFIG.password }), 401, /Credenciales/);
  rejects(() => h.mock.login(null), 401, /Credenciales/);

  const token = h.login();
  assert.match(token, /^1\|[0-9a-f]{48}$/);
  assert.equal(h.mock.authenticate(`Bearer ${token}`), 1);
  // Each login is another token; the earlier one keeps working.
  const second = h.mock.login({ email: QR_CONFIG.email.toUpperCase(), password: QR_CONFIG.password });
  assert.match(second.access_token, /^2\|/);
  assert.equal(h.mock.authenticate(`Bearer ${token}`), 1);

  for (const bad of [undefined, "", token, `Bearer ${token}x`, `Bearer 1|${"0".repeat(48)}`, `Bearer 99|${token.split("|")[1]}`, `Bearer 2|${token.split("|")[1]}`]) {
    rejects(() => h.mock.authenticate(bad), 401, /^Unauthenticated\.$/);
  }
  h.clock.advance(365 * 86_400_000);
  rejects(() => h.mock.authenticate(`Bearer ${token}`), 401, /Unauthenticated/);
  assert.equal(eventsOf(h.monitor.list({}), "qr.token_issued").length, 2);
});

test("generate: returns the image, its URL and a 9-digit id, and the QR starts as Pendiente", () => {
  const h = qrHarness();
  const tokenId = h.mock.authenticate(`Bearer ${h.login()}`);
  const qr = h.mock.generate(tokenId, h.body());
  assert.ok(qr.qr_id >= 100_000_000 && qr.qr_id < 1_000_000_000);
  assert.match(qr.qr_url, new RegExp(`^https://tilcai\\.test/mock/vendis/qr-image/${qr.qr_id}-[0-9a-f]{16}\\.png$`));
  // As in the documentation's example, the base64 is a PNG.
  assert.ok(qr.qr_image.startsWith("iVBORw0KGgo"));
  assert.deepEqual(h.mock.image(qr.qr_url.split("/").pop()!), Buffer.from(qr.qr_image, "base64"));
  // Nobody finds an image by guessing ids.
  assert.equal(h.mock.image(`${qr.qr_id}-${"0".repeat(16)}.png`), null);
  assert.equal(h.mock.image("../../etc/passwd"), null);

  assert.deepEqual(h.mock.status(qr.qr_id), { status: "Pendiente", payments: [] });
  assert.deepEqual(h.mock.status(String(qr.qr_id)), { status: "Pendiente", payments: [] });
  const stored = h.repo.code(qr.qr_id)!;
  assert.equal(stored.description, "SN0017 Pago QR OP-3F2A91C0");
  assert.equal(stored.amountCents, 11920);
  // Same shape as a real QR Simple: 256 bytes in base64, a bar and an identifier.
  assert.match(stored.payload, /^[A-Za-z0-9+/]{342}==\|[0-9a-f]{24}$/);
  const created = eventsOf(h.monitor.list({}), "qr.created")[0]!;
  assert.deepEqual([created.source, created.subject, created.data.amount], ["qr-simple", `qr:${qr.qr_id}`, "119.20"]);
});

test("generate: a bad request gets Vendis's error and nothing is stored", () => {
  const h = qrHarness();
  const tokenId = h.mock.authenticate(`Bearer ${h.login()}`);
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ device_id: null }, "device_id"],
    [{ device_id: "caja 1!" }, "device_id"],
    [{ amount: "ciento" }, "amount"],
    [{ amount: 10.999 }, "amount"],
    [{ amount: 0 }, "amount"],
    [{ modify_amount: "no" }, "modify_amount"],
    [{ is_multi_use: 1 }, "is_multi_use"],
    [{ qr_expiration: "mañana" }, "qr_expiration"],
    [{ qr_expiration: "2026-10-02 07:59:59" }, "qr_expiration"], // a second before the clock's now
    [{ description: "   " }, "description"],
    [{ description: "x".repeat(121) }, "description"],
  ];
  for (const [over, field] of bad) {
    assert.throws(
      () => h.mock.generate(tokenId, h.body(over)),
      (e: unknown) => e instanceof QrMockError && e.status === 422 && e.body.success === false && e.body.message === "Ocurrió un error al generar el QR" && field in (e.body.errors as object),
      JSON.stringify(over),
    );
  }
  assert.equal(h.mock.pending().length, 0);
  // An open amount is fine when the payer may change it.
  assert.ok(h.mock.generate(tokenId, h.body({ amount: 0, modify_amount: true })).qr_id);
  rejects(() => h.mock.status(123), 404, /^QR no encontrado$/);
  rejects(() => h.mock.status("abc"), 404, /QR no encontrado/);
});

test("deposit: the QR becomes Pagado and the caller is notified as Vendis would", async () => {
  const h = qrHarness();
  const token = h.login();
  const qr = h.mock.generate(h.mock.authenticate(`Bearer ${token}`), h.body());
  h.clock.advance(90_000);
  const r = await h.mock.simulateDeposit({ qrId: qr.qr_id });
  assert.deepEqual(r.callback, { state: "DELIVERED", attempts: 1, error: null });
  assert.equal(r.qr.status, "Pagado");

  const call = h.http.calls[0]!;
  assert.equal(call.url, QR_CONFIG.callbackUrl);
  // The callback carries the token the QR was created with.
  assert.equal(call.headers.authorization, `Bearer ${token}`);
  const payment = { payment_date: "2026-10-02 08:01:30", payment_amount: "119.20", payment_name: "PAGADOR DE PRUEBA", payment_bank: "BANCO MOCK" };
  assert.deepEqual(JSON.parse(call.body), { ...payment, qr_id: qr.qr_id });
  // The status answer carries the id as a string, like the documentation's example.
  assert.deepEqual(h.mock.status(qr.qr_id), { status: "Pagado", payments: [{ ...payment, qr_id: String(qr.qr_id) }] });

  await rejectsAsync(h.mock.simulateDeposit({ qrId: qr.qr_id }), 409, /ya fue pagado/);
  assert.equal(h.http.calls.length, 1);
  assert.deepEqual(h.types().filter((t) => t !== "qr.token_issued"), ["qr.created", "qr.paid", "qr.callback_delivered"]);
  // Nothing left for the worker.
  assert.equal(await h.mock.deliverDueCallbacks(), 0);
  assert.equal(h.http.calls.length, 1);
});

test("deposit: without a QR id the newest pending one is paid, and nothing pending is an error", async () => {
  const h = qrHarness();
  await rejectsAsync(h.mock.simulateDeposit(), 404, /No hay ningún QR pendiente/);
  const tokenId = h.mock.authenticate(`Bearer ${h.login()}`);
  const first = h.mock.generate(tokenId, h.body({ description: "primero" }));
  h.clock.advance(1000);
  const second = h.mock.generate(tokenId, h.body({ description: "segundo" }));
  assert.deepEqual(h.mock.pending().map((c) => c.qrId), [second.qr_id, first.qr_id]);
  assert.equal((await h.mock.simulateDeposit()).qr.qrId, second.qr_id);
  assert.deepEqual(h.mock.pending().map((c) => c.qrId), [first.qr_id]);
});

test("deposit: the amount follows the QR's rules", async () => {
  const h = qrHarness();
  const tokenId = h.mock.authenticate(`Bearer ${h.login()}`);
  const fixed = h.mock.generate(tokenId, h.body());
  await rejectsAsync(h.mock.simulateDeposit({ qrId: fixed.qr_id, amount: 100 }), 422, /no permite cambiar el monto/);
  await rejectsAsync(h.mock.simulateDeposit({ qrId: fixed.qr_id, amount: "mucho" }), 422, /Monto inválido/);
  assert.equal(h.mock.status(fixed.qr_id).status, "Pendiente");
  assert.equal((await h.mock.simulateDeposit({ qrId: fixed.qr_id, amount: "119.20", payerName: "  Ana Quispe ", payerBank: "BNB" })).payment.payerName, "Ana Quispe");

  const open = h.mock.generate(tokenId, h.body({ amount: 0, modify_amount: true, is_multi_use: true }));
  assert.equal((await h.mock.simulateDeposit({ qrId: open.qr_id })).payment.amountCents, 1000);
  // A multi-use QR takes another payment, with the amount the payer types.
  assert.equal((await h.mock.simulateDeposit({ qrId: open.qr_id, amount: 35.5 })).payment.amountCents, 3550);
  assert.deepEqual(h.mock.status(open.qr_id).payments.map((p) => p.payment_amount), ["10.00", "35.50"]);
});

test("notification: one delivery and three retries, then it gives up and the payment is still there", async () => {
  const h = qrHarness();
  const qr = h.mock.generate(h.mock.authenticate(`Bearer ${h.login()}`), h.body());
  h.http.queue.push({ status: 500, body: { success: false, message: "error message" } }, new Error("connect ECONNREFUSED"), { status: 200, body: { success: false, message: "no reconozco ese QR" } }, { status: 502, body: null });

  const r = await h.mock.simulateDeposit({ qrId: qr.qr_id });
  assert.deepEqual(r.callback, { state: "PENDING", attempts: 1, error: "HTTP 500: error message" });
  // Not before its turn: 5 s, then 15 s, then 45 s.
  h.clock.advance(4000);
  assert.equal(await h.mock.deliverDueCallbacks(), 0);
  h.clock.advance(1000);
  assert.equal(await h.mock.deliverDueCallbacks(), 1);
  h.clock.advance(15_000);
  assert.equal(await h.mock.deliverDueCallbacks(), 1);
  h.clock.advance(44_000);
  assert.equal(await h.mock.deliverDueCallbacks(), 0);
  h.clock.advance(1000);
  assert.equal(await h.mock.deliverDueCallbacks(), 1);
  h.clock.advance(600_000);
  assert.equal(await h.mock.deliverDueCallbacks(), 0);

  assert.equal(h.http.calls.length, 4);
  const payment = h.repo.payments(qr.qr_id)[0]!;
  assert.deepEqual([payment.callbackState, payment.callbackAttempts, payment.callbackLastError], ["FAILED", 4, "HTTP 502"]);
  const failures = eventsOf(h.monitor.list({}), "qr.callback_failed");
  assert.deepEqual(failures.map((e) => [e.severity, e.data.final]), [["warning", false], ["warning", false], ["warning", false], ["error", true]]);
  assert.match(failures[2]!.summary, /HTTP 200: no reconozco ese QR/);
  // Whoever polls still sees the payment.
  assert.equal(h.mock.status(qr.qr_id).status, "Pagado");
});

test("notification: delivered on a retry, and a reserved one is not sent twice", async () => {
  const h = qrHarness();
  const qr = h.mock.generate(h.mock.authenticate(`Bearer ${h.login()}`), h.body());
  h.http.queue.push(new Error("timeout"));
  await h.mock.simulateDeposit({ qrId: qr.qr_id });
  h.clock.advance(5000);
  const [due] = h.repo.dueCallbacks(h.clock.now().toISOString(), 10);
  // Another worker took it first.
  assert.equal(h.repo.claimCallback(due!.id, due!.callbackAttempts, new Date(h.clock.now().getTime() + 30_000).toISOString()), true);
  assert.equal(await h.mock.deliverDueCallbacks(), 0);
  assert.equal(h.http.calls.length, 1);
  // That worker died: after the reservation the notification is due again.
  h.clock.advance(30_000);
  assert.equal(await h.mock.deliverDueCallbacks(), 1);
  assert.deepEqual([h.repo.payments(qr.qr_id)[0]!.callbackState, h.repo.payments(qr.qr_id)[0]!.callbackAttempts], ["DELIVERED", 2]);
  assert.match(eventsOf(h.monitor.list({}), "qr.callback_delivered")[0]!.summary, /al intento 2/);
});

test("notification: without a callback URL the payment is only visible by asking for the status", async () => {
  const h = qrHarness({ callbackUrl: "" });
  const qr = h.mock.generate(h.mock.authenticate(`Bearer ${h.login()}`), h.body());
  assert.deepEqual((await h.mock.simulateDeposit({ qrId: qr.qr_id })).callback, { state: "SKIPPED", attempts: 0, error: null });
  assert.equal(h.http.calls.length, 0);
  assert.equal(h.mock.status(qr.qr_id).status, "Pagado");
});

test("expiry: an unpaid QR is voided when its time is up and can no longer be paid", async () => {
  const h = qrHarness();
  const tokenId = h.mock.authenticate(`Bearer ${h.login()}`);
  const short = h.mock.generate(tokenId, h.body({}, 5));
  const long = h.mock.generate(tokenId, h.body({}, 60));
  const paid = h.mock.generate(tokenId, h.body({}, 5));
  await h.mock.simulateDeposit({ qrId: paid.qr_id });

  h.clock.advance(5 * 60_000);
  assert.deepEqual(h.mock.pending().map((c) => c.qrId), [long.qr_id]);
  assert.equal(h.mock.status(short.qr_id).status, "Anulado");
  assert.equal(h.mock.status(paid.qr_id).status, "Pagado");
  await rejectsAsync(h.mock.simulateDeposit({ qrId: short.qr_id }), 409, /vencido o anulado/);
  const expired = eventsOf(h.monitor.list({}), "qr.expired");
  assert.deepEqual(expired.map((e) => e.subject), [`qr:${short.qr_id}`]);
  assert.equal(h.mock.expireDue(), 0);
});

test("image: every module of the code is on the picture, with the quiet zone and the badge in the centre", () => {
  const payload = `${Buffer.alloc(256, 7).toString("base64")}|${"ab".repeat(12)}`;
  const matrix = qrMatrix(payload);
  // 369 characters at error correction H: version 20, 97 modules a side.
  assert.equal(matrix.size, 97);
  const png = readGrayPng(renderQrPng(matrix));
  const side = (97 + QR_QUIET_MODULES * 2) * QR_SCALE;
  assert.deepEqual([png.width, png.height], [side, side]);

  const centre = (i: number) => (i + QR_QUIET_MODULES) * QR_SCALE + QR_SCALE / 2;
  const badge = 97 * QR_SCALE * 0.1 + QR_SCALE;
  let checked = 0;
  for (let row = 0; row < 97; row++) {
    for (let col = 0; col < 97; col++) {
      if (Math.hypot(centre(col) - side / 2, centre(row) - side / 2) <= badge) continue;
      assert.equal(png.pixel(centre(col), centre(row)), matrix.dark(row, col) ? 0 : 255, `module ${row},${col}`);
      checked++;
    }
  }
  assert.ok(checked > 97 * 97 * 0.95);
  // Quiet zone: white all around.
  for (let i = 0; i < side; i += 7) for (const edge of [0, QR_QUIET_MODULES * QR_SCALE - 1]) assert.equal(png.pixel(i, edge), 255);
  // The badge: white disc, with the ink of the "$" on its vertical bar.
  assert.equal(png.pixel(side / 2 + 40, side / 2), 255);
  assert.equal(png.pixel(side / 2, side / 2 - 40), 0);
  // The badge hides well under the 30 % that error correction H recovers.
  assert.ok((Math.PI * (97 * 0.1) ** 2) / 97 ** 2 < 0.04);
});

test("page: one button for the QR on screen, and whatever the caller wrote is shown as text", () => {
  const h = qrHarness();
  const tokenId = h.mock.authenticate(`Bearer ${h.login()}`);
  h.mock.generate(tokenId, h.body({ description: '<img src=x onerror="alert(1)">' }));
  const [qr] = h.mock.pending();
  const html = simulatorPage({ qr: qr!, imagePath: h.mock.imagePath(qr!), others: [], nonce: "n0nce", callbackUrl: QR_CONFIG.callbackUrl });
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, new RegExp(`<button id="pay" type="button" data-qr="${qr!.qrId}">Simular depósito</button>`));
  assert.match(html, /Bs 119\.20/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.equal(html.includes("<img src=x"), false);
  assert.match(html, /<script nonce="n0nce">/);

  const empty = simulatorPage({ qr: null, imagePath: null, others: [], nonce: "n", callbackUrl: "" });
  assert.match(empty, /<button id="pay" type="button" disabled>Simular depósito<\/button>/);
  assert.match(empty, /No hay ningún QR pendiente de pago/);
});
