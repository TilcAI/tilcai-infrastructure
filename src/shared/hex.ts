export type Hex = `0x${string}`;
export const ZERO32: Hex = `0x${"00".repeat(32)}`;

export const strip0x = (h: string): string => h.replace(/^0x/i, "");
export const hexToBytes = (h: string): Buffer => {
  const s = strip0x(h);
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new TypeError("Invalid hex string.");
  return Buffer.from(s, "hex");
};
export const bytesToHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;
export const isHex32 = (h: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(h);
export const sameHex = (a: string, b: string): boolean => strip0x(a).toLowerCase() === strip0x(b).toLowerCase();
