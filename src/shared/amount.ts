/**
 * Exact atomic amounts. No floats anywhere in the money path (report §14.4).
 * Atomic values are bigint in memory and canonical decimal strings on the wire.
 */
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ATOMIC = /^(0|[1-9][0-9]{0,77})$/;

/** "1.25" with 6 decimals → 1250000n. Rejects values that cannot be represented exactly. */
export function decimalToAtomic(value: string, decimals: number): bigint {
  if (!DECIMAL.test(value)) throw new RangeError("Amount must be a plain decimal string.");
  const [whole = "0", frac = ""] = value.split(".");
  const fraction = frac.replace(/0+$/, "");
  if (fraction.length > decimals) throw new RangeError(`Amount has more than ${decimals} decimals.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function atomicToDecimal(units: bigint, decimals: number): string {
  if (units < 0n) throw new RangeError("Negative amount.");
  if (decimals === 0) return units.toString();
  const s = units.toString().padStart(decimals + 1, "0");
  const out = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}

export function parseAtomic(value: unknown): bigint {
  if (typeof value !== "string" || !ATOMIC.test(value)) throw new RangeError("Atomic amount must be a canonical integer string.");
  return BigInt(value);
}

/** Converts between token precisions without losing value; throws if it would truncate. */
export function rescale(units: bigint, from: number, to: number): bigint {
  if (to >= from) return units * 10n ** BigInt(to - from);
  const factor = 10n ** BigInt(from - to);
  if (units % factor !== 0n) throw new RangeError("Rescaling would truncate the amount.");
  return units / factor;
}

/**
 * CCTP V2 fee ceiling from Iris' basis points (which can be fractional, e.g. 1.3).
 * bps is carried as hundredths of a basis point to stay integer.
 */
export function maxFeeForBps(amount: bigint, bpsHundredths: bigint, marginPercent = 10n): bigint {
  if (bpsHundredths <= 0n) return 0n;
  const raw = amount * bpsHundredths * (100n + marginPercent);
  const denom = 10_000n * 100n * 100n;
  return (raw + denom - 1n) / denom;
}
