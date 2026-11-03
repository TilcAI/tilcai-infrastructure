export { decimalToAtomic, atomicToDecimal, parseAtomic, rescale } from "tilcai-core/amount";

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
