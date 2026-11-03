import { formatVendisDate, parseVendisDate, QrMockError } from "../../qrsimple/domain.ts";
import type { QrSimpleMock } from "../../qrsimple/service.ts";
import { ProviderError, type CollectionState, type ProviderQr, type ProviderQrRequest, type ProviderStatus, type QrProvider } from "../domain.ts";
import { toCents } from "../http.ts";

/**
 * The QR Simple mock as a provider. When QR_MOCK_ENABLED is set it is the only provider: the real
 * ones are not asked, no bank is reached and a payment happens when someone presses
 * "Simular depósito" (or POST /v1/qr/:id/simulate-payment).
 */
export class MockProvider implements QrProvider {
  readonly id = "mock" as const;
  readonly label = "Mock (sin banco, sin dinero)";
  private tokenId: number | null = null;

  constructor(
    private readonly mock: QrSimpleMock,
    private readonly credentials: { email: string; password: string },
  ) {}

  configured(): boolean {
    return true;
  }

  private token(): number {
    if (this.tokenId === null) {
      const { access_token } = this.mock.login({ email: this.credentials.email, password: this.credentials.password, token_name: "tilcai-gateway" });
      this.tokenId = this.mock.authenticate(`Bearer ${access_token}`);
    }
    return this.tokenId;
  }

  async generate(req: ProviderQrRequest): Promise<ProviderQr> {
    try {
      const r = this.mock.generate(this.token(), {
        device_id: "tilcai",
        amount: `${Math.trunc(req.amountCents / 100)}.${String(req.amountCents % 100).padStart(2, "0")}`,
        modify_amount: req.modifyAmount,
        is_multi_use: !req.singleUse,
        qr_expiration: formatVendisDate(req.expiresAt),
        description: req.description,
      });
      return { providerRef: String(r.qr_id), imageBase64: r.qr_image, expiresAt: req.expiresAt };
    } catch (e) {
      if (e instanceof QrMockError) throw new ProviderError(this.id, "rejected", `${e.status}: ${JSON.stringify(e.body.errors ?? e.body.message)}`.slice(0, 200));
      throw e;
    }
  }

  async status(providerRef: string): Promise<ProviderStatus> {
    try {
      const s = this.mock.status(providerRef);
      const state: CollectionState = s.status === "Pagado" ? "PAID" : s.status === "Anulado" ? "CANCELLED" : s.status === "Fallido" ? "ERROR" : "PENDING";
      const p = s.payments.at(-1);
      return {
        state,
        message: null,
        payment: p
          ? { amountCents: toCents(p.payment_amount), paidAt: parseVendisDate(p.payment_date)?.toISOString() ?? null, payerName: p.payment_name, payerBank: p.payment_bank, payerAccount: null, bankReference: null }
          : null,
      };
    } catch (e) {
      if (e instanceof QrMockError) throw new ProviderError(this.id, "rejected", String(e.body.message));
      throw e;
    }
  }
}
