import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bearerOf, isLoopback, matchesAny } from "../../apps/api/auth.ts";
import { centsToAmount, QrMockError } from "./domain.ts";
import { simulatorPage } from "./page.ts";
import type { QrSimpleMock } from "./service.ts";

/** Everything the mock serves hangs from here; the paths below it are Vendis's own. */
export const QR_MOCK_PREFIX = "/mock/vendis";

/**
 * QR Simple mock over HTTP.
 *
 *   POST {prefix}/api/v1/login                              Vendis: token (valid one year)
 *   POST {prefix}/api/v1/devices/simple-qr/generate         Vendis: new QR
 *   GET  {prefix}/api/v1/devices/simple-qr/get/:qrId        Vendis: status and payments
 *   GET  {prefix}/qr-image/:file                            the image behind `qr_url`
 *   GET  {prefix}/                                          page with the "Simular depósito" button
 *   GET  {prefix}/simulate/pending                          QRs waiting for payment
 *   POST {prefix}/simulate/deposit                          pays a QR and sends the notification
 *
 * The Vendis endpoints answer in Vendis's shapes and authenticate with the token of
 * `login`, not with TilcAI's API keys. The simulator is open to the host itself; from
 * anywhere else it needs `?key=<QR_MOCK_SIMULATOR_KEY>` or a TilcAI API key.
 */
export function registerQrMock(app: FastifyInstance, o: { mock: QrSimpleMock; apiKeys: readonly string[]; simulatorKey: string; callbackUrl: string }): void {
  const { mock } = o;
  const json = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).type("application/json; charset=utf-8").send(JSON.stringify(body));

  app.register(
    async (scope) => {
      scope.setErrorHandler((err, req, reply) => {
        if (err instanceof QrMockError) return json(reply, err.status, err.body);
        if ((err as { statusCode?: number }).statusCode === 400 || (err as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY") {
          return json(reply, 400, { success: false, message: "Solicitud inválida" });
        }
        req.log.error({ err }, "qr mock: unhandled error");
        return json(reply, 500, { success: false, message: "Error interno" });
      });

      // ── Vendis API ────────────────────────────────────────────────────────
      scope.post("/api/v1/login", async (req, reply) => json(reply, 200, mock.login(req.body)));

      scope.post("/api/v1/devices/simple-qr/generate", async (req, reply) => {
        const tokenId = mock.authenticate(req.headers.authorization);
        return json(reply, 200, { success: true, data: mock.generate(tokenId, req.body) });
      });

      scope.get<{ Params: { qrId: string } }>("/api/v1/devices/simple-qr/get/:qrId", async (req, reply) => {
        mock.authenticate(req.headers.authorization);
        return json(reply, 200, { success: true, data: mock.status(req.params.qrId) });
      });

      // Like the real `qr_url`: reachable by whoever has the link, which nobody can guess.
      scope.get<{ Params: { file: string } }>("/qr-image/:file", async (req, reply) => {
        const png = mock.image(req.params.file);
        if (!png) return json(reply, 404, { success: false, message: "QR no encontrado" });
        return reply.code(200).type("image/png").header("cache-control", "private, max-age=300").send(png);
      });

      // ── Simulator ─────────────────────────────────────────────────────────
      const mayOperate = (req: FastifyRequest): boolean => {
        if (isLoopback(req.ip)) return true;
        const key = (req.query as { key?: unknown }).key;
        if (o.simulatorKey && typeof key === "string" && matchesAny(key, [o.simulatorKey])) return true;
        return matchesAny(bearerOf(req.headers.authorization), o.apiKeys);
      };
      const denied = (reply: FastifyReply) => json(reply, 401, { success: false, message: "Abre el simulador desde el equipo donde corre TilcAI o añade ?key=<QR_MOCK_SIMULATOR_KEY>" });

      scope.get("/", async (req, reply) => {
        if (!mayOperate(req)) return denied(reply);
        const pending = mock.pending();
        const asked = Number((req.query as { qr?: unknown }).qr);
        const qr = pending.find((c) => c.qrId === asked) ?? pending[0] ?? null;
        const nonce = randomBytes(16).toString("base64");
        return reply
          .code(200)
          .type("text/html; charset=utf-8")
          .header("cache-control", "no-store")
          .header("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'`)
          .send(simulatorPage({ qr, imagePath: qr ? mock.imagePath(qr) : null, others: pending.filter((c) => c !== qr), nonce, callbackUrl: o.callbackUrl }));
      });

      scope.get("/simulate/pending", async (req, reply) => {
        if (!mayOperate(req)) return denied(reply);
        return json(reply, 200, {
          success: true,
          data: mock.pending().map((c) => ({
            qr_id: c.qrId,
            amount: centsToAmount(c.amountCents),
            description: c.description,
            qr_image_path: mock.imagePath(c),
            expires_at: c.expiresAt,
            created_at: c.createdAt,
          })),
        });
      });

      scope.post("/simulate/deposit", async (req, reply) => {
        if (!mayOperate(req)) return denied(reply);
        const b = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
        const r = await mock.simulateDeposit({ qrId: b.qr_id, amount: b.amount, payerName: b.payment_name, payerBank: b.payment_bank });
        const amount = centsToAmount(r.payment.amountCents);
        const message =
          r.callback.state === "DELIVERED"
            ? `Depósito de Bs ${amount} registrado y notificación entregada.`
            : r.callback.state === "SKIPPED"
              ? `Depósito de Bs ${amount} registrado. No hay URL de notificación (QR_MOCK_CALLBACK_URL): el pago se ve consultando el estado del QR.`
              : `Depósito de Bs ${amount} registrado, pero la notificación falló (${r.callback.error}). ${r.callback.state === "FAILED" ? "No quedan reintentos." : "Se reintentará."}`;
        return json(reply, 200, {
          success: true,
          message,
          data: {
            qr_id: r.qr.qrId,
            status: r.qr.status,
            payment: { payment_amount: amount, payment_name: r.payment.payerName, payment_bank: r.payment.payerBank },
            callback: { state: r.callback.state, attempts: r.callback.attempts, error: r.callback.error },
          },
        });
      });
    },
    { prefix: QR_MOCK_PREFIX },
  );
}
