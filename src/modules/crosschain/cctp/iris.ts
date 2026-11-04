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

export type IrisErrorKind = "timeout" | "aborted" | "http" | "invalid_response" | "network";

export class IrisError extends Error {
  constructor(readonly kind: IrisErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = "IrisError";
  }
}

export class IrisClient implements IrisPort {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("Iris timeout must be a positive safe integer");
  }

  private async get(url: string, label: string): Promise<{ status: number; body: unknown; numberTokens?: unknown }> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal });
      if (signal.aborted) throw signal.reason;
      if (label === "messages" && res.status === 404) return { status: 404, body: null };
      if (!res.ok) throw new IrisError("http", `Iris ${label} HTTP ${res.status}`, res.status);
      let body: unknown;
      let numberTokens: unknown;
      try {
        if (label === "fees") {
          const raw = await res.text();
          body = JSON.parse(raw);
          // A second parse preserves JSON number lexemes before JavaScript number rounding.
          numberTokens = JSON.parse(quoteJsonNumbers(raw));
        } else {
          body = await res.json();
        }
        if (signal.aborted) throw signal.reason;
      } catch (e) {
        if (signal.aborted || isAbort(e)) throw e;
        if (e instanceof SyntaxError) throw new IrisError("invalid_response", `Iris ${label} invalid JSON`);
        throw e;
      }
      return { status: res.status, body, numberTokens };
    } catch (e) {
      if (e instanceof IrisError) throw e;
      if (signal.aborted && isTimeout(signal.reason)) throw new IrisError("timeout", `Iris ${label} timed out after ${this.timeoutMs} ms`);
      if (isAbort(e) || signal.aborted) throw new IrisError("aborted", `Iris ${label} aborted`);
      throw new IrisError("network", `Iris ${label} network error`);
    }
  }

  async lookup(sourceDomain: number, txHash: string): Promise<IrisLookup> {
    const { status, body } = await this.get(`${this.baseUrl}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(txHash)}`, "messages");
    if (status === 404) return { kind: "not_found" };
    if (!isRecord(body) || !Array.isArray(body.messages)) throw new IrisError("invalid_response", "Iris messages invalid response");
    if (body.messages.length === 0) return { kind: "not_found" };
    const m = body.messages[0];
    if (!isRecord(m) || typeof m.status !== "string" || !m.status.trim()) throw new IrisError("invalid_response", "Iris messages invalid entry");
    if (m.status === "complete") {
      if (typeof m.attestation !== "string" || m.attestation === "PENDING" || !m.attestation.startsWith("0x") ||
        typeof m.message !== "string" || !m.message.startsWith("0x")) {
        throw new IrisError("invalid_response", "Iris messages incomplete attestation");
      }
      return { kind: "complete", message: m as unknown as IrisMessage };
    }
    if (m.delayReason != null && typeof m.delayReason !== "string") throw new IrisError("invalid_response", "Iris messages invalid delay reason");
    return { kind: "pending", status: m.status, delayReason: m.delayReason ?? null };
  }

  async feeBpsHundredths(src: number, dst: number, finality: 1000 | 2000): Promise<bigint> {
    const { body, numberTokens } = await this.get(`${this.baseUrl}/v2/burn/USDC/fees/${src}/${dst}`, "fees");
    if (!Array.isArray(body) || !Array.isArray(numberTokens)) throw new IrisError("invalid_response", "Iris fees invalid response");
    const matches = body.map((entry: unknown, index: number) => ({ entry, index }))
      .filter(({ entry }) => isRecord(entry) && entry.finalityThreshold === finality);
    if (matches.length !== 1) throw new IrisError("invalid_response", `Iris fees missing or ambiguous finality tier ${finality}`);
    const { entry: tier, index } = matches[0]!;
    if (!isRecord(tier)) throw new IrisError("invalid_response", "Iris fees invalid tier");
    const rawTier = numberTokens[index];
    if (!isRecord(rawTier) || typeof rawTier.finalityThreshold !== "string" ||
      !decimalEqualsInteger(rawTier.finalityThreshold, BigInt(finality))) {
      throw new IrisError("invalid_response", "Iris fees invalid finality tier");
    }
    if (typeof tier.minimumFee !== "number" || !Number.isFinite(tier.minimumFee) || tier.minimumFee < 0) {
      throw new IrisError("invalid_response", `Iris fees invalid minimumFee for tier ${finality}`);
    }
    if (typeof rawTier.minimumFee !== "string") {
      throw new IrisError("invalid_response", "Iris fees invalid numeric token");
    }
    return feeHundredthsCeiling(rawTier.minimumFee);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAbort = (value: unknown): boolean =>
  value instanceof Error && (value.name === "AbortError" || value.name === "TimeoutError");

const isTimeout = (value: unknown): boolean => value instanceof Error && value.name === "TimeoutError";

/** Quotes each JSON number without changing its structure, so the fee's original decimal can be used. */
function quoteJsonNumbers(raw: string): string {
  let quoted = "";
  let inside = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (inside) {
      quoted += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inside = false;
    } else if (char === '"') {
      inside = true;
      quoted += char;
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      let end = i + 1;
      while (end < raw.length && /[0-9.eE+-]/.test(raw[end]!)) end++;
      quoted += `"${raw.slice(i, end)}"`;
      i = end - 1;
    } else {
      quoted += char;
    }
  }
  return quoted;
}

function decimalEqualsInteger(raw: string, expected: bigint): boolean {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return false;
  const digitsText = `${match[1]}${match[2] ?? ""}`.replace(/^0+/, "") || "0";
  const shift = BigInt(match[3] ?? "0") - BigInt((match[2] ?? "").length);
  if (shift >= 0n) {
    if (shift > 10n) return false;
    return BigInt(digitsText) * 10n ** shift === expected;
  }
  if (-shift > BigInt(digitsText.length)) return false;
  return BigInt(digitsText) === expected * 10n ** -shift;
}

/** Ceils an exact JSON decimal to hundredths of a basis point using integer arithmetic. */
function feeHundredthsCeiling(raw: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) throw new IrisError("invalid_response", "Iris fees invalid decimal");
  const digitsText = `${match[1]}${match[2] ?? ""}`.replace(/^0+/, "") || "0";
  if (digitsText === "0") return 0n;
  const shift = BigInt(match[3] ?? "0") + 2n - BigInt((match[2] ?? "").length);
  let hundredths: bigint;
  if (shift >= 0n) {
    if (BigInt(digitsText.length) + shift > 16n) throw new IrisError("invalid_response", "Iris fees minimumFee exceeds safe precision");
    hundredths = BigInt(digitsText) * 10n ** shift;
  } else if (-shift > BigInt(digitsText.length)) {
    hundredths = 1n;
  } else {
    const factor = 10n ** -shift;
    hundredths = (BigInt(digitsText) + factor - 1n) / factor;
  }
  if (hundredths > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IrisError("invalid_response", "Iris fees minimumFee exceeds safe precision");
  }
  return hundredths;
}
