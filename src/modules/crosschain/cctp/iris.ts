/**
 * Circle Iris (attestation service) client. Sandbox limit ~35 req/s per IP;
 * callers poll every few seconds. Iris output is input to verification, not truth:
 * the raw message is decoded and checked by `verify.ts`.
 */
export interface IrisMessage {
  message: string;
  attestation: string;
  eventNonce: string;
  cctpVersion: number;
  status: string;
  delayReason?: string | null;
}

export type IrisLookup =
  | { kind: "not_found" }
  | { kind: "pending"; status: string; delayReason?: string | null }
  | { kind: "complete"; message: IrisMessage };

export interface IrisPort {
  lookup(sourceDomain: number, txHash: string): Promise<IrisLookup>;
  /** Minimum fee in hundredths of a basis point for a finality threshold (1000 fast / 2000 standard). */
  feeBpsHundredths(sourceDomain: number, destinationDomain: number, finality: 1000 | 2000): Promise<bigint>;
}

export class IrisClient implements IrisPort {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async lookup(sourceDomain: number, txHash: string): Promise<IrisLookup> {
    const res = await this.fetchImpl(`${this.baseUrl}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(txHash)}`);
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) throw new Error(`Iris HTTP ${res.status}`);
    const data = (await res.json()) as { messages?: IrisMessage[] };
    const m = data.messages?.[0];
    if (!m) return { kind: "not_found" };
    if (m.status === "complete" && m.attestation && m.attestation !== "PENDING" && m.message?.startsWith("0x")) {
      return { kind: "complete", message: m };
    }
    return { kind: "pending", status: m.status, delayReason: m.delayReason ?? null };
  }

  async feeBpsHundredths(src: number, dst: number, finality: 1000 | 2000): Promise<bigint> {
    const res = await this.fetchImpl(`${this.baseUrl}/v2/burn/USDC/fees/${src}/${dst}`);
    if (!res.ok) throw new Error(`Iris fees HTTP ${res.status}`);
    const arr = (await res.json()) as Array<{ finalityThreshold: number; minimumFee: number }>;
    const bps = arr.find((x) => x.finalityThreshold === finality)?.minimumFee ?? 0;
    return BigInt(Math.round(bps * 100));
  }
}
