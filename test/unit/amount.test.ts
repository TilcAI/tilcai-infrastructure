import { test } from "node:test";
import assert from "node:assert/strict";
import { atomicToDecimal, decimalToAtomic, maxFeeForBps, parseAtomic, rescale } from "../../src/shared/amount.ts";

test("decimal ↔ atomic is exact and strict", () => {
  assert.equal(decimalToAtomic("1.5", 6), 1_500_000n);
  assert.equal(decimalToAtomic("0.000001", 6), 1n);
  assert.equal(decimalToAtomic("2.50", 6), 2_500_000n);
  assert.throws(() => decimalToAtomic("0.0000001", 6));
  for (const bad of ["1e6", "-1", " 1", "1.", ".5", "01", "0x10", "1,5"]) assert.throws(() => decimalToAtomic(bad, 6), bad);
  assert.equal(atomicToDecimal(15_000_000n, 7), "1.5");
  assert.equal(atomicToDecimal(0n, 7), "0");
});

test("rescale 6 ↔ 7 never truncates silently", () => {
  assert.equal(rescale(1_500_000n, 6, 7), 15_000_000n);
  assert.equal(rescale(15_000_000n, 7, 6), 1_500_000n);
  assert.throws(() => rescale(15_000_001n, 7, 6));
});

test("parseAtomic accepts canonical integers only", () => {
  assert.equal(parseAtomic("10"), 10n);
  assert.throws(() => parseAtomic("010"));
  assert.throws(() => parseAtomic(10));
});

test("max fee from fractional bps rounds up, zero bps is free", () => {
  assert.equal(maxFeeForBps(2_000_000n, 0n), 0n);
  // 1.3 bps of 2 USDC = 260 units, +10 % margin = 286
  assert.equal(maxFeeForBps(2_000_000n, 130n), 286n);
});
